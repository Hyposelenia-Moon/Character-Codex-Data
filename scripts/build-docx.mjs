/**
 * 反向转换器：data/gi/*.json → 主文档（Word docx）
 *
 * 与 scripts/parse-docx.mjs 严格互逆，是「保存即发布」链路的第 ③ 步：
 *   JSON --build-docx--> docx --parse-docx--> JSON   必须 129/129 深度相等（硬验收）
 *
 * 设计要点：
 *  1. 版面以 JSON 为准：`meta`（建议等级 / 定位 / 100级提升）+ `v2.*` 各字段渲染成文本行，
 *     顺序为 标题 → 6 个小节，块间 32 个 `─`，空栏位写成空段落（与现状一致）。
 *  2. 保留 Word 兼容部件：以现有主文档为模板，只替换 word/document.xml，
 *     其余部件（[Content_Types].xml、_rels、styles…）逐字节复制；段落属性（w:pPr / rPr）沿用模板。
 *  3. 默认写入引用标记 [[w:]] [[a:]] [[c:]] [[t:]] [[k:]]（与 mark-docx.mjs 同一套实现，
 *     且逐行做回推校验，凡会改变回推语义的标记一律撤回）；`--no-mark` 写纯文本。
 *  4. 写主文档前自动备份为同名 `.bak-YYYYMMDD-HHmmss`（保留最近 5 份），再用临时文件原子替换。
 *
 * 用法：
 *   node scripts/build-docx.mjs [--out 目标docx] [--no-mark] [--dry] [--no-verify]
 *   默认目标：D:\文件\游戏\原神\原神·角色攻略.docx
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readDocx, writeDocx, escapeXml, SEPARATOR } from './lib/docx.mjs'
import { deriveSections, renderArtifactRow, talentLevelLine, crownItemText, joinWithSep, sepTokens, itemText, stripMarks, isNoteRow, noteText, resolveNoteText, artifactStatPool, NOTE_PREFIX, NOTE_SEP } from './lib/schema.mjs'
import { loadRefs, planMarks, applyPlan, splitBlocks, loadParseBlock, parseToJson, parseDry } from './mark-docx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const giDir = path.join(dataDir, 'gi')
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'
/**
 * 两份文档的分工（用户决定，模式 B）：
 *   主文档 = 纯文本可读版（--write-main 时等价 --no-mark）
 *   标记版 = 带 [[w:]]/[[a:]]/[[c:]]/[[t:]]/[[k:]] 的转换用版本
 */
const MARKED_OUT = path.join(root, 'out', '原神·角色攻略(标记版).docx')
const MARKED_SHIPPED = 'D:\\文件\\游戏\\原神\\原神·角色攻略(标记版).docx'
/** 标记版的中间产物（验证通过后才同步到 out/ 与交付路径） */
const MARKED_STAGE = path.join(root, '.tmp', 'build-docx', '原神·角色攻略(标记版).docx')

/** 六个小节标题（顺序 = 文档里 `1.` … `6.` 的顺序） */
export const SECTIONS = ['武器推荐', '圣遗物推荐', '天赋加点', '毕业面板参考', '命座推荐', '配队推荐']
/** 小节 ↔ v2 字段名 */
export const SECTIONS_KEY = ['weapons', 'artifacts', 'talents', 'panels', 'constellations', 'teams']
/** 档位中文数字 */
const CN_NUM = ['', '一', '二', '三', '四', '五', '六']
/** 备份保留份数 */
export const KEEP_BACKUPS = 5
/** 文档抬头（与现有主文档保持一致；末尾的分隔段把抬头和第一个角色块分开） */
export const HEAD_LINES = [
  '原神 · 角色攻略',
  '',
  '共 129 名角色：129 名均已填入内容。',
  '',
  '说明：一行一条，`>` / `≥` 表示档位或优先级顺序，`/` 表示并列选项；「必须 / 建议」为皇冠投入建议（只有「可选 / 无需」的不再列出）。',
  '',
  SEPARATOR
]

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ------------------------------------------------------------------ *
 * 1. JSON → 文本行（与 parse-docx 的 parseBlock 互逆）
 * ------------------------------------------------------------------ */

/**
 * 单个角色 → 段落文本行（含空段落）
 *
 * 渲染规则与 parse-docx 的 parseBlock 一一对应：
 *   标题：`<角色名> —— 建议等级：<等级>`
 *   可选元信息：`定位：` / `100级提升：`
 *   六个小节：`1. 武器推荐` … `6. 配队推荐`，内容行来自 deriveSections（JSON → 文本行）
 *   空栏位写成空段落：小节之间（上一节非空时）插一个空段落，末节非空时以空段落收尾
 *
 * @param {object} data 角色 JSON
 * @returns {string[]}
 */
