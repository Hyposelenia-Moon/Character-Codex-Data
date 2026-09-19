/**
 * 由 JSON 数据生成网页版 guide.html
 *
 * 数据源：data/<gameId>/<角色名>.json（字段规范见 README）
 * 页面外壳：templates/guide.html（样式与页头，含 <!--{{CARDS}}--> 占位）
 * 输出：仓库根目录的 guide.html —— **该文件由本脚本生成，不要手改**
 *
 * 显示级归一（标题简称 / 档位标签 推荐·可选·过渡 / 副条目 `＞` / 简写展开 /
 * 皇冠并入天赋 / 命座「命之座X」 / 空模块「暂无」/ 0% 行不显示）统一走
 * scripts/lib/guide-display.mjs —— 与游戏内面板（Atlas-Plugin 的 codexIndex）同一份规则，
 * 所以网页版与面板措辞逐字一致。JSON / docx 里的原始写法**不被改动**。
 *
 * 用法：node scripts/build-html.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DISPLAY_SECTIONS, TIER_BY_INDEX, EMPTY_TEXT, normalizeSections, displayText, displayLines,
  resolveSetItems, crownedLetters, normalizePriorityRow
} from './lib/guide-display.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const templateFile = path.join(root, 'templates/guide.html')
const outputFile = path.join(root, 'guide.html')

/** 值是否为空（空串、只有占位符 ___、或只剩标点）：网页版不渲染这类待补栏位 */
function isBlank (text) {
  const s = String(text ?? '').trim()
  if (!s) return true
  if (s.includes('___')) return true
  // 去掉「标签：」「标签——」前缀后还有没有实际内容（「第二档：」这类待补栏位算空）
  const rest = s.replace(/^[^：:—]{1,8}[：:—]+/, '').trim()
  if (!rest) return true
  return /^[_\-—·、/：:（）()]+$/.test(rest)
}

