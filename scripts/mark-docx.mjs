/**
 * 文档标记化：把 Word 攻略文档里的实体名包上引用标记（[[w:..]] [[a:..]] [[c:..]]，以及规则里的 [[t:..]] [[k:..]]）
 *
 * 设计原则：
 *  1. **只加标记，不动其它任何字符**（空格 / 全角符号 / 分隔符 / 备注全部原样保留）。
 *  2. 标记名的来源是 data/gi/*.json 的 v2 refs；标记只是让引用显式化，回推（parse-docx）
 *     必须得到与标记前**完全一致**的 v2 数据 —— 脚本对每个候选标记逐行做回推校验，
 *     会改变 v2 的标记一律撤回（t/k 两类就是这样被撤回的，原因见 out/_mark-report.json 的 note），
 *     最后再用真正的 scripts/parse-docx.mjs 分别解析源文档与标记文档，逐角色块做 JSON 深比较。
 *  3. 只重写 word/document.xml，其余部件（[Content_Types].xml、_rels、styles…）逐字节复制。
 *  4. 幂等：已经带标记的文本不再重复包；对标记版再跑一次，word/document.xml 与所有段落完全不变
 *     （zip 里各条目的 DOS 时间戳按运行时刻写入，所以两次独立运行的文件字节会不同，内容相同）。
 *
 * 用法：
 *   node scripts/mark-docx.mjs [源docx] [--out 输出docx] [--keep-tmp]
 *   默认源：D:\文件\游戏\原神\原神·角色攻略.docx
 *   默认输出：out\原神·角色攻略(标记版).docx（相对仓库根）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readDocx, writeDocx, escapeXml, SEPARATOR } from './lib/docx.mjs'
import { MARK_RE, parseRef } from './lib/schema.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const giDir = path.join(dataDir, 'gi')
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'
const DEFAULT_OUT = path.join(root, 'out', '原神·角色攻略(标记版).docx')

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
/** 与 parse-docx 的 splitItems 保持一致的分隔符 */
const ANY_SEP_RE = /\s*(?:[>＞]|≥|[/／])\s*/
/** 与 parse-docx 的 parseSetGroup 保持一致的分隔符 */
const SET_PLUS_RE = /\s*[+＋]\s*/
/** 配队成员分隔符（与 parse-docx 的 parseMembers 一致） */
const MEMBER_SEP_RE = /\s*[+＋/／、]\s*/

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 拿到 parse-docx.mjs 里的 parseBlock（**不修改该文件**）：
 * 它没有 export，末尾又会直接跑 main()，所以在仓库内 .tmp 下克隆一份、
 * 只追加一行 export 再把 `main()` 那行注释掉，然后用动态 import 取出函数，
 * 这样本脚本用的是与 parse-docx 完全同一套解析语义。
 * @returns {Promise<Function>}
 */
export async function loadParseBlock () {
  const dir = path.join(root, '.tmp', 'parse-docx-clone')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  const code = fs.readFileSync(path.join(here, 'parse-docx.mjs'), 'utf8')
  fs.writeFileSync(path.join(dir, 'parse-docx.mjs'), code.replace(/^main\(\)$/m, '') + '\nexport { parseBlock }\n', 'utf8')
  for (const f of ['docx.mjs', 'schema.mjs']) fs.copyFileSync(path.join(here, 'lib', f), path.join(dir, 'lib', f))
  const mod = await import(new URL('file://' + path.join(dir, 'parse-docx.mjs').replace(/\\/g, '/')).href)
  if (typeof mod.parseBlock !== 'function') throw new Error('无法从 parse-docx.mjs 复用 parseBlock')
  parseBlock = mod.parseBlock
  return mod.parseBlock
}
/** 全脚本共用的 parseBlock 引用（在 main 里注入；纯函数，保证与 parse-docx 同一套语义） */
let parseBlock = null

/* ------------------------------------------------------------------ *
 * 1. 收集标记名册（以 data/gi/*.json 的 v2 refs 为准）
 * ------------------------------------------------------------------ */

export function loadRefs () {
  const byType = { weapon: new Map(), artifact: new Map(), character: new Map() }
  const files = []
  if (!fs.existsSync(giDir)) throw new Error(`找不到数据目录：${giDir}`)
  for (const f of fs.readdirSync(giDir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    files.push(f)
    let d
    try { d = readJson(path.join(giDir, f)) } catch { continue }
    const v2 = d.v2 ?? {}
    const add = (type, ref, where) => {
      if (!ref) return
      const { type: t, name } = parseRef(ref)
      if (t !== type || !name) return
      const key = type + ':' + name
      const rec = byType[type].get(key) ?? { name, count: 0, samples: [] }
      rec.count++
      if (rec.samples.length < 3) rec.samples.push(`${d.name ?? f} · ${where}`)
      byType[type].set(key, rec)
    }
    for (const row of v2.weapons ?? []) for (const it of row.items ?? []) add('weapon', it.ref, '武器推荐')
    for (const row of v2.artifacts ?? []) for (const it of row.sets ?? []) add('artifact', it.ref, '圣遗物推荐')
    for (const row of v2.teams ?? []) for (const it of row.members ?? []) add('character', it.ref, '配队推荐')
  }
  const names = (type) => [...byType[type].values()].map(r => r.name).sort((a, b) => b.length - a.length || a.localeCompare(b))
  return {
    files: files.sort(),
    byType,
    weapons: names('weapon'),
    artifacts: names('artifact'),
    characters: names('character'),
    weaponsSet: new Set(names('weapon')),
    artifactsSet: new Set(names('artifact')),
    charactersSet: new Set(names('character'))
  }
}

/* ------------------------------------------------------------------ *
 * 2. 标记（纯文本 → 标记文本 + 字符区间）
 * ------------------------------------------------------------------ */

const markRe = () => new RegExp(MARK_RE.source, 'g')

const inMark = (text, pos) => {
  for (const m of text.matchAll(markRe())) {
    if (pos >= m.index && pos < m.index + m[0].length) return true
  }
  return false
}

/** 生成「标记后文本」：按原区间（升序、互不重叠）重建 */
function buildMarked (raw, spans) {
  let out = ''
  let cur = 0
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    if (s.from < cur) throw new Error(`区间重叠：${raw}`)
    out += raw.slice(cur, s.from) + `[[${s.type}:` + raw.slice(s.from, s.to) + ']]'
    cur = s.to
  }
  return out + raw.slice(cur)
}

