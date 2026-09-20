/**
 * 文档层数据修正（本批次）：**只动主词条行 / 副词条行 / 指定圣遗物档位行**。
 *
 * 用户定稿的四条：
 *   1. 主词条**不写「百分比」**（主词条默认就是百分比）：`攻击力百分比` → `攻击力`。
 *   2. 副词条**固定值写成小前缀**：`攻击力`/`生命值`/`防御力` → `小攻击`/`小生命`/`小防御`
 *      （百分比那侧早已是 `大攻击`/`大生命`/`大防御`，两边对称）。
 *   3. 副词条里**暴击率与暴击伤害是同级**：`暴击率 > 暴击伤害` → `暴击率 / 暴击伤害`
 *      （`/` = 同级 → 渲染成 `=`；其余档位仍是 `>` → `＞`）。
 *   4. 圣遗物行**不显示件数**、2+2 用**属性词简写**（见 LINE_REWRITES）。
 *
 * 硬约束：
 *   · 只改上面这三类行；武器 / 天赋 / 面板 / 命座 / 配队 / 备注行一律不动；
 *   · 符号语义不动（`/` 同级、`>` 优先级、`｜` 部位并列、`≥` 原样、括注一并不动）；
 *   · 幂等：跑第二遍命中 0 处。
 *
 * 安全措施（与 fix-docx-substats.mjs 同一套）：
 *   · 只重写 `word/document.xml`，其余部件**逐字节**复制；
 *   · 写前 compare-and-swap（重读比对 sha256 与 xml）；
 *   · 改前备份 `<doc>.bak-YYYYMMDD-HHmmss`；
 *   · 写后复验：其它部件哈希一致、段落数不变、旧写法已清零、主词条/副词条外的行未被改动。
 *
 * 跨 run 安全：Word 会把一行拆进多个 `<w:r>/<w:t>`，所以按**段落**处理
 * （取出该段所有 `<w:t>` 拼成整行 → 替换 → 结果写回第一个 `<w:t>`，其余置空），run 属性一律不动。
 *
 * 用法：node scripts/fix-docx-stats.mjs [docx路径] [--dry]
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { readDocx, writeDocx, escapeXml, unescapeXml } from './lib/docx.mjs'

const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

/** 与 parse-docx 同一套分隔符（保留分隔符本身，逐档处理） */
const ITEM_SEP_RE = /\s*(?:[>＞]|≥|[/／｜]|[=＝]|[，,、])\s*/g

/** 主词条行：去掉「百分比」（主词条默认就是百分比） */
export const MAIN_PERCENT_TOKENS = [
  ['攻击力百分比', '攻击力'],
  ['生命值百分比', '生命值'],
  ['防御力百分比', '防御力'],
  ['百分比攻击力', '攻击力'],
  ['百分比生命值', '生命值'],
  ['百分比防御力', '防御力']
]

/** 副词条行：固定值 → 小前缀（百分比那侧已是 `大X`，不动） */
export const SUB_FLAT_TOKENS = {
  攻击力: '小攻击',
  生命值: '小生命',
  防御力: '小防御'
}

/** 副词条行：旧写法 → 大前缀（幂等兜底；批次 E 已跑过） */
export const SUB_PERCENT_TOKENS = {
  攻击力百分比: '大攻击',
  百分比攻击力: '大攻击',
  生命值百分比: '大生命',
  百分比生命值: '大生命',
  防御力百分比: '大防御',
  百分比防御力: '大防御'
}

/** 同级对：`暴击率 > 暴击伤害` → `暴击率 / 暴击伤害`（`/` = 同级 → 渲染 `=`） */
const CRIT_PAIRS = [['暴击率', '暴击伤害'], ['暴击伤害', '暴击率']]

/** 圣遗物档位行：逐字重写（件数去掉 + 2+2 用属性词简写 / 保留真名） */
export const LINE_REWRITES = [
  ['首选：翠绿之影 / 角斗士的终幕礼（2件套）', '首选：翠绿之影 / 2攻击'],
  ['首选：昔日宗室之仪 / 千岩牢固（2件套） + 绝缘之旗印（2件套） + 角斗士的终幕礼',
    '首选：昔日宗室之仪 / 2生命 + 2充能 + 角斗士的终幕礼']
]

