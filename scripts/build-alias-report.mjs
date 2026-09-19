/**
 * 生成 out/_alias-report.md：所有「解析出但取不到图鉴标准名」的引用清单
 * 同时给出「口语 2 件套」写法出现的位置（角色 + 行号）
 *
 * 数据来源：
 *   - data/gi/*.json 的 v2 结构化字段（ref 名 + 所在小节）
 *   - 原文档 D:\文件\游戏\原神\原神·角色攻略.docx 的段落（用于给出该角色块内的行号与原文行）
 *
 * 用法：node scripts/build-alias-report.mjs [--check] [docx路径]
 *   --check 只打印统计，不写文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDocx, SEPARATOR } from './lib/docx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const giDir = path.join(dataDir, 'gi')
const outFile = path.join(root, 'out', '_alias-report.md')
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const docFile = args.find(a => !a.startsWith('--')) ?? DEFAULT_DOC

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const idx = readJson(path.join(dataDir, '_index.json'))
const KNOWN = {
  weapon: new Set(idx.weapons ?? []),
  artifact: new Set(idx.artifacts ?? []),
  character: new Set(idx.characters ?? [])
}

const SECTION_HDR = /^\d+\.\s*(武器推荐|圣遗物推荐|天赋加点|毕业面板参考|命座推荐|配队推荐)\s*$/

/* ------------------------------------------------ 文档段落 → 角色块行号表 */

const src = readDocx(docFile)
/** 角色名 → { lines: [{no, section, text}], byText: Map(text → {no, section}) } */
const lineMaps = new Map()
{
  let cur = []
  const flush = () => {
    if (!cur.some(x => x.trim())) { cur = []; return }
    const name = String(cur[0] ?? '').split('——')[0].trim()
    if (name && !lineMaps.has(name)) {
      const byText = new Map()
      const lines = []
      let section = ''
      cur.forEach((text, i) => {
        const m = text.match(SECTION_HDR)
        if (m) section = m[1]
        const rec = { no: i + 1, section: section || '（标题）', text }
        lines.push(rec)
        if (!byText.has(text)) byText.set(text, rec)
      })
      lineMaps.set(name, { lines, byText })
    }
    cur = []
  }
  for (const p of src.paragraphs) {
    if (p === SEPARATOR) { flush(); continue }
    if (!p) continue
    cur.push(p)
  }
  flush()
}

/**
 * 在角色块里定位一行：优先精确匹配原文行；匹配不到（v2 回推文本与原文有差异，
 * 例如 `2+2` / 空格折叠）就退化成「包含该名字」的第一行，但要排除小节标题行
 * （名字是 `2` 这类短串时会误命中「2. 圣遗物推荐」）。
 * @returns {{no: number, section: string, text: string, exact: boolean}}
 */
function locate (character, lineText, name) {
  const entry = lineMaps.get(character)
  if (!entry) return { no: 0, section: '?', text: lineText ?? '', exact: false }
  if (lineText && entry.byText.has(lineText)) return { ...entry.byText.get(lineText), exact: true }
  const needle = String(name ?? '')
  if (needle) {
    const hit = entry.lines.find(l => l.text.includes(needle) && !/^\d+\.\s/.test(l.text))
    if (hit) return { ...hit, exact: false }
  }
  return { no: 0, section: '?', text: lineText ?? '', exact: false }
}

/* ------------------------------------------------ v2 行 → 文档原文行 */

const CN = ['', '一', '二', '三', '四', '五', '六']

const itemText = (it) => `${it.name ?? ''}${it.note ? `（${it.note}）` : ''}`