/** 行内文本转义（数据是纯文本，标签由本脚本生成） */
function escapeHtml (text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 行内强调：**文字** → span.must，==文字== → span.highlight
 * @param {string} text
 * @returns {string} 已转义的 HTML 片段
 */
function inline (text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<span class="must">$1</span>')
    .replace(/==([^=]+)==/g, '<span class="highlight">$1</span>')
}

/** 标签既接受字符串，也接受 {text, style} */
function tagOf (tag) {
  if (typeof tag === 'string') return { text: tag, style: '' }
  return { text: String(tag?.text ?? ''), style: String(tag?.style ?? '') }
}

/**
 * 读取 JSON（容忍编辑器写入的 UTF-8 BOM：Node 的 JSON.parse 不接受 BOM）
 * @param {string} file
 * @returns {object}
 */
function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/**
 * 读取某游戏的卡片顺序表（data/<gameId>/_order.json，缺省按角色名排序）
 * @param {string} dir
 * @returns {string[]}
 */
function readOrder (dir) {
  try {
    const data = readJson(path.join(dir, '_order.json'))
    const list = Array.isArray(data) ? data : (Array.isArray(data?.order) ? data.order : [])
    return list.map(name => String(name))
  } catch {
    return []
  }
}

/**
 * 是否为空档：只有六个栏位标题、没有任何内容（新增角色待补充时的占位）
 *
 * 判据只看 JSON 里的**原始文本行**，不看显示级归一结果 —— 归一后空段落会显示
 * 「暂无」，若拿它当判据，空档角色也会被当成「有内容」而混进网页版。
 * @param {object} data
 * @returns {boolean}
 */
function isEmptyCharacter (data) {
  const hasTags = Array.isArray(data.tags) && data.tags.length > 0
  const hasHighlight = Boolean(data.highlight)
  const hasLines = (data.sections || []).some(s => Array.isArray(s.lines) && s.lines.some(line => !isBlank(line)))
  return !hasTags && !hasHighlight && !hasLines
}

/** 上次列出时跳过的空档角色（供命令行提示） */
export const skippedEmpty = []

/**
 * 列出 data/<gameId>/*.json（跳过 `_` 前缀的元数据文件与没有内容的空档角色）
 * @returns {Array<{game: string, name: string, data: object, dir: string}>}
 */
export function listCharacters () {
  const out = []
  skippedEmpty.length = 0
  let games = []
  try {
    games = fs.readdirSync(dataDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => e.name)
  } catch {
    return out
  }
  for (const game of games.sort((a, b) => a.localeCompare(b))) {
    const dir = path.join(dataDir, game)
    const order = readOrder(dir)
    const chars = []
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue
      const data = readJson(path.join(dir, file))
      const name = data.name || path.basename(file, '.json')
      // 空档角色（新增待补）不进网页版，避免出现整页空卡片
      if (isEmptyCharacter(data)) {
        skippedEmpty.push(name)
        continue
      }
      chars.push({ game, name, data, dir })
    }
    const rank = (char) => {
      const i = order.indexOf(char.name)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    chars.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    out.push(...chars)
  }
  return out
}

/**
 * 段落配图路径：数据里相对 JSON 文件，页面里相对仓库根目录
 * @param {string} dir - JSON 文件所在目录
 * @param {string} image
 * @returns {string} 仓库根目录下的相对路径（POSIX 分隔）
 */
function imageSrc (dir, image) {
  if (!image) return ''
  return path.relative(root, path.resolve(dir, image)).split(path.sep).join('/')
}

/**
 * 渲染段落正文：lines / items / fields 三选一，可附 image
 * @param {object} section
 * @param {number} indent - 行首缩进
 * @param {string} dir - JSON 文件所在目录
 * @returns {string} HTML
 */
function renderBody (section, indent, dir) {
  const pad = ' '.repeat(indent)
  const lines = []

  if (Array.isArray(section.lines)) {
    const body = section.lines.filter(line => !isBlank(line))
    if (body.length) {
      lines.push(`${pad}<div class="text-block">`)
      lines.push(body.map(line => `${pad}    ${inline(line)}`).join('<br>\n'))
      lines.push(`${pad}</div>`)
    }
  } else if (Array.isArray(section.items)) {
    lines.push(`${pad}<ul class="content-list">`)
    for (const item of section.items) {
      const desc = item.desc ? `<br>${inline(item.desc)}` : ''
      lines.push(`${pad}    <li>${inline(item.name)}${desc}</li>`)
    }
    lines.push(`${pad}</ul>`)
  } else if (Array.isArray(section.fields)) {
    for (const field of section.fields) {
      lines.push(`${pad}<div class="field-line"><span class="field-label">${inline(field.label)}</span>${inline(field.value)}</div>`)
    }
  }

  if (section.image) {
    lines.push(`${pad}<img class="codex-img" src="${escapeHtml(imageSrc(dir, section.image))}"/>`)
  }
  return lines.join('\n')
}

/**
 * 数据里的 `sections[].lines` → 渲染模型的行
 *
 * 网页版的「文本行 → 模型」最小实现：只做**结构解析**（拆出标签 / 条目 / 分隔符）
 * 与两条显示级分隔符规则（主词条部位之间 `＞`、部位内部候选用 `/`；副词条 `/` → `＞`），
 * 其余措辞、档位标签、简写展开、皇冠并入、命座命名全部交给 guide-display.mjs。
 * @param {string[]} lines 原始文本行（未归一）
 * @param {string[]} [labelHints] 逐行的显示标签覆盖（武器行按 v2 的 tier 算，见 weaponLabelHints）
 * @param {string|null} [crownHint] 天赋优先级行的「皇冠必需字母」（来自 v2.talents 的皇冠行）
 * @returns {Array<{label: string, kind?: string, items: Array}>}
 */
function linesToModelRows (lines, labelHints = [], crownHint = null) {
  const out = []
  lines?.forEach((line, index) => {
    const text = String(line ?? '').trim()
    if (!text) return
    // 段末备注行 `注：…`：单独一行、不拆档位
    if (/^注\s*[:：]/.test(text)) {
      out.push({ label: '', kind: 'note', items: [{ text }] })
      return
    }
    const kv = text.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
    if (!kv) {
      out.push({ label: '', items: [{ text }] })
      return
    }
    const value = String(kv[2] ?? '').trim()
    if (!value) return
    const hint = String(labelHints[index] ?? '').trim()
    const label = hint || kv[1]
    if (MAIN_SLOTS.some(s => value.includes(s + '：') || value.includes(s + ':'))) {
      out.push({ label, items: splitMainSlots(value) })
      return
    }
    // 优先级行交给共享的归一（拆 `A=Q`、必需项补 10、沿用数据分隔符），与面板同一套
    if (label === '优先级') {
      out.push({ label, raw: value, items: normalizePriorityRow([{ text: value, sepAfter: '', raw: value }], crownHint ?? undefined, value) })
      return
    }
    const tokens = splitRankParts(value, '／')
    // 套装行要把 2+2 组合当整体、并把同名套装去重（与面板共用 resolveSetItems）
    if (/推荐|可选|过渡|首选|次选|套装/.test(label)) {
      const sets = []
      const seps = []
      tokens.forEach((t, i) => {
        const parts = t.text.split(/\s*[+＋＆&]\s*/).map(s => s.trim()).filter(Boolean)
        parts.forEach((p, j) => {
          if (j > 0) seps.push('+')
          sets.push({ name: p })
        })
        if (i < tokens.length - 1) seps.push(t.sepAfter === '／' ? '/' : t.sepAfter)
      })
      const resolved = resolveSetItems(sets, seps, { sep: '／' })
      out.push({
        label,
        items: resolved.map(r => ({ text: displayText(r.name), sepAfter: r.sepAfter === '／' ? '＞' : r.sepAfter }))
      })
      return
    }
    // 其余档位行：分隔符**原样保留数据里的写法**（`>` / `≥` / `＞`），
    // 与面板侧一致；`／`（候选并列）统一显示成 `/`
    out.push({
      label,
      items: tokens.map((t, i) => ({
        text: t.text,
        sepAfter: i < tokens.length - 1 ? (t.sepAfter === '／' ? '/' : (t.sepAfter || '＞')) : ''
      }))
    })
  })
  return out
}

/** 主词条三槽（顺序固定；只认 `${部位}：` 前面的部位边界） */
const MAIN_SLOTS = ['时之沙', '空之杯', '理之冠']

/**
 * `时之沙：A / B / 空之杯：C / 理之冠：D / E` → 每个部位一条，
 * 部位之间用 `＞`，部位内部的候选值留在同一条文本里用 `/` 连（去掉多余空格）。
 * @param {string} text
 * @returns {Array<{text: string, sepAfter: string}>}
 */
/** 括号配对表（用于「括号内部不拆」的判断） */
const BRACKET_PAIRS = { '(': ')', '（': '）', '[': ']', '【': '】' }

function splitMainSlots (text) {
  const out = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    // 部位边界：`时之沙：` / `空之杯：` / `理之冠：` 都是部位的起点，部位名连同「：」一起留在条目里
    const slot = MAIN_SLOTS.find(s => text.startsWith(s + '：', i) || text.startsWith(s + ':', i))
    if (slot) {
      const t = buf.trim()
      if (t) out.push({ text: t, sepAfter: '＞' }) // 上一部位收尾
      buf = text.slice(i, i + slot.length + 1)
      i += slot.length + 1
      continue
    }
    const ch = text[i]
    if (BRACKET_PAIRS[ch]) {
      // 括号内部原样搬进来（含括号），免得把里面出现的部位名当边界
      const end = text.indexOf(BRACKET_PAIRS[ch], i)
      const stop = end < 0 ? text.length : end + 1
      buf += text.slice(i, stop)
      i = stop
      continue
    }
    buf += ch
    i += 1
  }
  const t = buf.trim()
  if (t) out.push({ text: t, sepAfter: '' })
  // 候选值之间去空格（`元素充能效率 / 生命值` → `元素充能效率/生命值`），
  // 并丢掉部位边界上残留的悬挂分隔符（`… / 空之杯：…` 里的那个 `/`）
  return out.map(item => ({
    ...item,
    text: item.text.replace(/\s*[/／]\s*/g, '/').replace(/[/／]+$/, '')
  }))
}

