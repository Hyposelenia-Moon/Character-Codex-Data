/**
 * 角色攻略数据模式 v2
 *
 * 设计目标（A+B 路线）：
 *  - A：Word 文档里，凡是「需要引用图标」的实体都用标记包起来（[[w:武器名]] 等），
 *       转换器据此知道该用哪个解析器，不再靠猜。
 *  - B：JSON 里每个字段独立成结构化字段（sections.*），引用单独存放（{name, ref, note}），
 *       图标、跳转、错别字校验全部基于 ref。
 *
 * 兼容：sections（旧版文本行）与 tags 由本模块从结构化字段**回推**，
 *       现有渲染器（build-html.mjs / build-doc.mjs / 插件）无需改动即可继续工作。
 *
 * 用法：
 *   import { deriveTags, deriveSections, parseRef, stripMarks, validate } from './lib/schema.mjs'
 */

/** 标记类型 → ref 前缀 */
export const MARK_TYPES = { w: 'weapon', a: 'artifact', c: 'character', t: 'talent', k: 'constellation' }

/** [[w:名称]] 形式的引用标记 */
export const MARK_RE = /\[\[([wactk])[:：]([^[\]]+?)\]\]/g

/** 天赋字母（图标按 A/E/Q 顺序对应 0/1/2） */
export const TALENT_ORDER = ['A', 'E', 'Q']

/**
 * 主词条「部位之间」的并列分隔符 —— 全角竖线。
 * 三个槽位（时之沙 / 空之杯 / 理之冠）是并列关系，不是优先级，所以**不能**用 `＞`；
 * 部位内部的候选值仍用 `/`，副词条的优先级仍用 `＞`。
 * 文档行（本模块 deriveSections）、网页版（build-html.mjs）、面板（插件 parse.js）三处必须一致。
 */
export const MAIN_SLOT_SEP = '｜'

/** 档位中文数字 */
const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八']

/** 构造 ref 字符串 */
export function makeRef (type, name) {
  return `${type}:${String(name).trim()}`
}

/** 拆解 ref 字符串 */
export function parseRef (ref) {
  const s = String(ref ?? '')
  const i = s.indexOf(':')
  if (i < 0) return { type: '', name: s.trim() }
  return { type: s.slice(0, i).trim(), name: s.slice(i + 1).trim() }
}

/** 去掉文本里的标记，只留名称（用于旧版 sections / 纯文本输出） */
export function stripMarks (text) {
  return String(text ?? '').replace(MARK_RE, '$2')
}

/** 抽取文本里所有标记 → [{type, name, raw}] */
export function extractMarks (text) {
  const out = []
  const re = new RegExp(MARK_RE.source, 'g')
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) {
    out.push({ type: MARK_TYPES[m[1]] ?? m[1], name: m[2].trim(), raw: m[0] })
  }
  return out
}

/** 备注行前缀（文档 ↔ JSON 的备注走廊） */
export const NOTE_PREFIX = '注：'

/** 备注行里多条备注的分隔符（同一段落有多条备注时合并成一行） */
export const NOTE_SEP = '；'

/** 一条「段末备注」行：`注：<文本>`。备注行固定追加在所属段落数组的末尾位置 */
export function isNoteRow (row) {
  return !!row && typeof row === 'object' && row.kind === 'note'
}

/** 备注行文本（去掉前缀） */
export function noteText (row) {
  return stripMarks(String(row?.text ?? '')).trim()
}

/** 「注：」行 → 备注文本；不是备注行返回 null */
export function parseNoteLine (line) {
  const m = String(line ?? '').trim().match(/^注\s*[:：]\s*(.*)$/)
  return m ? m[1].trim() : null
}

/**
 * 把一个数组里的备注行合并成**一行**备注文本（多条用 `；` 分隔）。
 * 备注行在数组里的位置不参与渲染 —— 文档里统一放在段末（`注：` 紧跟该段最后一行）。
 * @param {Array} rows
 * @returns {string}
 */
