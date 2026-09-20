/**
 * 转换器：Word 文档（原神·角色攻略.docx） → data/gi/*.json（模式 v2 结构化字段）
 *
 * 特点：
 *  - 识别 [[w:武器名]] [[a:圣遗物]] [[c:角色]] [[t:E]] [[k:2]] 引用标记（有标记时以标记为准，无标记时按行形态推断）
 *  - 每类信息写进独立字段（v2.weapons / v2.artifacts / v2.talents / v2.panels / v2.constellations / v2.teams）
 *  - 认不出来的行原样存进 unparsed，绝不丢内容；tags / sections 由 v2 回推，旧渲染器与插件继续可用
 *
 * 用法：
 *   node scripts/parse-docx.mjs [docx路径] [--dry]
 *   默认 docx 路径：D:\文件\游戏\原神\原神·角色攻略.docx
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readDocx, SEPARATOR } from './lib/docx.mjs'
import { makeRef, parseRef, deriveSections, deriveTags, validate, constellationIndex, extractMarks, stripMarks, MARK_RE, parseNoteLine, resolveNoteText, artifactStatPool, isNoteRow } from './lib/schema.mjs'
import { warn, getWarnings, resetWarnings, setWarnContext } from './lib/parse-warnings.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = process.env.DSH_DATA_DIR ? path.resolve(process.env.DSH_DATA_DIR) : path.join(root, 'data')
// DSH_GI_DIR 可指向 data/gi 的**冻结副本**：并发写 data/gi 时（编辑器多个窗口 / 批处理脚本），
// build-docx 的往返校验用副本 + 同一份内存 bundle 比对，避免被别处的在途改动搅乱。
const giDir = process.env.DSH_GI_DIR ? path.resolve(process.env.DSH_GI_DIR) : path.join(dataDir, 'gi')
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

const SECTION_TITLES = ['武器推荐', '圣遗物推荐', '天赋加点', '毕业面板参考', '命座推荐', '配队推荐']
/** 小节 → v2 字段名（备注行 `注：` 落到所属小节的数组里） */
const NOTE_SECTION_KEY = {
  武器推荐: 'weapons', 圣遗物推荐: 'artifacts', 天赋加点: 'talents',
  毕业面板参考: 'panels', 命座推荐: 'constellations', 配队推荐: 'teams'
}
const BUILD_LABELS = ['辅助向', '输出向', '辅助', '输出', '主c', '主C', '副c', '副C', '日常使用', '大世界', '深渊', '新手']
const STAT_LABELS = ['暴击率', '暴击伤害', '暴伤', '攻击力', '生命值', '防御力', '元素精通', '元素充能效率', '充能效率', '充能', '精通', '双爆', '治疗加成', '护盾强效', '元素伤害加成']
const BUDGET_SETS = new Set(['战狂', '武人', '教官', '流放者', '游医', '冒险家', '幸运儿', '学士', '赌徒', '奇迹', '守护之心', '勇士之心', '祭冰之人', '祭火之人', '祭水之人', '祭雷之人'])

const CN_TIER = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 }

/** 命座序号 → 中文位（1 → 一） */
const CN_NUM_CHAR = ['', '一', '二', '三', '四', '五', '六']

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function loadIndex () {
  try {
    return readJson(path.join(dataDir, '_index.json'))
  } catch {
    return { weapons: [], artifacts: [], characters: [] }
  }
}

/**
 * 「并列/优先级」分隔符：`>` ＞、`≥`、`/` ／、`=` ＝、`，` `,` `、`
 * 连写的分隔符（`> >`、`/ /`）算一个，切完不留空项。
 */
/**
 * 条目分隔符：`>` / `＞`（优先级）、`≥`、`/` / `／`（并列）、全角竖线 `｜`（主词条槽位之间的并列）、
 * `=` / `＝`、顿号逗号。
 *
 * `｜` 必须在这里：主词条行的三个槽位（时之沙｜空之杯｜理之冠）用 `｜` 分隔，
 * 解析侧要能把它还原成三个部位（见 parseMainStats）。
 */
const ITEM_SEP_RE = /\s*(?:[>＞]|≥|[/／｜]|[=＝]|[，,、])\s*/

/**
 * 拆分「并列/优先级」条目，并记录原文用的分隔符（回写时保持一致）。
 * 空项（`/ /` 这类连续分隔符造成的）一律丢掉，避免回推文本出现 ` / / `。
 */
function splitItems (text) {
  const s = String(text ?? '').trim()
  if (!s) return { items: [], sep: ' > ' }
  let sep = ' > '
  if (/[>＞]/.test(s)) sep = ' > '
  else if (s.includes('≥')) sep = ' ≥ '
  else if (/[/／=＝，,]/.test(s)) sep = ' / '
  const items = s.split(ITEM_SEP_RE).map(x => x.trim()).filter(Boolean)
  return { items, sep }
}

/**
 * `[[t:Q]]` 这类标记在按分隔符切分时不能被切开（`]]` 里的 `]` 会变成空段，
 * 所以先把标记换成不含分隔符的占位符，切完再还原。
 * 占位符用私有区字符，正常文本里不会出现。
 */
