/**
 * 文档层一次性数据修正：
 *   1. 「冰主」→「旅行者·冰」（俗称 → 标准名，全库逐处计数）
 *   2. 套装组合符归一：`＆` / `＋` → `+`（在文档里就写成拆分符，回推文本不再出现 `＆`）
 *
 * 只重写 word/document.xml 这一个部件，其余部件逐字节复制。
 * 附带：首次运行时把原文档备份到 <doc>.bak-before-rename，便于回滚。
 *
 * 注意 Word 会把一行拆进多个 `<w:r>/<w:t>`，所以符号修正按**单字符**替换，
 * 不按整行字符串替换（整行替换会命中 0 处）。当前仓库里 `＆` 只出现 1 次（烟绯的套装行）。
 *
 * 用法：node scripts/fix-docx-names.mjs [docx路径] [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readDocx, writeDocx } from './lib/docx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

/** 名字修正表：文档文本 → 标准名（old 必须是标准名白名单外的俗称） */
const RENAMES = [
  ['冰主', '旅行者·冰']
]

/**
 * 符号修正表：单字符 → 替换串。
 * 替换串刻意带空格（` + `），让文档写法与衍生的 sections 文本一致；多余空格由 parse-docx 归一。
 */
const SYMBOL_FIXES = [
  ['＆', ' + '], // 全角 and（Word 的中文输入法会打出这个）
  ['＋', ' + '] // 全角 plus
]

/** 需要保留首尾空格的 run（替换串以空格结尾时，<w:t> 必须带 xml:space="preserve"，否则 Word 会吃掉空格） */
const SPACE_PRESERVE_FIXES = [
  { find: '<w:t>礼 + </w:t>', replace: '<w:t xml:space="preserve">礼 + </w:t>' }
]

/**
 * 删除表：把写不通的组合名整段删掉（连它前面的一个连接符一起删，删完不留 ` / / ` 或行尾悬挂符）。
 * 早柚「圣遗物推荐」的 `少女角斗士追忆乐团2+2` 就是这种情况（用户决定先删，后续手工补真实搭配）。
 */
const REMOVALS = [
  '+ 少女角斗士追忆乐团（2件套）',
  // 早柚首选行末尾的孤儿 `[[a:2]]`（`少女角斗士追忆乐团2+2` 拆出来的件数碎片，取不到图标）
  ' + [[a:2]]',
  // 面板括注（用户拍板扩大范围删掉；解析层 isCostNote 同步）
  '水元素伤害加成（二命）',
  '生命值（二命）'
]

/**
 * 括注删除表：配队成员上的**命座与成本类**括注（用户决定先删，后续手工补）。
 *
 * 用「名称 + 括注」定位，只删点名的几处：
 *   - 武器精炼 `（精5）/（精五）/（叠满）`、皇冠 `（必须/建议/可选/满命）`、
 *     面板 `%（随命座）`、主词条 `（特殊）/（华馆）` 一律不许动；
 *   - 面板里的两处（`水元素伤害加成（二命）` `生命值（二命）`）已在 REMOVALS 里按整串删，不走通配。
 */
const NOTE_REMOVALS = [
  '纳西妲（二命）',
  '纳西妲（2命）',
  '妮露（高金）',
  '希诺宁（二命）'
]

/** 删完括注可能留下多余空格（尤其删的是跨 run 的一半），收一下 */
function collapseDoubledSpaces (xml) {
  return String(xml).replace(/ {2,}/g, ' ')
}

/** 不按整行替换（Word 会把一行拆进多个 run），这里只动含目标符号的 `<w:t>` 文本 */
function applySymbolFixes (xml) {
  let n = 0
  let out = String(xml)
  for (const [from, to] of SYMBOL_FIXES) {
    if (!out.includes(from)) continue
    n += out.split(from).length - 1
    out = out.split(from).join(to)
  }
  for (const { find, replace } of SPACE_PRESERVE_FIXES) {
    if (!out.includes(find)) continue
    out = out.replace(find, replace)
  }
  return { xml: out, count: n }
}

/**
 * 应用删除表。命中数必须是 1（多了说明文档变了，宁可报错也不乱删）。
 * @returns {{xml: string, counts: Record<string, number>}}
 */
function applyRemovals (xml) {
  let out = String(xml)
  const counts = {}
  for (const needle of REMOVALS) {
    const n = out.split(needle).length - 1
    counts[needle] = n
    if (n > 1) throw new Error(`删除目标命中 ${n} 处（应为 0 或 1）：${needle}`)
    if (n === 1) out = out.split(needle).join('')
  }
  // 命座/成本括注：文档里全删（不限行型），删完把多余空格收掉
  let noteCount = 0
  for (const needle of NOTE_REMOVALS) {
    const n = out.split(needle).length - 1
    counts[`括注「${needle}」`] = n
    noteCount += n
    if (n) out = out.split(needle).join('')
  }
  if (noteCount) out = collapseDoubledSpaces(out)
  return { xml: out, counts }
}

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const doc = args.find(a => !a.startsWith('--')) ?? DEFAULT_DOC

