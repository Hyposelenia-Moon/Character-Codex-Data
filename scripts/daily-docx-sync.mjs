/**
 * 每日自动回写：检测「数据比文档新」→ 把数据回写进主文档（docx）→ 重建派生文件
 *
 *   node scripts/daily-docx-sync.mjs            # 正常跑（给计划任务用）
 *   node scripts/daily-docx-sync.mjs --dry      # 只报告，不写
 *   node scripts/daily-docx-sync.mjs --force    # 跳过"数据是否更新"的判断，强制走一次
 *
 * 判定顺序（**只在数据确实比文档新时才回写**，避免覆盖你在 Word 里的改动）：
 *   1. 取 `data/**` 最新 mtime 与主文档 mtime 比较
 *   2. 数据不比文档新 → 跳过回写并记日志（很可能你刚在 Word 里改过文档）
 *   3. 跑了 `diagnose-docx-json.mjs <主文档>`：读它的结构化结论行 `诊断结论：{…}`，
 *      `ok=true` → 跳过回写（文档已是最新）；`ok=false`（含"只在文档 / 只在 JSON"这类集合差）
 *      → 走回写分支。拿不到结构化行则报错退出，不再靠中文正则猜计数
 *   4. `ok=false` → `build-docx.mjs --write-main`（该脚本自带 `.bak-<时间戳>` 备份与往返校验，
 *      校验不过会**拒绝写主文档**，所以这里不需要再兜一层）
 *   5. 重建派生文件：`build-index.mjs`（data/_index.json）→ `build-html.mjs`（guide.html）
 *      → `build-doc.mjs`（guide.md）
 *   6. 每次结果追加到 `out/daily-docx-sync.log`
 *
 * 第 5 步**每次真跑都执行**（不在回写分支里）：派生文件只依赖数据，重建是幂等的几秒操作，
 * 这样才能覆盖「在 Word 里加了角色 → parse-docx 更新数据 → 文档与数据本来就一致」
 * 这条路径 —— 否则网页版会一直落后于数据。
 *
 * 退出码：0 = 成功或按规则跳过；1 = 出错（计划任务里可据此排查）
 *
 * 主文档路径：统一由 `scripts/lib/main-doc.mjs` 提供（`CODEX_DOCX` 优先），
 * 诊断 / 构建 / 备份 / 标记版全部同源 —— 以前这个脚本自己读 `CODEX_DOCX` 只用来比 mtime，
 * 诊断脚本却去看硬编码的 D 盘文件，会出现「比 A 的时间、诊断 B、回写 C」的错位（审核 P2-9）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MAIN_DOC } from './lib/main-doc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const DRY = process.argv.includes('--dry')
const FORCE = process.argv.includes('--force')
/** 主文档（`CODEX_DOCX` 已由 main-doc.mjs 消化） */
const DOCX = MAIN_DOC
const LOG = path.join(root, 'out', 'daily-docx-sync.log')

/** 追加一行日志（同时打到 stdout，计划任务里可在"上次运行结果"之外留痕） */
function log (line) {
  const text = `[${new Date().toISOString()}] ${line}`
  console.log(text)
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, text + '\n', 'utf8')
  } catch (e) {
    console.error('写日志失败：' + e.message)
  }
}

/** 跑一个 node 脚本，返回 { code, text } */
function runNode (args) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { code: r.status === null ? -1 : r.status, text }
}

/** 输出末几行压成一行，写日志用 */
const tailOf = (text, lines = 4) => text.trim().split('\n').slice(-lines).map(l => l.trim()).filter(Boolean).join(' ｜ ')

/**
 * 重建三份派生文件：索引 → 网页版 → 文档版。
 * 只依赖 `data/`，幂等；任一步失败就记日志并以非 0 退出。
 * @returns {boolean} 全部成功
 */
function rebuildDerived () {
  const steps = [
    ['索引 data/_index.json', path.join('scripts', 'build-index.mjs')],
    ['网页版 guide.html', path.join('scripts', 'build-html.mjs')],
    ['文档版 guide.md', path.join('scripts', 'build-doc.mjs')]
  ]
  for (const [label, script] of steps) {
    const r = runNode([script])
    if (r.code !== 0) {
      log(`× 重建${label}失败：${tailOf(r.text, 6)}`)
      return false
    }
    log(`　重建${label}完成：${tailOf(r.text)}`)
  }
  return true
}