const MARK_HOLD = '\uE000'
const MARK_HOLD_END = '\uE001'
function holdMarks (text) {
  const held = []
  const masked = String(text ?? '').replace(new RegExp(MARK_RE.source, 'g'), (raw) => {
    held.push(raw)
    return MARK_HOLD + (held.length - 1) + MARK_HOLD_END
  })
  return { masked, held }
}
function releaseMarks (token, held) {
  return token.replace(new RegExp(MARK_HOLD + '(\\d+)' + MARK_HOLD_END, 'g'), (_, i) => held[Number(i)] ?? '')
}

/**
 * 逐档分隔符 → v2 的 `sep` 写法。
 *
 *   · 各档相同 → 单 token（`' / '` / `' > '`），与历史数据逐字节一致；
 *   · 混合写法 → 逐档（`' / > '` ＝ 第一档 `/`、第二档 `>`）—— `sepTokens` / `gapSeps`
 *     就是按空白拆 token 逐档取的，所以这是仓库既有约定；
 *   · 只有一条 / 认不出分隔符 → 退回 `splitItems` 的老口径（不制造无谓改动）。
 * @param {Array<{text: string, sep: string}>} full
 * @param {string} raw 原始行文本（兜底用）
 * @returns {string}
 */
function gapSepOf (full, raw) {
  const gaps = full.slice(0, -1).map(x => String(x.sep ?? '').trim() || '/')
  if (!gaps.length) return splitItems(raw).sep
  const uniq = [...new Set(gaps)]
  return uniq.length === 1 ? ` ${uniq[0]} ` : ' ' + gaps.join(' ') + ' '
}

/**
 * 与 splitStats 同一套切分，但额外给出**每一项后面的分隔符原文**（末项为 ''）。
 * `优先级：Q＞E＞A` 要连 `＞` 一起逐字写回，不能被归一成 `>`。
 * @param {string} text
 * @returns {Array<{text: string, sep: string}>}
 */
function splitStatsFull (text) {
  const { masked, held } = holdMarks(text)
  const out = []
  let last = 0
  const re = new RegExp(ITEM_SEP_RE.source, 'g')
  let m
  while ((m = re.exec(masked)) !== null) {
    out.push({ text: releaseMarks(masked.slice(last, m.index).trim(), held), sep: m[0] })
    last = m.index + m[0].length
  }
  out.push({ text: releaseMarks(masked.slice(last).trim(), held), sep: '' })
  return out
}

/**
 * 按分隔符切分（与 splitItems 同一套分隔符），且不破坏 `[[x:..]]` 标记
 * —— 标记内部的分隔符不参与切分。空项一律丢掉。
 * @param {string} text
 * @returns {string[]}
 */
function splitStats (text) {
  const { masked, held } = holdMarks(text)
  return masked.split(ITEM_SEP_RE)
    .map(x => releaseMarks(x.trim(), held))
    .filter(Boolean)
}

/**
 * 括注 → 备注走廊：
 *   `纳西妲（二命）`            → 成员 `纳西妲`，备注 `二命`
 *   `螭骨剑（精5）`             → 条目 `螭骨剑`，note `精5`（精炼类**留在原地**，不进备注走廊）
 *   `水元素伤害加成（二命）`      → 词条 `水元素伤害加成`，行内括注 `二命`
 *   行末 `注：建议二命及以上…`    → 该段的备注行 `{kind:'note', text:'二命'}`
 *
 * 只有**命座 / 成本 / 随命座**这类括注会进备注走廊（`（精五）` `（叠满）` `（满命）`
 * `（建议/必须/可选）` `（特殊）` `（华馆）` 等保持现状不动）。
 */

/** 括注尾巴：名称 +（备注） —— 只要末尾那一层括号 */
const NAME_NOTE_RE = /^(.*?)\s*[（(]([^（()）]+)[）)]\s*$/

/**
 * 配队成员 / 武器条目：识别的角色名 + 末尾括注 → {name, note}
 * 括注文本与 JSON 的 note 逐字相同（不润色），这样 build-docx 能写回。
 */
function splitNameNote (token) {
  const raw = String(token ?? '').trim()
  const marks = extractMarks(raw)
  if (marks.length) {
    const mk = marks[0]
    return { name: mk.name, note: raw.replace(mk.raw, '').trim().replace(/^[（(]|[）)]$/g, '').trim() }
  }
  const m = raw.match(NAME_NOTE_RE)
  if (m) return { name: m[1].trim(), note: m[2].trim() }
  return { name: raw, note: '' }
}

/** 「名称（备注）」或「[[w:名称]]」→ {name, note, ref} */
function parseWeaponItem (token, index) {
  const { name, note } = splitNameNote(token)
  return { name, ...(note ? { note } : {}), ref: makeRef('weapon', name) }
}

