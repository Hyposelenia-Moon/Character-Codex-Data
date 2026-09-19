/**
 * 两份「显示级归一」副本的同步校验
 *
 * 同一份规则要在两个仓库各留一份（运行期插件不能依赖未被 pull 的攻略仓库）：
 *   scripts/lib/guide-display.mjs            ← 数据仓库（规范副本 / 网页版用）
 *   <ATLAS_PLUGIN>/model/codexIndex/display.js ← 插件仓库（面板用）
 *
 * 两份必须**逐字节相同**，否则网页版与面板的措辞会漂移。改完规范副本后跑：
 *   node scripts/check-display-sync.mjs            # 校验
 *   node scripts/check-display-sync.mjs --write    # 把规范副本同步到插件
 *
 * 用法：DSH_PLUGIN_DIR 可指定插件仓库路径（默认 D:\文件\游戏\原神\Atlas-Plugin）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SRC = path.join(root, 'scripts', 'lib', 'guide-display.mjs')
const PLUGIN = process.env.DSH_PLUGIN_DIR ?? 'D:\\文件\\游戏\\原神\\Atlas-Plugin'
const DST = path.join(PLUGIN, 'model', 'codexIndex', 'display.js')

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

if (!fs.existsSync(SRC)) {
  console.error(`❌ 找不到规范副本：${SRC}`)
  process.exit(1)
}
if (!fs.existsSync(DST)) {
  console.error(`❌ 找不到插件副本：${DST}（可用 DSH_PLUGIN_DIR 指定插件仓库）`)
  process.exit(1)
}

const write = process.argv.includes('--write')
const a = sha(SRC)
const b = sha(DST)
if (write) {
  fs.copyFileSync(SRC, DST)
  console.log(`已同步：${SRC} → ${DST}`)
  console.log(`sha256 ${sha(DST)}`)
  process.exit(0)
}

const bytes = f => fs.statSync(f).size
if (a === b) {
  console.log('✅ 两份显示级归一逐字节一致')
  console.log(`   ${SRC}  ${bytes(SRC)} 字节  sha256 ${a.slice(0, 16)}…`)
  console.log(`   ${DST}  ${bytes(DST)} 字节`)
} else {
  console.log('❌ 两份显示级归一不一致（网页版与面板会出现措辞漂移）')
  console.log(`   ${SRC}  ${bytes(SRC)} 字节  sha256 ${a.slice(0, 16)}…`)
  console.log(`   ${DST}  ${bytes(DST)} 字节  sha256 ${b.slice(0, 16)}…`)
  console.log('   修复：node scripts/check-display-sync.mjs --write')
  process.exitCode = 1
}
