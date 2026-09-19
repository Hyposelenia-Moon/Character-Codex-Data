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

/** 数组 → 「A > B > C」 */
export function joinItems (items, sep = ' > ') {
  return (items ?? []).map(x => (typeof x === 'string' ? x : itemText(x))).filter(Boolean).join(sep)
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

/**
 * 由结构化字段回推 tags（旧版渲染器读它）
 * @param {object} data
 * @returns {Array<{text: string, style: string}>}
 */
export function deriveTags (data) {
  const m = data?.meta ?? {}
  const tags = []
  if (m['建议等级']) tags.push({ text: `建议等级：${stripMarks(m['建议等级'])}`, style: 'level' })
  if (m['定位']) tags.push({ text: `定位：${stripMarks(m['定位'])}`, style: 'role' })
  if (m['100级提升']) tags.push({ text: `100级提升：${stripMarks(m['100级提升'])}`, style: 'power' })
  return tags
}

/** 结构化字段 → 旧版文本行（与 Word 文档里的行一一对应） */
export function deriveSections (data) {
  const s = data?.v2 ?? {}
  const out = []
  const push = (title, lines) => {
    const body = (lines ?? []).map(x => stripMarks(String(x)).trim()).filter(Boolean)
    if (body.length) out.push({ title, lines: body })
  }

  // 1. 武器推荐
  const w = []
  for (const row of s.weapons ?? []) {
    for (const line of renderWeaponRow(row)) w.push(line)
  }
  for (const line of data?.unparsed?.['武器推荐'] ?? []) w.push(stripMarks(line))
  push('1. 武器推荐', w)

  // 2. 圣遗物推荐
  const a = []
  for (const row of s.artifacts ?? []) {
    for (const line of renderArtifactRow(row)) a.push(line)
  }
  for (const line of data?.unparsed?.['圣遗物推荐'] ?? []) a.push(stripMarks(line))
  push('2. 圣遗物推荐', a)

  // 3. 天赋加点
  const t = []
  for (const row of s.talents ?? []) {
    if (row.kind === 'priority') t.push(`优先级：${joinItems(row.order)}`)
    else if (row.kind === 'crown') t.push(`皇冠：${(row.items ?? []).map(itemText).join('')}`)
  }
  for (const line of data?.unparsed?.['天赋加点'] ?? []) t.push(stripMarks(line))
  push('3. 天赋加点', t)

  // 4. 毕业面板参考
  const p = []
  for (const row of s.panels ?? []) {
    const label = row.label ? `${stripMarks(row.label)}：` : ''
    if (row.k != null) p.push(`${label}${stripMarks(row.k)}：${stripMarks(row.v ?? '')}`)
    else if (row.text) p.push(`${label}${stripMarks(row.text)}`)
  }
  for (const line of data?.unparsed?.['毕业面板参考'] ?? []) p.push(stripMarks(line))
  push('4. 毕业面板参考', p)

  // 5. 命座推荐
  const k = []
  for (const row of s.constellations ?? []) {
    k.push(row.text ? `${stripMarks(row.name)}——${stripMarks(row.text)}` : stripMarks(row.name))
  }
  for (const line of data?.unparsed?.['命座推荐'] ?? []) k.push(stripMarks(line))
  push('5. 命座推荐', k)

  // 6. 配队推荐
  const team = []
  for (const row of s.teams ?? []) {
    const label = row.label ? `${stripMarks(row.label)}：` : ''
    const members = joinItems(row.members, ' + ')
    const text = stripMarks(row.text ?? '')
    team.push(`${label}${[members, text].filter(Boolean).join(' / ')}`)
  }
  for (const line of data?.unparsed?.['配队推荐'] ?? []) team.push(stripMarks(line))
  push('6. 配队推荐', team)

  return out
}

/** 单条武器行 → 文本行 */
export function renderWeaponRow (row) {
  const label = row.label ? `${stripMarks(row.label)}：` : ''
  const tier = row.tier ? `第${CN_NUM[row.tier] ?? row.tier}档：` : ''
  const items = joinItems(row.items, row.sep ?? ' > ')
  const text = `${label}${tier}${items}`.trim()
  return text ? [text] : []
}

/** 单条圣遗物行 → 文本行 */
export function renderArtifactRow (row) {
  const label = row.label ? `${stripMarks(row.label)}：` : ''
  switch (row.kind) {
    case 'preferred':
    case 'transition':
    case 'optional': {
      const head = { preferred: '首选', transition: '过渡', optional: '可选' }[row.kind]
      const sets = (row.sets ?? []).map(x => {
        const name = stripMarks(x.name ?? x)
        const pieces = x.pieces ? `（${stripMarks(x.pieces)}）` : ''
        return `${name}${pieces}`
      }).join(row.sep ?? ' / ')
      const text = `${label}${row.label ? '' : (row.title ? `${stripMarks(row.title)}：` : head + '：')}${sets}`.trim()
      return text ? [text] : []
    }
    case 'main': {
      const st = row.stats ?? {}
      const parts = ['时之沙', '空之杯', '理之冠']
        .filter(k => (st[k] ?? []).length)
        .map(k => `${k}：${(st[k] ?? []).map(stripMarks).join(' / ')}`)
      return parts.length ? [`${label}主词条：${parts.join(' / ')}`] : []
    }
    case 'sub': {
      const stats = (row.stats ?? []).map(stripMarks)
      return stats.length ? [`${label}副词条：${stats.join(row.sep ?? ' / ')}`] : []
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