/** 圣遗物套装 token（可能带件数说明或 [[a:..]]） */
function parseSetItem (token) {
  const marks = extractMarks(token)
  let name = token.trim()
  let pieces = ''
  if (marks.length) {
    const mk = marks[0]
    name = mk.name
    pieces = token.replace(mk.raw, '').trim().replace(/^[（(]|[）)]$/g, '').trim()
  } else {
    const m = name.match(/^(.+?)\s*[（(]([^（()）]+)[）)]\s*$/)
    if (m) { name = m[1].trim(); pieces = m[2].trim() }
    if (!pieces) {
      const p = name.match(/^(.+?)(\d件套|\d[+＋＆&]\d件套|\d件套[+＋＆&]\d件套)$/)
      if (p) { name = p[1].trim(); pieces = p[2] }
    }
    if (!pieces) {
      // 「千岩牢固2」「绝缘之旗印2」这类尾部数字 = 两件套件数（不删数字）
      const q = name.match(/^(.+?)(\d)$/)
      if (q) { name = q[1].trim(); pieces = q[2] + '件套' }
    }
  }
  // 字段顺序与 data/gi 既有写法一致：name, ref, pieces —— 否则 JSON.stringify 的深比较会被键序影响
  return { name, ref: makeRef('artifact', name), ...(pieces ? { pieces } : {}) }
}

/**
 * 套装组合分隔符：半角 `+`、全角 `＋`、全角 `＆`、半角 `&` —— 都表示「A 与 B 两套」。
 * 统一按 `+` 处理，这样文档里写成 `A＆B` 也能拆成两个 set 并各自带 ref。
 */
const SET_PLUS_RE = /\s*[+＋＆&]\s*/

/**
 * 渲染器按 sep 连接条目，所以 sep 里的分隔符必须带空格（' / '、' + '）。
 * `A / B + C` 这种「份间用 /、份内用 +」的混用写法归一成 `' / + '`，
 * 与仓库既有 JSON 里的混合 sep 写法一致，保证 before/after 往返 sep 逐字不变。
 * 纯 `/` 与纯 `+` 各自归一成 `' / '`、`' + '`。
 */
const canonicalSep = (s) => {
  const toks = []
  for (const m of String(s).matchAll(/[/／]|[+＋＆&]/g)) toks.push(/[/／]/.test(m[0]) ? '/' : '+')
  if (!toks.length) return String(s).replace(/\s+/g, ' ').trim()
  const uniq = [...new Set(toks)]
  if (uniq.length > 1) return ' / + '
  return uniq[0] === '/' ? ' / ' : ' + '
}

/**
 * 把「被 > ≥ / 拆出来的一份」再按 + 拆成 2+2 的两个套装。
 * 例：水仙之梦+沉沦之心 → [{name:水仙之梦},{name:沉沦之心}]，该行 sep 用 ' + '，回推仍是「水仙之梦+沉沦之心」。
 * 「2充能+2充能」这类口语写法照样拆开，靠校验（不在图鉴）标出来。
 * @param {string} text 一份套装内容
 * @param {(t: string) => object} parse 单个套条的解析函数
 * @returns {object[] | null} 不是 2+2 组合时返回 null
 */
function parseSetPlus (text, parse) {
  const s = String(text ?? '')
  if (!SET_PLUS_RE.test(s)) return null
  const parts = s.split(SET_PLUS_RE).map(x => x.trim()).filter(Boolean)
  return parts.length > 1 ? parts.map(parse) : null
}

/** 每个条目两侧不应残留的分隔符 / 组合符（`如雷的盛怒 /` 这类带尾巴的名字要先清掉） */
const ITEM_EDGE_RE = /^[\s>＞≥/／=＝+＋＆&、,，]+|[\s>＞≥/／=＝+＋＆&、,，]+$/g

/** 拆出来的每份去掉首尾残留的分隔符 */
function normalizeSegment (seg) {
  return String(seg ?? '').replace(ITEM_EDGE_RE, '').replace(/\s+/g, ' ').trim()
}

/**
 * 套装行：把 sep 拆出来的每份交给 parseSetPlus，再按份数补上连接符。
 *
 * sep 是**逐档**分隔符（schema.mjs 的 joinWithSep 与插件 gapSeps 都按 `sep.split(/\s+/)` 逐档读）。
 * 规则：
 *   - 份内（同一份里被 `+`/`＆` 拆开的）间隔一律 `+`：烟绯的 `A / B / C + D` → sep `/ / +`，逐档还原原文；
 *   - 份间（splitItems 拆出来的）沿用原文的份间分隔符（统一成一个，避免 `' / / '` 这种连续分隔符）；
 *   - 每份先 normalizeSegment，丢掉原文里悬挂的 `/`、`+`；
 *   - 最后按 sets.length - 1 裁剪：多了丢掉、少了用 fallback 补齐，
 *     保证 `sep.split(/\s+/).length === sets.length - 1`（否则渲染器 join 出来就会出现空条目）。
 *
 * @param {string[]} segments
 * @param {string} baseSep splitItems 拆出来的份间分隔符
 * @param {(t: string) => object} parse
 * @returns {{ sets: object[], sep: string }}
 */
function buildSetRow (segments, baseSep, parse) {
  const base = canonicalSep(baseSep)
  const raw = segments.map(normalizeSegment).filter(Boolean)
  // 空项过滤后重新选一个份间连接符，免得沿用原文的 ' / / '（连续分隔符）导致 sep 对不上
  const between = raw.length > 1 && base !== ' > ' && base !== ' ≥ ' ? ' / ' : base
  const sets = []
  const seps = []
  raw.forEach((seg, i) => {
    // parseSetPlus 会按 SET_PLUS_RE 过滤空项，所以「份内有几项」要按实际结果算
    const plus = parseSetPlus(seg, parse)
    const group = plus ?? [parse(seg)]
    group.forEach((set, j) => {
      // 第一份的首项前面没有 gap；其余每一项前面都有 gap（份内 ' + '，跨份 between）
      const isFirstOfRow = i === 0 && j === 0
      if (!isFirstOfRow) seps.push(j > 0 ? ' + ' : between)
      sets.push(set)
    })
  })
  const fallback = sets.length === 1 ? ' > ' : (between === ' > ' ? ' / ' : between)
  const used = seps.slice(0, Math.max(0, sets.length - 1))
  while (used.length < sets.length - 1) used.push(fallback)
  return {
    sets,
    sep: sets.length > 1 ? canonicalSep(used.join(' ')) : fallback
  }
}

