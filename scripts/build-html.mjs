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
 * 与两条显示级分隔符规则（主词条部位之间用 `｜`、部位内部候选用 `/`；符号语义见 splitRankParts），
 * 其余措辞、档位标签、简写展开、皇冠并入、命座命名全部交给 guide-display.mjs。
 * @param {string[]} lines 原始文本行（未归一）
 * @param {string[]} [labelHints] 逐行的显示标签覆盖（武器行：自定义词优先，否则按 v2 的 tier 算，见 weaponLabelHints）
 * @param {string|null} [crownHint] 天赋优先级行的「皇冠必需字母」（来自 v2.talents 的皇冠行）
 * @returns {Array<{label: string, kind?: string, items: Array}>}
 */
function linesToModelRows (lines, labelHints = [], crownHint = null, levelHints = null, v2SetRows = [], v2WeaponRows = []) {
  let weaponAt = 0
  const weaponRows = (v2WeaponRows ?? []).filter(r => r && typeof r === 'object' && Array.isArray(r.items) && r.items.length)
  // v2 的套装行（与派生的 sections 行**同序**，按出现顺序取）。
  // 为什么从 v2 取：2+2 组合（`A + B + C`）的分组只有 v2 的 `sets` 数组带得住；
  // 文档文本行里的 `+` 在显示归一里会退化成首个 token，反推会分叉。
  const setRows = (v2SetRows ?? []).filter(r => r && typeof r === 'object' && Array.isArray(r.sets) && r.sets.some(x => String(x?.name ?? x ?? '').trim()))
  let setAt = 0
  // v2 的**副词条行**（与派生行同序）：两两之间的优先级关系只有 v2 带得住 ——
  // 文档行里的 `/` 只表示「同级」，而编辑器还要能写 `≥` / `＝`（用户定稿 2026-09-21：
  // 副词条两两之间的关系可改，双爆固定 `=`）。按行猜会把这些字形混成一个。
  const subRows = (v2SetRows ?? []).filter(r => r && typeof r === 'object' && r.kind === 'sub' && (r.stats ?? []).some(s => String(s ?? '').trim()))
  let subAt = 0
  /**
   * 这一行是不是下一条 v2 套装行：**按套装名核对**（去掉 `（2件套）` 这类括注、忽略分隔符字形）。
   * 只按位置取会错位（圣遗物段的「主词条 / 副词条」行会把游标推歪，导致后面的行拿错数据）。
   */
  const matchSetRow = (value) => {
    const row = setRows[setAt]
    if (!row) return null
    // 两侧都过显示归一（简写展开）+ 去件数括注 + 去重，比较**套装名集合**
    // （`2充能 + 2充能` ↔ v2 的 `[2充能, 2充能]` 要能对上；`（2件套）` 不算差异）
    const norm = (x) => String(displayText(x) ?? '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '')
    const key = (x) => [...new Set(String(x ?? '').split(/[/／+＋>＞]/).map(norm).filter(Boolean))].sort().join('|')
    const v2Key = key((row.sets ?? []).map(x => String(x?.name ?? x ?? '')).join('/'))
    return key(value) && key(value) === v2Key ? setRows[setAt++] : null
  }
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
    // 命座行（`命之座2：核心输出质变`）：挂上 `ref: constellation:N`，两侧据此取命座图标
    const consHit = label.match(/(?:命之座|命座)\s*([一二三四五六\d]+)/)
    const consIndex = consHit ? ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[consHit[1]] ?? Number(consHit[1])) : 0
    if (consIndex >= 1 && consIndex <= 6) {
      const ref = `constellation:${consIndex}`
      out.push({ label, ref, items: [{ text: value, sepAfter: '', ref }] })
      return
    }
    if (MAIN_SLOTS.some(s => value.includes(s + '：') || value.includes(s + ':'))) {
      out.push({ label, items: splitMainSlots(value) })
      return
    }
    // 优先级行交给共享的归一（拆 `A=Q`、读等级 `A1`/`E10`、沿用数据分隔符），与面板同一套
    if (label === '优先级' || label === '天赋') {
      const items = normalizePriorityRow([{ text: value, sepAfter: '', raw: value }], crownHint ?? undefined, value)
      // 文档行里没写数字时，用 v2 的结构化等级兜底（避免「数据有 level、文档没数字」时丢信息）
      const withLevels = levelHints && levelHints.size
        ? items.map(it => {
          const name = String(it.text ?? '').match(/[AEQ]/)?.[0] ?? ''
          const lv = levelHints.get(name)
          if (lv === undefined || Number.isInteger(it.level)) return it
          return { ...it, level: lv, crown: it.crown === true || lv === 10 }
        })
        : items
      // 天赋：**固定三格 A → E → Q**（不再按优先级排序），level 缺省按 1
      const fixed = ['A', 'E', 'Q'].map(name => {
        const hit = withLevels.find(it => String(it.text ?? '').toUpperCase() === name)
        if (hit) return { ...hit, text: name, sepAfter: '' }
        const lv = levelHints?.get(name)
        return { text: name, sepAfter: '', level: Number.isInteger(lv) ? lv : 1, crown: lv === 10 }
      })
      // 行首标签用**显示词汇** `推荐`（与武器 / 圣遗物行一致；文档里仍写 `天赋：…`，面板同口径）
      // 行首**不写标签**（用户定稿 2026-09-21：天赋那行的「推荐」chip 去掉）——
      // 天赋只有 A / E / Q 三格，图标本身已经说明一切，标签是噪声。
      // 空标签 ⇒ 卡片给这一行 `row-nolabel`，值列占满整行（面板侧 codex.html 同口径）。
      out.push({ label: '', kind: 'talents', raw: value, items: fixed })
      return
    }
    const tokens = splitRankParts(value, '／')
    // 套装行：**与面板侧 parse.js 的 v2ArtifactRows 同源**（都读 v2.artifacts[].sets/sep，
    // 都走共享 resolveSetItems：2+2 组合整体保留、同名只留一次、候选用 `/`）。
    // 判据 = **按顺序**取 v2 套装行（派生的 sections 行与它同序；显示标签会被折成
    // 「推荐 / 可选 / 过渡」，所以不能按标签名比对）
    const v2Set = setRows.length ? matchSetRow(value) : null
    if (v2Set) {
      const sets = []
      const seps = []
      // 逐档 token：与面板的 gapSeps 同一展开规则（不够时重复**最后一个**）
      const toks = String(v2Set.sep ?? '').trim().split(/\s+/).filter(Boolean)
      v2Set.sets.forEach((x, i) => {
        const name = String(x?.name ?? x ?? '').trim()
        if (!name) return
        if (sets.length) seps.push(toks[sets.length - 1] ?? toks[toks.length - 1] ?? '/')
        // 件数（`（2件套）`）**不再显示**（用户定稿：圣遗物旁边不要件数；2+2 写 `2精通 + 2精通` 这类简写）。
        // 旧数据里若还留着 `pieces`，这里**照样不画** —— 面板侧 parse.js 同一口径。
        sets.push({ name })
      })
      if (process.env.DBG_SET) console.log('DBG v2Set', JSON.stringify({ value, label, sep: v2Set.sep, sets, seps }))
      const resolved = resolveSetItems(sets, seps, { sep: '' })
      out.push({
        label,
        // 同级（源文档 `/`）→ **`/`**（字面斜杠：`教官/勇者`）；优先级（`>`/`≥`）→ `＞`。
        // 见 guide-display.mjs 的 SET_LEVEL_SEP / gapSepOf。
        items: resolved.map(r => ({ text: displayText(r.name), sepAfter: r.sepAfter === '/' ? '/' : (r.sepAfter ? '＞' : '') }))
      })
      return
    }
    // 武器档位行（含「加攻 / 均衡 / 特殊 / 辅助」这类自定义档）：与面板同源，
    // 直接从 v2 的 `items + sep` 取（文档行/派生文本行里的分隔符可能与数据不一致，如 `>` ↔ `/`）
    const v2Weapon = weaponRows.length ? weaponRows[weaponAt] : null
    if (v2Weapon) {
      weaponAt++
      const toks = String(v2Weapon.sep ?? '').trim().split(/\s+/).filter(Boolean)
      const items = (v2Weapon.items ?? []).filter(it => String(it?.name ?? it ?? '').trim())
      out.push({
        label,
        ref: String(items[0]?.ref || ''),
        items: items.map((it, i) => ({
          text: displayText(String(it?.name ?? it ?? '').trim()),
          note: String(it?.note ?? '').trim() ? displayText(it.note) : '',
          ref: String(it?.ref || ''),
          sepAfter: i < items.length - 1 ? (toks[i] ?? toks[toks.length - 1] ?? ' > ').trim() : ''
        }))
      })
      return
    }
    // 副词条行：**直接从 v2 取**（`stats` + 逐档 `sep`），与武器 / 套装同源。
    // 分隔符语义交给显示层（`subSepBetween`）：双爆恒 `=`，其余按数据里的符号原样渲染
    // （`>` → `＞`、`≥` → `≥`、`=` → `=`；文档里的 `/` 只对双爆成立，非双爆按优先级显示）。
    if (/^副词条$/.test(label)) {
      const v2Sub = subRows[subAt]
      if (v2Sub) {
        subAt++
        const stats = (v2Sub.stats ?? []).map(s => String(s ?? '').trim()).filter(Boolean)
        const toks = String(v2Sub.sep ?? '').trim().split(/\s+/).filter(Boolean)
        out.push({
          label,
          ref: '',
          items: stats.map((s, i) => ({
            text: s,
            note: '',
            ref: '',
            sepAfter: i < stats.length - 1 ? (toks[i] ?? toks[toks.length - 1] ?? ' > ') : ''
          }))
        })
        return
      }
    }
    // 其余档位行：分隔符**原样保留数据里的写法**，与面板侧一致。
    //   · `>` / `≥` = 优先级 → 显示成全角 `＞` / `≥`（`＞` 是文档与面板统一的优先级字形）
    //   · `＝` = 同级（`双爆` 展开）→ 原样
    //   · `/` = 可替换 → 原样
    out.push({
      label,
      items: tokens.map((t, i) => ({
        text: t.text,
        sepAfter: i < tokens.length - 1
          ? (t.sepAfter === '／' ? '＞' : (t.sepAfter || '＞'))
          : ''
      }))
    })
  })
  return out
}