const src = readDocx(doc)
console.log(`文档：${doc}`)
console.log(`部件：${src.entries.size} 个，段落 ${src.paragraphs.length} 行`)

const counts = {}
let next = src.xml
for (const [from, to] of RENAMES) {
  const n = next.split(from).length - 1
  counts[`${from} → ${to}`] = n
  if (!n) continue
  const paras = src.paragraphs.map((p, i) => [i, p]).filter(([, p]) => p.includes(from))
  console.log(`  · ${from} → ${to}：${n} 处，涉及 ${paras.length} 行`)
  for (const [i, p] of paras) console.log(`      段落 #${i}：${p}`)
  next = next.split(from).join(to)
}
for (const [from, to] of SYMBOL_FIXES) {
  const n = next.split(from).length - 1
  counts[`${from} → ${to.trim()}`] = n
  if (!n) continue
  const paras = src.paragraphs.map((p, i) => [i, p]).filter(([, p]) => p.includes(from))
  console.log(`  · 符号 ${from} → ${to.trim()}：${n} 处，涉及 ${paras.length} 行`)
  for (const [i, p] of paras) console.log(`      段落 #${i}：${p}`)
}

// 删除表：命中数进 counts（0 表示已删过，幂等），>1 直接抛错
const rem = applyRemovals(next)
next = rem.xml
for (const [needle, n] of Object.entries(rem.counts)) {
  counts[`删除「${needle}」`] = n
  if (!n) continue
  const paras = src.paragraphs.map((p, i) => [i, p]).filter(([, p]) => p.includes(needle.replace(/^\+\s*/, '')))
  console.log(`  · 删除「${needle.trim()}」：${n} 处，涉及 ${paras.length} 行`)
  for (const [i, p] of paras) console.log(`      段落 #${i}：${p}`)
}

if (Object.values(counts).every(n => n === 0)) {
  console.log('没有需要修正的内容（0 处）')
  process.exit(0)
}
if (dry) {
  console.log('--dry：未写文件。统计：', JSON.stringify(counts, null, 2))
  process.exit(0)
}

const sym = applySymbolFixes(next)
next = sym.xml

/* ---------------------------------------------------------------- 写回（带 compare-and-swap 保护）
 * 同一个仓库/文档可能有别的任务在同时改，所以：
 *   1. 写之前重新读一次文件，比对 sha 与刚才那次读是否一致（不一致就中止，避免覆盖别人的改动）；
 *   2. 只替换 word/document.xml，其余部件逐字节复制；
 *   3. 写完后复验：其它部件哈希一致、段落数不变。
 */
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const bufBefore = fs.readFileSync(doc)
const fresh = readDocx(doc)
if (sha256(bufBefore) !== sha256(fs.readFileSync(doc))) {
  console.error('中止：文档在读取与写回之间被其它进程改动，请稍后重跑')
  process.exit(2)
}
if (fresh.xml !== src.xml) {
  console.error('中止：文档内容已变化（xml 与规划时不一致），请稍后重跑')
  process.exit(2)
}

const bak = doc + '.bak-before-rename'
if (!fs.existsSync(bak)) {
  fs.copyFileSync(doc, bak)
  console.log(`已备份原文档 → ${bak}`)
} else {
  console.log(`备份已存在，未覆盖：${bak}`)
}

const sha = sha256
const entries = new Map()
for (const [name, buf] of src.entries) {
  entries.set(name, name === 'word/document.xml' ? Buffer.from(next, 'utf8') : buf)
}
const w = writeDocx(entries, doc)

// 复验：除 document.xml 外逐字节一致；段落文本应已更新
const rt = readDocx(doc)
const changed = []
for (const [name, buf] of src.entries) {
  if (name === 'word/document.xml') continue
  if (sha(buf) !== sha(rt.entries.get(name))) changed.push(name)
}
const leftNames = rt.paragraphs.filter(p => RENAMES.some(([from]) => p.includes(from)))
const leftSyms = rt.paragraphs.filter(p => SYMBOL_FIXES.some(([from]) => p.includes(from)))
console.log(`已写回 ${doc}（${w.count} 个部件，${w.bytes} 字节）`)
console.log(`其它部件：${changed.length ? '有改动！' + changed.join(',') : '与源逐字节一致'}`)
console.log(`段落数：${rt.paragraphs.length}（源 ${src.paragraphs.length}）`)
console.log(`残留旧名行：${leftNames.length}${leftNames.length ? '：' + leftNames.join(' ｜ ') : ''}`)
console.log(`残留旧符号行：${leftSyms.length}${leftSyms.length ? '：' + leftSyms.join(' ｜ ') : ''}`)