/**
 * 带偏移地按分隔符切分：返回 [{text, start, end}]。
 * 语义与 parse-docx 的 String.split(sep) 一致，只是额外保留每段在 value 里的位置，
 * 这样按区间拼回文本时能逐字还原（分隔符原样保留）。
 */
function splitWithOffsets (value, re) {
  const out = []
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let last = 0
  let m
  while ((m = g.exec(value)) !== null) {
    if (m.index > last) out.push({ text: value.slice(last, m.index), start: last, end: m.index })
    last = m.index + m[0].length
    if (m[0].length === 0) g.lastIndex++
  }
  if (last < value.length) out.push({ text: value.slice(last), start: last, end: value.length })
  return out
}

/** 武器行：第N档：A > B（精5） */
function markWeaponItems (value, off, add, refs) {
  for (const seg of splitWithOffsets(value, ANY_SEP_RE)) {
    const name = seg.text.trim()
    if (!name || !refs.weaponsSet.has(name)) continue
    const lead = seg.text.length - seg.text.trimStart().length
    const trail = seg.text.length - seg.text.trimEnd().length
    add({ from: off + seg.start + lead, to: off + seg.end - trail, type: 'w', name })
  }
}

/** 圣遗物套装行：A / B + C（2+2 组合每个名字各包一层） */
function markArtifactItems (value, off, add, refs) {
  for (const seg of splitWithOffsets(value, ANY_SEP_RE)) {
    for (const p of splitWithOffsets(seg.text, SET_PLUS_RE)) {
      const name = p.text.trim()
      if (!name || !refs.artifactsSet.has(name)) continue
      const lead = p.text.length - p.text.trimStart().length
      const trail = p.text.length - p.text.trimEnd().length
      add({ from: off + seg.start + p.start + lead, to: off + seg.start + p.end - trail, type: 'a', name })
    }
  }
}

/** 天赋行：优先级 Q > E > A ｜ 皇冠 E（建议）Q（必须） */
function markTalents (value, off, add, kind) {
  const re = kind === 'crown' ? /[AEQ](\s*[（(][^）)]*[）)])?/g : /[AEQ]/g
  for (const m of value.matchAll(re)) {
    add({ from: off + m.index, to: off + m.index + m[0].length, type: 't', name: m[0] })
  }
}

/** 配队行：成员 + 成员 / 成员 */
function markMembers (value, off, add, refs) {
  for (const seg of splitWithOffsets(value, MEMBER_SEP_RE)) {
    const name = seg.text.trim()
    if (!name || !refs.charactersSet.has(name)) continue
    const lead = seg.text.length - seg.text.trimStart().length
    const trail = seg.text.length - seg.text.trimEnd().length
    add({ from: off + seg.start + lead, to: off + seg.end - trail, type: 'c', name })
  }
}

/**
 * 单行标记
 * @param {string} line 段落原文（含可能的首尾空白）
 * @param {string} section 所属小节
 * @returns {{raw, text, rebuilt, spans, skipped, rejects}}
 */