/** 主词条三槽（顺序固定；只认 `${部位}：` 前面的部位边界） */
const MAIN_SLOTS = ['时之沙', '空之杯', '理之冠']
/** 槽位之间是**并列**关系；**文档层**用全角竖线（schema.mjs 的 MAIN_SLOT_SEP），网页版靠排版分隔 */
const MAIN_SLOT_SEP = '｜'

/**
 * `时之沙：A / B / 空之杯：C / 理之冠：D / E` → 每个部位一条。
 *
 * **网页版不写字面 `｜`**：槽位之间用**排版分隔**（每条带 `slot` 标记、CSS 换行/分块），
 * 部位内部的候选值仍留 `/`。文档（纯文本）层才用 `｜`（见 schema.mjs 的 MAIN_SLOT_SEP）。
 * @param {string} text
 * @returns {Array<{text: string, sepAfter: string, slot: string}>}
 */
/** 括号配对表（用于「括号内部不拆」的判断） */
const BRACKET_PAIRS = { '(': ')', '（': '）', '[': ']', '【': '】' }

function splitMainSlots (text) {
  const out = []
  let buf = ''
  let i = 0
  let lastSlot = ''
  while (i < text.length) {
    // 部位边界：`时之沙：` / `空之杯：` / `理之冠：` 都是部位的起点，部位名连同「：」一起留在条目里
    const slot = MAIN_SLOTS.find(s => text.startsWith(s + '：', i) || text.startsWith(s + ':', i))
    if (slot) {
      const t = buf.trim()
      if (t) out.push({ text: t, sepAfter: '', slot: lastSlot }) // 上一部位收尾（并列 → 排版分隔）
      lastSlot = slot
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
  if (t) out.push({ text: t, sepAfter: '', slot: lastSlot })
  // 候选值之间去空格（`元素充能效率 / 生命值` → `元素充能效率/生命值`），
  // 并丢掉部位边界上残留的悬挂分隔符（`… / 空之杯：…` 里的 `/`，以及旧写法里多余的 `｜`）
  return out.map(item => ({
    ...item,
    text: item.text.replace(/\s*[/／]\s*/g, '/').replace(/[/／｜]+$/, ''),
    slot: item.slot || (MAIN_SLOTS.find(s => item.text.startsWith(s + '：')) ?? '')
  }))
}

/**
 * 按「顶层 `/`」拆成若干候选组，**组内**再按 `>` / `≥` / `＞` / `=` 拆档位。
 *
 * 符号语义（用户定稿，三处一致）：
 *   · `/` = **或者 / 可替换**（同位置二选一）→ 组与组之间用它，渲染成**同一个 chip 内 ` / `**
 *   · `=` = **同级 / 等价**（`双爆` → `暴击率=暴击伤害`）→ 拆成**两个独立 chip、中间显示 `=`**
 *   · `>`（显示 `＞`）= **优先级 / 顺序** → 组内用它
 *
 * 两类分隔符不能混：`时之沙：攻击力 / 空之杯：冰伤 / 理之冠：暴击率 / 暴击伤害`
 * 拆成 4 个条目的同时，第 3 个后面的其实是 `/`（候选并列），
 * 所以用 `candidateSep` 决定「组与组之间」用什么符号。
 * @param {string} text
 * @param {string} candidateSep 组间分隔符（候选之间用 `/`，这里统一成全角 `＞` 与面板一致）
 * @returns {Array<{text: string, sepAfter: string}>}
 */
function splitRankParts (text, candidateSep) {
  // `=`（含全角）也当档位分隔符：同级项拆成两个 chip，中间保留 `=`
  const RANK = [' > ', ' ≥ ', '＞', '>', '≥', '=', '＝']
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
        // 组内：`=` 原样显示成 `＝`（同级），其余档位分隔符按数据写法
        sepAfter: isLastInLevel ? (isLastLevel ? '' : candidateSep) : (tok.sep === '＝' ? '=' : (tok.sep || '＞'))
      })
    })
  })
  return out
}