/**
 * 配队成员：认识的角色名 → ref，其余留文字。
 *
 * 语义符号（与网页版 build-html.mjs 的 teamsFromLines、面板 parse.js 的 v2TeamRows 同一口径）：
 *   · `+` 连接的是**并列成员**（3 个 = 3 人队、4 个 = 4 人队）
 *   · `/` 连接的是**同一格的可替换项**（二选一）→ **并进同一个成员格**，格内原样保留 ` / `
 *     （`A + B + C / D` → 3 个成员，第 3 个是 `C / D`）；`/` 不拆成额外成员格
 *
 * 成员带**括注**（`纳西妲（二命）` `爱可菲 / 尼可`）时**留在成员上**
 * （`{name:'纳西妲', note:'二命'}`）—— 显示层渲染成**行内全角括弧**，与圣遗物的
 * `千岩牢固（四件套）` 同款（用户定稿 2026-09-20：成员备注用括弧、`注：` 只留给段末纯文字行）。
 * 以前这里会把命座/成本类括注提到段末 `注：` 行，现在不再拆开。
 * @returns {{members: object[], notes: string[]} | null}
 */
function parseMembers (text, index) {
  const chars = index.characters ?? []
  // 没有 `+` 就不是队伍行（整段说明，如 `自由选择 / 减抗位`）
  if (!/\s*[+＋＆&]\s*/.test(String(text))) return null
  const slots = String(text).split(/\s*[+＋＆&]\s*/).map(x => x.trim()).filter(Boolean)
  if (slots.length < 2) return null
  const notes = []
  const members = slots.map(slot => {
    // 同一格里的 `/` 候选择并成一格（`C / D`），空白归一成 ` / `；`、` 是旧写法同样并格
    const merged = slot.split(/\s*[/／、]\s*/).map(x => x.trim()).filter(Boolean).join(' / ')
    const sn = splitNameNote(merged)
    // 取图标用第一个候选名（面板 / 网页版同款：格内首个候选代表这一格）
    const first = sn.name.split(/\s*\/\s*/)[0].trim()
    // 括注**留在成员上**（渲染成行内括弧），不再提到段末 `注：` 行
    const note = String(sn.note ?? '').trim()
    return { name: sn.name, ...(note ? { note } : {}), ref: makeRef('character', first) }
  })
  // 至少一个候选能对上角色名就认为是队伍（候选项并格后成员数变少，不能按「一半」判）
  const hit = members.filter(x => x.name.split(/\s*\/\s*/).some(n => chars.includes(n.trim()))).length
  return hit >= 1 ? { members, notes } : null
}

/**
 * 主词条一行 → {时之沙:[], 空之杯:[], 理之冠:[]}
 *
 * 分隔符语义：部位之间是**并列**关系（文档里写全角竖线 `｜`，旧数据是 `/`，两者都要能读），
 * 部位内部候选值用 `/`，优先级才用 `＞`。`ITEM_SEP_RE` 会把 `｜` 与 `/` 都切开，
 * 靠 `时之沙：` 这类部位前缀把片段归位，所以两种写法都能还原成三个槽位。
 *
 * 词条值上的括注（`水元素伤害加成（二命）`、`防御力（特殊）`）**一律留在值里**
 * —— 用户定稿（2026-09-20）：「统一放括注里面」。所以这里不再把它剥成 `note` / `noteSlot`
 * 字段；显示层会把值末尾的括注折成小字备注（见 guide-display 的 normalizeArtifactRows），
 * 两条链路看起来完全一样，而 JSON / 文档两边都是同一种写法（往返逐字相等）。
 * @param {string} text
 * @param {object} [into]
 */
function parseMainStats (text, into = { 时之沙: [], 空之杯: [], 理之冠: [] }) {
  const slots = ['时之沙', '空之杯', '理之冠']
  let current = null
  const take = (raw) => String(raw ?? '').trim()
  for (const seg of splitStats(text)) {
    const hit = slots.find(s => seg.startsWith(s + '：') || seg.startsWith(s + ':'))
    if (hit) {
      current = hit
      const v = take(seg.slice(hit.length + 1))
      if (v) into[hit].push(v)
    } else if (current) {
      const v = take(seg)
      if (v) into[current].push(v)
    } else {
      const v = take(seg)
      if (v) into['时之沙'].push(v)
      // 还没遇到过任何部位就有独立词条 → 无法归位，兜底塞进「时之沙」并显式告警（防呆，不静默）
      warn(`主词条片段「${String(seg).trim()}」出现在任何部位之前，无法归位，已兜底归入「时之沙」`)
    }
  }
  return into
}