/**
 * 单行渲染：优先沿用 JSON 里记录的分隔符写法（`row.sep` / `rawAll`），
 * 这样 `A > B`、`A ＞ B`、`A / B + C` 都能逐字写回，parse-docx 读回来与 JSON 完全一致。
 * @param {string} key v2 字段名
 * @param {object} row 该字段的一条记录
 * @returns {string}
 */
export function renderRow (key, row) {
  const label = row.label ? `${stripMarks(row.label)}：` : ''
  switch (key) {
    case 'weapons': {
      const tier = row.tier ? `第${CN_NUM[row.tier] ?? row.tier}档：` : ''
      return `${label}${tier}${joinWithSep(row.items, row.sep, ' > ')}`
    }
    case 'artifacts':
      // renderArtifactRow 返回数组（一行可能渲染成 0/1 行），这里只需要那唯一一行
      return renderArtifactRow(row)[0] ?? ''
    case 'talents':
      // 天赋：固定顺序 A → E → Q + 等级（`天赋：A1 E10 Q10`），不再按优先级排序；
      // 皇冠行单独一行（`皇冠：E（10）Q（10）`）
      if (row.kind === 'priority') return talentLevelLine(row)
      if (row.kind === 'crown') return `皇冠：${(row.items ?? []).map(crownItemText).join('')}`
      return ''
    case 'panels':
      if (row.k != null) return `${label}${stripMarks(row.k)}：${stripMarks(row.v ?? '')}`
      if (row.text != null) return `${label}${stripMarks(row.text)}`
      return label
    case 'constellations':
      return row.text ? `${stripMarks(row.name)}——${stripMarks(row.text)}` : stripMarks(row.name)
    case 'teams': {
      // 成员连接符沿用 row.sep（`A + B / C` 这类混用写法要逐字写回）；缺省 `+`
      const members = joinWithSep(row.members, row.sep, ' + ')
      const text = stripMarks(row.text ?? '')
      return `${label}${[members, text].filter(Boolean).join(' / ')}`
    }
    default:
      return ''
  }
}

/**
 * 结构化字段 → 文档文本行（保留原分隔符写法），并在**段末**补上 `注：` 备注行。
 * 备注行（`{kind:'note'}`）不进正文 —— 它统一合并成一行放在该段最后。
 * @param {string} key
 * @param {object[]} rows
 * @returns {string[]}
 */
export function sectionLines (key, rows) {
  const body = (rows ?? []).filter(r => !isNoteRow(r)).map(r => renderRow(key, r)).filter(x => x !== '')
  const note = sectionNoteText(rows)
  if (note) body.push(`${NOTE_PREFIX}${note}`)
  return body
}

/** 该段备注行合并成一行（语义化润色，多条 `；` 分隔） */
export function sectionNoteText (rows) {
  const pool = artifactStatPool(rows)
  return (rows ?? []).filter(isNoteRow).map(noteText).filter(Boolean)
    .map(t => resolveNoteText(t, { polishPool: pool })?.polished ?? t)
    .join(NOTE_SEP)
}

/**
 * 单个角色 → 文档文本行（与 parse-docx 的 parseBlock 互逆）
 *
 * 正文行来自 `deriveSections`（**与 JSON 里的 `sections` 字段同源**），这样
 * 「JSON 里的 sections」与「写进文档的行」永远是同一份渲染结果，不会出现两套渲染器漂移。
 * 空栏位（该段一行内容都没有）**不写标题行**，也不占空段落；
 * 有内容的小节之间插一个空段落，末节有内容时以空段落收尾（Word 版式与现状一致）。
 * @param {object} data 角色 JSON
 * @returns {string[]}
 */
export function characterLines (data) {
  const meta = data.meta ?? {}
  const lines = [`${data.name} —— 建议等级：${meta['建议等级'] ?? ''}`]
  if (meta['定位']) lines.push(`定位：${meta['定位']}`)
  if (meta['100级提升']) lines.push(`100级提升：${meta['100级提升']}`)

  const derived = deriveSections(data).filter(sec => sec.lines.length)
  derived.forEach((sec, i) => {
    if (i > 0) lines.push('')
    // 编号沿用 deriveSections 的标题编号（空栏位被跳过时也不会把后面的小节改号）
    lines.push(sec.title.match(/^\d+\./) ? sec.title : `${i + 1}. ${sec.title}`)
    lines.push(...sec.lines)
  })
  if (derived.length) lines.push('')
  return lines
}

/**
 * 全部角色 → 段落文本行（抬头 + 每个角色块之间 32 个 `─`）
 * @param {{names: string[], docs: object[]}} bundle
 * @returns {string[]}
 */