/**
 * 武器行的**档位标签**：与显示层 `displayLabel` / 文档层 `renderWeaponRow` 同口径 ——
 *   · `label` 非空 = **自定义档位词**（用户定稿：可以把「推荐」写成「建议」）→ 原样用它；
 *   · `label` 为空才按 v2 的 `tier` 算（1/2/3 → 推荐 / 可选 / 过渡）。
 * ⚠ 过去这里是「tier 优先」，于是「档位=推荐 + 自定义词=建议」时网页版显示 `推荐`、
 *   面板显示 `建议`（`audit-web-vs-panel` 漂移）。文档里的「第N档」只是显示文本，
 *   所以仍以 v2 的 tier 为准（第 3 档在圣遗物侧会被归到「可选」）。
 * @param {object} data
 * @returns {string[]} 与武器行一一对应的显示标签
 */
function weaponLabelHints (data) {
  return (data?.v2?.weapons ?? [])
    .filter(row => row && !row.kind)
    .map(row => {
      const custom = String(row.label ?? '').trim()
      if (custom) return custom
      return Number.isInteger(row.tier) && row.tier > 0 ? (TIER_BY_INDEX[row.tier] ?? '') : ''
    })
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
  // 天赋等级提示：`v2.talents.priority.order[].level`（1..10）+ 皇冠行的字母。
  // 文档行（`sections`）里已经写了 `A1 ＞ E10`，所以正常情况解析侧就能拿到；
  // 这里把结构化字段一起带下去，保证「文档缺数字」时也用数据里的等级兜底。
  const levelHints = new Map()
  const crownHint = []
  for (const row of data?.v2?.talents ?? []) {
    if (row?.kind === 'priority') {
      for (const it of row.order ?? []) {
        const name = String(it?.name ?? '').toUpperCase()
        const lv = Number(it?.level)
        if (/^[AEQ]$/.test(name) && Number.isInteger(lv) && lv >= 1 && lv <= 10) levelHints.set(name, lv)
        if (it?.crown === true && /^[AEQ]$/.test(name)) crownHint.push(name)
      }
    }
    if (row?.kind === 'crown') {
      for (const it of row.items ?? []) {
        const name = String(it?.name ?? '').toUpperCase()
        if (!/^[AEQ]$/.test(name)) continue
        crownHint.push(name)
        // 皇冠行 = 已投皇冠 → 等级 10
        levelHints.set(name, 10)
      }
    }
  }
  const model = DISPLAY_SECTIONS.map(({ title, kind }, i) => {
    const src = byKeyword.get(title)
    const badge = String(i + 1)
    if (!src) return { title, badge, type: kind, kind, rows: [], teams: [] }
    const lines = displayLines(src.lines ?? [])
    if (kind === 'teams') {
      // 配队段**优先用 `v2.teams`**（与面板 `parse.js` 的 `v2TeamRows` 同口径）：
      // 只有 v2 分得清「一个成员的队伍」和「整行说明」—— 文档行 `首选：阿贝多` 与 `可选：自由选择`
      // 形状完全一样，按行猜会把**单成员队伍误判成备注**（用户报：「新增配队后不激活」：
      // 新增一行、加一个成员，预览里那个成员不生效）。
      const v2teams = Array.isArray(data?.v2?.teams) ? data.v2.teams : null
      if (v2teams && v2teams.length) {
        const teams = []
        for (const row of v2teams) {
          const tag = String(row?.label ?? '').trim()
          const text = String(row?.text ?? '').trim()
          const members = (Array.isArray(row?.members) ? row.members : [])
            .map(m => ({
              // 成员名里的 `/` 是**同一格的可替换项**，并进同一格、格内保留 ` / `
              name: String(m?.name ?? m ?? '').replace(/\s*[/／]\s*/g, ' / ').trim(),
              note: String(m?.note ?? '').trim(),
              ref: '',
              plain: ''
            }))
            .filter(m => m.name)
          // 没成员、也没说明的行不画（与面板同口径；避免多出一个只有标签的空行）
          if (!members.length && !text) continue
          teams.push({ tag, members, text: '', note: text })
        }
        return { title, badge, type: 'teams', kind, rows: [], teams }
      }
      // 旧数据（没有 v2.teams）→ 退回按文档行解析
      const teamLines = lines.filter(l => !/^注\s*[:：]/.test(l))
      const teams = teamsFromLines(teamLines)
      const noteText = lines.filter(l => /^注\s*[:：]/.test(l))
        .map(l => l.replace(/^注\s*[:：]\s*/, '').trim()).filter(Boolean).join('；')
      if (noteText) teams.push({ tag: '', members: [], text: '', note: noteText, notePrefix: true })
      return { title, badge, type: 'teams', kind, rows: [], teams }
    }
    // 面板段：**与面板侧 parse.js 的 v2PanelRows 同源**。只有 v2 分得清「键值对」和「说明行」
    // （文档行 `暴击率：70%+` 与 `辅助向：暴击率70% / 暴伤220%` 形状一样），
    // 键值对统一成「label 留空 + `k：v` 进 item」，同组 ≤3 条才能在共享归一里合并成一行。
    if (title === '面板' && (data?.v2?.panels ?? []).length) {
      const panelRows = (data.v2.panels ?? []).map(r => {
        const key = String(r?.k ?? '').trim()
        if (key) {
          const value = String(r?.v ?? '').trim()
          return value ? { label: '', ref: '', items: [{ text: displayText(`${key}：${value}`), sepAfter: '' }] } : null
        }
        const text = String(r?.text ?? '').trim()
        if (!text) return null
        const parts = text.split(/\s*[/／]\s*/).filter(Boolean)
        return {
          label: displayText(String(r?.label ?? '')),
          ref: '',
          // `/` 只是拆分的依据，**不画字面分隔符**（用户反馈：chip 之间不该有残留的 `/`）
          items: parts.map((p, i) => ({ text: displayText(p), sepAfter: '' }))
        }
      }).filter(Boolean)
      return { title, badge, type: 'stats', kind, rows: panelRows }
    }
    const rows = linesToModelRows(lines, title === '武器' ? weaponHints : [], title === '天赋' ? crownHint : null, title === '天赋' ? levelHints : null,
      title === '圣遗物' ? (data?.v2?.artifacts ?? []) : [],
      title === '武器' ? (data?.v2?.weapons ?? []) : [])
    // 主词条行的 `note` / `noteSlot`（`理之冠：…防御力（特殊）` 里的「特殊」）：
    // 面板直接读 v2 字段；网页版读的是**文档层行**，所以这里把字段里的括注补挂到对应部位的那个值上，
    // 渲染成同一份小字备注（值里已经带括注的不重复挂 —— 那种由显示层折成 note，见 guide-display）。
    const withNotes = title === '圣遗物' ? attachMainNotes(rows, data?.v2?.artifacts ?? []) : rows
    return { title, badge, type: kind === 'stats' ? 'stats' : 'rows', kind, rows: withNotes }
  })
  // 天赋兜底（用户定稿 2026-09-24）：**没填天赋就按 111 正常显示**，不再显示「暂无」。
  // 正常数据里每个角色都有 `天赋：A1 E1 Q1` 行（没有的话由 build-docx 补），这里再兜一层：
  // 以后新增角色还没填天赋时，网页版 / 预览照样画 A 1 ／ E 1 ／ Q 1 三格。
  for (const section of model) {
    if (section.kind === 'rows' && section.title === '天赋' && !(section.rows ?? []).length) {
      section.rows = [defaultTalentRow(levelHints, crownHint)]
    }
  }
  return normalizeSections(model)
}