export function collectNotes (rows) {
  const parts = (rows ?? []).filter(isNoteRow).map(noteText).filter(Boolean)
  return parts.join(NOTE_SEP)
}

/**
 * 数组 → 「A > B > C」。
 *
 * ⚠ `sep` 是**逐档**分隔符（`' / + '` ＝ 第一档 `/`、第二档 `+`），必须逐档展开；
 * 直接 `items.join(sep)` 会把整串 sep 塞进每个间隔 —— `' > = '` 拼出 `A > = B > = C`，
 * 解析回来空档被丢掉、只剩 `' > '`，`docx → data` 与数据不一致，每日回写就会因往返校验
 * 失败而**放弃写主文档**（用户 2026-09-21 在瓦雷莎的武器行踩到）。
 */
export function joinItems (items, sep = ' > ') {
  return joinWithSep(items, sep, ' > ')
}

/** 单个条目 → 文本（名称 +（备注）） */
export function itemText (item) {
  if (item == null) return ''
  if (typeof item === 'string') return stripMarks(item)
  const name = stripMarks(item.name ?? item.text ?? '')
  const note = item.note ? `（${stripMarks(item.note)}）` : ''
  const level = item.level ? `（${stripMarks(item.level)}）` : ''
  return `${name}${note}${level}`
}

/** 命座名 → 序号（二命 → 2），取不到返回 0 */
export function constellationIndex (name) {
  const s = String(name ?? '')
  const cn = s.match(/^([一二三四五六])命/)
  if (cn) return CN_NUM.indexOf(cn[1])
  const n = s.match(/(\d+)\s*命/)
  return n ? Number(n[1]) : 0
}

/* ------------------------------------------------------------------ *
 * 备注（括注）走廊：JSON 侧存**原始括注文本**，文档侧渲染**语义化润色**
 * ------------------------------------------------------------------ */

/**
 * 原始括注 → 文档里的备注文本（语义化润色）
 *
 * 目的是「让括号里的东西读起来是给人看的一句话」，同时保持**可逆**：
 * `unpolishNoteText` 必须能把润色结果还原成同一份原始括注，这样
 * parse-docx → build-docx → parse-docx 才能 129/129 深度相等且逐字节幂等。
 *
 * 规则（认不出语义的一律**原样保留**括注文本）：
 *   `二命`（主词条数值上）→ `建议二命及以上使用<该词条>`
 *   `二命`               → `建议二命及以上`
 *   `2命`                → `建议二命及以上`
 *   `高金`               → `高金配置`
 *   `中金` / `低金`       → `<原样>配置`
 *   `随命座`              → `随命座变化`
 *   其它                  → 原样
 *
 * @param {string} note 原始括注文本（JSON 里的 note / 备注行 text）
 * @param {{section?: string, stat?: string}} [ctx] 上下文（段落 / 主词条数值）
 * @returns {string}
 */
/**
 * 把「原始括注」润色成文档里的备注文本。
 * 只做**可逆**润色（`unpolishNoteText` 能还原成同一份原始括注），否则原样返回，
 * 这样 `parse-docx → build-docx → parse-docx` 不会漂移。
 * @param {string} raw 原始括注（JSON 里的 note / 备注行 text）
 * @param {{stat?: string}} [ctx] 主词条上下文（如 `水元素伤害加成`）
 */
export function polishNoteText (raw, ctx = {}) {
  const s = stripMarks(String(raw ?? '')).trim()
  if (!s) return ''
  const guess = () => {
    if (/^[一二三四五六\d]+\s*命$/.test(s)) {
      const cn = CN_NUM[constellationIndex(s)] ?? s.replace(/\s*命$/, '')
      const base = `建议${cn}命及以上`
      return ctx.stat ? `${base}使用${ctx.stat}` : base
    }
    if (s === '高金') return '高金配置'
    if (s === '中金' || s === '低金') return `${s}配置`
    if (s === '随命座') return '随命座变化'
    return s
  }
  return unpolishNoteText(guess(), { stats: ctx.stat ? [ctx.stat] : [] }) === s ? guess() : s
}