export function documentLines (bundle) {
  const out = [...HEAD_LINES]
  bundle.names.forEach((name, i) => {
    if (i > 0) out.push(SEPARATOR)
    out.push(...characterLines(bundle.docs[i]))
  })
  // 最后一个角色块之后不再补分隔段：文档以角色块收尾（与现有主文档一致）
  return out
}

/** 读取 data/gi/_order.json + 全部角色 JSON */
export function loadCharacters () {
  const orderFile = path.join(giDir, '_order.json')
  if (!fs.existsSync(orderFile)) throw new Error(`找不到 ${orderFile}`)
  const names = readJson(orderFile)
  const docs = names.map(n => {
    const f = path.join(giDir, `${n}.json`)
    if (!fs.existsSync(f)) throw new Error(`_order.json 里的角色缺少 JSON：${n}`)
    return readJson(f)
  })
  const byName = new Map(names.map((n, i) => [n, docs[i]]))
  return { names, docs, byName }
}

/* ------------------------------------------------------------------ *
 * 2. 文本行 → document.xml（以模板段落的属性重建，段落数与行数一致）
 * ------------------------------------------------------------------ */

const PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g

/**
 * 把模板里的段落拆成「头部（<w:p …> + 段属性）」「尾部（</w:p>）」，
 * 头部里保留 w:pPr（段落样式、缩进、编号…），这样重排文本后 Word 版面不变。
 */
function paraShell (chunk) {
  if (chunk.endsWith('/>')) return { open: '<w:p>', pPr: '', close: '</w:p>' }
  const openEnd = chunk.indexOf('>') + 1
  const body = chunk.slice(openEnd, chunk.lastIndexOf('</w:p>'))
  const m = body.match(/<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/)
  return { open: '<w:p>', pPr: m ? m[0] : '', close: '</w:p>' }
}

/** 文本 → `<w:r><w:t xml:space="preserve">…</w:t></w:r>`（空格与首尾空白原样保留） */
function runXml (text) {
  if (text === '') return ''
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
}

/**
 * 用新的段落文本序列重建 word/document.xml
 *  - 段落数 == 文本行数（模板段落数不同时，多出的用最后一段的段属性补、少的截断）
 *  - 除段落属性外不保留模板的 run 结构：文本被整体重排，旧 run 已无意义
 * @param {string} xml 模板 document.xml
 * @param {string[]} lines 新段落文本
 * @returns {{xml: string, templateParas: number}}
 */
export function rebuildDocumentXml (xml, lines) {
  const chunks = xml.match(PARA_RE) ?? []
  const shells = chunks.map(paraShell)
  const first = shells[0] ?? { open: '<w:p>', pPr: '', close: '</w:p>' }
  const bodyEnd = xml.lastIndexOf('</w:body>')
  if (bodyEnd < 0) throw new Error('document.xml 缺少 </w:body>')
  const head = xml.slice(0, xml.search(PARA_RE))
  const tail = xml.slice(bodyEnd)
  // 段落之间是否夹着 sectPr 等非段落内容：直接丢弃（模板里段落是连续的）
  const parts = lines.map((text, i) => {
    const shell = shells[i] ?? first
    return `${shell.open}${shell.pPr}${runXml(text)}${shell.close}`
  })
  return { xml: head + parts.join('') + tail, templateParas: chunks.length }
}

/* ------------------------------------------------------------------ *
 * 3. 备份 / 原子写
 * ------------------------------------------------------------------ */

