/**
 * 每日自动回写：检测「数据比文档新」→ 把数据回写进主文档（docx）
 *
 *   node scripts/daily-docx-sync.mjs            # 正常跑（给计划任务用）
 *   node scripts/daily-docx-sync.mjs --dry      # 只报告，不写
 *   node scripts/daily-docx-sync.mjs --force    # 跳过"数据是否更新"的判断，强制走一次
 *
 * 判定顺序（**只在数据确实比文档新时才回写**，避免覆盖你在 Word 里的改动）：
 *   1. 取 `data/**` 最新 mtime 与主文档 mtime 比较
 *   2. 数据不比文档新 → 跳过并记日志（很可能你刚在 Word 里改过文档）
 *   3. 跑了 `diagnose-docx-json.mjs`：0 个不一致 → 跳过（文档已是最新）
 *   4. 有差异 → `build-docx.mjs --write-main`（该脚本自带 `.bak-<时间戳>` 备份与往返校验，
 *      校验不过会**拒绝写主文档**，所以这里不需要再兜一层）
 *   5. 每次结果追加到 `out/daily-docx-sync.log`
 *
 * 退出码：0 = 成功或按规则跳过；1 = 出错（计划任务里可据此排查）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const DRY = process.argv.includes('--dry')
const FORCE = process.argv.includes('--force')
const DOCX = process.env.CODEX_DOCX || 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'
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

if (!fs.existsSync(DOCX)) {
  log('× 找不到主文档：' + DOCX + '（可用环境变量 CODEX_DOCX 指定）')
  process.exit(1)
}

const dataMs = newestDataMtime()
const docxMs = fs.statSync(DOCX).mtimeMs
log(`数据最新改动：${fmt(dataMs)}（${path.relative(root, path.join(root, 'data'))}）`)
log(`主文档改动时间：${fmt(docxMs)}`)

if (!FORCE && dataMs <= docxMs) {
  log('按规则跳过：主文档不比数据旧（可能你刚在 Word 里改过文档；确认要回写时加 --force）')
  process.exit(0)
}

const diag = runNode([path.join('scripts', 'diagnose-docx-json.mjs')])
const m = diag.text.match(/不一致角色：\s*(\d+)\s*个/)
const diff = m ? Number(m[1]) : null
if (diff === null) {
  log('× 诊断脚本没有给出结果，输出片段：' + diag.text.slice(-400).replace(/\s+/g, ' '))
  process.exit(1)
}
log(`文档 ↔ 数据诊断：不一致角色 ${diff} 个`)

if (diff === 0) {
  log('按规则跳过：文档已经与数据一致，无需回写')
  process.exit(0)
}

if (DRY) {
  log(`--dry：本应回写（不一致 ${diff} 个角色）。真实运行会执行 build-docx --write-main（含自动备份）`)
  process.exit(0)
}

const build = runNode([path.join('scripts', 'build-docx.mjs'), '--write-main'])
const tail = build.text.trim().split('\n').slice(-6).map((l) => l.trim()).filter(Boolean).join(' ｜ ')
if (build.code !== 0) {
  log('× 回写失败（主文档未被改动，原文件与备份都在）：' + tail)
  process.exit(1)
}
log(`✅ 回写完成（不一致 ${diff} 个角色）：${tail}`)
process.exit(0)