/**
 * 文档里的备注文本 → JSON 侧的原始括注（`polishNoteText` 的逆）
 * 认不出来的原样返回（用户手写的备注不会被改写）。
 * @param {string} text
 * @param {{stats?: string[]}} [ctx] 主词条候选值（用来剥掉「使用<词条>」后缀）
 * @returns {string}
 */
export function unpolishNoteText (text, ctx = {}) {
  const s = stripMarks(String(text ?? '')).trim()
  if (!s) return ''
  const use = s.match(/^建议([一二三四五六\d]+)命及以上使用(.+)$/)
  if (use) {
    const stat = use[2].trim()
    if (!ctx.stats || !ctx.stats.length || ctx.stats.includes(stat)) return `${use[1]}命`
    return s
  }
  const plain = s.match(/^建议([一二三四五六\d]+)命及以上$/)
  if (plain) return `${plain[1]}命`
  if (s === '高金配置') return '高金'
  const tier = s.match(/^(中金|低金)配置$/)
  if (tier) return tier[1]
  if (s === '随命座变化') return '随命座'
  return s
}

/**
 * 段落数组里的**全部主词条值**（给备注润色当上下文用）
 * @param {Array} rows
 * @returns {string[]}
 */
export function artifactStatPool (rows) {
  const main = (rows ?? []).find(r => r && r.kind === 'main' && r.stats)
  if (!main) return []
  return ['时之沙', '空之杯', '理之冠'].flatMap(k => main.stats[k] ?? []).map(x => stripMarks(x)).filter(Boolean)
}

/**
 * 段落级备注润色：`二命` → `建议二命及以上使用水元素伤害加成`（本段有主词条时）。
 * 判据是「润色结果能反向还原成同一份原始括注」，否则退化成不带词条的写法。
 * @param {Array} rows 该段的数组
 * @param {string} raw 原始括注
 */
export function polishNoteInSection (rows, raw) {
  const s = stripMarks(String(raw ?? '')).trim()
  if (!s) return ''
  const pool = artifactStatPool(rows)
  for (const stat of [...pool].reverse()) {
    const t = polishNoteText(s, { stat })
    if (unpolishNoteText(t, { stats: [stat] }) === s) return t
  }
  return polishNoteText(s)
}

/**
 * 备注文本 ↔ 原始括注的双向映射（parse-docx / build-docx 共用同一套判定）。
 *
 * - `readPool`（解析侧）：文档里的备注文本 → 原始括注。`使用<词条>` 后缀只在词条命中候选时剥掉。
 * - `polishPool`（渲染侧）：原始括注 → 文档里的润色文本。候选词条按倒序试，取第一个能无损往返的。
 *
 * 返回 null 表示这段文本**不是备注**（认不出语义），调用方保持原文不动。
 * @param {string} text
 * @param {{readPool?: string[], polishPool?: string[]}} [ctx]
 * @returns {{raw: string, polished: string} | null}
 */
export function resolveNoteText (text, ctx = {}) {
  const t = stripMarks(String(text ?? '')).trim()
  if (!t) return null

  // 渲染侧：原始括注 → 润色文本
  if (ctx.polishPool) {
    if (!isCostNoteText(t)) return null
    for (const stat of [...ctx.polishPool].reverse()) {
      const p = polishNoteText(t, { stat })
      if (unpolishNoteText(p, { stats: [stat] }) === t) return { raw: t, polished: p }
    }
    const p = polishNoteText(t)
    return unpolishNoteText(p) === t ? { raw: t, polished: p } : { raw: t, polished: t }
  }

  // 解析侧：文档文本 → 原始括注
  const pool = ctx.readPool ?? []
  const hasSuffix = /^建议[一二三四五六\d]+命及以上使用/.test(t)
  if (hasSuffix) {
    const stat = t.replace(/^.*及以上使用/, '').trim()
    if (pool.length && !pool.includes(stat)) return null
    return { raw: unpolishNoteText(t, { stats: pool }), polished: t }
  }
  if (isCostNoteText(t)) return { raw: t, polished: polishNoteText(t) }
  const raw = unpolishNoteText(t)
  return raw === t ? null : { raw, polished: t }
}