const stamp = (d = new Date()) => {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 备份文件（`<doc>.bak-YYYYMMDD-HHmmss`），只保留最近 KEEP_BACKUPS 份
 * @returns {string} 备份路径
 */
export function backupFile (file, date = new Date()) {
  let out = `${file}.bak-${stamp(date)}`
  let n = 1
  while (fs.existsSync(out)) out = `${file}.bak-${stamp(date)}-${n++}`
  fs.copyFileSync(file, out)
  pruneBackups(file)
  return out
}

/** 删除多余的备份，保留最近 KEEP_BACKUPS 份 */
export function pruneBackups (file, keep = KEEP_BACKUPS) {
  const dir = path.dirname(file)
  const base = path.basename(file) + '.bak-'
  const list = fs.readdirSync(dir).filter(f => f.startsWith(base)).sort()
  const dead = list.slice(0, Math.max(0, list.length - keep))
  for (const f of dead) fs.rmSync(path.join(dir, f), { force: true })
  return { kept: list.slice(-keep), removed: dead }
}

/** 原子替换：写同目录临时文件 → rename 覆盖 */
export function atomicWrite (file, buf) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`)
  fs.writeFileSync(tmp, buf)
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/* ------------------------------------------------------------------ *
 * 4. 主流程
 * ------------------------------------------------------------------ */

/** 默认输出目录（仓库内 out/，已在 .gitignore 里） */
export const OUT_DIR = path.join(root, 'out')

/** `20260919-213340` 时间戳（默认输出文件名用） */
export function fileStamp (d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function parseArgs (argv) {
  const args = { out: null, template: null, mark: true, dry: false, verify: true, keepTmp: false, writeMain: false, markedSrc: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
    else if (a === '--template') args.template = argv[++i]
    else if (a === '--no-mark') args.mark = false
    else if (a === '--dry') args.dry = true
    else if (a === '--no-verify') args.verify = false
    else if (a === '--keep-tmp') args.keepTmp = true
    else if (a === '--write-main') args.writeMain = true
    else if (a === '--marked-src') args.markedSrc = true
    else if (a.startsWith('--')) throw new Error(`未知参数：${a}`)
    else throw new Error(`多余参数：${a}`)
  }
  // 分工（用户决定）：**主文档 = 纯文本可读版（--no-mark）**，标记版 = 带引用标记（转换用）
  if (args.markedSrc) args.mark = true
  else if (args.writeMain) args.mark = false
  // 安全默认：**只有显式 --write-main 才会写主文档**，其余一律写 out/ 下的试验产物
  if (!args.out) {
    if (args.writeMain) args.out = DEFAULT_DOC
    else if (args.markedSrc) args.out = MARKED_OUT
    else args.out = path.join(OUT_DIR, `build-docx-${fileStamp()}.docx`)
  }
  if (!path.isAbsolute(args.out)) args.out = path.join(root, args.out)
  // 模板：显式给了就用；否则主文档在就用主文档（保留 Word 部件），否则用 out/
  args.template = args.template ?? (fs.existsSync(DEFAULT_DOC) ? DEFAULT_DOC : args.out)
  if (!path.isAbsolute(args.template)) args.template = path.join(root, args.template)
  return args
}

/**
 * 生成文档（不落盘）
 * @param {{template?: string, mark?: boolean, out?: string}} opts
 * @returns {Promise<object>}
 */
export async function build (opts = {}) {
  const out = opts.out ?? path.join(OUT_DIR, `build-docx-${fileStamp()}.docx`)
  const template = opts.template ?? (fs.existsSync(out) ? out : DEFAULT_DOC)
  const useMark = opts.mark !== false
  if (!fs.existsSync(template)) throw new Error(`找不到模板文档：${template}`)

  const bundle = loadCharacters()
  const jsonSnapshot = snapshotJson() // 校验时用来识别「被并发改动」的角色
  // 冻结 data/gi 快照：往返校验用它与内存 bundle 比对，
  // 避免「校验期间别的进程改了 data/gi」造成假失败（parse-docx 支持 DSH_GI_DIR）
  const frozenGiDir = opts.frozenGiDir ?? freezeGiDir(bundle)
  const lines = documentLines(bundle)
  const blocks = bundle.names.length
  const src = readDocx(template)
  const rebuilt = rebuildDocumentXml(src.xml, lines)

  // ---- 标记（默认开）：逐行做回推校验，有损的标记自动撤回 ----
  let xml = rebuilt.xml
  const markStats = { plan: 0, marks: { w: 0, a: 0, c: 0, t: 0, k: 0 }, dropped: 0, problems: 0, fallback: 0 }
  if (useMark) {
    await loadParseBlock() // planMarks 的行级回推校验需要与 parse-docx 同一套解析语义
    const refs = loadRefs()
    const index = (() => { try { return readJson(path.join(dataDir, '_index.json')) } catch { return null } })()
    const tplBlocks = splitBlocks(lines.map(x => x.trim()))
    const planned = planMarks(tplBlocks, refs, index)
    const applied = applyPlan(xml, planned.plan)
    xml = applied.xml
    markStats.plan = planned.plan.size
    markStats.marks = planned.marks
    markStats.dropped = planned.dropped
    markStats.problems = planned.problems
    markStats.fallback = applied.fallback
  }

  const entries = new Map()
  for (const [name, buf] of src.entries) entries.set(name, name === 'word/document.xml' ? Buffer.from(xml, 'utf8') : buf)

  return {
    out,
    template,
    characters: blocks,
    lines: lines.length,
    paragraphs: src.paragraphs.length,
    textLines: lines,
    marked: useMark,
    xml,
    entries,
    src,
    bundle,
    jsonSnapshot,
    frozenGiDir,
    markStats,
    docFingerprint: sha256(Buffer.from(xml, 'utf8'))
  }
}

/**
 * 冻结一份 data/gi 快照到 `.tmp/frozen-gi/`（含 _index.json），供往返校验使用。
 * 已经通过 DSH_GI_DIR 指定过的（例如上层调用想复用同一份）就直接用它。
 * @param {{names: string[], docs: object[]}} bundle
 * @returns {{dir: string, files: number, indexFrom?: string}}
 */
export function freezeGiDir (bundle) {
  if (process.env.DSH_GI_DIR && fs.existsSync(process.env.DSH_GI_DIR)) {
    return { dir: path.resolve(process.env.DSH_GI_DIR), files: bundle.names.length, reused: true }
  }
  const dir = path.join(root, '.tmp', `frozen-gi-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  bundle.names.forEach((name, i) => {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(bundle.docs[i], null, 2) + '\n', 'utf8')
  })
  // parse-docx 解析完会按「文档里出现的顺序」重写 _order.json，但 mark-docx 的 parseToJson
  // 是**先读 `_order.json` 再逐角色读 JSON**，所以快照里必须先放一份（顺序 = 本次生成的顺序）
  fs.writeFileSync(path.join(dir, '_order.json'), JSON.stringify(bundle.names, null, 2) + '\n', 'utf8')
  // parse-docx 会沿用「上一份 JSON」里的 highlight/source，所以 _index.json 也要带上
  try {
    fs.copyFileSync(path.join(dataDir, '_index.json'), path.join(dir, '_index.json'))
  } catch { /* 没有索引也能跑，只是名称校验弱一些 */ }
  return { dir, files: bundle.names.length }
}