/**
 * 天赋字母 + 可选等级：`Q` / `[[t:Q]]` / `E10` / `A1` / `E 10` 都能读。
 *
 * 边界（重要）：字母后**紧跟的 1~2 位数字**才算等级，且必须是 1..10 ——
 *   `A1` → A 等级 1；`A10` → A 等级 10（= 已投皇冠）；`A 10` → 同样按等级 10（中间允许一个空格）
 *   其它情况（如 `A0`、`A11`）不当作等级，退回「只认字母」并保留原文本，绝不臆造数值。
 * 等级 10 表示已投皇冠，会同时带上 `crown: true`（文档里只有 `E10` 一种写法，不需要额外标记）。
 * @param {string} token
 * @returns {{name: string, ref: string, level?: number, crown?: boolean}|null}
 */
function talentItem (token) {
  const text = stripMarks(String(token)).trim()
  const m = text.match(/^([AEQaeq])\s*(\d{1,2})?/)
  if (!m) return null
  const name = m[1].toUpperCase()
  const item = { name }
  const lv = Number(m[2])
  if (m[2] !== undefined && Number.isInteger(lv) && lv >= 1 && lv <= 10) {
    item.level = lv
    if (lv === 10) item.crown = true
  }
  item.ref = makeRef('talent', name)
  return item
}

/**
 * 皇冠行：E（建议）Q（必须）
 * 也支持标记写法 `[[t:E]]（建议）Q（必须）` —— 先把标记逐个取出来（level 取标记后面紧跟的括注），
 * 标记都摘掉后再对剩下的纯字母跑老逻辑，最后按 name+level 去重，保证两种写法结果一致。
 */
function parseCrown (text) {
  const out = []
  const re = /([AEQaeq])\s*(?:[（(]([^）)]*)[）)])?/g
  const seen = new Set()
  /**
   * 皇冠条目入列：括号里可能是**等级**（`E（10）`）、**建议**（`E（必须）`）或两者
   * （`E（10·建议）`）。规则：`10` / `10·xxx` → `level: 10`（皇冠已投），
   * 其它文本进 `note`（建议 / 可选…）；两者都有的写成 `10·建议`。
   */
  const push = (name, raw) => {
    const s = String(raw ?? '').trim()
    const num = s.match(/^(\d{1,2})\s*(?:[·・]\s*(.*))?$/)
    let level = ''
    let note = ''
    if (num) {
      // level 一律写**整数**（与编辑器 / 网页版模型同型；字符串会让往返深比较失败）
      level = Number(num[1])
      note = (num[2] ?? '').trim()
    } else {
      note = s
    }
    const key = `${name}|${level}|${note}`
    if (seen.has(key)) return
    seen.add(key)
    const item = { name }
    if (level) {
      item.level = level
      // 皇冠行里的 10 就是「已投皇冠」——与天赋行的 `talentItem` 同口径，补上 crown:true
      if (level === 10) item.crown = true
    }
    if (note) item.note = note
    item.ref = makeRef('talent', name)
    out.push(item)
  }
  let rest = String(text ?? '')
  for (const mk of extractMarks(rest)) {
    const m = mk.name.match(/[AEQaeq]/)
    if (!m) continue
    const name = m[0].toUpperCase()
    const at = rest.indexOf(mk.raw)
    // 备注也可能写在标记里面：[[t:E（建议）]]
    const inline = mk.name.match(/[（(]([^）)]*)[）)]/)
    let after = rest.slice(at + mk.raw.length)
    const lv = after.match(/^\s*[（(]([^）)]*)[）)]/)
    push(name, lv ? lv[1].trim() : (inline ? inline[1].trim() : ''))
    if (lv) after = after.slice(lv[0].length)
    rest = rest.slice(0, at) + after
  }
  let m
  const re2 = new RegExp(re.source, 'g')
  while ((m = re2.exec(rest)) !== null) push(m[1].toUpperCase(), (m[2] ?? '').trim())
  return out
}

