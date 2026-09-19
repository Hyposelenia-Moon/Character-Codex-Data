/**
 * 文档层一次性数据修正（批次 E）：**只动副词条**，把百分比写法统一成简写。
 *
 *   `生命值百分比` / `百分比生命值` / `大生命` → `大生命`
 *   `攻击力百分比` / `百分比攻击力` / `大攻击` → `大攻击`
 *   `防御力百分比` / `百分比防御力` / `大防御` → `大防御`
 *
 * 硬约束（用户裁定）：
 *   1. **只改 `副词条：` 开头的行**。主词条（`时之沙：…｜空之杯：…｜理之冠：…`）里的
 *      `攻击力百分比` **绝对不动** —— 主词条用固定词表。
 *   2. 武器 / 圣遗物档位 / 配队 / 面板 / 命座里的文本一律不动（面板里的 `生命值40000+`
 *      是固定值不是百分比，也不动）。
 *   3. 符号语义不动：`/` 同级、`>` 优先级、`｜` 部位并列、`（…）` 括注一并不动。
 *
 * 安全措施（与 fix-docx-dup-sets.mjs 同一套）：
 *   · 只重写 `word/document.xml`，其余部件**逐字节**复制；
 *   · 写前 compare-and-swap（重读比对 sha256 与 xml）；
 *   · 改前备份 `<doc>.bak-YYYYMMDD-HHmmss`；
 *   · 写后复验：其它部件哈希一致、段落数不变、副词条行已无旧写法、主词条行未被改动。
 *
 * 跨 run 安全：Word 会把一行拆进多个 `<w:r>/<w:t>`，所以按**段落**处理
 * （取出该段所有 `<w:t>` 拼成整行 → 替换 token → 结果写回第一个 `<w:t>`，其余置空），
 * run 属性一律不动。
 *
 * 用法：node scripts/fix-docx-substats.mjs [docx路径] [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readDocx, writeDocx, escapeXml, unescapeXml } from './lib/docx.mjs'

const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

/** token → 目标简写（**顺序即应用顺序**，长词在前，避免叠加） */
export const SUB_STAT_TOKENS = [
  ['生命值百分比', '大生命'],
  ['百分比生命值', '大生命'],
  ['攻击力百分比', '大攻击'],
  ['百分比攻击力', '大攻击'],
  ['防御力百分比', '大防御'],
  ['百分比防御力', '大防御']
]

/** 只处理「副词条」开头的行；主词条等一律跳过 */
const SUB_PREFIX = /^副词条\s*[:：]/

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const decode = s => unescapeXml(String(s))

/** 对一行副词条文本应用 token 替换，返回 { text, hits } */
function normalizeSubLine (text) {
  let out = text
  const hits = {}
  for (const [from, to] of SUB_STAT_TOKENS) {
    if (!out.includes(from)) continue
    const n = out.split(from).length - 1
    hits[from] = (hits[from] || 0) + n
    out = out.split(from).join(to)
  }
  return { text: out, hits }
}

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const doc = args.find(a => !a.startsWith('--')) ?? DEFAULT_DOC
if (!fs.existsSync(doc)) { console.error(`找不到文档：${doc}`); process.exit(1) }

const bufBefore = fs.readFileSync(doc)
const src = readDocx(doc)
console.log(`文档：${doc}`)
console.log(`部件：${src.entries.size} 个，段落 ${src.paragraphs.length} 行，document.xml ${Buffer.byteLength(src.xml)} 字节`)

/* ---- 规划：逐段落找「副词条：」行，做 token 替换 ---- */
const plan = []
let xml = src.xml
let replacedParas = 0
const totalHits = {}
xml = xml.replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (chunk) => {
  if (chunk.endsWith('/>')) return chunk
  const ts = [...chunk.matchAll(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g)]
  if (!ts.length) return chunk
  const joined = ts.map(m => decode(m[2])).join('')
  if (!SUB_PREFIX.test(joined)) return chunk          // ← 只动副词条行
  const { text: next, hits } = normalizeSubLine(joined)
  if (next === joined) return chunk
  replacedParas++
  for (const [k, v] of Object.entries(hits)) totalHits[k] = (totalHits[k] || 0) + v
  plan.push({ from: joined, to: next })
  // 新文本写回该段第一个 <w:t>，其余 <w:t> 置空（run 属性不动）
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

console.log(`\n命中「副词条：」行 ${replacedParas} 段；token 替换次数：${JSON.stringify(totalHits)}`)
console.log('\n逐条（原文 → 现在）：')
plan.forEach((p, i) => { console.log(`  [${i + 1}] ${p.from}`); console.log(`      → ${p.to}`) })

/* ---- 复验预检：主词条行不得被改动 ---- */
const mainBefore = src.paragraphs.filter(p => /^(主词条|时之沙)/.test(p))
console.log(`\n主词条相关段落（源）${mainBefore.length} 行 —— 计划未触碰；写后复验会逐字比对`)

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
const leftSub = rt.paragraphs.filter(p => SUB_PREFIX.test(p) && SUB_STAT_TOKENS.some(([f]) => p.includes(f)))
const mainAfter = rt.paragraphs.filter(p => /^(主词条|时之沙)/.test(p))
const mainSame = mainBefore.length === mainAfter.length && mainBefore.every((p, i) => p === mainAfter[i])
console.log(`\n已写回 ${doc}（${w.count} 个部件，${w.bytes} 字节）`)
console.log(`  document.xml：${Buffer.byteLength(src.xml)} → ${Buffer.byteLength(rt.xml)} 字节`)
console.log(`  其它部件：${changedParts.length ? '有改动！' + changedParts.join(', ') : '与源逐字节一致 ✅'}`)
console.log(`  段落数：${rt.paragraphs.length}（源 ${src.paragraphs.length}）${rt.paragraphs.length === src.paragraphs.length ? ' ✅' : ' ❌'}`)
console.log(`  副词条行残留旧写法：${leftSub.length} ${leftSub.length ? '❌ ' + leftSub.slice(0, 3).join(' ｜ ') : '✅'}`)
console.log(`  主词条行逐字未变：${mainSame ? '✅' : '❌'}`)
if (changedParts.length || rt.paragraphs.length !== src.paragraphs.length || leftSub.length || !mainSame) {
  console.error(`\n复验未通过 —— 回滚：copy /Y "${bak}" "${doc}"`)
  process.exit(3)
}
console.log('\n✅ 复验通过')