function lineTextOf (key, row) {
  if (key === 'weapons') {
    const label = row.label ? `${row.label}：` : ''
    const tier = row.tier ? `第${CN[row.tier] ?? row.tier}档：` : ''
    const items = (row.items ?? []).map(itemText).join(row.sep ?? ' > ')
    return `${label}${tier}${items}`.trim()
  }
  if (key === 'artifacts') {
    const label = row.label ? `${row.label}：` : ''
    if (!Array.isArray(row.sets)) return null
    const sets = row.sets.map(s => `${s.name ?? ''}${s.pieces ? `（${s.pieces}）` : ''}`).join(row.sep ?? ' / ')
    return `${label}${sets}`.trim()
  }
  if (key === 'teams') {
    const label = row.label ? `${row.label}：` : ''
    const members = (row.members ?? []).map(itemText).join(' + ')
    return `${label}${[members, row.text].filter(Boolean).join(' / ')}`.trim()
  }
  return null
}

/* ------------------------------------------------ 采集所有取不到标准名的 ref */

/** @type {Array<{type,name,character,section,lineNo,lineText,refKind}>} */
const records = []
const colloquial = []
const characterFiles = fs.readdirSync(giDir).filter(f => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
const characterNames = characterFiles.map(f => f.slice(0, -'.json'.length))

for (const cname of characterNames) {
  const d = readJson(path.join(giDir, `${cname}.json`))
  const collect = (type, item, section, lineText) => {
    if (!item || typeof item !== 'object') return
    const ref = String(item.ref ?? '')
    const i = ref.indexOf(':')
    if (i <= 0) return
    if (ref.slice(0, i) !== type) return
    const name = ref.slice(i + 1).trim()
    if (!name || KNOWN[type].has(name)) return
    const loc = locate(cname, lineText, name)
    records.push({
      type, name, character: cname,
      section: loc.section !== '?' ? loc.section : section,
      lineNo: loc.no, lineText,
      docLine: loc.text, exact: loc.exact
    })
  }
  for (const row of d.v2?.weapons ?? []) {
    const lineText = lineTextOf('weapons', row)
    for (const it of row.items ?? []) collect('weapon', it, '武器推荐', lineText)
  }
  for (const row of d.v2?.artifacts ?? []) {
    const lineText = lineTextOf('artifacts', row)
    for (const s of row.sets ?? []) {
      collect('artifact', s, '圣遗物推荐', lineText)
      // 口语「2 件套」：名字是「数字+属性」写法，无法映射到具体套装名（保留纯文本）
      if (/^\d/.test(String(s.name ?? ''))) {
        const loc = locate(cname, lineText, s.name)
        colloquial.push({
          name: s.name, character: cname,
          section: loc.section !== '?' ? loc.section : '圣遗物推荐',
          lineNo: loc.no, lineText, docLine: loc.text
        })
      }
    }
  }
  for (const row of d.v2?.teams ?? []) {
    const lineText = lineTextOf('teams', row)
    for (const m of row.members ?? []) collect('character', m, '配队推荐', lineText)
  }
}

/* ------------------------------------------------ 分类 */

/**
 * 找「最接近的标准名」：长度差 ≤ 1 且逐位比较只差一个字（漏字 / 多字 / 错字）。
 * 名字很短的（≤ 3 字）要求长度必须相等，避免把「奶位」这类描述型写法误判成错别字。
 * @param {string} name
 * @param {Iterable<string>} pool
 * @returns {string|null}
 */
function closestName (name, pool) {
  const s = String(name ?? '')
  if (!s) return null
  const minLen = s.length >= 4 ? s.length - 1 : s.length
  const maxLen = s.length + 1
  let best = null
  let bestScore = Infinity
  for (const cand of pool) {
    if (cand === s) continue
    if (cand.length < minLen || cand.length > maxLen) continue
    if (!/[\u4e00-\u9fa5]/.test(cand[0]) || !/[\u4e00-\u9fa5]/.test(s[0])) continue
    // 首字不同的一律不算（避免「千岩牢固」被算成「万岩牢固」这类瞎猜）
    if (cand[0] !== s[0]) continue
    let diff = 0
    const max = Math.max(s.length, cand.length)
    for (let i = 0; i < max; i++) if (s[i] !== cand[i]) diff++
    if (diff > 1) continue
    const score = diff * 10 + Math.abs(s.length - cand.length)
    if (score < bestScore) { bestScore = score; best = cand }
  }
  return best
}

const POOLS = { weapon: KNOWN.weapon, artifact: KNOWN.artifact, character: KNOWN.character }
/** 人工确认过的建议（优先于自动推断） */
const TYPO_SUGGEST = new Map([
  ['苐草之稻光', '薙草之稻光'],
  ['系诺宁', '希诺宁'],
  ['瓦蕾莎', '瓦雷莎'],
  ['阿洛夏', '阿罗夏'],
  ['白羽心弦', '白雨心弦']
])

/** 名字结尾的「数字」= 两件套件数（`少女角斗士追忆乐团2` → 名 + 2件套） */
function trailingPieceNum (name) {
  const s = String(name ?? '')
  const m = s.match(/^(.+?)(\d{1,2})$/)
  if (!m) return null
  const base = m[1].trim()
  if (!base) return null
  return { base, count: m[2] }
}

/** 名字里带「数字+数字」（2+2 之类的复合写法） */
const PIECE_PLUS_RE = /\d\s*[+＋]\s*\d|^\d+$/
/** 名字里带「2件套 / 两件套」这类件数说明 */
const PIECE_WORD_RE = /(\d件套|两件套|二件套|\d\+\d)/

/** B 类：描述型 / 整句（本就无图标） */
const DESCRIPTIVE_RE = /^(\d|任意|其他|其它|主[cCＣ]|武器|套装|散搭|白值|辅助|奶|生存|减抗|挂[水雷火冰草岩]|自由|摔门|月反应|双爆|充能|精通|生命|攻击|防御|岩元素)/
/** D 类：一个字符串里塞了多个实体 */
const COMPOUND_RE = /[+＋/／＆&、＝=]/

/**
 * @param {{type:string,name:string}} r
 * @returns {{cls:'A'|'B'|'C'|'D', suggest?:string, split?:string[]}}
 */
function classifyRec (r) {
  const name = r.name
  const pool = POOLS[r.type] ?? new Set()

  // 0) 纯数字碎片（`少女角斗士追忆乐团2+2` 被 2+2 解析切出来的那个「2」）—— 不是实体名
  if (/^\d+$/.test(name)) return { cls: 'B' }

  // 1) 带件数说明：`少女角斗士追忆乐团2+2` / `角斗士的终幕礼两件套`
  //    去掉件数说明与数字后应剩标准套装名；剩不下就说明数字本来就是名字的一部分（如「祭礼剑2」不存在，交给后面的规则）
  const stripped = name.replace(PIECE_WORD_RE, '').replace(/\d+/g, '').replace(/[＋+]+/g, '').trim()
  if (stripped && stripped !== name && /(\d件套|两件套|二件套|\d\+\d|\d$)/.test(name)) {
    if (pool.has(stripped)) {
      let label = '2件套'
      const word = name.match(/\d件套|两件套|二件套/)
      if (word) label = word[0]
      else {
        const plus = name.match(/(\d)\s*[+＋]\s*\d/)
        if (plus) label = `${plus[1]}件套`
        else {
          const tail = name.match(/(\d)$/)
          if (tail) label = `${tail[1]}件套`
        }
      }
      return { cls: 'D', split: [stripped, label] }
    }
  }

  // 2) 复合写法：带分隔符
  if (COMPOUND_RE.test(name)) {
    const parts = name.split(/[+＋/／＆&、＝=]/).map(x => x.trim()).filter(Boolean)
    return { cls: 'D', split: parts.length > 1 ? parts : undefined }
  }
  const tp = trailingPieceNum(name)
  if (tp && pool.has(tp.base)) {
    // 「标准名 + 数字」＝该套装的 2 件套（parse-docx 已支持），但名字里混进了数字 → 建议拆开
    return { cls: 'D', split: [tp.base, `${tp.count}件套`] }
  }

  // 3) 错别字：与某个标准名只差一个字
  const typo = TYPO_SUGGEST.get(name) ?? closestName(name, pool)
  if (typo) return { cls: 'A', suggest: typo }

  // 4) 描述型 / 整句
  if (DESCRIPTIVE_RE.test(name)) return { cls: 'B' }
  if (name.length >= 6) return { cls: 'B' }

  // 5) 剩下的短名字 = 别名 / 俗称
  return { cls: 'C' }
}

const groups = { A: [], B: [], C: [], D: [] }
for (const r of records) {
  const c = classifyRec(r)
  groups[c.cls].push({ ...r, suggest: c.suggest, split: c.split })
}

/** 同一 (角色, 原文) 只留一条，附出现次数 */
function dedupe (list) {
  const map = new Map()
  for (const r of list) {
    const k = `${r.character}|${r.lineText}|${r.name}`
    if (!map.has(k)) map.set(k, { ...r, count: 1 })
    else map.get(k).count++
  }
  return [...map.values()]
}

const at = (r) => `${r.character} → ${r.section} → 块内第 ${r.lineNo} 行${r.exact ? '' : '（按名称定位）'}`
const srcLine = (r) => `\`${r.docLine ?? r.lineText}\``
const parsedLine = (r) => (r.exact || r.docLine === r.lineText ? '' : `（v2 回推：\`${r.lineText}\`）`)

/* ------------------------------------------------ 输出 */

const L = []
L.push('# 别名 / 未识别引用清单')
L.push('')
L.push(`生成时间：${new Date().toISOString()}`)
L.push('')
L.push('数据来源：`data/gi/*.json` 的 `v2.weapons` / `v2.artifacts` / `v2.teams` 里的 `ref`，')
L.push('与 `data/_index.json`（图鉴标准名白名单 = 武器 / 角色 / 圣遗物套装）逐一比对，')
L.push('**凡是取不到标准名的引用都列在下面**。')
L.push('')
L.push('「位置」的读法：`角色 → 小节 → 块内第 N 行`（行号含角色标题行，1-based，与 Word 里的顺序一致）。')
L.push('`出现次数` > 1 表示同一个角色块里同一行重复解析出多次该引用（例如 2+2 组合各写一次）。')
L.push('')
L.push('## 分类统计')
L.push('')
L.push('| 分类 | 含义 | 条数（去重后） | 条数（原始） |')
L.push('|---|---|---|---|')
L.push(`| A 类 | 明显错别字（给出建议名） | ${dedupe(groups.A).length} | ${groups.A.length} |`)
L.push(`| B 类 | 描述型 / 整句（本就无图标，保持纯文本） | ${dedupe(groups.B).length} | ${groups.B.length} |`)
L.push(`| C 类 | 别名 / 俗称（应改写成标准名） | ${dedupe(groups.C).length} | ${groups.C.length} |`)
L.push(`| D 类 | 复合写法（一个字符串多实体，建议拆分） | ${dedupe(groups.D).length} | ${groups.D.length} |`)
L.push(`| 合计 | | ${dedupe(records).length} | ${records.length} |`)
L.push('')

L.push(`## A 类：明显错别字（${dedupe(groups.A).length} 条）`)
L.push('')
if (groups.A.length) {
  L.push('| 原文 | 建议名 | 位置 | 所在行 | 次数 |')
  L.push('|---|---|---|---|---|')
  for (const r of dedupe(groups.A)) L.push(`| ${r.name} | **${r.suggest ?? '待人工确认'}** | ${at(r)} | ${srcLine(r)}${parsedLine(r)} | ${r.count} |`)
} else L.push('（无）')
L.push('')

L.push(`## B 类：描述型 / 整句（${dedupe(groups.B).length} 条 —— 本就无图标，保持纯文本）`)
L.push('')
if (groups.B.length) {
  L.push('| 原文 | 位置 | 所在行 | 次数 |')
  L.push('|---|---|---|---|')
  for (const r of dedupe(groups.B)) L.push(`| ${r.name} | ${at(r)} | ${srcLine(r)}${parsedLine(r)} | ${r.count} |`)
} else L.push('（无）')
L.push('')

L.push(`## C 类：别名 / 俗称（${dedupe(groups.C).length} 条）`)
L.push('')
if (groups.C.length) {
  L.push('| 原文 | 位置 | 所在行 | 次数 |')
  L.push('|---|---|---|---|')
  for (const r of dedupe(groups.C)) L.push(`| ${r.name} | ${at(r)} | ${srcLine(r)}${parsedLine(r)} | ${r.count} |`)
} else L.push('（无）')
L.push('')

L.push(`## D 类：复合写法（${dedupe(groups.D).length} 条 —— 一个字符串多实体）`)
L.push('')
if (groups.D.length) {
  L.push('| 原文 | 建议拆分 | 位置 | 所在行 | 次数 |')
  L.push('|---|---|---|---|---|')
  for (const r of dedupe(groups.D)) {
    const parts = r.split ?? r.name.split(/[+＋/／＆&、＝=]/).map(x => x.trim()).filter(Boolean)
    L.push(`| ${r.name} | ${parts.length > 1 ? parts.join(' + ') : '人工判断'} | ${at(r)} | ${srcLine(r)}${parsedLine(r)} | ${r.count} |`)
  }
} else L.push('（无）')
L.push('')

L.push(`## 附：口语「2 件套」写法（${colloquial.length} 条，去重后 ${dedupe(colloquial).length} 条）`)
L.push('')
L.push('无法映射到具体套装名的口语写法（`2充能` / `2精通` / `2生命` / `2攻击` 等）：**保持纯文本，不造 ref、不删信息**；')
L.push('下面是它们出现的位置，供人工判断是否要写成具体套装。')
L.push('')
L.push('| 写法 | 角色 | 小节 | 块内行号 | 所在行 |')
L.push('|---|---|---|---|---|')
for (const c of dedupe(colloquial)) L.push(`| ${c.name} | ${c.character} | ${c.section} | ${c.lineNo} | \`${c.docLine ?? c.lineText}\` |`)
L.push('')
L.push('对照：`千岩牢固2` / `绝缘之旗印2` 这类「标准名 + 数字」已由 `parse-docx.mjs` 的 `parseSetItem`')
L.push('拆成 `{name:"千岩牢固", pieces:"2件套", ref:"artifact:千岩牢固"}` —— ref 能取到图标，pieces 即两件套件数，工作正常。')
L.push('')

L.push('---')
L.push('')
L.push('## 统计')
L.push('')
L.push(`- 取不到图鉴标准名的引用（原始）：**${records.length}** 条；去重（角色 + 行 + 名）：**${dedupe(records).length}** 条`)
L.push(`- 涉及角色：**${new Set(records.map(r => r.character)).size}** 个`)
L.push(`- A 类（错别字）：**${dedupe(groups.A).length}** 条 —— ${dedupe(groups.A).map(r => r.name).join('、') || '无'}`)
L.push(`- B 类（描述型/整句）：**${dedupe(groups.B).length}** 条`)
L.push(`- C 类（别名/俗称）：**${dedupe(groups.C).length}** 条 —— ${dedupe(groups.C).map(r => r.name).join('、') || '无'}`)
L.push(`- D 类（复合写法）：**${dedupe(groups.D).length}** 条 —— ${dedupe(groups.D).map(r => r.name).join('、') || '无'}`)
L.push(`- 口语 2 件套写法：**${dedupe(colloquial).length}** 条（原始 ${colloquial.length} 条）`)
L.push('')

const text = L.join('\n')
let reportLines = text.split('\n').length
L.push(`- 本报告行数：**${reportLines + 1}** 行`)
const finalText = L.join('\n')

if (!checkOnly) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, finalText, 'utf8')
  console.log(`已写入 ${path.relative(root, outFile)}`)
}
console.log(`引用 ${records.length} 条（去重 ${dedupe(records).length}）：A ${dedupe(groups.A).length} / B ${dedupe(groups.B).length} / C ${dedupe(groups.C).length} / D ${dedupe(groups.D).length}`)
console.log(`口语2件套 ${colloquial.length} 条（去重 ${dedupe(colloquial).length}）；涉及角色 ${new Set(records.map(r => r.character)).size} 个`)
console.log(`报告行数 ${reportLines}`)