/**
 * `100级提升` = 0 的判据：`0` / `0%` / `0%（收益可忽略）` 都算 0，`约 5%`、`0.5%` 不算。
 * 末尾用「除数字和点以外的任意字符」收尾，所以 `0%`、`0%（收益可忽略）` 都能匹配，
 * 而 `0.5%` 会因为 `.5` 不是数字/点以外的字符而不匹配。
 */
export const ZERO_POWER_RE = /^[+＋]?0+(?:\.0+)?[%％]?(?:[^0-9.]*)$/

/**
 * 由结构化字段回推 tags（旧版渲染器读它）
 *
 * `100级提升` 为 `0` / `0%`（或没填）时**不产出这一条** —— 没有信息量的行不显示；
 * 显示侧（scripts/lib/guide-display.mjs）也会再挡一层，保证网页版与面板一致。
 * @param {object} data
 * @returns {Array<{text: string, style: string}>}
 */
export function deriveTags (data) {
  const m = data?.meta ?? {}
  const tags = []
  const power = stripMarks(m['100级提升'] ?? '').trim()
  if (m['建议等级']) tags.push({ text: `建议等级：${stripMarks(m['建议等级'])}`, style: 'level' })
  if (m['定位']) tags.push({ text: `定位：${stripMarks(m['定位'])}`, style: 'role' })
  // 100级提升：没填（含占位符 ___）或 0 / 0% 都不显示
  if (power && !power.includes('___') && !ZERO_POWER_RE.test(power)) {
    tags.push({ text: `100级提升：${power}`, style: 'power' })
  }
  return tags
}

/**
 * 结构化字段 → 旧版文本行（与 Word 文档里的行一一对应）
 *
 * 备注（`{kind:'note', text}`）在**每个段落数组末尾**渲染成一行 `注：<文本>`：
 * 同一段里有多条备注时合并成一行、用 `；` 分隔。这样正文行始终是干净的标准名/标准词条
 * （能取到图鉴图标），而括注信息不会丢 —— 见 README「备注行」一节。
 */
