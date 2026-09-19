/**
 * 分类对比：主文档解析结果 vs data/gi 当前内容
 *
 * 分类（吸收并发改造）：
 *   docExtra   ：文档有、库没有 的「内容行」（用户新填入的数据）★最关心
 *   jsonExtra  ：库有、文档没有 的「内容行」
 *   noteRows   ：库里有 `{kind:"note"}` 行 / 条目 `note` 字段，而文档没有 → 视为并发改造（不算内容差）
 *   other      ：其它深层字段差异（sep / label / pieces / 顺序 …）
 *
 * 用法：node scripts/compare-doc-json2.mjs --snapshot <.tmp 里的 docx 快照>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childRun } from './mark-docx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const work = path.join(root, '.tmp', 'cmp2')
const shadow = path.join(work, 'shadow')
const snapArg = (() => { const i = process.argv.indexOf('--snapshot'); return i >= 0 ? process.argv[i + 1] : null })()
const docx = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const SECTIONS = ['weapons', 'artifacts', 'talents', 'panels', 'constellations', 'teams']
const CN = { weapons: '武器推荐', artifacts: '圣遗物推荐', talents: '天赋加点', panels: '毕业面板参考', constellations: '命座推荐', teams: '配队推荐' }

// ---- 影子解析（只读 data/gi，不写） ----
fs.rmSync(shadow, { recursive: true, force: true })
fs.mkdirSync(path.join(shadow, 'scripts', 'lib'), { recursive: true })
fs.mkdirSync(path.join(shadow, 'data'), { recursive: true })
fs.copyFileSync(path.join(here, 'parse-docx.mjs'), path.join(shadow, 'scripts', 'parse-docx.mjs'))
for (const f of ['docx.mjs', 'schema.mjs']) fs.copyFileSync(path.join(here, 'lib', f), path.join(shadow, 'scripts', 'lib', f))
fs.copyFileSync(path.join(root, 'data', '_index.json'), path.join(shadow, 'data', '_index.json'))
const srcGi = path.join(shadow, 'data', 'gi')
fs.mkdirSync(srcGi, { recursive: true })
// 用「冻结副本」当上一版数据 + 当比较对象，避免比对期间 data/gi 被并发改写
const frozen = path.join(work, 'frozen-gi')
fs.rmSync(frozen, { recursive: true, force: true })
fs.mkdirSync(frozen, { recursive: true })
for (const f of fs.readdirSync(giDir)) {
  try { fs.copyFileSync(path.join(giDir, f), path.join(srcGi, f)); fs.copyFileSync(path.join(giDir, f), path.join(frozen, f)) } catch { /* 并发写时跳过 */ }
}
fs.mkdirSync(work, { recursive: true })
const ascii = path.join(work, 'main.docx')
if (snapArg) fs.writeFileSync(ascii, fs.readFileSync(snapArg))
else fs.copyFileSync(docx, ascii)
// 通过环境变量把影子解析器指向冻结副本（childRun 会继承 process.env）
process.env.DSH_GI_DIR = srcGi
process.env.DSH_DATA_DIR = path.join(shadow, 'data')
const r = childRun(path.join(shadow, 'scripts', 'parse-docx.mjs'), [ascii], shadow, path.join(work, 'out.txt'))
if (r.status !== 0) { console.error(r.stderr.slice(0, 800)); process.exit(1) }
const names = readJson(path.join(srcGi, '_order.json'))
const docMap = new Map(names.map(n => [n, readJson(path.join(srcGi, `${n}.json`))]))
const realMap = new Map()
for (const f of fs.readdirSync(frozen)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue
  realMap.set(f.slice(0, -5), readJson(path.join(frozen, f)))
}

/** v2 一个 section → 内容行数组（忽略 note 字段本身） */
function rows (doc, key) {
  const v2 = doc?.v2 ?? {}
  const R = v2[key] ?? []
  const noteLv = (x) => (x?.note ? `〔注:${x.note}〕` : '')
  if (key === 'weapons') return R.map(x => `${x.label ?? (x.tier ? `第${x.tier}档` : '')}：${(x.items ?? []).map(i => i.name + noteLv(i)).join(' ' + String(x.sep ?? ' > ').trim() + ' ')}`.trim())
  if (key === 'artifacts') return R.map(x => {
    if (x.kind === 'main') return `主词条：${Object.entries(x.stats ?? {}).map(([k, v]) => `${k}：${(v ?? []).join(' / ')}`).join(' / ')}${noteLv(x)}`
    if (x.kind === 'sub') return `副词条：${(x.stats ?? []).join(' / ')}${noteLv(x)}`
    if (x.kind === 'text') return `${x.label ? x.label + '：' : ''}${x.text ?? ''}`
    if (x.kind === 'note') return `（注行）${x.text ?? ''}`
    const head = x.label ? `${x.label}：` : `${({ preferred: '首选', transition: '过渡', optional: '可选' }[x.kind]) ?? x.kind}：`
    return `${head}${(x.sets ?? []).map(s => s.name + (s.pieces ? `（${s.pieces}）` : '') + noteLv(s)).join(' / ')}`
  })
  if (key === 'talents') return R.map(x => x.kind === 'priority' ? `优先级：${(x.order ?? []).map(o => o.name).join(' > ')}` : x.kind === 'crown' ? `皇冠：${(x.items ?? []).map(i => i.name + (i.level ? `（${i.level}）` : '')).join('')}` : `（${x.kind}）${x.text ?? ''}`)
  if (key === 'panels') return R.map(x => x.label ? `${x.label}：${x.text ?? ''}` : x.k === undefined || x.k === null ? (x.text ?? '') : `${x.k}：${x.v ?? ''}`)
  if (key === 'constellations') return R.map(x => `${x.name}${x.text ? '——' + x.text : ''}`)
  if (key === 'teams') return R.map(x => x.kind === 'note' ? `（注行）${x.text ?? ''}` : `${x.label ? x.label + '：' : ''}${(x.members ?? []).map(m => m.name + noteLv(m)).join(' + ')}${x.text ? (x.members?.length ? ' / ' : '') + x.text : ''}`)
  return []
}