export function markLine (line, section, refs, counters) {
  const spans = []
  const rejects = []
  // 只包「干净的名字」：带括号 / 等号 / 分隔符的是复合写法或带备注，包了会改变回推语义
  const add = (s) => {
    if (/[（）()\[\]<>＞＝=+＋/／、，,＆&]/.test(s.name)) { rejects.push(s); return }
    if (inMark(line, s.from) || inMark(line, s.to - 1)) return
    spans.push(s)
    counters[s.type]++
  }
  const raw = line
  const lead = raw.length - raw.trimStart().length
  const text = raw.trim()
  if (!text) return { raw, text: raw, rebuilt: raw, spans, skipped: false, rejects }

  if (section === '武器推荐') {
    let m = text.match(/^(第[一二三四五六1-6][档挡])([:：])([\s\S]*)$/)
    if (m) markWeaponItems(m[3], lead + m[1].length + m[2].length, add, refs)
    else if ((m = text.match(/^([^：:]{1,12})([:：])([\s\S]*)$/)) && m[3].trim()) markWeaponItems(m[3], lead + m[1].length + m[2].length, add, refs)
  } else if (section === '圣遗物推荐') {
    let m = text.match(/^(首选|次选|可选|过渡|套装)([:：])([\s\S]*)$/)
    if (m) markArtifactItems(m[3], lead + m[1].length + m[2].length, add, refs)
    else if ((m = text.match(/^([^：:]{1,12})([:：])([\s\S]*)$/)) && m[3].trim()) markArtifactItems(m[3], lead + m[1].length + m[2].length, add, refs)
  } else if (section === '天赋加点') {
    let m = text.match(/^(优先级)([:：])([\s\S]*)$/)
    if (m) markTalents(m[3], lead + m[1].length + m[2].length, add, 'priority')
    else if ((m = text.match(/^(皇冠)([:：])([\s\S]*)$/))) markTalents(m[3], lead + m[1].length + m[2].length, add, 'crown')
  } else if (section === '命座推荐') {
    const m = text.match(/^([一二三四五六]命)([\s\S]*)$/)
    if (m && CN_NUM[m[1][0]]) add({ from: lead, to: lead + m[1].length, type: 'k', name: m[1] })
  } else if (section === '配队推荐') {
    const m = text.match(/^([^：:]{1,12})([:：])([\s\S]*)$/)
    if (m) {
      const value = m[3]
      const parts = value.split(MEMBER_SEP_RE).map(x => x.trim()).filter(Boolean)
      const hit = parts.filter(x => refs.charactersSet.has(x)).length
      // 与 parse-docx 的 parseMembers 同判据：至少一半能对上角色名才算队伍行
      if (parts.length >= 2 && hit >= Math.max(1, Math.floor(parts.length / 2))) {
        markMembers(value, lead + m[1].length + m[2].length, add, refs)
      }
    }
  }

  if (!spans.length) return { raw, text: raw, rebuilt: raw, spans, skipped: false, rejects }
  let marked
  try { marked = buildMarked(raw, spans) } catch { return { raw, text: raw, rebuilt: raw, spans: [], skipped: true, rejects } }
  // 自检：标记后文本去掉标记必须逐字等于原文（保证「只加标记，不改其它文字」）
  const rebuilt = marked.replace(markRe(), '$2')
  return { raw, text: marked, rebuilt, spans, skipped: false, rejects }
}

/* ------------------------------------------------------------------ *
 * 3. 文档结构：段落 → 角色块 → 标记计划 → document.xml
 * ------------------------------------------------------------------ */

const PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
const TEXT_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g

/** 遍历段落里的 <w:t>，得到「拼接文本的字符区间 → 节点」映射 */
function scanTextNodes (chunk) {
  const nodes = []
  let text = ''
  const re = new RegExp(TEXT_RE.source, 'g')
  let m
  while ((m = re.exec(chunk)) !== null) {
    const gt = m[0].indexOf('>')
    const decoded = unescapeXmlText(m[1])
    nodes.push({ index: m.index, innerStart: m.index + gt + 1, innerLen: m[1].length, text: decoded, start: text.length })
    text += decoded
  }
  return { nodes, text }
}