export function deriveSections (data) {
  const s = data?.v2 ?? {}
  const out = []
  /** 段落数组里的备注行 → 段末 `注：` 文本（**整行原样**，多条 `；` 分隔） */
  const sectionNote = (rows) => {
    // 备注文本在数据里就是「要显示的文本」（parse-docx 入库时已认过语义、编辑器改过就是新值）：
    // 这里**不再二次润色** —— 面板渲染的是同一条 `text`，再润色一次会让网页版 / 文档
    // 显示成 `建议二命及以上` 而面板显示 `二命`（两端漂移）。
    return (rows ?? []).filter(isNoteRow).map(noteText).filter(Boolean).join(NOTE_SEP)
  }
  /** 把段落数组渲染成「正文行 + 段末备注行」 */
  const pushSection = (title, lines, note) => {
    const body = (lines ?? []).map(x => stripMarks(String(x)).trim()).filter(Boolean)
    if (note) body.push(`${NOTE_PREFIX}${note}`)
    if (body.length) out.push({ title, lines: body })
  }

  // 1. 武器推荐
  const w = []
  for (const row of s.weapons ?? []) {
    if (isNoteRow(row)) continue
    for (const line of renderWeaponRow(row)) w.push(line)
  }
  pushSection('1. 武器推荐', w, sectionNote(s.weapons))

  // 2. 圣遗物推荐
  const a = []
  for (const row of s.artifacts ?? []) {
    if (isNoteRow(row)) continue
    for (const line of renderArtifactRow(row)) a.push(line)
  }
  pushSection('2. 圣遗物推荐', a, sectionNote(s.artifacts))

  // 3. 天赋加点
  const t = []
  for (const row of s.talents ?? []) {
    if (isNoteRow(row)) continue
    // priority：**逐条写字母 + 等级**（`E10 ＞ Q10 ＞ A1`，没有等级的就只写字母 `E ＞ Q`）
    // —— 等级是结构化字段（{name, level, crown}），文档里用紧凑写法 `E10` 表达，解析侧能读回
    if (row.kind === 'priority') t.push(talentLevelLine(row))
    else if (row.kind === 'crown') t.push(`皇冠：${(row.items ?? []).map(crownItemText).join('')}`)
  }
  pushSection('3. 天赋加点', t, sectionNote(s.talents))

  // 4. 毕业面板参考
  const p = []
  for (const row of s.panels ?? []) {
    if (isNoteRow(row)) continue
    const label = row.label ? `${stripMarks(row.label)}：` : ''
    if (row.k != null) p.push(`${label}${stripMarks(row.k)}：${stripMarks(row.v ?? '')}`)
    else if (row.text) p.push(`${label}${stripMarks(row.text)}`)
  }
  pushSection('4. 毕业面板参考', p, sectionNote(s.panels))

  // 5. 命座推荐
  const k = []
  for (const row of s.constellations ?? []) {
    if (isNoteRow(row)) continue
    k.push(row.text ? `${stripMarks(row.name)}——${stripMarks(row.text)}` : stripMarks(row.name))
  }
  pushSection('5. 命座推荐', k, sectionNote(s.constellations))

  // 6. 配队推荐
  const team = []
  for (const row of s.teams ?? []) {
    if (isNoteRow(row)) continue
    const label = row.label ? `${stripMarks(row.label)}：` : ''
    const members = joinItems(row.members, ' + ')
    const text = stripMarks(row.text ?? '')
    team.push(`${label}${[members, text].filter(Boolean).join(' / ')}`)
  }
  pushSection('6. 配队推荐', team, sectionNote(s.teams))

  return out
}

/** 天赋等级行的行首标记（面板 / 文档 / 网页版共用的展示口径） */
export const TALENT_PREFIX = '天赋：'
/** 旧的行首标记（解析侧仍兼容旧文档） */
export const TALENT_PREFIX_LEGACY = '优先级：'

/**
 * 天赋等级行 → 文档文本（**固定顺序 A → E → Q，不用 `＞`**）
 *
 * 写法：`A1 E10 Q10`（数字 1..10，10 = 已投皇冠；缺省按 1）。三格固定顺序与面板一致，
 * 优先级顺序不再用于展示（但数据里的 `order` / `raw` 仍保留，便于回溯）。
 *
 * ⚠️ 主格式用**空格**分隔；备选写法是 `A1｜E10｜Q10`（全角竖线）。解析侧两种都认。
 * @param {object} row
 * @param {{sep?: string, prefix?: string}} [opts] sep=分隔符（默认空格）、prefix=行首（默认 `天赋：`）
 * @returns {string}
 */
export function talentLevelLine (row, opts = {}) {
  const sep = opts.sep === undefined ? ' ' : String(opts.sep)
  const prefix = opts.prefix === undefined ? `${TALENT_PREFIX}` : opts.prefix
  const byName = new Map()
  for (const it of row?.order ?? []) {
    const name = String(typeof it === 'string' ? it : (it?.name ?? '')).trim().toUpperCase()
    if (!/^[AEQ]$/.test(name)) continue
    const rawLv = typeof it === 'object' && it !== null ? it.level : undefined
    const lv = Number(rawLv)
    const crowned = typeof it === 'object' && it !== null && it.crown === true
    const level = crowned ? 10 : (Number.isInteger(lv) && lv >= 1 && lv <= 10 ? lv : 1)
    byName.set(name, level)
  }
  if (!byName.size) return stripMarks(row?.raw ?? '') || ''
  return prefix + TALENT_ORDER.map(name => `${name}${byName.has(name) ? byName.get(name) : 1}`).join(sep)
}

/**
 * @deprecated 旧版「优先级行」写法（`E10 ＞ Q10 ＞ A1`）。保留导出只为兼容，正式输出用 talentLevelLine。
 */