/**
 * 按「顶层 `/`」拆成若干候选组，**组内**再按 `>` / `≥` / `＞` 拆优先级。
 *
 * 两类分隔符不能混：`时之沙：攻击力 / 空之杯：冰伤 / 理之冠：暴击率 / 暴击伤害`
 * 拆成 4 个条目的同时，第 3 个后面的其实是 `/`（候选并列），
 * 所以用 `candidateSep` 决定「组与组之间」用什么符号，组内一律 `＞`。
 * @param {string} text
 * @param {string} candidateSep 组间分隔符（需求第 2 条：候选之间用 `/`，这里统一成全角 `＞` 与面板一致）
 * @returns {Array<{text: string, sepAfter: string}>}
 */
function splitRankParts (text, candidateSep) {
  const RANK = [' > ', ' ≥ ', '＞', '>', '≥']
  const levels = [[]]
  let depth = 0
  let buf = ''
  const flushToken = (sep) => {
    const t = buf.trim()
    if (t) levels[levels.length - 1].push({ text: t, sep })
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ('(（[【'.includes(ch)) depth += 1
    else if (')）]】'.includes(ch)) depth = Math.max(0, depth - 1)
    if (depth === 0) {
      const rank = RANK.find(sep => text.startsWith(sep, i))
      if (rank) { flushToken(rank.trim()); i += rank.length - 1; continue }
      if (ch === '/' || ch === '／') { flushToken(''); levels.push([]); continue }
    }
    buf += ch
  }
  flushToken('')

  const out = []
  levels.forEach((tokens, li) => {
    tokens.forEach((tok, ti) => {
      const isLastInLevel = ti === tokens.length - 1
      const isLastLevel = li === levels.length - 1
      out.push({
        text: tok.text,
        sepAfter: isLastInLevel ? (isLastLevel ? '' : candidateSep) : (tok.sep || '＞')
      })
    })
  })
  return out
}

