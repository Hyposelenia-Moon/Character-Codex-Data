/**
 * 解析隔离：解析器克隆 + 只读输入种子 + 目录哈希断言
 *
 * 背景（2026-10-04 审核 P1-3 / P2-15）：
 *  1. `mark-docx.parseToJson` 以前把 `opts.giDir`（声称是"冻结的输入快照"）**同时**当作
 *     子进程的写入目录（`DSH_GI_DIR`），于是「输入快照」被解析结果覆写；诊断随后再从这个
 *     目录读期望值 → 「数据 ↔ 文档」这一项退化成"文档和自己比"，永远 0 个不一致（实测
 *     95 级数据对 90 级文档也 exit 0）。发布校验用的就是这一项。
 *  2. 依赖清单以前在 4 个脚本里各手抄一遍，`deep-diff` / `compare-doc-json` / `compare-doc-json2`
 *     因此漏了 `lib/parse-warnings.mjs`，在干净目录里直接 ERR_MODULE_NOT_FOUND。
 *
 * 本模块定下的契约：
 *   · **输入目录只读**：种子通过 `seedGi()` 复制进克隆体，子进程只写克隆体内部；
 *     调用方在解析后用 `assertDirUnchanged()` 证明种子一个字节都没被动过。
 *   · **依赖清单从源码生成**：`parserDeps()` 直接扫 `parse-docx.mjs` 的相对 import，
 *     新增依赖不会再漏。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** scripts/ 目录 */
export const SCRIPTS_DIR = path.resolve(here, '..')
/** 仓库根 */
export const ROOT = path.resolve(SCRIPTS_DIR, '..')
/** data/ 目录 */
export const DATA_DIR = path.join(ROOT, 'data')

/**
 * 解析器（`scripts/parse-docx.mjs`）的非内置依赖：直接从源码里的相对 import 扫出来，
 * 不再手写数组。返回形如 `['./lib/docx.mjs', './lib/main-doc.mjs', …]`（相对 scripts/）。
 * @returns {string[]}
 */
export function parserDeps () {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'parse-docx.mjs'), 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) out.add(m[1])
  return [...out].sort()
}

/**
 * 建一个最小解析器克隆：`<dstRoot>/clone/{scripts,data}`（每次重建，保证干净）。
 * 含 `parse-docx.mjs` + 它的全部相对依赖 + `data/_index.json`；**不含** data/gi ——
 * 需要在干净目录里跑就接着调 `seedGi()`。
 *
 * @param {string} dstRoot 临时根目录（会被清空重建其中的 clone/）
 * @param {{transformSrc?: (code: string) => string}} [opts] transformSrc：改写 parse-docx 源码的钩子
 *        （`loadParseBlock` 用它追加 `export { parseBlock }`）
 * @returns {{clone: string, scriptsDir: string, dataDir: string, giDir: string, deps: string[]}}
 */
export function cloneParser (dstRoot, opts = {}) {
  const clone = path.join(dstRoot, 'clone')
  fs.rmSync(clone, { recursive: true, force: true })
  fs.mkdirSync(path.join(clone, 'scripts', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(clone, 'data'), { recursive: true })

  const srcFile = path.join(SCRIPTS_DIR, 'parse-docx.mjs')
  let code = fs.readFileSync(srcFile, 'utf8')
  if (opts.transformSrc) code = opts.transformSrc(code)
  fs.writeFileSync(path.join(clone, 'scripts', 'parse-docx.mjs'), code, 'utf8')

  const deps = parserDeps()
  for (const rel of deps) {
    const src = path.join(SCRIPTS_DIR, rel)
    if (!fs.existsSync(src)) throw new Error(`解析器依赖缺失：scripts/${rel.replace(/^\.\//, '')}（parse-docx.mjs 里 import 了它）`)
    const dst = path.join(clone, 'scripts', rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }

  const indexFile = path.join(DATA_DIR, '_index.json')
  if (!fs.existsSync(indexFile)) throw new Error(`缺少 data/_index.json（先跑 node scripts/build-index.mjs）`)
  fs.copyFileSync(indexFile, path.join(clone, 'data', '_index.json'))

  return {
    clone,
    scriptsDir: path.join(clone, 'scripts'),
    dataDir: path.join(clone, 'data'),
    giDir: path.join(clone, 'data', 'gi'),
    deps
  }
}

/**
 * 目录内容哈希：`文件名 → sha256`（只算普通文件，不递归）
 * @param {string} dir
 * @returns {Map<string, string>}
 */
export function hashDir (dir) {
  const map = new Map()
  if (!dir || !fs.existsSync(dir)) return map
  for (const f of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, f)
    try {
      if (!fs.statSync(full).isFile()) continue
      map.set(f, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'))
    } catch { /* 并发写时跳过读不到的文件 */ }
  }
  return map
}

/**
 * 两份目录哈希的差异清单（改动 + 新增 + 删除）
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {string[]}
 */
export function hashDiff (before, after) {
  const out = []
  for (const [f, h] of before) {
    if (!after.has(f)) out.push(`${f}（被删除）`)
    else if (after.get(f) !== h) out.push(`${f}（被改写）`)
  }
  for (const f of after.keys()) if (!before.has(f)) out.push(`${f}（新增）`)
  return out
}

/**
 * 断言目录内容未变（输入只读契约的兑现方式）
 * @param {string} dir
 * @param {Map<string, string>} before `hashDir()` 的结果
 * @param {string} [label]
 */
export function assertDirUnchanged (dir, before, label) {
  const changed = hashDiff(before, hashDir(dir))
  if (changed.length) {
    throw new Error(`${label ?? dir} 被改写（输入目录必须只读）：${changed.slice(0, 8).join('、')}${changed.length > 8 ? ` 等 ${changed.length} 项` : ''}`)
  }
}

/**
 * 把只读种子 `data/gi` 复制进克隆体（**只读入、不写出**）
 * @param {{giDir: string}} clone `cloneParser()` 的返回值
 * @param {string} seedGiDir 种子目录（调用方保证只读）
 * @returns {Map<string, string>} 种子目录复制前的哈希，交给 `assertDirUnchanged()` 校验
 */
export function seedGi (clone, seedGiDir) {
  const before = hashDir(seedGiDir)
  if (!before.size) throw new Error(`输入种子目录为空或不存在：${seedGiDir}`)
  fs.mkdirSync(clone.giDir, { recursive: true })
  for (const f of before.keys()) fs.copyFileSync(path.join(seedGiDir, f), path.join(clone.giDir, f))
  return before
}