export function priorityLine (row) {
  const order = (row?.order ?? []).map(it => {
    const name = String(typeof it === 'string' ? it : (it?.name ?? '')).trim().toUpperCase()
    if (!/^[AEQ]$/.test(name)) return null
    const rawLv = typeof it === 'object' && it !== null ? it.level : undefined
    const lv = Number(rawLv)
    const crowned = typeof it === 'object' && it !== null && it.crown === true
    const level = crowned ? 10 : (Number.isInteger(lv) && lv >= 1 && lv <= 10 ? lv : 1)
    return { name, level }
  }).filter(Boolean)
  if (!order.length) return stripMarks(row?.raw ?? '') || ''
  const rawSeps = String(row?.raw ?? '').split(/[AEQaeq0-9\s]+/).filter(s => /[>＞≥＝=/／]/.test(s))
  const sep = (i) => rawSeps[i] || (row?.sep ? String(row.sep) : '') || '＞'
  return order.map((it, i) => `${it.name}${it.level}${i < order.length - 1 ? sep(i) : ''}`).join('')
}

/**
 * 皇冠行条目 → 文本：`E（10）`、`E（10·建议）`（等级 + 可选建议用 `·` 连，避免两层括号）
 * @param {object} item
 * @returns {string}
 */
export function crownItemText (item) {
  if (item == null) return ''
  if (typeof item === 'string') return stripMarks(item)
  const name = stripMarks(item.name ?? '')
  const lv = Number(item.level)
  const level = Number.isInteger(lv) && lv >= 1 && lv <= 10 ? String(lv) : ''
  const note = item.note ? stripMarks(item.note) : ''
  const inside = [level, note].filter(Boolean).join('·')
  return `${name}${inside ? `（${inside}）` : ''}`
}

/** 单条武器行 → 文本行 */
export function renderWeaponRow (row) {
  // **自定义档位词优先**（与圣遗物行 / 显示层同口径）：`label` 非空时它就是这一行的标签
  // （`建议：西风剑`），此时**不再写** `第N档：` —— 否则会拼出 `建议：第一档：西风剑`，
  // 那是 parse-docx 认不出的写法（往返必然丢 tier / 多出一个假条目）。
  const label = row.label ? `${stripMarks(row.label)}：` : ''
  const tier = !row.label && row.tier ? `第${CN_NUM[row.tier] ?? row.tier}档：` : ''
  const items = joinItems(row.items, row.sep ?? ' > ')
  const text = `${label}${tier}${items}`.trim()
  return text ? [text] : []
}

/**
 * 把 `sep` 拆成「逐档分隔符」token 列表。
 *
 * v2 里 sep 是**逐档**分隔符按空白拼接的结果（插件 model/codexIndex/parse.js 的 gapSeps 就这么读）：
 *   `' / '`   → 每个间隔都是 /
 *   `' / + '` → 第一个间隔是 /，第二个是 +（「A / B + C」）
 * 用单 token 当整体 join 会 join 出一堆空条目（`A / / + B`），所以渲染时按 token 逐档拼。
 * @param {string} sep
 * @param {number} count 需要的间隔数
 * @param {string} fallback 不足时的兜底
 * @returns {string[]}
 */
export function sepTokens (sep, count, fallback = ' / ') {
  const tokens = String(sep ?? '').trim().split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 0; i < Math.max(0, count); i++) out.push(` ${tokens[i] ?? tokens[tokens.length - 1] ?? fallback.trim()} `)
  return out
}

/** 按逐档分隔符连接条目（与 sepTokens 配套） */
export function joinWithSep (items, sep, fallback = ' / ') {
  const list = (items ?? []).map(x => (typeof x === 'string' ? stripMarks(x) : itemText(x))).filter(Boolean)
  if (list.length < 2) return list.join('')
  const seps = sepTokens(sep, list.length - 1, fallback)
  let out = list[0]
  for (let i = 1; i < list.length; i++) out += seps[i - 1] + list[i]
  return out
}