/** data 目录里最新的一次改动时间（毫秒） */
function newestDataMtime () {
  let newest = 0
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'images' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.json')) newest = Math.max(newest, fs.statSync(p).mtimeMs)
    }
  }
  walk(path.join(root, 'data'))
  return newest
}

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '（无）')

log('=== 每日回写检查开始 ' + (DRY ? '（--dry 只报告）' : '') + (FORCE ? '（--force 强制）' : '') + ' ===')

// 护栏（审核 P2-9）：本脚本认定的主文档必须与 lib/main-doc.mjs 的 MAIN_DOC 是同一个文件。
// 这条断言防的就是「5 处各自硬编码 → 比 A 的 mtime、诊断 B、回写 C」那种日志上看不出来的错位。
if (path.resolve(DOCX) !== path.resolve(MAIN_DOC)) {
  log('× 主文档路径不一致：' + DOCX + ' ≠ ' + MAIN_DOC + '（两者应同源于 scripts/lib/main-doc.mjs）')
  process.exit(1)
}

if (!fs.existsSync(DOCX)) {
  log('× 找不到主文档：' + DOCX + '（可用环境变量 CODEX_DOCX 指定）')
  process.exit(1)
}

const dataMs = newestDataMtime()
const docxMs = fs.statSync(DOCX).mtimeMs
log(`数据最新改动：${fmt(dataMs)}（${path.relative(root, path.join(root, 'data'))}）`)
log(`主文档改动时间：${fmt(docxMs)}`)

let wrote = false
if (!FORCE && dataMs <= docxMs) {
  log('按规则跳过回写：主文档不比数据旧（可能你刚在 Word 里改过文档；确认要回写时加 --force）')
} else {
  // 必须把主文档路径显式传给诊断脚本：以前只比 DOCX 的 mtime，却让诊断去看它自己硬编码的
  // D 盘文件 —— CODEX_DOCX 一改就是「比 A 的时间、诊断 B、回写 C」（审核 P2-9）。
  const diag = runNode([path.join('scripts', 'diagnose-docx-json.mjs'), DOCX])
  // 消费诊断脚本的机器可读结论行（全角冒号 + 单行 JSON）：
  // `诊断结论：{"ok":false,"fields":1,"onlyDoc":["X"],"onlyJson":[],"order":true}`
  // `ok = fields===0 && onlyDoc.length===0 && onlyJson.length===0 && order===true`
  const matched = diag.text.match(/^诊断结论：(\{.*\})$/m)
  let r = null
  if (matched) {
    try { r = JSON.parse(matched[1]) } catch { r = null }
  }
  if (!r) {
    // 拿不到结构化结论就宁可报错退出：以前退回中文正则"猜"计数，集合差（只在文档 / 只在 JSON）
    // 会让不一致计数为 0 而错误地跳过回写（审核 P2-10）
    log('× 诊断脚本没有给出结构化结论（找不到「诊断结论：{…}」行），输出片段：' + diag.text.slice(-400).replace(/\s+/g, ' '))
    process.exit(1)
  }
  log(`文档 ↔ 数据诊断：内容不一致 ${r.fields} 个；只在文档：${(r.onlyDoc ?? []).join('、') || '无'}；只在 JSON：${(r.onlyJson ?? []).join('、') || '无'}；顺序${r.order ? '一致' : '不一致'}`)

  if (r.ok) {
    log('按规则跳过回写：文档已经与数据一致')
  } else if (DRY) {
    log(`--dry：本应回写（内容不一致 ${r.fields} 个）。真实运行会执行 build-docx --write-main（含自动备份）`)
  } else {
    // 不加 --out：build-docx 里 writeMain 会把 out 设成 DEFAULT_DOC，而它现在就是 MAIN_DOC，
    // 显式给 --out 反而可能让「判定主文档」与「实际写入」分叉
    const build = runNode([path.join('scripts', 'build-docx.mjs'), '--write-main'])
    if (build.code !== 0) {
      log('× 回写失败（主文档未被改动，原文件与备份都在）：' + tailOf(build.text, 6))
      process.exit(1)
    }
    log(`✅ 回写完成（内容不一致 ${r.fields} 个）：${tailOf(build.text, 6)}`)
    wrote = true
  }
}

if (DRY) {
  log('--dry：跳过重建派生文件（索引 / 网页版 / 文档版）')
  process.exit(0)
}

log('重建派生文件：索引 → 网页版 → 文档版')
if (!rebuildDerived()) process.exit(1)
log(`✅ 完成：${wrote ? '已回写主文档，' : '主文档未改动，'}派生文件已重建`)
process.exit(0)
