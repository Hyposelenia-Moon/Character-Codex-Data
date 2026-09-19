/**
 * 文档层一次性数据修正：删除「圣遗物套装行」里**重复出现的套装条目**（用户裁定：先删重复数据）。
 *
 * 背景：这类行在源文档里是「两分组」写法，例如
 *   `首选：苍白之火 / 染血的骑士道 + 苍白之火 + 角斗士的终幕礼 + 武人 + 战狂`
 * 前半段用 `/` 并列、后半段用 `+` 组合；解析器把它拍平成一个 sets 数组 + 复合 sep，
 * 于是前半段成员在后半段重现，成了"重复项"。用户决定**先删重复的那一项**，保留其余项与原始顺序。
 *
 * 涉及 7 个角色（相邻/非相邻都算）：
 *   优菈、烟绯、赛索斯、菲米尼、梦见月瑞希、鹿野院平藏、丽莎
 * **不动** 10 个 `2X + 2X`（凝光/叶洛亚/塔利雅/尼可/旅行者·岩草雷/沃雅妮莎/菈乌玛/薇斯纳）——
 * 它们是"两套 2 件套"而不是重复。
 *
 * 语义约定（不许改）：`/`=或者、`+`=组合、`＝/=`=同级、`＞`=优先级。
 * 删项规则：删掉**重复出现的那一项 + 紧邻其前的一个分隔符**，保证删完不留 ` / / `、` + + `、
 * 行首/行尾悬挂分隔符。
 *
 * 安全措施（与 fix-docx-names.mjs 同一套）：
 *   1. 只重写 word/document.xml 这一个部件，其余部件**逐字节**复制；
 *   2. 写前 compare-and-swap：重读文件比对 sha256 与 xml，被别的进程改过就中止；
 *   3. 改前备份 `<doc>.bak-YYYYMMDD-HHmmss`；
 *   4. 写后复验：其它部件哈希一致、段落数不变、新行齐备且旧行消失。
 *
 * 跨 run 安全：Word 常把一行拆进多个 `<w:r>/<w:t>`。本脚本对每处修改先试"原文在
 * document.xml 里连续出现"的快速路径；若跨 run 则自动回退到**段落级 run-aware 重写**
 * （把新文本写进该段第一个 `<w:t>`，其余 `<w:t>` 置空，不动任何 run 属性）。
 *
 * 用法：node scripts/fix-docx-dup-sets.mjs [docx路径] [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readDocx, writeDocx, escapeXml, unescapeXml } from './lib/docx.mjs'

const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

/** 7 处修正：`from` 是文档里当前整行，`to` 是删掉重复项后的整行（其余项与顺序不变） */
export const DUP_SET_EDITS = [
  {
    name: '优菈',
    from: '首选：苍白之火 / 染血的骑士道 + 苍白之火 + 角斗士的终幕礼 + 武人 + 战狂',
    to: '首选：苍白之火 / 染血的骑士道 + 角斗士的终幕礼 + 武人 + 战狂',
    dropped: '第 3 项 苍白之火（与第 1 项重复，非相邻）'
  },
  {
    name: '烟绯',
    from: '首选：炽烈的炎之魔女 / 流浪大地的乐团 + 角斗士的终幕礼 + 炽烈的炎之魔女',
    to: '首选：炽烈的炎之魔女 / 流浪大地的乐团 + 角斗士的终幕礼',
    dropped: '第 4 项 炽烈的炎之魔女（与第 1 项重复，非相邻）'
  },
  {
    name: '赛索斯',
    from: '首选：流浪大地的乐团 / 饰金之梦 + 流浪大地的乐团 + 饰金之梦 + 乐园遗落之花 + 逆飞的流星',
    to: '首选：流浪大地的乐团 / 饰金之梦 + 乐园遗落之花 + 逆飞的流星',
    dropped: '第 3 项 流浪大地的乐团、第 4 项 饰金之梦（与第 1、2 项重复，非相邻）'
  },
  {
    name: '菲米尼',
    from: '首选：苍白之火 / 染血的骑士道 + 苍白之火 + 冰风迷途的勇士',
    to: '首选：苍白之火 / 染血的骑士道 + 冰风迷途的勇士',
    dropped: '第 3 项 苍白之火（与第 1 项重复，非相邻）'
  },
  {
    name: '梦见月瑞希',
    from: '首选：翠绿之影 / 血红之证 + 饰金之梦 + 饰金之梦 + 流浪大地的乐团',
    to: '首选：翠绿之影 / 血红之证 + 饰金之梦 + 流浪大地的乐团',
    dropped: '第 4 项 饰金之梦（与第 3 项重复，相邻）'
  },
  {
    name: '鹿野院平藏',
    from: '首选：翠绿之影 / 翠绿之影 / 角斗士的终幕礼（2件套）',
    to: '首选：翠绿之影 / 角斗士的终幕礼（2件套）',
    dropped: '第 2 项 翠绿之影（与第 1 项重复，相邻）'
  },
  {
    name: '丽莎',
    from: '首选：如雷的盛怒 / 如雷的盛怒 + 昔日宗室之仪',
    to: '首选：如雷的盛怒 + 昔日宗室之仪',
    dropped: '第 2 项 如雷的盛怒（与第 1 项重复，相邻）'
  }
]

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