/** data/gi/*.json 的内容指纹（用来识别「回读校验期间被别的进程改了」的角色） */
export function snapshotJson () {  const map = new Map()
  if (!fs.existsSync(giDir)) return map
  for (const f of fs.readdirSync(giDir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    map.set(f, sha256(fs.readFileSync(path.join(giDir, f))))
  }
  return map
}

/**
 * 用真正的 parse-docx.mjs 解析产物，逐角色与「生成文档时用的那份 JSON」深比较
 *
 * 主判据是**内存里的 bundle**（生成时的数据），所以这个校验是纯往返校验，
 * 不受「校验期间别的进程改了 data/gi」影响；文件是否过期另用 `onDisk` 表示。
 *
 * @param {string} docx
 * @param {{names: string[], docs: object[], byName?: Map<string,object>}} bundle
 * @param {string} tmpDir
 * @param {Map<string, string>} [before] 生成文档前抓的 JSON 指纹
 * @param {string} [frozenGiDir] 冻结的 data/gi 快照目录（并发写 data/gi 时用它保证校验稳定）
 */
export function verifyAgainstJson (docx, bundle, tmpDir, before, frozenGiDir) {
  const opts = frozenGiDir ? { giDir: frozenGiDir } : {}
  const parsed = parseToJson(docx, path.join(tmpDir, 'out'), opts)
  const stats = parseDry(docx, tmpDir, opts).stats
  const after = snapshotJson()
  const diffs = []
  const changedDuring = [] // 校验期间被并发改写（比对仍以 bundle 为准）
  if (parsed.names.length !== bundle.names.length) diffs.push(`角色数 ${bundle.names.length} → ${parsed.names.length}`)
  for (let i = 0; i < Math.min(parsed.names.length, bundle.names.length); i++) {
    const got = parsed.objs[i]
    const want = bundle.docs[i]
    const file = `${want.name}.json`
    if (before && before.get(file) !== undefined && after.get(file) !== before.get(file)) changedDuring.push(want.name)
    for (const k of ['schema', 'name', 'game', 'meta', 'v2']) {
      if (!eqJson(got[k] ?? null, want[k] ?? null)) diffs.push(`${want.name}：${k} 不一致`)
    }
    if (Object.keys(got.unparsed ?? {}).length) diffs.push(`${want.name}：有未识别行 ${JSON.stringify(got.unparsed).slice(0, 80)}`)
  }
  // 定位第一处不同（只打印路径 / 小片段，不打印大段 JSON）
  const findDiff = (a, b, p = '') => {
    if (eqJson(a, b)) return null
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (i >= a.length) return `${p}[${i}] 文档多出 ${JSON.stringify(b[i]).slice(0, 50)}`
        if (i >= b.length) return `${p}[${i}] 文档缺少 ${JSON.stringify(a[i]).slice(0, 50)}`
        const d = findDiff(a[i], b[i], `${p}[${i}]`)
        if (d) return d
      }
      return `${p} 长度不同`
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = findDiff(a[k], b[k], p ? `${p}.${k}` : k)
        if (d) return d
      }
      return `${p} 键不同`
    }
    const show = (x) => {
      const s = JSON.stringify(x)
      return (s === undefined ? String(x) : s).slice(0, 40)
    }
    return `${p}: JSON=${show(a)} ≠ 文档=${show(b)}`
  }
  for (let i = 0; i < Math.min(parsed.names.length, bundle.names.length); i++) {
    const d = findDiff(bundle.docs[i].v2, parsed.objs[i].v2, 'v2') ?? findDiff(bundle.docs[i].meta, parsed.objs[i].meta, 'meta')
    if (d) { diffs.push(`首处差异（${bundle.names[i]}）：${d}`); break }
  }
  return {
    names: parsed.names,
    stats,
    diffs,
    changedDuring,
    onDisk: changedDuring.length === 0,
    objs: parsed.objs,
    ok: diffs.length === 0
  }
}