/**
 * 这条括注算不算「备注走廊」里的一条（命座 / 成本 / 随命座 类）。
 * 只有这一类会被移出正文：主词条上留行内括注，其它段落进段末 `注：` 行。
 * `（精五）` `（叠满）` `（满命）` `（建议）` `（特殊）` `（华馆）` 等**不算**，保持原样不动。
 * @param {string} text
 */
export function isCostNoteText (text) {
  const s = stripMarks(String(text ?? '')).trim()
  if (!s) return false
  if (/^[一二三四五六\d]+\s*命$/.test(s)) return true
  return /^(高金|中金|低金|随命座)$/.test(s)
}

/**
 * 主词条行上的**行内括注**：`主词条：… / 空之杯：水元素伤害加成（二命） / 理之冠：…`
 *
 * 主词条的括注要指回**具体那个杯/沙/冠**，所以它不像其它备注那样单起一行 `注：`，
 * 而是挂在**该词条值后面**（全角括号，括注文本与 JSON 里的 `note` 逐字相同 —— 不润色，
 * 这样 parse-docx → build-docx → parse-docx 才不会漂移）。
 *
 * ⚠ **任何括注都要写**（2026-09-20 修订）：以前只写「命座 / 成本」类括注（`isCostNoteText`），
 * 于是 `（特殊）` `（华馆）` `（西风）` 这类限定被**文档层丢掉** —— 网页版读文档行，就跟着看不见
 * （面板读 `note` 字段所以还能显示）→ 两条链路不一致。现在一律写进文档行，
 * 显示层再把行尾括注折回小字备注（见 guide-display 的 normalizeArtifactRows）。
 * @param {object} row
 * @returns {string} 要附在行尾的括注（含全角括号），没有则 ''
 */
export function mainRowNoteSuffix (row) {
  const raw = stripMarks(String(row?.note ?? '')).trim()
  if (!raw) return ''
  return `（${raw}）`
}