/**
 * 武器行的**档位标签**：从 v2 数据取真实档位（1/2/3），
 * 文档里的「第N档」只是**显示文本**，第 3 档在圣遗物侧会被归到「可选」，
 * 所以这里必须按 v2 的 tier 算，保证网页版与面板（插件读 v2）措辞一致。
 * @param {object} data
 * @returns {string[]} 与武器行一一对应的显示标签
 */
function weaponLabelHints (data) {
  return (data?.v2?.weapons ?? [])
    .filter(row => row && !row.kind)
    .map(row => (Number.isInteger(row.tier) && row.tier > 0
      ? (TIER_BY_INDEX[row.tier] ?? '')
      : (row.label ?? '')))
}

/**
 * 角色 JSON → 六个模块的渲染模型（顺序固定，空模块保留并标 empty）
 *
 * 编号徽标（1…6）与面板侧 `section.badge` 同一套：按固定模块顺序取 1..6，
 * 与原「1. 武器推荐」的编号一致，所以图标/徽标不会因为标题改成简称而错位。
 * @param {object} data
 * @returns {object[]}
 */
export function characterSections (data) {
  const byKeyword = new Map()
  for (const section of data?.sections ?? []) {
    const title = String(section?.title ?? '')
    for (const [re, name] of [[/武器/, '武器'], [/圣遗物/, '圣遗物'], [/天赋/, '天赋'], [/命座/, '命座'], [/面板|属性/, '面板'], [/配队|队伍|阵容/, '配队']]) {
      if (re.test(title)) { byKeyword.set(name, section); break }
    }
  }
  const weaponHints = weaponLabelHints(data)
  // 天赋：把「皇冠必需项」的字母显式传给归一。
  // 判据与面板（display.js 的 normalizeTalentRows）**完全一致**：只有 `level` 含「必须」才需要皇冠；
  // `皇冠：E`（无 level）按数据语义视为可选，不加 10。
  const crownHint = (data?.v2?.talents ?? [])
    .filter(row => row?.kind === 'crown')
    .flatMap(row => (row.items ?? [])
      .filter(it => /必须/.test(String(it.level ?? '')))
      .map(it => String(it.name ?? '')))
    .filter(Boolean)
  const model = DISPLAY_SECTIONS.map(({ title, kind }, i) => {
    const src = byKeyword.get(title)
    const badge = String(i + 1)
    if (!src) return { title, badge, type: kind, kind, rows: [], teams: [] }
    const lines = displayLines(src.lines ?? [])
    if (kind === 'teams') {
      // 段末备注行 `注：…` 不占队伍行（避免与成员备注重复），交给模板的段末备注渲染
      const teamLines = lines.filter(l => !/^注\s*[:：]/.test(l))
      return { title, badge, type: 'teams', kind, rows: [], teams: teamsFromLines(teamLines) }
    }
    const rows = linesToModelRows(lines, title === '武器' ? weaponHints : [], title === '天赋' ? crownHint : null)
    return { title, badge, type: kind === 'stats' ? 'stats' : 'rows', kind, rows }
  })
  return normalizeSections(model)
}