/**
 * 两份文档「去标记后是否逐字一致」：按段落比较（忽略首尾空白）
 * @param {string} fileA
 * @param {string} fileB
 * @returns {{equal: boolean, paragraphs: number, diffs: string[]}}
 */
export function stripsEqual (fileA, fileB) {
  const stripMarksInText = (s) => s.replace(/\[\[([wactk])[:：]([^[\]]+?)\]\]/g, '$2')
  const a = readDocx(fileA).paragraphs.map(p => stripMarksInText(p).trim())
  const b = readDocx(fileB).paragraphs.map(p => stripMarksInText(p).trim())
  const diffs = []
  if (a.length !== b.length) diffs.push(`段落数 ${a.length} ≠ ${b.length}`)
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) diffs.push(`第 ${i + 1} 段：${a[i].slice(0, 40)} ≠ ${b[i].slice(0, 40)}`)
  }
  return { equal: diffs.length === 0, paragraphs: a.length, diffs: diffs.slice(0, 5) }
}

/** 读一份 docx 的 document.xml 指纹（幂等比对用） */
function docFingerprint (file) {
  const { entries } = readDocx(file)
  return sha256(entries.get('word/document.xml'))
}

/** 文件的 sha1（十六进制） */
function sha1File (file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 同步「标记版文档」：把主文档原样写出到 `out/原神·角色攻略(标记版).docx`，
 * 再拷贝一份到 `D:\文件\游戏\原神\原神·角色攻略(标记版).docx`（覆盖前备份 `.bak-<时间戳>`，保留最近 5 份）。
 *
 * 说明：主文档当前**本身就是带引用标记**的产物（build-docx 默认写标记），
 * 所以标记版与主文档字节级一致、只是多一层「另一份文件名」的产物；
 * 若将来改成「主文档干净 + 标记版带标记」的分工，这里换成写 `--no-mark` 即可。
 *
 * @param {string} mainDocx 已落盘的主文档
 * @returns {{outPath: string, shippedPath: string, backup: string|null, bytes: number, sha: string|null}}
 */
export function syncMarkedDocx (mainDocx = DEFAULT_DOC) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.copyFileSync(mainDocx, MARKED_OUT)
  fs.mkdirSync(path.dirname(MARKED_SHIPPED), { recursive: true })
  const backup = fs.existsSync(MARKED_SHIPPED) ? backupFile(MARKED_SHIPPED) : null
  atomicWrite(MARKED_SHIPPED, fs.readFileSync(mainDocx))
  return {
    outPath: MARKED_OUT,
    shippedPath: MARKED_SHIPPED,
    backup,
    bytes: fs.statSync(MARKED_SHIPPED).size,
    sha: sha1File(MARKED_SHIPPED)
  }
}