/** 主词条行 JSON 里 `note` 该挂在哪个部位（没有 noteSlot 时按本行顺序取第一个落点） */
export function pickMainNoteSlot (row) {
  const raw = stripMarks(String(row?.note ?? '')).trim()
  if (!raw) return null
  const st = row.stats ?? {}
  const slots = ['时之沙', '空之杯', '理之冠'].filter(k => (st[k] ?? []).length)
  if (!slots.length) return null
  if (row.noteSlot && slots.includes(row.noteSlot)) return row.noteSlot
  return slots.find(k => !(st[k] ?? []).some(v => /[（(]/.test(stripMarks(v)))) ?? null
}

/**
 * 主词条行：把每个词条值按需补上括注，再拼成一行。
 *
 * 分隔符语义（重要，别改回去）：
 *   · **部位之间**（时之沙 → 空之杯 → 理之冠）是**并列**关系，用全角竖线 `｜`
 *   · **部位内部**的候选值（同一部位里的备选）用 `/`
 *   · 副词条的优先级关系才用 `＞`（由显示层处理，这里不碰）
 * @param {object} row
 * @param {string} label
 * @returns {string}
 */
function mainStatsLine (row, label) {
  const st = row.stats ?? {}
  const slots = ['时之沙', '空之杯', '理之冠'].filter(k => (st[k] ?? []).length)
  if (!slots.length) return ''
  const raw = stripMarks(String(row.note ?? '')).trim()
  const note = raw ? `（${raw}）` : ''
  const slot = note ? pickMainNoteSlot(row) : null
  const parts = slots.map(k => {
    let list = (st[k] ?? []).map(stripMarks)
    if (note && k === slot && !list.some(v => v.includes('（') || v.includes('('))) {
      list = [...list]
      list[list.length - 1] = list[list.length - 1] + note
    }
    return `${k}：${list.join(' / ')}`
  })
  return `${label}主词条：${parts.join(MAIN_SLOT_SEP)}${note && !slot ? note : ''}`
}

/** 单条圣遗物行 → 文本行 */
export function renderArtifactRow (row) {
  const label = row.label ? `${stripMarks(row.label)}：` : ''
  switch (row.kind) {
    case 'preferred':
    case 'transition':
    case 'optional': {
      // 这里是**文档词汇**（首选 / 过渡 / 可选），不是显示词汇 ——
      // deriveSections 的产物要能被 parse-docx 逐字读回（doc → JSON → doc 往返），
      // 而 parse-docx 只认 `首选|次选|可选|过渡|套装`、**不认 `推荐`**，所以必须保持来源写法。
      // 同一份映射的共享定义见 scripts/lib/guide-display.mjs 的 ARTIFACT_KIND_LABEL
      // （插件侧只取那一份、再经 displayLabel 归一出显示词）；改这里请同步那一份。
      const head = { preferred: '首选', transition: '过渡', optional: '可选' }[row.kind]
      const sets = (row.sets ?? []).map(x => {
        const name = stripMarks(x.name ?? x)
        const pieces = x.pieces ? `（${stripMarks(x.pieces)}）` : ''
        return `${name}${pieces}`
      })
      const body = joinWithSep(sets, row.sep, ' / ')
      // label 就是文档里的原词（首选 / 可选 / 过渡 / 输出向…），有 label 就不再套 kind 的头词
      const text = `${label}${row.label ? '' : (row.title ? `${stripMarks(row.title)}：` : head + '：')}${body}`.trim()
      return text ? [text] : []
    }
    case 'main': {
      const line = mainStatsLine(row, label)
      return line ? [line] : []
    }
    case 'sub': {
      const stats = (row.stats ?? []).map(stripMarks)
      return stats.length ? [`${label}副词条：${joinWithSep(stats, row.sep, ' / ')}`] : []
    }
    case 'text':
      return row.text ? [`${label}${stripMarks(row.text)}`] : []
    default:
      return row.text ? [`${label}${stripMarks(row.text)}`] : []
  }
}

/**
 * 校验所有 ref 是否命中图鉴标准名
 * @param {object} data
 * @param {{weapons?: Iterable<string>, artifacts?: Iterable<string>, characters?: Iterable<string>}} index
 * @returns {Array<{where: string, ref: string, reason: string}>}
 */
export function validate (data, index = {}) {
  const w = new Set(index.weapons ?? [])
  const a = new Set(index.artifacts ?? [])
  const c = new Set(index.characters ?? [])
  const issues = []
  const check = (where, item) => {
    if (isNoteRow(item)) return
    const ref = typeof item === 'string' ? item : item?.ref
    if (!ref) return
    const { type, name } = parseRef(ref)
    if (type === 'weapon' && w.size && !w.has(name)) issues.push({ where, ref, reason: '武器名不在图鉴' })
    else if (type === 'artifact' && a.size && !a.has(name)) issues.push({ where, ref, reason: '圣遗物名不在图鉴' })
    else if (type === 'character' && c.size && !c.has(name)) issues.push({ where, ref, reason: '角色名不在图鉴' })
    else if (type === 'talent' && !/^[AEQ]$/i.test(name)) issues.push({ where, ref, reason: '天赋应为 A/E/Q' })
    else if (type === 'constellation' && !/^\d$/.test(name)) issues.push({ where, ref, reason: '命座应为 1-6' })
    else if (!type) issues.push({ where, ref, reason: '缺少类型前缀' })
  }
  for (const row of data?.v2?.weapons ?? []) (row.items ?? []).forEach(it => check('武器推荐', it))
  for (const row of data?.v2?.artifacts ?? []) (row.sets ?? []).forEach(it => check('圣遗物推荐', it))
  for (const row of data?.v2?.teams ?? []) (row.members ?? []).forEach(it => check('配队推荐', it))
  for (const row of data?.v2?.talents ?? []) {
    if (row.kind === 'priority') (row.order ?? []).forEach(it => check('天赋加点', it))
    if (row.kind === 'crown') (row.items ?? []).forEach(it => check('天赋加点', it))
  }
  return issues
}