/** 深层 firstDiff（最多 max 条） */
function firstDiffs (a, b, p = '', out = [], max = 8) {
  if (out.length >= max || eq(a, b)) return out
  const isObj = (x) => x && typeof x === 'object'
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
      if (i >= a.length) out.push(`${p}[${i}] 文档缺（库: ${JSON.stringify(b[i]).slice(0, 70)}）`)
      else if (i >= b.length) out.push(`${p}[${i}] 库缺（文档: ${JSON.stringify(a[i]).slice(0, 70)}）`)
      else firstDiffs(a[i], b[i], `${p}[${i}]`, out, max)
    }
    return out
  }
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      if (out.length >= max) break
      if (!(k in a)) out.push(`${p}.${k} 文档缺（库: ${JSON.stringify(b[k]).slice(0, 70)}）`)
      else if (!(k in b)) out.push(`${p}.${k} 库缺（文档: ${JSON.stringify(a[k]).slice(0, 70)}）`)
      else firstDiffs(a[k], b[k], `${p}.${k}`, out, max)
    }
    return out
  }
  out.push(`${p}: 文档=${JSON.stringify(a)?.slice(0, 70)} ≠ 库=${JSON.stringify(b)?.slice(0, 70)}`)
  return out
}

let contentDiff = 0
const report = []
for (const name of names) {
  const doc = docMap.get(name)
  if (!realMap.has(name)) { report.push({ name, onlyDoc: true }); contentDiff++; continue }
  const real = realMap.get(name)
  const item = { name, docExtra: [], jsonExtra: [], noteRows: [], other: [] }
  for (const key of SECTIONS) {
    if (eq(doc.v2?.[key] ?? null, real.v2?.[key] ?? null)) continue
    const A = rows(doc, key).map(s => s.trim())
    const B = rows(real, key).map(s => s.trim())
    const sA = new Set(A), sB = new Set(B)
    const onlyA = A.filter(x => !sB.has(x))
    const onlyB = B.filter(x => !sA.has(x))
    for (const x of onlyA) { item.docExtra.push({ section: key, line: x }); contentDiff++ }
    for (const x of onlyB) {
      if (x.startsWith('（注行）') || x.includes('〔注:')) item.noteRows.push({ section: key, line: x })
      else { item.jsonExtra.push({ section: key, line: x }); contentDiff++ }
    }
    const d = firstDiffs(doc.v2?.[key] ?? null, real.v2?.[key] ?? null)
    if (d.length) item.other.push({ section: key, diffs: d })
  }
  if (item.docExtra.length || item.jsonExtra.length || item.noteRows.length || item.other.length) report.push(item)
}
// 库里多出来的角色
for (const name of realMap.keys()) if (!docMap.has(name)) { report.push({ name, onlyJson: true }); contentDiff++ }

console.log(`影子解析：${names.length} 个角色（快照 ${snapArg ?? docx}）`)
console.log(`有差异的角色：${report.length} 个；其中「文档 vs 库」内容差异条目：${contentDiff}`)
for (const it of report) {
  console.log(`\n=== ${it.name} ===`)
  if (it.onlyDoc) { console.log('  [只在文档]'); continue }
  if (it.onlyJson) { console.log('  [只在库]'); continue }
  for (const x of it.docExtra) console.log(`  [文档有·库没有] ${CN[x.section]}：${x.line}`)
  for (const x of it.jsonExtra) console.log(`  [库有·文档没有] ${CN[x.section]}：${x.line}`)
  for (const x of it.noteRows) console.log(`  [并发改造·note] ${CN[x.section]}：${x.line}`)
  for (const x of it.other) { console.log(`  [其它字段差异] ${CN[x.section]}`); for (const d of x.diffs) console.log(`      ${d}`) }
}
