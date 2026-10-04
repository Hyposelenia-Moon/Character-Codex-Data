/**
 * 输出「主文档解析结果 vs data/gi」的逐字段深层差异（含 JSON 结构级 firstDiff）
 * 用法：node scripts/deep-diff-doc-json.mjs [--snapshot <docx>] [角色名...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childRun } from './mark-docx.mjs'
import { cloneParser, seedGi, assertDirUnchanged } from './lib/parse-isolation.mjs'
import { MAIN_DOC } from './lib/main-doc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const work = path.join(root, '.tmp', 'deepdiff')
const snapArg = (() => { const i = process.argv.indexOf('--snapshot'); return i >= 0 ? process.argv[i + 1] : null })()
const only = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== snapArg)
const docx = MAIN_DOC

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function firstDiffs (a, b, pathStr = '', out = [], max = 6) {
  if (out.length >= max || eq(a, b)) return out
  const isObj = (x) => x && typeof x === 'object'
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n && out.length < max; i++) {
      if (i >= a.length) out.push(`${pathStr}[${i}] 文档缺（库有 ${JSON.stringify(b[i]).slice(0, 70)}）`)
      else if (i >= b.length) out.push(`${pathStr}[${i}] 库缺（文档有 ${JSON.stringify(a[i]).slice(0, 70)}）`)
      else firstDiffs(a[i], b[i], `${pathStr}[${i}]`, out, max)
    }
    return out
  }
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      if (out.length >= max) break
      if (!(k in a)) out.push(`${pathStr}.${k} 文档缺（库: ${JSON.stringify(b[k]).slice(0, 70)}）`)
      else if (!(k in b)) out.push(`${pathStr}.${k} 库缺（文档: ${JSON.stringify(a[k]).slice(0, 70)}）`)
      else firstDiffs(a[k], b[k], `${pathStr}.${k}`, out, max)
    }
    return out
  }
  out.push(`${pathStr}: 文档=${JSON.stringify(a)?.slice(0, 80)} ≠ 库=${JSON.stringify(b)?.slice(0, 80)}`)
  return out
}

// 影子解析（不写 data/gi）：解析器克隆 + 只读输入种子。
// 依赖清单由 `cloneParser()` 从 parse-docx.mjs 的 import 里扫出来 —— 以前这里手抄
// `['docx.mjs', 'schema.mjs']`，漏了 `lib/parse-warnings.mjs`，干净目录里直接 ERR_MODULE_NOT_FOUND。
const cl = cloneParser(work)
const seedBefore = seedGi(cl, giDir)
const srcGi = cl.giDir
const ascii = path.join(work, 'main.docx')
if (snapArg) fs.writeFileSync(ascii, fs.readFileSync(snapArg))
else fs.copyFileSync(docx, ascii)
const r = childRun(path.join(cl.scriptsDir, 'parse-docx.mjs'), [ascii], cl.clone, path.join(work, 'out.txt'), { DSH_GI_DIR: srcGi })
// 输入只读契约：不管子进程成功与否，先证明 data/gi 一个字节都没被动过
assertDirUnchanged(giDir, seedBefore, '输入目录 data/gi')
if (r.status !== 0) { console.error(r.stderr.slice(0, 600)); process.exit(1) }

const names = readJson(path.join(srcGi, '_order.json'))
let n = 0
for (const name of names) {
  if (only.length && !only.includes(name)) continue
  const doc = readJson(path.join(srcGi, `${name}.json`))
  const realFile = path.join(giDir, `${name}.json`)
  if (!fs.existsSync(realFile)) { console.log(`=== ${name} === 只在文档`); n++; continue }
  const real = readJson(realFile)
  const d = firstDiffs(doc, real, '', [], 8)
  if (!d.length) continue
  n++
  console.log(`=== ${name} ===`)
  for (const x of d) console.log('   ' + x)
}
console.log(`\n有深层差异的角色：${n} / ${names.length}`)