/**
 * 配队行 → 队伍模型（`推荐：A + B + C　注：…`）
 *
 * 与面板侧（parse.js 的 v2TeamRows + display.js 的 normalizeTeams）形状对齐：
 *   - 用 `+` 连起来的才是成员（`A + B + C`）
 *   - 没有 `+` 的整段文字是**行尾说明**，统一成 `注：…`（`推荐：减抗位` → `注：减抗位`）
 */
function teamsFromLines (lines) {
  return (lines ?? []).map(line => {
    const text = String(line ?? '').trim()
    const kv = text.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
    const tag = kv ? kv[1] : ''
    const body = (kv ? kv[2] : text).trim()
    const noteHit = body.match(/^(.*?)[\s　]*(注\s*[:：].*)$/)
    const membersPart = (noteHit ? noteHit[1] : body).trim()
    const notes = noteHit ? [noteHit[2].trim()] : []
    const members = /\s*[+＋＆&]\s*/.test(membersPart)
      ? membersPart.split(/\s*[+＋＆&]\s*/).map(x => x.trim()).filter(Boolean)
        .map(name => ({ name, ref: '', plain: name }))
      : []
    if (!members.length && membersPart) notes.push(membersPart)
    return { tag, members, text: '', note: notes.filter(Boolean).join('；') }
  }).filter(t => t.tag || t.members.length || t.note)
}

/**
 * 渲染一行档位条目（`it.sepAfter` 已由显示级归一换成 `＞`）
 * @param {object} row
 * @returns {string} HTML
 */
function renderItems (row) {
  const items = row.items ?? []
  if (!items.length) return ''
  if (row.kind === 'note') return `<span class="row-note">${inline(items[0]?.text ?? '')}</span>`
  if (items.length === 1) return `<span class="row-value">${inline(items[0].text)}</span>`
  const parts = items.map(it => {
    const note = it.note ? `<span class="rank-note">（${inline(it.note)}）</span>` : ''
    const sep = it.sepAfter ? `<span class="sep">${inline(it.sepAfter)}</span>` : ''
    return `<span class="rank-unit"><span class="rank-item">${inline(it.text)}${note}</span>${sep}</span>`
  })
  return `<span class="rank-list">${parts.join('')}</span>`
}

/**
 * 渲染一个模块（空模块输出「暂无」占位）
 * @param {object} section 已归一的段落
 * @param {number} indent
 * @param {string} dir
 * @returns {string} HTML
 */