const MAIN_PREFIX = /^(主词条|时之沙)\s*[:：]/
const SUB_PREFIX = /^副词条\s*[:：]/

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const decode = s => unescapeXml(String(s))

/** 按分隔符切成 {text, sep}（与 parse-docx 的 splitStatsFull 同一套） */
function splitKeepSeps (text) {
  const out = []
  const re = new RegExp(ITEM_SEP_RE.source, 'g')
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(last, m.index).trim(), sep: m[0] })
    last = m.index + m[0].length
  }
  out.push({ text: text.slice(last).trim(), sep: '' })
  return out.filter(x => x.text || x.sep)
}

/**
 * 副词条行归一：先修旧百分比写法、再把固定值改小前缀、最后把暴击率/暴击伤害之间改成 `/`。
 * @param {string} body `副词条：` 之后的部分
 * @returns {string}
 */
function normalizeSubBody (body) {
  const parts = splitKeepSeps(body)
  // ① 词条本身：百分比旧写法 → 大X；固定值 → 小X
  const tokens = parts.map(p => {
    const t = p.text
    if (SUB_PERCENT_TOKENS[t]) return { ...p, text: SUB_PERCENT_TOKENS[t] }
    if (SUB_FLAT_TOKENS[t]) return { ...p, text: SUB_FLAT_TOKENS[t] }
    return p
  })
  // ② 同级对：暴击率 / 暴击伤害 之间用 `/`（`>` 表示优先级，会把"同级"说成"优先级"）
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!tokens[i].sep || !/[>＞]/.test(tokens[i].sep)) continue
    const a = tokens[i].text
    const b = tokens[i + 1].text
    if (CRIT_PAIRS.some(([x, y]) => a === x && b === y)) tokens[i] = { ...tokens[i], sep: ' / ' }
  }
  // ③ 拼回（保留每档原有分隔符）
  return tokens.map(p => p.text + p.sep).join('').replace(/\s+$/, '')
}

/** 主词条行归一：只把「百分比」写法去掉 */
function normalizeMainLine (line) {
  let out = line
  for (const [from, to] of MAIN_PERCENT_TOKENS) out = out.split(from).join(to)
  return out
}

/** 一行段落文本 → 新文本（不认识的行走原样） */
function rewriteLine (text) {
  const hit = LINE_REWRITES.find(([from]) => text === from)
  if (hit) return hit[1]
  if (MAIN_PREFIX.test(text)) {
    const idx = text.search(/[:：]/)
    return text.slice(0, idx + 1) + normalizeMainLine(text.slice(idx + 1))
  }
  if (SUB_PREFIX.test(text)) {
    const idx = text.search(/[:：]/)
    return text.slice(0, idx + 1) + normalizeSubBody(text.slice(idx + 1))
  }
  return text
}

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const doc = args.find(a => !a.startsWith('--')) ?? DEFAULT_DOC
if (!fs.existsSync(doc)) { console.error(`找不到文档：${doc}`); process.exit(1) }

const bufBefore = fs.readFileSync(doc)
const src = readDocx(doc)
console.log(`文档：${doc}`)
console.log(`部件：${src.entries.size} 个，段落 ${src.paragraphs.length} 行，document.xml ${Buffer.byteLength(src.xml)} 字节`)

/* ---- 规划：逐段落改写 ---- */
const plan = []
let xml = src.xml
let replacedParas = 0
xml = xml.replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (chunk) => {
  if (chunk.endsWith('/>')) return chunk
  const ts = [...chunk.matchAll(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g)]
  if (!ts.length) return chunk
  const joined = ts.map(m => decode(m[2])).join('')
  const next = rewriteLine(joined)
  if (next === joined) return chunk
  replacedParas++
  plan.push({ from: joined, to: next })
  let first = true
  let out = chunk
  for (let i = ts.length - 1; i >= 0; i--) {
    const m = ts[i]
    const inner = first && i === ts.length - 1 ? escapeXml(next) : ''
    first = false
    out = out.slice(0, m.index) + m[1] + inner + m[3] + out.slice(m.index + m[0].length)
  }
  return out
})

console.log(`\n命中并改写 ${replacedParas} 段`)
console.log('\n逐条（原文 → 现在）：')
plan.forEach((p, i) => { console.log(`  [${i + 1}] ${p.from}`); console.log(`      → ${p.to}`) })