/** 删完不许留下的坏写法 */
const BAD_PATTERNS = [
  { re: /([/＋+])\s*[/＋+]/, what: '连续分隔符（` / / `、` + + `）' },
  { re: /：\s*[/＋+]/, what: '行首紧贴分隔符' },
  { re: /[/＋+]\s*$/, what: '行尾悬挂分隔符' },
  { re: /^\s*[/＋+]/, what: '行首悬挂分隔符' }
]

/**
 * 段落级 run-aware 重写：把 oldLine 所在段落的文本换成 newLine。
 * 只改 `<w:t>` 的内文，不动 run 属性；新文本写进第一个非空 `<w:t>`，其余置空。
 * @returns {{xml: string, hit: number}}
 */
function rewriteByParagraph (xml, oldLine, newLine) {
  let hit = 0
  const out = xml.replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (chunk) => {
    if (chunk.endsWith('/>')) return chunk
    const ts = [...chunk.matchAll(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g)]
    if (!ts.length) return chunk
    const joined = ts.map(m => unescapeXml(m[2])).join('')
    if (joined !== oldLine) return chunk
    hit++
    let first = true
    let next = chunk
    // 从后往前替换，避免偏移失效
    for (let i = ts.length - 1; i >= 0; i--) {
      const m = ts[i]
      const inner = first && i === ts.length - 1 ? escapeXml(newLine) : ''
      first = false
      next = next.slice(0, m.index) + m[1] + inner + m[3] + next.slice(m.index + m[0].length)
    }
    return next
  })
  return { xml: out, hit }
}

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const doc = args.find(a => !a.startsWith('--')) ?? DEFAULT_DOC

if (!fs.existsSync(doc)) {
  console.error(`找不到文档：${doc}`)
  process.exit(1)
}

const bufBefore = fs.readFileSync(doc)
const src = readDocx(doc)
console.log(`文档：${doc}`)
console.log(`部件：${src.entries.size} 个，段落 ${src.paragraphs.length} 行，document.xml ${Buffer.byteLength(src.xml)} 字节`)

/* ---- 规划：逐处命中数必须是 1（0 = 已删过可跳过，>1 = 文档变了宁可报错） ---- */
let next = src.xml
const plan = []
for (const e of DUP_SET_EDITS) {
  const contiguous = next.split(e.from).length - 1
  if (contiguous > 1) {
    console.error(`中止：删除目标命中 ${contiguous} 处（应为 0 或 1）：${e.from}`)
    process.exit(2)
  }
  if (contiguous === 1) {
    next = next.split(e.from).join(e.to)
    plan.push({ ...e, hit: 1, mode: '整串（单 run，document.xml 内连续）' })
    continue
  }
  // 回退：段落级 run-aware
  const r = rewriteByParagraph(next, e.from, e.to)
  if (r.hit > 1) {
    console.error(`中止：段落级匹配命中 ${r.hit} 段（应为 0 或 1）：${e.from}`)
    process.exit(2)
  }
  next = r.xml
  plan.push({ ...e, hit: r.hit, mode: r.hit ? '段落级 run-aware（跨 run 回退）' : '未命中（可能已删过）' })
}