function renderDisplaySection (section, indent, dir) {
  const pad = ' '.repeat(indent)
  const out = []
  out.push(`${pad}<div class="section${section.empty ? ' section-empty' : ''}">`)
  const badge = section.badge ? `<span class="section-badge">${escapeHtml(section.badge)}</span>` : ''
  out.push(`${pad}    <div class="section-title">${badge}${inline(section.displayTitle ?? section.title)}</div>`)
  if (section.empty) {
    out.push(`${pad}    <div class="section-empty-text">${EMPTY_TEXT}</div>`)
  } else if (section.kind === 'teams') {
    out.push(`${pad}    <div class="team-rows">`)
    for (const team of section.teams) {
      const tag = team.tag ? `<span class="row-label">${inline(team.tag)}</span>` : ''
      const members = team.members.map(m => {
        const note = m.note ? `<span class="team-note-inline">（${inline(m.note)}）</span>` : ''
        return `<span class="team-member">${inline(m.name)}${note}</span>`
      }).join('<span class="team-plus">+</span>')
      const note = team.note ? `<span class="row-note">${inline(team.note)}</span>` : ''
      out.push(`${pad}        <div class="row${team.tag ? '' : ' row-nolabel'}">${tag}<span class="row-value">${members}${note}</span></div>`)
    }
    out.push(`${pad}    </div>`)
  } else {
    out.push(`${pad}    <div class="rows">`)
    for (const row of section.rows) {
      const label = row.label ? `<span class="row-label">${inline(row.label)}</span>` : ''
      out.push(`${pad}        <div class="row${row.label ? '' : ' row-nolabel'}">${label}${renderItems(row)}</div>`)
    }
    out.push(`${pad}    </div>`)
  }
  if (section.image) out.push(`${pad}    <img class="codex-img" src="${escapeHtml(imageSrc(dir, section.image))}"/>`)
  out.push(`${pad}</div>`)
  return out.join('\n')
}

/**
 * 渲染单个角色卡片
 * @param {{name: string, data: object, dir: string}} character
 * @returns {string} HTML
 */
export function renderCard (character) {
  const { name, data, dir } = character
  const out = []
  out.push(`<!-- ================= ${name} ================= -->`)
  out.push(`<div class="guide-card" data-name="${escapeHtml(name)}">`)
  out.push('    <div class="char-header">')
  out.push(`        <div class="char-name">${escapeHtml(name)}</div>`)
  const tags = (data.tags || []).map(tagOf).filter(t => t.text && !isBlank(t.text) && !/：\s*$/.test(t.text))
  if (tags.length) {
    out.push('        <div class="char-tags">')
    for (const tag of tags) {
      out.push(`            <span class="tag${tag.style ? ` ${escapeHtml(tag.style)}` : ''}">${inline(tag.text)}</span>`)
    }
    out.push('        </div>')
  }
  out.push('    </div>')
  if (data.highlight && !isBlank(data.highlight)) {
    out.push('    <div class="text-block" style="margin-bottom:10px; color:#dd6b20;">')
    out.push(`        ${inline(data.highlight)}`)
    out.push('    </div>')
  }
  out.push('    <div class="grid-2">')
  for (const section of characterSections(data)) {
    out.push(renderDisplaySection(section, 8, dir))
  }
  out.push('    </div>')
  out.push('</div>')
  return out.join('\n')
}

/**
 * 生成完整网页
 * @returns {string} guide.html 内容
 */
export function buildHtml () {
  const template = fs.readFileSync(templateFile, 'utf8')
  const cards = listCharacters().map(renderCard).join('\n\n')
  return template.replace('<!--{{CARDS}}-->', cards)
}

// 直接执行时写入 guide.html
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const html = buildHtml()
  fs.writeFileSync(outputFile, html, 'utf8')
  const rendered = listCharacters().length
  const skipped = skippedEmpty.length
  console.log(`已生成 ${path.relative(root, outputFile)}（${rendered} 个角色${skipped ? `，跳过 ${skipped} 个空档` : ''}）`)
}