/* ---- 复验预检：不该动的行先记下来 ---- */
const untouchedProbe = src.paragraphs.filter(p => /^(武器|第一档|第二档|第三档|优先级|皇冠|注|[0-9]\.|配队|天赋)/.test(p))
console.log(`\n无关行（武器 / 档位 / 天赋 / 标题 / 备注…）${untouchedProbe.length} 行 —— 计划未触碰；写后逐字比对`)

if (!replacedParas) { console.log('\n没有需要修正的内容（0 处，幂等）'); process.exit(0) }
if (dry) { console.log('\n--dry：未写文件'); process.exit(0) }

/* ---- 写回：CAS + 备份 + 只换 document.xml ---- */
if (sha256(bufBefore) !== sha256(fs.readFileSync(doc))) {
  console.error('中止：文档在读取与写回之间被其它进程改动（sha256 不一致），请稍后重跑')
  process.exit(2)
}
const re = readDocx(doc)
if (re.xml !== src.xml) {
  console.error('中止：文档内容已变化（xml 与规划时不一致），请稍后重跑')
  process.exit(2)
}
const stamp = (() => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` })()
const bak = `${doc}.bak-${stamp}`
fs.copyFileSync(doc, bak)
console.log(`\n已备份 → ${bak}（${fs.statSync(bak).size} 字节）`)

const entries = new Map()
for (const [name, buf] of src.entries) entries.set(name, name === 'word/document.xml' ? Buffer.from(xml, 'utf8') : buf)
const w = writeDocx(entries, doc)

/* ---- 写后复验 ---- */
const rt = readDocx(doc)
const changedParts = []
for (const [name, buf] of src.entries) {
  if (name === 'word/document.xml') continue
  if (sha256(buf) !== sha256(rt.entries.get(name))) changedParts.push(name)
}
const leftPercent = rt.paragraphs.filter(p => MAIN_PREFIX.test(p) && MAIN_PERCENT_TOKENS.some(([f]) => p.includes(f)))
const leftPieces = rt.paragraphs.filter(p => /件套/.test(p))
const leftCrit = rt.paragraphs.filter(p => SUB_PREFIX.test(p) && CRIT_PAIRS.some(([x, y]) => new RegExp(x + '\\s*[>＞]\\s*' + y).test(p)))
const after = rt.paragraphs.filter(p => untouchedProbe.includes(p))
const sameProbe = after.length === untouchedProbe.length
console.log(`\n已写回 ${doc}（${w.count} 个部件，${w.bytes} 字节）`)
console.log(`  document.xml：${Buffer.byteLength(src.xml)} → ${Buffer.byteLength(rt.xml)} 字节`)
console.log(`  其它部件：${changedParts.length ? '有改动！' + changedParts.join(', ') : '与源逐字节一致 ✅'}`)
console.log(`  段落数：${rt.paragraphs.length}（源 ${src.paragraphs.length}）${rt.paragraphs.length === src.paragraphs.length ? ' ✅' : ' ❌'}`)
console.log(`  主词条残留「百分比」：${leftPercent.length} ${leftPercent.length ? '❌ ' + leftPercent.slice(0, 2).join(' ｜ ') : '✅'}`)
console.log(`  残留「件套」：${leftPieces.length} ${leftPieces.length ? '❌ ' + leftPieces.slice(0, 2).join(' ｜ ') : '✅'}`)
console.log(`  副词条里暴击率/暴击伤害仍是 > ：${leftCrit.length} ${leftCrit.length ? '❌ ' + leftCrit.slice(0, 2).join(' ｜ ') : '✅'}`)
console.log(`  无关行逐字未变：${sameProbe ? '✅' : '❌'}`)
console.log(`  幂等预检（再跑一遍应为 0 处）：${rt.paragraphs.filter(p => rewriteLine(p) !== p).length} 处`)
if (changedParts.length || rt.paragraphs.length !== src.paragraphs.length || leftPercent.length || leftPieces.length || leftCrit.length || !sameProbe) {
  console.error(`\n复验未通过 —— 回滚：copy /Y "${bak}" "${doc}"`)
  process.exit(3)
}
console.log('\n✅ 复验通过')