/** 默认天赋行：固定三格 A → E → Q，等级取 v2（缺省 1），皇冠按皇冠行 —— 与「文档写了 `天赋：A1 E1 Q1`」同一形状 */
function defaultTalentRow (levelHints, crownHint) {
  const crowns = new Set(crownHint ?? [])
  return {
    label: '',
    kind: 'talents',
    ref: '',
    items: ['A', 'E', 'Q'].map(name => {
      const lv = levelHints?.get(name)
      const level = Number.isInteger(lv) && lv >= 1 && lv <= 10 ? lv : 1
      return { text: name, sepAfter: '', level, crown: crowns.has(name) || level === 10 }
    })
  }
}

/**
 * 把 v2 主词条行的 `note`（+ `noteSlot`）挂到网页版模型的那个部位条目上。
 * 与面板侧 parse.js 的取法同序：两边都按 v2 里 `kind:'main'` 行的**出现顺序**对齐。
 * @param {object[]} rows 文档层行模型
 * @param {object[]} v2Artifacts v2.artifacts
 * @returns {object[]}
 */
function attachMainNotes (rows, v2Artifacts) {
  const mains = (v2Artifacts ?? []).filter(r => r && r.kind === 'main')
  if (!mains.length) return rows
  const isMainRow = (row) => (row?.items ?? []).some(it => it.slot)
  let seen = 0
  return (rows ?? []).map(row => {
    if (!isMainRow(row)) return row
    const src = mains[seen++]
    const note = String(src?.note ?? '').trim()
    if (!note) return row
    const wantSlot = String(src?.noteSlot ?? '').trim()
    const items = (row.items ?? []).map(it => ({ ...it }))
    // 目标部位：noteSlot 指定的那个；没指定就取第一个「值里还没有括注」的部位
    const target = (wantSlot && items.find(it => it.slot === wantSlot)) ||
      items.find(it => !/[（(][^）)]*[）)]/.test(String(it.text ?? '')))
    if (!target || /[（(][^）)]*[）)]\s*$/.test(String(target.text ?? ''))) return row
    target.note = note
    return { ...row, items }
  })
}