async function main () {
  const t0 = Date.now()
  const args = parseArgs(process.argv.slice(2))
  const writesMain = path.resolve(args.out) === path.resolve(DEFAULT_DOC)

  /** 把一次 build 的 entries 写成 stage 文件：zip 部件完整性 + 往返校验 */
  const writeStage = (rr, stage, tmpDir) => {
    const writtenX = writeDocx(rr.entries, stage)
    const verifyX = verifyAgainstJson(stage, rr.bundle, path.join(tmpDir, `v-${path.basename(stage, '.docx')}`), rr.jsonSnapshot, rr.frozenGiDir?.dir)
    const rtX = readDocx(stage)
    const needX = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
    const missingX = needX.filter(n => !rtX.entries.has(n))
    const changedX = []
    for (const [name, buf] of rr.src.entries) {
      if (name === 'word/document.xml') continue
      const other = rtX.entries.get(name)
      if (!other || sha256(buf) !== sha256(other)) changedX.push(name)
    }
    return { written: writtenX, rt: rtX, missing: missingX, changedOthers: changedX, verify: verifyX }
  }

  const r = await build({ template: args.template, mark: args.mark, out: args.out })
  const w = args.dry ? { bytes: 0, count: r.entries.size, stored: [], deflated: [] } : null

  console.log(`角色块：${r.characters}`)
  console.log(`段落数：${r.lines}（模板 ${r.paragraphs}，块间分隔段 ${r.characters - 1}）`)
  console.log(`模式：${r.marked ? '带引用标记 [[w:]] [[a:]] [[c:]] [[t:]] [[k:]]' : '纯文本（--no-mark）'}`)
  console.log(`输出：${args.out}${writesMain ? '（主文档，--write-main 显式指定）' : '（仓库内试验产物，未触碰主文档）'}`)
  if (r.marked) {
    const m = r.markStats.marks
    console.log(`标记：落盘 w=${m.w} a=${m.a} c=${m.c} t=${m.t} k=${m.k}（覆盖 ${r.markStats.plan} 个段落）；撤回 ${Array.isArray(r.markStats.dropped) ? r.markStats.dropped.length : 0} 处；定位失败 ${r.markStats.fallback}`)
  }
  if (args.dry) {
    console.log(`zip 部件：${w.count} 个（--dry 未写文件）`)
    return
  }

  const tmp = path.join(root, '.tmp', 'build-docx')
  fs.mkdirSync(tmp, { recursive: true })
  fs.mkdirSync(path.dirname(args.out), { recursive: true })

  // ---- 先写到临时文件并自检，通过后才备份 / 替换目标 ----
  const stage = path.join(tmp, `stage-${process.pid}.docx`)
  const sres = writeStage(r, stage, tmp)
  const { written, rt, missing, changedOthers } = sres
  const verify = sres.verify

  // 主文档要备份；out/ 下的试验产物直接覆盖
  // 硬门槛：写主文档前往返校验必须通过 —— 否则宁可不写，保留旧文档
  if (writesMain && verify && !verify.ok) {
    fs.rmSync(stage, { force: true })
    console.log(`❌ 往返校验未通过，已放弃写主文档（保留原文档不动）：${verify.diffs.slice(0, 3).join(' ｜ ')}`)
    process.exitCode = 1
    return
  }
  const existed = fs.existsSync(args.out)
  let backup = null
  if (existed && writesMain) backup = backupFile(args.out)
  atomicWrite(args.out, fs.readFileSync(stage))
  fs.rmSync(stage, { force: true })

  // 主文档更新后立刻复验一次（确认写进去的就是通过与 JSON 严格相等的那份）
  let postOk = null
  if (writesMain && args.verify) {
    const post = verifyAgainstJson(args.out, r.bundle, path.join(tmp, 'post'), r.jsonSnapshot, r.frozenGiDir?.dir)
    postOk = post.ok
    console.log(`写主文档后复验：${post.ok ? `${post.names.length}/${r.bundle.names.length} 仍完全相等` : '不一致 → ' + post.diffs.slice(0, 3).join(' ｜ ')}`)
    if (!post.ok) process.exitCode = 1
  }

  // ---- 标记版：单独生成一份带引用标记的（主文档是干净可读版，两者去标记后应逐字等价）----
  let marked = null
  if (writesMain) {
    const mr = await build({ template: args.template, mark: true, out: MARKED_STAGE, frozenGiDir: r.frozenGiDir?.dir })
    const mstage = path.join(tmp, `marked-${process.pid}.docx`)
    const mres = writeStage(mr, mstage, tmp)
    const mv = mres.verify
    marked = syncMarkedDocx(mstage)
    marked.roundTrip = mv.ok ? `${mv.names.length}/${mr.bundle.names.length} 完全相等` : '不一致 → ' + mv.diffs.slice(0, 3).join(' ｜ ')
    marked.roundTripOk = mv.ok
    marked.markStats = mr.markStats
    marked.stripsEqualCheck = stripsEqual(marked.shippedPath, args.out)
    marked.stripsEqual = marked.stripsEqualCheck.equal
    marked.paragraphs = mres.rt.paragraphs
    marked.sameAsMain = marked.sha === sha1File(args.out)
    console.log(`标记版输出：${marked.outPath}`)
    console.log(`标记版拷贝：${marked.shippedPath}（备份 ${marked.backup ?? '无'}，${marked.bytes} 字节，sha1 ${String(marked.sha).slice(0, 12)}）`)
    console.log(`标记版往返（parse-docx ↔ 生成时 JSON）：${marked.roundTrip}`)
    console.log(`两份文档去标记后逐字一致：${marked.stripsEqual ? `是（${marked.stripsEqualCheck.paragraphs} 段全等）` : `否（${marked.stripsEqualCheck.diffs.join('；')}）`}`)
    fs.rmSync(mstage, { force: true })
    if (!mv.ok || !marked.stripsEqual) process.exitCode = 1
  }

  console.log(`zip：${written.count} 个部件（store ${written.stored.length} / deflate ${written.deflated.length}），${written.bytes} 字节`)
  console.log(`必需部件：${missing.length ? '缺失 ' + missing.join(',') : '齐全'}；其它部件${changedOthers.length ? '有改动 ' + changedOthers.join(',') : '与模板逐字节一致'}`)
  console.log(`段落数：产物 ${rt.paragraphs}（模板 ${r.paragraphs}）`)
  console.log(`备份：${backup ?? (writesMain ? '（目标不存在，未备份）' : '（非主文档，无需备份）')}`)
  console.log(`写出：${args.out}`)
  console.log(`主文档 sha1：${sha1File(args.out)}`)
  if (verify) {
    const fmt = s => `角色 ${s.characters}/武器 ${s.weapons}/圣遗物 ${s.artifacts}/天赋 ${s.talents}/面板 ${s.panels}/命座 ${s.constellations}/配队 ${s.teams}/未识别 ${s.unparsed}`
    console.log(`回读统计（parse-docx --dry）：${fmt(verify.stats)}`)
    console.log(`与生成时 JSON 深比较：${verify.ok ? `${verify.names.length}/${r.bundle.names.length} 完全相等` : '不一致 → ' + verify.diffs.slice(0, 5).join(' ｜ ')}`)
    if (verify.changedDuring.length) console.log(`提示：校验期间 data/gi 有 ${verify.changedDuring.length} 个角色被并发改写（${verify.changedDuring.slice(0, 5).join('、')}），产物与生成时数据一致，但可能已不是最新`)
    // 供上层（编辑器 publish 的三方一致性校验）使用的机器可读行
    console.log(`三方校验·往返=${verify.ok ? 'ok' : 'fail'}`)
    console.log(`冻结快照目录：${r.frozenGiDir?.dir ?? '（无）'}`)
    if (!verify.ok) process.exitCode = 1
  }
  // ---- 标记版（自包含块，防止被并发编辑覆盖）：主文档=干净可读版，标记版=带引用标记 ----
  if (writesMain) {
    const MARKED_OUT = path.join(OUT_DIR, '原神·角色攻略(标记版).docx')
    const MARKED_SHIPPED = 'D:\\文件\\游戏\\原神\\原神·角色攻略(标记版).docx'
    const mstage = path.join(tmp, `marked-${process.pid}.docx`)
    const mr = await build({ template: args.template, mark: true, out: mstage, frozenGiDir: r.frozenGiDir?.dir })
    // 自包含：写 stage + 往返校验（不依赖 main 里的局部函数，避免被并发编辑覆盖）
    const mWritten = writeDocx(mr.entries, mstage)
    const mv = verifyAgainstJson(mstage, mr.bundle, path.join(tmp, `mv-${process.pid}`), mr.jsonSnapshot, mr.frozenGiDir?.dir)
    if (!mv.ok) console.log(`⚠ 标记版往返校验未通过：${mv.diffs.slice(0, 3).join(' ｜ ')}`)
    console.log(`标记版 zip：${mWritten.count} 个部件，${mWritten.bytes} 字节`)
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.copyFileSync(mstage, MARKED_OUT)
    fs.mkdirSync(path.dirname(MARKED_SHIPPED), { recursive: true })
    const markedBackup = fs.existsSync(MARKED_SHIPPED) ? backupFile(MARKED_SHIPPED) : null
    atomicWrite(MARKED_SHIPPED, fs.readFileSync(mstage))
    const markedSha = sha1File(MARKED_SHIPPED)
    const strips = stripsEqual(MARKED_SHIPPED, args.out)
    const markedParas = readDocx(MARKED_SHIPPED).paragraphs.length
    console.log(`标记版输出：${MARKED_OUT}`)
    console.log(`标记版拷贝：${MARKED_SHIPPED}（备份 ${markedBackup ?? '无'}）`)
    console.log(`标记版往返（parse-docx ↔ 生成时 JSON）：${mv.ok ? `${mv.names.length}/${mr.bundle.names.length} 完全相等` : '不一致'}`)
    console.log(`标记版标记数：w=${mr.markStats.marks.w} a=${mr.markStats.marks.a} c=${mr.markStats.marks.c} t=${mr.markStats.marks.t} k=${mr.markStats.marks.k}`)
    console.log(`两份文档去标记后逐字一致：${strips.equal ? `是（${strips.paragraphs} 段全等）` : `否（${strips.diffs.join('；')}）`}`)
    console.log(`标记版 sha1：${markedSha}`)
    fs.rmSync(mstage, { force: true })
    if (!mv.ok || !strips.equal) process.exitCode = 1
  }

  // ---- 幂等：再生成一次，document.xml 必须逐字节相同 ----
  const again = await build({ template: args.out, mark: args.mark, out: args.out })
  const idem = again.docFingerprint === docFingerprint(args.out)
  console.log(`幂等：再生成一次 document.xml → ${idem ? '逐字节相同' : '不同（不幂等）'}`)
  if (!idem) process.exitCode = 1
  if (!args.keepTmp) fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`结论：${verify?.ok !== false && idem && !missing.length && !changedOthers.length ? '通过' : '存在未通过项'}（耗时 ${Date.now() - t0} ms）`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(String(e?.stack ?? e)); process.exitCode = 1 })
}