/** 单个角色块 → v2 数据。`parsed.stray` = 文档里没认出来的行（必须为 0） */
function parseBlock (lines, index) {
  const data = { meta: {}, v2: { weapons: [], artifacts: [], talents: [], panels: [], constellations: [], teams: [] } }
  /** 段落行号（不含标题行）→ 认出来了没有 */
  const stray = []
  data.stray = stray
  let title = lines[0] ?? ''
  let name = title
  const dash = title.match(/^(.*?)\s*——\s*(.*)$/)
  if (dash) {
    name = dash[1].trim()
    const lv = dash[2].match(/建议等级[:：]\s*(.+)$/)
    if (lv) data.meta['建议等级'] = lv[1].trim()
  }
  data.name = name
  let section = ''
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) continue
    if (/^[^：:]{1,12}[:：]\s*$/.test(line)) continue // 空栏位（「优先级：」「皇冠：」等）跳过
    const sec = line.match(/^\d+\.\s*(武器推荐|圣遗物推荐|天赋加点|毕业面板参考|命座推荐|配队推荐)\s*$/)
    if (sec) { section = sec[1]; continue }
    if (!section) {
      const m = line.match(/^(定位|100级提升)[:：]\s*(.*)$/)
      if (m) { data.meta[m[1]] = m[2].trim(); continue }
    }
    const un = () => { stray.push({ section: section || '其它', line }) }

    /**
     * 段末备注行 `注：<文本>` → 该段的 `{kind:'note', text}`（放在所属数组末尾）。
     * **整行原样存一条**（不按 `；` 拆开）：同一段的备注在导出时拼成一行 `注：…`，
     * 渲染层（网页版 build-html / 面板 parse.js）都按「一行备注 = 一条」逐行画，
     * 拆开会变成多行、与文档 / 另一端不一致。认不出语义的文本原样存（不丢内容）。
     * @returns {string} 所属 v2 字段名；不是备注行则 ''
     */
    const takeNote = () => {
      const text = parseNoteLine(line)
      if (text == null) return ''
      const key = NOTE_SECTION_KEY[section]
      if (!key) return '' // 不在六个小节里（如抬头说明）→ 当普通行处理
      const pool = section === '圣遗物推荐' ? artifactStatPool(data.v2.artifacts) : []
      // 整行备注一般认不出「命座/成本」语义（那是一整句话），认不出就原样存
      const hit = resolveNoteText(text, { readPool: pool })
      data.v2[key].push({ kind: 'note', text: hit ? hit.raw : text })
      return key
    }

    if (takeNote()) continue

    if (section === '武器推荐') {
      const tier = line.match(/^第([一二三四五六1-6])[档挡][:：]\s*(.*)$/)
      if (tier) {
        const { items, sep } = splitItems(tier[2])
        if (!items.length) continue
        data.v2.weapons.push({ label: null, tier: CN_TIER[tier[1]] ?? null, sep, items: items.map(t => parseWeaponItem(t, index)) })
        continue
      }
      const labeled = line.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
      if (labeled && labeled[2].trim()) {
        const { items, sep } = splitItems(labeled[2])
        if (items.length) {
          data.v2.weapons.push({ label: labeled[1].trim(), tier: null, sep, items: items.map(t => parseWeaponItem(t, index)) })
          continue
        }
      }
      un(); continue
    }

    if (section === '圣遗物推荐') {
      const main = line.match(/^主词条[:：]\s*(.*)$/)
      if (main) {
        const stats = parseMainStats(main[1])
        data.v2.artifacts.push({ kind: 'main', stats })
        continue
      }
      const single = line.match(/^(时之沙|空之杯|理之冠)[:：]\s*(.*)$/)
      if (single) {
        const stats = parseMainStats(`${single[1]}：${single[2]}`)
        const last = data.v2.artifacts[data.v2.artifacts.length - 1]
        if (last && last.kind === 'main') {
          last.stats[single[1]] = stats[single[1]]
        } else {
          data.v2.artifacts.push({ kind: 'main', stats })
        }
        continue
      }
      const sub = line.match(/^副词条[:：]\s*(.*)$/)
      if (sub) {
        // **逐档分隔符**（用户定稿：`暴击率 / 暴击伤害 > 大攻击` → 显示 `暴击率 = 暴击伤害 ＞ 大攻击`）。
        // 全同分隔符仍写成单 token（`' / '` / `' > '`），与旧数据逐字节一致；
        // 混合写法才写成逐档（`' / > '`），这样 `schema.renderArtifactRow` 能逐字写回原文。
        const full = splitStatsFull(sub[1]).filter(x => x.text)
        const stats = full.map(x => x.text)
        if (stats.length) data.v2.artifacts.push({ kind: 'sub', stats, sep: gapSepOf(full, sub[1]) })
        continue
      }
      const setRow = line.match(/^(首选|次选|可选|过渡|套装)[:：]\s*(.*)$/)
      if (setRow) {
        const kind = { 首选: 'preferred', 过渡: 'transition', 次选: 'optional', 可选: 'optional', 套装: 'preferred' }[setRow[1]]
        const { items, sep } = splitItems(setRow[2])
        if (items.length) {
          const row = buildSetRow(items, sep, parseSetItem)
          // label 原样存下（首选 / 次选 / 可选 / 过渡 / 套装），build-docx 写回时逐字还原
          data.v2.artifacts.push({ kind, label: setRow[1], sep: row.sep, sets: row.sets })
          continue
        }
      }
      const labeled = line.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
      if (labeled && labeled[2].trim()) {
        const { items, sep } = splitItems(labeled[2])
        if (items.length) {
          const row = buildSetRow(items, sep, parseSetItem)
          data.v2.artifacts.push({ kind: 'preferred', label: labeled[1].trim(), sep: row.sep, sets: row.sets })
          continue
        }
      }
      un(); continue
    }

    if (section === '天赋加点') {
      /**
       * 天赋等级行（新格式 `天赋：A1 E10 Q10`，固定顺序 A → E → Q）。
       * 分隔符两种都认：空格（主格式）与全角竖线 `｜`（备选格式）。
       */
      const talentLine = line.match(/^天赋[:：]\s*(.*)$/)
      if (talentLine && !/^优先级/.test(stripMarks(line))) {
        const names = [...stripMarks(talentLine[1]).matchAll(/([AEQaeq])\s*(\d{1,2})?/g)]
          .map(m => {
            const name = m[1].toUpperCase()
            const lv = Number(m[2])
            const item = { name }
            if (m[2] !== undefined && Number.isInteger(lv) && lv >= 1 && lv <= 10) {
              item.level = lv
              if (lv === 10) item.crown = true
            } else {
              item.level = 1   // 缺省按 1（用户确认的规则）
            }
            item.ref = makeRef('talent', name)
            return item
          })
        if (names.length) {
          // 固定顺序 A → E → Q；raw 记原写法，便于回溯（不再用于展示）
          const ordered = ['A', 'E', 'Q'].map(k => names.find(n => n.name === k)).filter(Boolean)
          data.v2.talents.push({ kind: 'priority', order: ordered, raw: stripMarks(talentLine[1]).trim() })
          continue
        }
      }
      const pri = line.match(/^(?:优先级|天赋)[:：]\s*(.*)$/)
      if (pri) {
        // 旧格式兼容：`优先级：A1 ＞ E10 ＞ Q10`（逐档分隔符原文保留）
        const parts = splitStatsFull(pri[1])
        const order = parts.filter(p => p.text).map(p => talentItem(p.text)).filter(Boolean)
        if (order.length) {
          // 逐项拼回：每一项后面跟**它自己的**分隔符（`A＞E＞Q` 的两段分隔符不能串位）
          let raw = ''
          for (const p of parts) if (p.text) raw += stripMarks(p.text) + p.sep
          data.v2.talents.push({ kind: 'priority', order, raw: raw.trim() })
          continue
        }
      }
      const crown = line.match(/^皇冠[:：]\s*(.*)$/)
      if (crown) {
        const items = parseCrown(crown[1])
        if (items.length) { data.v2.talents.push({ kind: 'crown', items }); continue }
        // 空皇冠（`皇冠：`）也落成空 items，这样回推文本与原文一致
        data.v2.talents.push({ kind: 'crown', items: [] })
        continue
      }
      un(); continue
    }

    if (section === '毕业面板参考') {
      const kv = line.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
      if (kv) {
        const label = kv[1].trim()
        const value = kv[2].trim()
        if (STAT_LABELS.some(s => label.startsWith(s))) { data.v2.panels.push({ label: null, k: label, v: value }); continue }
        if (BUILD_LABELS.includes(label) || !value) { data.v2.panels.push({ label, text: value }); continue }
        data.v2.panels.push({ label: null, k: label, v: value })
        continue
      }
      const inline = line.match(new RegExp('^(' + STAT_LABELS.join('|') + ')\\s*(\\d.*)$'))
      if (inline) { data.v2.panels.push({ label: null, k: inline[1], v: inline[2].trim() }); continue }
      un(); continue
    }

    if (section === '命座推荐') {
      const c = line.match(/^(.*?)——\s*(.*)$/)
      if (c) {
        // name 先 stripMarks 再归一：`[[k:2]]` / `[[k:二命]]` / `二命` 都要得到 name='二命'、index=2
        const rawName = c[1].trim()
        const stripped = stripMarks(rawName).trim()
        const index = constellationIndex(stripped)
        const name = /^[一二三四五六]命/.test(stripped)
          ? stripped
          : (index ? `${CN_NUM_CHAR[index]}命` : stripped)
        data.v2.constellations.push({ name, index, text: c[2].trim() })
        continue
      }
      // 只有命座号、没有说明的裸行（`[[k:2]]` / `二命` / `2命`）：与 `二命——`（说明为空）同结果，
      // name 归一成「二命」、index=2、text='' —— 这样 build-docx 两种写法都无损
      const bare = line.match(/^\s*(?:\[\[k[:：]\s*)?([一二三四五六]\s*命|\d{1,2}\s*命)\s*\]{0,2}\s*$/)
      if (bare) {
        const stripped = stripMarks(bare[1]).replace(/\s+/g, '').trim()
        const idx = constellationIndex(stripped)
        if (idx) { data.v2.constellations.push({ name: `${CN_NUM_CHAR[idx]}命`, index: idx, text: '' }); continue }
      }
      un(); continue
    }

    if (section === '配队推荐') {
      const row = line.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
      if (row) {
        const label = row[1].trim()
        const value = row[2].trim()
        const parsed = parseMembers(value, index)
        if (parsed) {
          // 成员上的命座/成本括注 → 段末备注行（正文行只留标准名）
          data.v2.teams.push({ label, members: parsed.members, text: '' })
          for (const note of parsed.notes) data.v2.teams.push({ kind: 'note', text: note })
        } else {
          data.v2.teams.push({ label, members: [], text: value })
        }
        continue
      }
      un(); continue
    }
    un()
  }
  // 圣遗物小节有内容但没有主词条行 → 补一条空的主词条（时之沙/空之杯/理之冠 全空）。
  // 现有 data/gi 里就是这么记的（16 个角色），补上才能与 build-docx 的「空栏位不写行」严格互逆。
  if (data.v2.artifacts.length && !data.v2.artifacts.some(r => r.kind === 'main')) {
    data.v2.artifacts.push({ kind: 'main', stats: { 时之沙: [], 空之杯: [], 理之冠: [] } })
  }
  return data
}