/**
 * 配队行 → 队伍模型
 *
 * 语义符号口径（**如实保留，不臆断**）：
 *   · `+` 连接的是**同一支队伍的并列成员**（3 个 = 3 人队、4 个 = 4 人队，谁都不是「备选」）
 *   · `/` 连接的是**同一格里的可替换项**（二选一）→ **合并进同一个成员格**，
 *     格内文本原样保留 ` / `（如 `[迪奥娜 / 阿罗夏]`）；不另加中文标注、不拆成额外成员格
 *   · 两者都没有的整段文字 → 当行尾说明（`note`）
 * @param {string[]} lines
 * @returns {Array}
 */
function teamsFromLines (lines) {
  return (lines ?? []).map(line => {
    const text = String(line ?? '').trim()
    const kv = text.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
    const tag = kv ? kv[1] : ''
    const body = (kv ? kv[2] : text).trim()
    const noteHit = body.match(/^(.*?)[\s　]*(注\s*[:：].*)$/)
    const membersPart = (noteHit ? noteHit[1] : body).trim()
    const notes = noteHit ? [noteHit[2].trim().replace(/^注\s*[:：]\s*/, '')] : []
    // `A + B + C / D / E`：先按 `+` 切并列成员，再把每格里的 `/` 候选**并回同一格**
    const members = []
    if (/\s*[+＋＆&]\s*/.test(membersPart)) {
      for (const piece of membersPart.split(/\s*[+＋＆&]\s*/)) {
        const merged = piece.replace(/\s*[/／]\s*/g, ' / ').trim()
        if (!merged) continue
        // 成员**末尾的括注**要拆成 note（`希诺宁（二命）` → name `希诺宁` + note `二命`）：
        // 判据与 parse-docx 的 splitNameNote / NAME_NOTE_RE 一致（只认末尾那一层括号）。
        // 拆出来之后，共享的 `normalizeTeams` 才会把「X命 / 高金」这类**成本备注**提到**行尾小字**
        // （`… + 希诺宁　注：二命`，与面板 codex.html 同款）；其余括注（`精五` 之类）留在成员上，
        // 两端都渲染成成员名后的行内括注。
        // ⚠ 以前这里不拆，括注被当成**名字的一部分**（`希诺宁（二命）`），于是网页版画的是
        //   行内括注、面板画的是行尾备注 —— audit-web-vs-panel 会报这一处漂移。
        const hit = merged.match(/^(.*?)\s*[（(]([^（()）]+)[）)]\s*$/)
        const name = (hit ? hit[1] : merged).trim()
        const note = hit ? hit[2].trim() : ''
        if (name) members.push({ name, note, ref: '', plain: name })
      }
    } else if (membersPart) {
      // 没有 `+`：整段是说明文字（`自由选择 / 减抗位` 这类，**不当成员**，`/` 原样留在说明里）
      notes.push(membersPart)
    }
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
  // 单条目的行也要画备注（主词条只有一槽、副词条只写一条时很容易踩到）：
  // 面板侧 codex.html 是画 `row.items[0].note` 的，这里漏了就会「网页版没有括注、面板有」。
  if (items.length === 1) {
    const note = items[0].note ? `<span class="rank-note">（${inline(items[0].note)}）</span>` : ''
    return `<span class="row-value">${inline(items[0].text)}${note}${crownBadge(items[0])}${levelBadge(items[0])}</span>`
  }
  const isTalent = row.kind === 'talents' || /天赋/.test(String(row.label))
  const isMain = items.some(it => it.slot)
  // 命座：行上有 ref（`constellation:N`）时带 `data-icon-ref`，面板侧据此挂命座图标
  // （网页版 guide.html 不打包图鉴图片资源，图标由面板 / 插件在运行期解析）
  const iconRef = items.find(it => String(it.ref || '').startsWith('constellation:'))?.ref
  const iconAttr = iconRef && /命座/.test(String(row.label)) ? ` data-icon-ref="${escapeHtml(iconRef)}"` : ''
  const listCls = isTalent ? 'rank-list talents' : (isMain ? 'rank-list main-slots' : 'rank-list')
  const parts = items.map(it => {
    const note = it.note ? `<span class="rank-note">（${inline(it.note)}）</span>` : ''
    // 天赋三格固定顺序（A → E → Q）：图标 + 正下方数字，等级 10 叠皇冠徽标
    // 主词条并列三槽：靠排版分隔（不写字面 `｜`），槽名用 <b> 提亮
    const sep = it.sepAfter && !isTalent && !isMain ? `<span class="sep">${inline(it.sepAfter)}</span>` : ''
    const slotAttr = it.slot ? ` data-slot="${escapeHtml(it.slot)}"` : ''
    const cls = ['rank-item', it.crown ? 'rank-crown' : '', it.slot ? 'main-slot' : '', isTalent ? 'talent-item' : ''].filter(Boolean).join(' ')
    const unitCls = ['rank-unit', it.slot ? 'main-slot' : '', isTalent ? 'talent' : ''].filter(Boolean).join(' ')
    const text = isTalent ? `<span class="rank-text">${inline(it.text)}</span>` : inline(it.text)
    return `<span class="${unitCls}"${slotAttr}><span class="${cls}">${text}${crownBadge(it)}${levelBadge(it)}${note}</span>${sep}</span>`
  })
  return `<span class="${listCls}"${iconAttr}>${parts.join('')}</span>`
}

/**
 * 天赋等级数字：`level` 1..10 → 图标/字母下方的小数字（面板同款口径）。
 * 没有 level 的旧数据不显示数字（不臆造数值）。
 */
function levelBadge (item) {
  const lv = Number(item?.level)
  if (!Number.isInteger(lv) || lv < 1 || lv > 10) return ''
  return `<span class="level-num" title="天赋等级 ${lv}">${lv}</span>`
}

/**
 * 皇冠必需项的徽标：**内联 SVG**（不用 emoji —— 游戏内 webview 渲染不一致）。
 * 数据里的 `10` 已经不在文本里，皇冠只由渲染模型的 `crown: true` 表达。
 */
function crownBadge (item) {
  if (!item || item.crown !== true) return ''
  return '<svg class="crown-badge" viewBox="0 0 16 16" role="img" aria-label="需要皇冠">' +
    '<path d="M1.6 4.4l2.9 2.1L8 2.6l3.5 3.9 2.9-2.1-1.3 8.1H2.9z" fill="currentColor"/>' +
    '<rect x="2.9" y="12.9" width="10.2" height="1.7" rx="0.85" fill="currentColor"/>' +
    '<circle cx="1.6" cy="4.4" r="1.15" fill="currentColor"/>' +
    '<circle cx="14.4" cy="4.4" r="1.15" fill="currentColor"/>' +
    '<circle cx="8" cy="2.6" r="1.25" fill="currentColor"/></svg>'
}

/**
 * 六个模块 → 预览用 HTML 片段（与 guide.html 的卡片**同一套渲染函数**）
 * @param {object} data 角色 JSON
 * @param {{dir?: string, indent?: number}} [opts]
 * @returns {string}
 */
export function renderGuideSectionsHtml (data, opts = {}) {
  const indent = Number.isInteger(opts.indent) ? opts.indent : 6
  return characterSections(data)
    .map(section => renderDisplaySection(section, indent, opts.dir ?? ''))
    .join('\n')
}

/**
 * 六个模块 → 纯文本行（预览面板的逐行文本；与面板模型逐行可比对）
 * 形如 `[天赋] 优先级：Q＞E＞A`、`[配队] 推荐：A + B 注：…`
 * @param {object} data
 * @returns {string[]}
 */
export function renderGuideSectionsText (data) {
  const out = []
  for (const section of characterSections(data)) {
    const name = `${section.badge ? section.badge + ' ' : ''}${section.displayTitle ?? section.title}`
    if (section.empty) { out.push(`[${name}] ${EMPTY_TEXT}`); continue }
    // 段落固定小字说明（武器段）：与网页版 / 面板渲染出的那一行同内容
    if (section.hint) out.push(`[${name}] ${section.hint}`)
    if (section.kind === 'teams') {
      for (const team of section.teams) {
        // 成员格内的可替换项（`迪奥娜 / 阿罗夏`）已并进 `name`，这里原样输出
        const members = team.members.map(m => `${m.name}${m.note ? `（${m.note}）` : ''}`).join(' + ')
        const note = team.note ? `${team.notePrefix ? '注：' : ''}${team.note}` : ''
        const body = [members, note].filter(Boolean).join(team.members.length ? ' ' : '')
        out.push(`[${name}] ${team.tag ? team.tag + '：' : ''}${body}`)
      }
      continue
    }
    for (const row of section.rows) {
      if (row.kind === 'note') { out.push(`[${name}] ${row.items?.[0]?.text ?? ''}`); continue }
      const items = row.items ?? []
      // 天赋三格：**固定顺序 + 空格分隔**（与文档一致）；主词条：文档/纯文本层用 `｜`
      const isTalent = row.kind === 'talents' || /天赋/.test(String(row.label))
      const isMain = items.some(it => it.slot)
      const body = items.map((it, i) => {
        const level = Number.isInteger(Number(it.level)) ? String(it.level) : ''
        const crown = it.crown ? '👑' : ''
        const sep = i < items.length - 1 ? (isMain ? '｜' : (isTalent ? ' ' : (it.sepAfter || ''))) : ''
        return `${it.text}${level}${crown}${sep}`
      }).join('')
      out.push(`[${name}] ${row.label ? row.label + '：' : ''}${body}`)
    }
  }
  return out
}

/**
 * 渲染一个模块（空模块输出「暂无」占位）
 * @param {object} section 已归一的段落
 * @param {number} indent
 * @param {string} dir
 * @returns {string} HTML
 */
export function renderDisplaySection (section, indent, dir) {
  const pad = ' '.repeat(indent)
  const out = []
  out.push(`${pad}<div class="section${section.empty ? ' section-empty' : ''}">`)
  const badge = section.badge ? `<span class="section-badge">${escapeHtml(section.badge)}</span>` : ''
  out.push(`${pad}    <div class="section-title">${badge}${inline(section.displayTitle ?? section.title)}</div>`)
  // 段落的固定小字说明（武器段：三星/四星武器默认为精5，见 guide-display 的 WEAPON_REFINE_HINT）
  if (section.hint) out.push(`${pad}    <div class="section-hint">${inline(section.hint)}</div>`)
  if (section.empty) {
    out.push(`${pad}    <div class="section-empty-text">${EMPTY_TEXT}</div>`)
  } else if (section.kind === 'teams') {
    out.push(`${pad}    <div class="team-rows">`)
    for (const team of section.teams) {
      const tag = team.tag ? `<span class="row-label">${inline(team.tag)}</span>` : ''
      const members = team.members.map(m => {
        const note = m.note ? `<span class="team-note-inline">（${inline(m.note)}）</span>` : ''
        // 同一格里的可替换项（`迪奥娜 / 阿罗夏`）并在一格里，**不加任何中文标注**、不额外加分隔符
        return `<span class="team-member">${inline(m.name)}${note}</span>`
      }).join('<span class="team-plus">+</span>')
      const note = team.note ? `<span class="row-note">${team.notePrefix ? '注：' : ''}${inline(team.note)}</span>` : ''
      // 没有成员也没有备注的行不画（避免渲染出空的「可选：」）
      if (!team.members.length && !note) return
      out.push(`${pad}        <div class="row${team.tag ? '' : ' row-nolabel'}">${tag}<span class="row-value">${members}${note}</span></div>`)
    }
    out.push(`${pad}    </div>`)
  } else {
    out.push(`${pad}    <div class="rows">`)
    for (const row of section.rows) {
  // 命座：行上有 ref（`constellation:N`）→ 行级 `data-icon-ref`，面板 / 插件据此在**文字前**挂命座图标
  // （网页版 guide.html 不打包图鉴图片资源，运行时由面板解析；取不到图标就纯文字，不留空位）
  const rowIconRef = row.ref && String(row.ref).startsWith('constellation:') ? row.ref : ''
  const iconAttr = rowIconRef ? ` data-icon-ref="${escapeHtml(rowIconRef)}"` : ''
  const label = row.label ? `<span class="row-label">${inline(row.label)}</span>` : ''
  out.push(`${pad}        <div class="row${row.label ? '' : ' row-nolabel'}${rowIconRef ? ' row-constellation' : ''}"${iconAttr}>${label}${renderItems(row)}</div>`)
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
  // 注释里的名字也要转义：名字若含 `-->` 就能从注释里逃出来（下一行已经转义，这行以前漏了）
  out.push(`<!-- ================= ${escapeHtml(name)} ================= -->`)
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