const pending = plan.filter(p => p.hit === 1)
console.log(`\n计划修改 ${pending.length} / ${DUP_SET_EDITS.length} 处：`)
for (const p of plan) {
  console.log(`  · ${p.name}  [${p.mode}]`)
  console.log(`      删掉：${p.dropped}`)
  console.log(`      原文：${p.from}`)
  if (p.hit) console.log(`      现在：${p.to}`)
}

/* ---- 语法自检：新行不得留下坏写法 ---- */
console.log('\n语法自检（正文行）：')
let badTotal = 0
for (const p of pending) {
  for (const { re, what } of BAD_PATTERNS) {
    if (re.test(p.to)) { console.log(`  ❌ ${p.name}：${what} → ${p.to}`); badTotal++ }
  }
}
console.log(badTotal ? `  ❌ 共 ${badTotal} 处坏写法` : '  ✅ 无连续分隔符 / 无悬挂分隔符')
if (badTotal) process.exit(2)

if (!pending.length) {
  console.log('\n没有需要修正的内容（0 处，幂等）')
  process.exit(0)
}
if (dry) {
  console.log('\n--dry：未写文件')
  process.exit(0)
}

/* ---- 写回：compare-and-swap + 备份 + 只换 document.xml ---- */
const fresh1 = fs.readFileSync(doc)
if (sha256(bufBefore) !== sha256(fresh1)) {
  console.error('中止：文档在读取与写回之间被其它进程改动（sha256 不一致），请稍后重跑')
  process.exit(2)
}
const re = readDocx(doc)
if (re.xml !== src.xml) {
  console.error('中止：文档内容已变化（xml 与规划时不一致），请稍后重跑')
  process.exit(2)
}

const stamp = (() => {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})()
const bak = `${doc}.bak-${stamp}`
fs.copyFileSync(doc, bak)
console.log(`\n已备份 → ${bak}（${fs.statSync(bak).size} 字节）`)

const entries = new Map()
for (const [name, buf] of src.entries) {
  entries.set(name, name === 'word/document.xml' ? Buffer.from(next, 'utf8') : buf)
}
const w = writeDocx(entries, doc)

/* ---- 写后复验 ---- */
const rt = readDocx(doc)
const changedParts = []
for (const [name, buf] of src.entries) {
  if (name === 'word/document.xml') continue
  if (sha256(buf) !== sha256(rt.entries.get(name))) changedParts.push(name)
}
const leftOld = rt.paragraphs.filter(p => DUP_SET_EDITS.some(e => p.includes(e.from)))
const missingNew = pending.filter(p => !rt.paragraphs.some(x => x === p.to))

console.log(`\n已写回 ${doc}（${w.count} 个部件，${w.bytes} 字节）`)
console.log(`  document.xml：${Buffer.byteLength(src.xml)} → ${Buffer.byteLength(rt.xml)} 字节`)
console.log(`  其它部件：${changedParts.length ? '有改动！' + changedParts.join(', ') : '与源逐字节一致 ✅'}`)
console.log(`  段落数：${rt.paragraphs.length}（源 ${src.paragraphs.length}）${rt.paragraphs.length === src.paragraphs.length ? ' ✅' : ' ❌'}`)
console.log(`  残留旧行：${leftOld.length} ${leftOld.length ? '❌ ' + leftOld.join(' ｜ ') : '✅'}`)
console.log(`  新行缺失：${missingNew.length} ${missingNew.length ? '❌ ' + missingNew.map(x => x.name).join('、') : '✅'}`)

if (changedParts.length || rt.paragraphs.length !== src.paragraphs.length || leftOld.length || missingNew.length) {
  console.error('\n复验未通过 —— 回滚命令：')
  console.error(`  copy /Y "${bak}" "${doc}"`)
  process.exit(3)
}
console.log('\n✅ 复验通过')