function main () {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const docFile = args.find(a => !a.startsWith('--')) ?? DEFAULT_DOC
  if (!fs.existsSync(docFile)) {
    console.error(`找不到文档：${docFile}`)
    process.exit(1)
  }
  const index = loadIndex()
  const { paragraphs } = readDocx(docFile)
  const blocks = []
  let cur = []
  for (const p of paragraphs) {
    if (p === SEPARATOR) { blocks.push(cur); cur = [] } else cur.push(p)
  }
  if (cur.some(x => x.trim())) blocks.push(cur)

  const report = { doc: docFile, characters: [], totals: { characters: 0, weapons: 0, artifacts: 0, talents: 0, panels: 0, constellations: 0, teams: 0, notes: 0, unparsed: 0 }, issues: [], stray: [], warnings: [] }
  resetWarnings()
  for (const block of blocks) {
    const lines = block.filter(x => x !== '')
    if (!lines.length) continue
    setWarnContext(String(lines[0] ?? '').split('——')[0].trim())
    const parsed = parseBlock(lines, index)
    if (!parsed.name || parsed.name.includes('共 129') || parsed.name.startsWith('原神 ·')) continue
    const prevFile = path.join(giDir, `${parsed.name}.json`)
    let prev = {}
    if (fs.existsSync(prevFile)) { try { prev = readJson(prevFile) } catch { prev = {} } }
    const data = {
      schema: 2,
      name: parsed.name,
      game: 'gi',
      ...(prev.highlight ? { highlight: prev.highlight } : {}),
      meta: parsed.meta,
      v2: parsed.v2,
      tags: [],
      sections: [],
      source: prev.source ?? { guide: '原神·角色攻略.docx' }
    }
    data.tags = deriveTags(data)
    data.sections = deriveSections(data)
    const issues = validate(data, index)
    report.issues.push(...issues.map(x => ({ name: parsed.name, ...x })))
    const noteCount = Object.values(data.v2).reduce((n, rows) => n + (rows ?? []).filter(isNoteRow).length, 0)
    // 行数统计**不含备注行**（备注单独计），这样「配队行 79」这类数字在加备注前后不变
    const rows = (k) => (data.v2[k] ?? []).filter(r => !isNoteRow(r)).length
    const cnt = {
      name: parsed.name,
      weapons: rows('weapons'),
      artifacts: rows('artifacts'),
      talents: rows('talents'),
      panels: rows('panels'),
      constellations: rows('constellations'),
      teams: rows('teams'),
      notes: noteCount,
      unparsed: parsed.stray.length
    }
    if (parsed.stray.length) report.stray.push(...parsed.stray.map(s => ({ name: parsed.name, ...s })))
    report.characters.push(cnt)
    report.totals.characters++
    for (const k of ['weapons', 'artifacts', 'talents', 'panels', 'constellations', 'teams', 'notes', 'unparsed']) report.totals[k] += cnt[k]
    if (!dry) {
      if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
      fs.writeFileSync(prevFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
    }
  }
  if (!dry) {
    if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, '_parse-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
    // 展示顺序按文档出现顺序重建（文档顺序 = 图鉴发布时间从远到近）
    const order = report.characters.map(c => c.name)
    fs.writeFileSync(path.join(giDir, '_order.json'), JSON.stringify(order, null, 2) + '\n', 'utf8')
  }
  console.log(`文档：${docFile}`)
  console.log(`角色块：${report.totals.characters}`)
  console.log(`武器行 ${report.totals.weapons} / 圣遗物行 ${report.totals.artifacts} / 天赋行 ${report.totals.talents} / 面板行 ${report.totals.panels} / 命座 ${report.totals.constellations} / 配队行 ${report.totals.teams}`)
  console.log(`备注行（注：）${report.totals.notes} 条`)
  console.log(`未识别行：${report.totals.unparsed}${dry ? '（--dry 未写文件）' : ''}`)
  report.warnings = getWarnings()
  if (report.warnings.length) {
    console.log(`解析告警：${report.warnings.length} 条（无法保留 / 无法归位的括注与标记${dry ? '，--dry 不写文件' : '，已汇总进 data/_parse-report.json 的 warnings'}）`)
    for (const w of report.warnings.slice(0, 8)) console.log(`  ⚠ ${w}`)
  } else {
    console.log('解析告警：0 条（没有无法保留 / 无法归位的括注与标记）')
  }
  if (report.issues.length) {
    console.log(`名称校验问题：${report.issues.length} 条（详见 data/_parse-report.json）`)
    for (const it of report.issues.slice(0, 8)) console.log(`  · ${it.name} ${it.where} ${it.ref} — ${it.reason}`)
  }
  if (report.stray.length) {
    console.log('未识别行明细（应为 0；不为 0 说明文档里有解析器不认识的写法）：')
    for (const s of report.stray.slice(0, 20)) console.log(`  · ${s.name} [${s.section}] ${s.line}`)
    process.exitCode = 1
  }
}

/**
 * 入口守卫：**只有** `node scripts/parse-docx.mjs` 直接运行时才执行 main()（才会写盘）。
 *
 * 为什么必须有：本文件是脚本、不是库，`import('./scripts/parse-docx.mjs')` 之前会**直接跑到底**，
 * 也就是「只想看一眼导出」会把整个 data/gi 按文档重写一遍（2026-09-20 真出过一次事故）。
 * 加上守卫后：被 import 时只定义函数/常量，不解析、不写盘；`mark-docx.mjs` 克隆复用 parseBlock
 * 也依赖这一点（克隆体被 import，argv[1] 是 mark-docx.mjs，守卫自然为假）。
 */
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
})()

if (isDirectRun) main()