/** XML 文本反转义（与 docx.mjs 的 unescapeXml 同一套规则） */
function unescapeXmlText (s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

/** 按区间把标记切进对应的 <w:t>（自后向前替换，不破坏偏移；首尾空白与 xml:space 保持原样） */
function spliceIntoNodes (chunk, nodes, spans) {
  // 一个 <w:t> 里可能落进多个标记（如「第一档：A > B > C」只有一个 run），
  // 所以先按节点聚合，再对每个节点只用一次「基于原文的」重建，避免偏移串味。
  const perNode = new Map()
  for (const s of spans) {
    const touched = nodes.filter(n => n.start < s.to && n.start + n.text.length > s.from)
    if (!touched.length) return null
    const first = touched[0]
    const last = touched[touched.length - 1]
    if (first.start > s.from || last.start + last.text.length < s.to) return null
    for (const n of touched) {
      const list = perNode.get(n) ?? []
      list.push(s)
      perNode.set(n, list)
    }
  }
  const edits = []
  const pieces = [] // 段落级重建，用来复验「插标记后逐字还原」
  for (const n of nodes) {
    const list = perNode.get(n)
    if (!list) { pieces.push(n.text); continue }
    const cuts = new Map() // 节点内偏移 → 要插入的字符串
    const put = (at, text) => cuts.set(at, (cuts.get(at) ?? '') + text)
    for (const s of list) {
      const isStart = s.from >= n.start && s.from < n.start + n.text.length
      const isEnd = s.to > n.start && s.to <= n.start + n.text.length
      if (isStart) put(s.from - n.start, `[[${s.type}:`) // 起始在本节点才补开标记
      if (isEnd) put(s.to - n.start, ']]') // 结束在本节点才补闭标记（中间节点不加，否则会多个 ]])
    }
    let text = n.text
    for (const at of [...cuts.keys()].sort((a, b) => b - a)) text = text.slice(0, at) + cuts.get(at) + text.slice(at)
    pieces.push(text)
    edits.push({ index: n.index, innerStart: n.innerStart, innerLen: n.innerLen, replacement: escapeXml(text) })
  }
  // 复验：拼接后的段落文本 = 原文插标记（比较时忽略段落首尾空白）
  const joined = pieces.join('').replace(markRe(), '$2')
  const original = nodes.map(n => n.text).join('')
  if (joined.trim() !== original.trim()) return null
  edits.sort((a, b) => b.index - a.index)
  let out = chunk
  for (const e of edits) out = out.slice(0, e.innerStart) + e.replacement + out.slice(e.innerStart + e.innerLen)
  return out
}

/** 按分隔段切角色块：与 parse-docx 完全一致（丢掉空段） */
export function splitBlocks (paragraphs) {
  const blocks = []
  let cur = { lines: [], indices: [] }
  paragraphs.forEach((p, i) => {
    if (p === SEPARATOR) { blocks.push(cur); cur = { lines: [], indices: [] }; return }
    if (p === '') return
    cur.lines.push(p)
    cur.indices.push(i)
  })
  if (cur.lines.length) blocks.push(cur)
  return blocks.filter(b => b.lines.length)
}

/** 行 → 所属小节（与 parse-docx 的 section 识别一致） */
export function sectionsOf (block) {
  const sections = []
  let section = ''
  for (let i = 0; i < block.lines.length; i++) {
    const m = block.lines[i].trim().match(/^\d+\.\s*(武器推荐|圣遗物推荐|天赋加点|毕业面板参考|命座推荐|配队推荐)\s*$/)
    if (m) section = m[1]
    sections.push(i === 0 ? '' : section)
  }
  return sections
}

/**
 * 生成「去掉若干个标记」的候选集合：先整体，再依次少一个、少两个……（最多 maxTries 个）
 * @returns {Array<{spans: object[], dropped: object[]}>}
 */
export function spanSubsets (spans, maxTries = 200) {
  const out = [{ spans, dropped: [] }]
  if (!spans.length || maxTries <= 1) return out
  const idx = [...spans.keys()]
  const combos = []
  const walk = (start, picked) => {
    if (combos.length >= maxTries - 1) return
    if (picked.length) combos.push([...picked])
    for (let i = start; i < idx.length; i++) { picked.push(idx[i]); walk(i + 1, picked); picked.pop() }
  }
  walk(0, [])
  // 组合生成顺序天然是「先少后多」，直接按长度稳定排序一次
  combos.sort((a, b) => a.length - b.length)
  for (const kill of combos.slice(0, maxTries - 1)) {
    const set = new Set(kill)
    out.push({ spans: spans.filter((_, i) => !set.has(i)), dropped: kill.map(i => spans[i]) })
  }
  return out
}

/** 小节 → 该小节在文档里的标题行（parseBlock 靠它判断当前小节） */
const SECTION_HEADER = {
  武器推荐: '1. 武器推荐',
  圣遗物推荐: '2. 圣遗物推荐',
  天赋加点: '3. 天赋加点',
  毕业面板参考: '4. 毕业面板参考',
  命座推荐: '5. 命座推荐',
  配队推荐: '6. 配队推荐'
}
const SECTION_KEY = {
  武器推荐: 'weapons', 圣遗物推荐: 'artifacts', 天赋加点: 'talents',
  毕业面板参考: 'panels', 命座推荐: 'constellations', 配队推荐: 'teams'
}

/**
 * 单个候选标记集合的「回推校验」：标记后必须能被 parse-docx（未改动）解析出与原文完全一样的数据。
 * @returns {{ok: boolean, marked?: string, before: object, after?: object}}
 */
export function verifySpanSet (line, spans, section, index) {
  const head = ['某某 —— 建议等级：90级', SECTION_HEADER[section] ?? '']
  const before = parseBlock([...head, line], index)
  if (!spans.length) return { ok: false, before }
  let marked
  try { marked = buildMarked(line, spans) } catch { return { ok: false, before } }
  const after = parseBlock([...head, marked], index)
  const key = SECTION_KEY[section]
  const same = key
    ? eqJson([before.v2[key], before.unparsed], [after.v2[key], after.unparsed])
    : eqJson(before, after)
  if (!same) return { ok: false, before, after, marked }
  return { ok: true, marked, before, after }
}

/**
 * 规划整篇标记：段落索引 → {text, spans, section}
 *
 * 关键点：`优先级：`/`皇冠：`/命座这三类行在当前 parse-docx 下**打标记会改变回推结果**
 * （splitStats 会被 `[[` 切开、parseCrown 丢掉 `（建议）`、命座名不 strip 标记），
 * 所以这里逐行做回推校验：只要标记后解析结果与原文不一致，就撤回这些标记并记进 dropped。
 * 这样产物满足「标记只是让引用显式化，不改变语义」的硬要求；被撤回的明细写在报告里。
 */
export function planMarks (blocks, refs, index) {
  const plan = new Map()
  const intent = { w: 0, a: 0, c: 0, t: 0, k: 0 } // 按规则「应当」打的标记数
  const marks = { w: 0, a: 0, c: 0, t: 0, k: 0 } // 实际落盘的标记数
  const rejects = []
  const dropped = []
  const problems = []
  let markedLines = 0
  for (const block of blocks) {
    const sections = sectionsOf(block)
    for (let i = 0; i < block.lines.length; i++) {
      const section = sections[i]
      if (!section) continue
      const counters = { w: 0, a: 0, c: 0, t: 0, k: 0 }
      const res = markLine(block.lines[i], section, refs, counters)
      for (const r of res.rejects) rejects.push({ section, line: block.lines[i], name: r.name })
      for (const k of Object.keys(counters)) intent[k] += counters[k]
      if (res.skipped) { problems.push({ kind: '区间冲突', line: block.lines[i] }); continue }
      if (res.rebuilt !== res.raw) { problems.push({ kind: '文字被改动', line: block.lines[i], marked: res.text }); continue }
      if (!res.spans.length) continue
      if (index) {
        // 逐个退回「会改变回推语义」的标记，直到剩下的标记集合是无损的
        let accepted = null
        let lostMarks = null
        for (const cand of spanSubsets(res.spans, 200)) {
          const v = verifySpanSet(res.raw, cand.spans, section, index)
          if (v.ok) { accepted = { ...v, spans: cand.spans }; lostMarks = cand.dropped; break }
        }
        if (!accepted) {
          dropped.push({ section, line: res.raw, marks: res.spans.map(s => `[[${s.type}:${s.name}]]`), reason: '标记后 parse-docx 回推结果与原文不同（未修改 parse-docx 时无安全写法）' })
          continue
        }
        if (lostMarks.length) {
          dropped.push({ section, line: res.raw, marks: lostMarks.map(s => `[[${s.type}:${s.name}]]`), reason: '该行部分标记回推有损（如皇冠行的「（建议）」会丢），已撤回这些标记' })
        }
        for (const s of accepted.spans) marks[s.type]++
        plan.set(block.indices[i], { text: accepted.marked, spans: accepted.spans, section })
      } else {
        for (const s of res.spans) marks[s.type]++
        plan.set(block.indices[i], { text: res.text, spans: res.spans, section })
      }
      markedLines++
    }
  }
  return { plan, marks, intent, markedLines, rejects, dropped, problems }
}

/** 把标记计划写进 document.xml（按段落索引定位，在文本节点级切分） */
export function applyPlan (xml, plan) {
  let pi = 0
  let fallback = 0
  const out = xml.replace(PARA_RE, (chunk) => {
    const isEmpty = chunk.endsWith('/>')
    const thisIndex = pi++
    if (isEmpty) return chunk
    const item = plan.get(thisIndex)
    if (item == null) return chunk
    const { nodes } = scanTextNodes(chunk)
    const spans = item.spans
    const nodeEdit = new Map() // 节点 → 偏移 → 要插入的标记片段
    for (const s of spans) {
      const touched = nodes.filter(n => n.start < s.to && n.start + n.text.length > s.from)
      if (!touched.length) { fallback++; return chunk }
      const first = touched[0]
      const last = touched[touched.length - 1]
      if (first.start > s.from || last.start + last.text.length < s.to) { fallback++; return chunk }
      for (const n of touched) {
        const cuts = nodeEdit.get(n) ?? new Map()
        const put = (at, text) => cuts.set(at, (cuts.get(at) ?? '') + text)
        if (s.from >= n.start && s.from < n.start + n.text.length) put(s.from - n.start, `[[${s.type}:`) // 起始在本节点才补开标记
        if (n === last) put(s.to - n.start, ']]') // 结束在本节点才补闭标记（中间节点不加，否则会多个 ]])
        nodeEdit.set(n, cuts)
      }
    }
    // 复验：用这些 span 重建的整段文本必须与计划文本逐字相同（否则说明区间算错了）
    const rebuilt = nodes.map(n => {
      const cuts = nodeEdit.get(n)
      if (!cuts) return n.text
      let t = n.text
      for (const at of [...cuts.keys()].sort((a, b) => b - a)) t = t.slice(0, at) + cuts.get(at) + t.slice(at)
      return t
    }).join('')
    if (rebuilt.trim() !== item.text.trim()) { fallback++; return chunk }
    return spliceIntoNodes(chunk, nodes, spans)
  })
  return { xml: out, fallback }
}

/* ------------------------------------------------------------------ *
 * 4. 外部验收：用真正的 parse-docx.mjs 分别解析两份文档并深比较
 * ------------------------------------------------------------------ */

/** 跑一个 node 子进程（沙箱下子进程不能用管道 stdio，所以把输出重定向到文件再读） */
export function childRun (scriptPath, argv, cwd, outFile) {
  const ofd = fs.openSync(outFile, 'w')
  const efd = fs.openSync(outFile + '.err', 'w')
  let r
  try {
    r = spawnSync(process.execPath, [scriptPath, ...argv], { cwd, stdio: ['ignore', ofd, efd] })
  } finally {
    fs.closeSync(ofd)
    fs.closeSync(efd)
  }
  const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  const stderr = fs.existsSync(outFile + '.err') ? fs.readFileSync(outFile + '.err', 'utf8') : ''
  if (r.error) throw new Error(`无法启动子进程：${r.error.message}`)
  return { status: r.status, stdout, stderr }
}

/** --dry 先确认能解析（不写任何文件） */
export function parseDry (docx, tmpDir) {
  const out = path.join(tmpDir, 'dry-' + crypto.createHash('sha1').update(docx).digest('hex').slice(0, 8) + '.txt')
  const r = childRun(path.join(root, 'scripts', 'parse-docx.mjs'), [docx, '--dry'], root, out)
  if (r.status !== 0) throw new Error(`parse-docx --dry 失败（${r.status}）：${r.stderr.slice(0, 500)}`)
  const text = r.stdout
  // 输出形如「角色块：129」「武器行 222 / 圣遗物行 403 / …」「未识别行：0」
  // 输出形如「角色块：129」「武器行 222 / 圣遗物行 403 / …」「未识别行：0」；全角冒号要跳过去
  const num = (label) => {
    const m = text.match(new RegExp(label + '[^0-9]*([0-9]+)'))
    return m ? Number(m[1]) : null
  }
  const stats = {
    characters: num('角色块'),
    weapons: num('武器行'),
    artifacts: num('圣遗物行'),
    talents: num('天赋行'),
    panels: num('面板行'),
    constellations: num('命座'),
    teams: num('配队行'),
    unparsed: num('未识别行')
  }
  return { text, stats }
}

/** 真正解析并落盘到 dumpDir（parse-docx 自己没有 dump 选项，这里在临时目录里跑一个克隆） */
export function parseToJson (docx, dumpDir) {
  fs.rmSync(dumpDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dumpDir, 'scripts', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(dumpDir, 'data'), { recursive: true })
  fs.copyFileSync(path.join(here, 'parse-docx.mjs'), path.join(dumpDir, 'scripts', 'parse-docx.mjs'))
  for (const f of ['docx.mjs', 'schema.mjs']) fs.copyFileSync(path.join(here, 'lib', f), path.join(dumpDir, 'scripts', 'lib', f))
  fs.copyFileSync(path.join(dataDir, '_index.json'), path.join(dumpDir, 'data', '_index.json'))
  const abs = path.isAbsolute(docx) ? docx : path.resolve(root, docx)
  const r = childRun(path.join(dumpDir, 'scripts', 'parse-docx.mjs'), [abs], dumpDir, path.join(dumpDir, 'stdout.txt'))
  if (r.status !== 0) throw new Error(`parse-docx 失败（${r.status}）：${r.stderr.slice(0, 500)}`)
  const outGi = path.join(dumpDir, 'data', 'gi')
  const names = readJson(path.join(outGi, '_order.json'))
  const objs = names.map(n => readJson(path.join(outGi, `${n}.json`)))
  return { names, objs, stdout: r.stdout }
}

/** 全量比对两份解析结果 */
function compareParsed (a, b) {
  const diffs = []
  if (a.names.length !== b.names.length) diffs.push(`角色块数 ${a.names.length} → ${b.names.length}`)
  for (let i = 0; i < Math.min(a.names.length, b.names.length); i++) {
    if (a.names[i] !== b.names[i]) { diffs.push(`#${i + 1} 角色名 ${a.names[i]} → ${b.names[i]}`); continue }
    if (!eqJson(a.objs[i], b.objs[i])) {
      // 定位第一处不同
      const x = JSON.stringify(a.objs[i], null, 1).split('\n')
      const y = JSON.stringify(b.objs[i], null, 1).split('\n')
      let line = -1
      for (let j = 0; j < Math.max(x.length, y.length); j++) if (x[j] !== y[j]) { line = j; break }
      diffs.push(`#${i + 1} ${a.names[i]} 第 ${line + 1} 行不同：${(x[line] ?? '').trim()} vs ${(y[line] ?? '').trim()}`)
    }
  }
  return diffs
}

/** data/gi 快照（用于证明本脚本没有改动 data/gi/*.json） */
function snapshotGi () {
  const map = new Map()
  if (!fs.existsSync(giDir)) return map
  for (const f of fs.readdirSync(giDir)) {
    if (!f.endsWith('.json')) continue
    const buf = fs.readFileSync(path.join(giDir, f))
    map.set(f, crypto.createHash('sha256').update(buf).digest('hex'))
  }
  return map
}

/* ------------------------------------------------------------------ *
 * 5. 主流程
 * ------------------------------------------------------------------ */

function parseArgs (argv) {
  const args = { src: null, out: null, keepTmp: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
    else if (a === '--keep-tmp') args.keepTmp = true
    else if (a.startsWith('--')) throw new Error(`未知参数：${a}`)
    else if (!args.src) args.src = a
  }
  args.src = args.src ?? DEFAULT_DOC
  args.out = args.out ?? DEFAULT_OUT
  if (!path.isAbsolute(args.out)) args.out = path.join(root, args.out)
  return args
}

async function main () {
  const t0 = Date.now()
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.src)) {
    console.error(`找不到源文档：${args.src}`)
    process.exitCode = 1
    return
  }
  parseBlock = await loadParseBlock()
  const before = snapshotGi()
  const refs = loadRefs()
  const index = (() => { try { return readJson(path.join(dataDir, '_index.json')) } catch { return null } })()
  const report = {
    src: args.src, out: args.out, time: new Date().toISOString(),
    chars: { blocks: 0, lines: 0 },
    marks: { w: 0, a: 0, c: 0, t: 0, k: 0 }, intent: { w: 0, a: 0, c: 0, t: 0, k: 0 },
    markedLines: 0, rejects: [], dropped: [], problems: [],
    leftover: {}, idempotent: null, zip: null, verify: null, parse: null,
    note: '标记只覆盖「回推无损」的三类：[[w:武器]] [[a:圣遗物套装]] [[c:角色]]。' +
      '[[t:天赋]] 与 [[k:命座]] 未落盘：未修改的 scripts/parse-docx.mjs 会把标记原样带进 v2 —— ' +
      '天赋 `优先级：[[t:Q]] > [[t:E]]` 会被 splitStats 按 `[[`/`]]` 切开导致 order 变成空数组、' +
      '`皇冠：[[t:E]]（建议）` 因 parseCrown 的 `[（(]` 被 `]]` 隔开而丢掉 level；' +
      '命座分支不做 stripMarks，`[[k:二命]]` 会原样进 name 且 constellationIndex → 0。' +
      '所以本脚本对每个候选标记逐行做回推校验，凡会改变 v2 的一律撤回（见 dropped）。' +
      '将来若允许改 parse-docx.mjs，需要动三处：' +
      '(1) splitStats/priority 分支（约 56 行 / 280-284 行）：对 `[[t:X]]` 每个标记单独取字母，或在 splitItems/splitStats 前先 stripMarks 再解析；' +
      '(2) parseCrown（约 183-194 行）：先按标记逐个解析 `[[t:X]]`，再把紧随其后的 `（建议）` 作为 level；' +
      '(3) 命座分支（约 308-312 行）：name 先 stripMarks 再 constellationIndex，index 取数字。'
  }

  const src = readDocx(args.src)
  const blocks = splitBlocks(src.paragraphs)
  report.chars.blocks = blocks.length
  report.chars.lines = blocks.reduce((n, b) => n + b.lines.length, 0)

  // ---- 规划标记（逐行做回推校验） ----
  const { plan, marks, intent, markedLines, rejects, dropped, problems } = planMarks(blocks, refs, index)
  report.marks = marks
  report.intent = intent
  report.markedLines = markedLines
  report.rejects = rejects
  report.dropped = dropped
  report.problems = problems

  // ---- 覆盖率：数据里的 ref 名有多少在文档里被标记 ----
  for (const [type, list] of [['weapon', refs.weapons], ['artifact', refs.artifacts], ['character', refs.characters]]) {
    const letter = { weapon: 'w', artifact: 'a', character: 'c' }[type]
    const used = new Set()
    for (const item of plan.values()) for (const s of item.spans) if (s.type === letter) used.add(s.name)
    report.leftover[type] = { total: list.length, used: used.size, missing: list.filter(n => !used.has(n)) }
  }

  // ---- 写 document.xml 并组装输出（只换这一个部件） ----
  const applied = applyPlan(src.xml, plan)
  if (applied.fallback) report.problems.push({ kind: 'XML 定位失败', count: applied.fallback })
  const newXml = applied.xml
  const entries = new Map()
  for (const [name, buf] of src.entries) entries.set(name, name === 'word/document.xml' ? Buffer.from(newXml, 'utf8') : buf)
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  const w = writeDocx(entries, args.out)

  const fmtMarks = (m) => `w=${m.w} a=${m.a} c=${m.c} t=${m.t} k=${m.k}`
  console.log(`标记统计（请求 / 落盘）：w ${intent.w}/${marks.w}｜a ${intent.a}/${marks.a}｜c ${intent.c}/${marks.c}｜t ${intent.t}/${marks.t}｜k ${intent.k}/${marks.k}    合计 ${intent.w + intent.a + intent.c + intent.t + intent.k}/${marks.w + marks.a + marks.c + marks.t + marks.k}（落盘 ${fmtMarks(marks)}）`)
  console.log(`角色块 ${report.chars.blocks} / 文本行 ${report.chars.lines} / 有标记的行 ${markedLines}`)
  if (rejects.length) console.log(`保持原样（复合写法或带备注，包了会改变回推语义）：${rejects.length} 处`)
  if (dropped.length) {
    const bySection = {}
    for (const d of dropped) bySection[d.section] = (bySection[d.section] ?? 0) + d.marks.length
    console.log(`已撤回（parse-docx 未改时回推有损）：${dropped.length} 行 / ${dropped.reduce((n, d) => n + d.marks.length, 0)} 个标记 · ` +
      Object.entries(bySection).map(([s, n]) => `${s} ${n}`).join('，'))
  }

  // ---- c. zip 结构与部件完整性 ----
  const rt = readDocx(args.out)
  const need = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
  const missing = need.filter(n => !rt.entries.has(n))
  const changedOthers = []
  for (const [name, buf] of src.entries) {
    if (name === 'word/document.xml') continue
    const other = rt.entries.get(name)
    const sha = b => crypto.createHash('sha256').update(b).digest('hex')
    if (!other || sha(buf) !== sha(other)) changedOthers.push(name)
  }
  report.zip = {
    file: args.out, bytes: w.bytes, entries: w.count, stored: w.stored.length, deflated: w.deflated.length,
    missing, changedOthers, paragraphs: rt.paragraphs.length, paragraphsSrc: src.paragraphs.length,
    ok: missing.length === 0 && changedOthers.length === 0 && rt.paragraphs.length === src.paragraphs.length
  }
  console.log(`zip（c）：${w.count} 个部件（store ${w.stored.length} / deflate ${w.deflated.length}），${w.bytes} 字节；` +
    `必需部件${missing.length ? '缺失 ' + missing.join(',') : '齐全'}；其它部件${changedOthers.length ? '有改动 ' + changedOthers.join(',') : '与源逐字节一致'}；` +
    `段落 ${rt.paragraphs.length}（源 ${src.paragraphs.length}）→ ${report.zip.ok ? '通过' : '不通过'}`)

  // ---- 幂等自检：对标记版再跑一次 ----
  const idem = idempotence(rt, refs, index)
  report.idempotent = idem
  console.log(`幂等：对标记版再跑一次 → ${idem.equal ? '输出完全一致（二次新增标记 0 个、0 处文本变化）' : `不一致（二次仍标记 w=${idem.marks.w} a=${idem.marks.a} c=${idem.marks.c} t=${idem.marks.t} k=${idem.marks.k}，改动 ${idem.changedParas} 段）`}`)
  if (!idem.equal && idem.samples.length) for (const s of idem.samples.slice(0, 5)) console.log(`  · ${s}`)

  // ---- a/b. 用真正的 parse-docx 分别解析两份文档并深比较 ----
  const tmp = path.join(root, '.tmp', 'mark-verify')
  fs.mkdirSync(tmp, { recursive: true })
  let verifyOk = false
  let statsOk = false
  try {
    const a = parseToJson(args.src, path.join(tmp, 'src'))
    const b = parseToJson(args.out, path.join(tmp, 'marked'))
    const dryA = parseDry(args.src, tmp)
    const dryB = parseDry(args.out, tmp)
    const diffs = compareParsed(a, b)
    verifyOk = diffs.length === 0 && eqJson(b.names, a.names)
    statsOk = eqJson(dryA.stats, dryB.stats)
    report.verify = {
      dir: tmp,
      strict: {
        fields: 'schema/name/game/meta/v2/unparsed/tags/sections/source（parse-docx 落盘的整份 JSON）',
        before: { stats: dryA.stats, names: a.names.length },
        after: { stats: dryB.stats, names: b.names.length },
        diffs
      }
    }
    report.parse = { before: dryA.stats, after: dryB.stats }
    const fmt = (s) => `角色 ${s.characters}/武器 ${s.weapons}/圣遗物 ${s.artifacts}/天赋 ${s.talents}/面板 ${s.panels}/命座 ${s.constellations}/配队 ${s.teams}/未识别 ${s.unparsed}`
    console.log(`验收 a：parse-docx --dry  源「${fmt(dryA.stats)}」 vs 标记版「${fmt(dryB.stats)}」→ ${statsOk ? '统计完全一致' : '不一致'}`)
    console.log(`验收 b：把 parse 结果落盘后逐对象深比较（${report.verify.strict.fields}）→ ${verifyOk ? `${a.names.length}/${b.names.length} 完全相等` : '不一致：' + diffs.slice(0, 5).join(' ｜ ')}`)
  } catch (e) {
    report.verify = { error: String(e.message ?? e) }
    console.log(`验收 b：无法完成（${e.message ?? e}）`)
  }

  const after = snapshotGi()
  const giChanged = []
  for (const [f, h] of before) if (after.get(f) !== h) giChanged.push(f)
  for (const f of after.keys()) if (!before.has(f)) giChanged.push(f)
  console.log(`data/gi 未被改动：${giChanged.length ? '否！' + giChanged.join(',') : `是（${before.size} 个 JSON 哈希一致）`}`)

  for (const [type, info] of Object.entries(report.leftover)) {
    if (info.missing.length) console.log(`数据里有、文档未用到的 ${type}：${info.missing.length} 个${info.missing.length <= 8 ? '：' + info.missing.join('、') : ''}`)
  }
  if (problems.length) {
    console.log(`⚠ 行级问题 ${problems.length} 条：`)
    for (const p of problems.slice(0, 8)) console.log('  · ' + JSON.stringify(p).slice(0, 240))
  } else {
    console.log('行级自检：原文去掉标记后逐字等于原文（0 处改动，0 条问题）')
  }

  const ok = idem.equal && verifyOk && statsOk && report.zip.ok && problems.length === 0 && giChanged.length === 0
  console.log(`结论：${ok ? '全部验收通过' : '存在未通过项'}（耗时 ${Date.now() - t0} ms，临时解析目录 ${tmp}）`)
  if (!args.keepTmp) fs.rmSync(tmp, { recursive: true, force: true })

  report.ok = ok
  fs.mkdirSync(path.join(root, 'out'), { recursive: true })
  fs.writeFileSync(path.join(root, 'out', '_mark-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
  if (!ok) process.exitCode = 1
}

/**
 * 幂等自检：用刚才产出的（内存中的）标记文档重新规划一遍标记，
 * 若还有任何新增标记 / 文本变化，说明不幂等。
 * @param {{paragraphs: string[], xml: string}} rt 标记版文档
 */
export function idempotence (rt, refs, index) {
  const blocks = splitBlocks(rt.paragraphs)
  const { plan, marks, markedLines } = planMarks(blocks, refs, index)
  const applied = applyPlan(rt.xml, plan)
  const samples = []
  for (const [pi, item] of plan) {
    const line = rt.paragraphs[pi]
    if (samples.length < 12 && line !== item.text) samples.push(`${(blocks.find(b => b.indices.includes(pi))?.parsed?.name) ?? ''}｜${line} → ${item.text}`)
  }
  return { equal: applied.xml === rt.xml, marks, markedLines, changedParas: plan.size, fallback: applied.fallback, samples }
}

/** 供脚本/测试复用：对一份文档做「规划 + 应用」，返回新 xml 与统计 */
export function markDocument (paragraphs, xml, refs, index) {
  const { plan, marks, markedLines, rejects, problems } = planMarks(splitBlocks(paragraphs), refs, index)
  const applied = applyPlan(xml, plan)
  return { xml: applied.xml, fallback: applied.fallback, marks, markedLines, rejects, problems, plan }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
