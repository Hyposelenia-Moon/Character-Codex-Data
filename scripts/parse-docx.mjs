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
import { fileURLToPath } from 'node:url'
import { readDocx, SEPARATOR } from './lib/docx.mjs'
import { makeRef, parseRef, deriveSections, deriveTags, validate, constellationIndex, extractMarks, stripMarks, MARK_RE } from './lib/schema.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const giDir = path.join(dataDir, 'gi')
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

const SECTION_TITLES = ['武器推荐', '圣遗物推荐', '天赋加点', '毕业面板参考', '命座推荐', '配队推荐']
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

/** 拆分「并列/优先级」条目，并记录原文用的分隔符（回写时保持一致） */
function splitItems (text) {
  const s = String(text ?? '').trim()
  if (!s) return { items: [], sep: ' > ' }
  let sep = ' > '
  if (/[>＞]/.test(s)) sep = ' > '
  else if (s.includes('≥')) sep = ' ≥ '
  else if (/[/／=＝，,]/.test(s)) sep = ' / '
  const items = s.split(/\s*(?:[>＞]|≥|[/／=＝，,])\s*/).map(x => x.trim()).filter(Boolean)
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
 * 按分隔符切分，且不破坏 `[[x:..]]` 标记（标记内部的分隔符不参与切分）。
 * @param {string} text
 * @returns {string[]}
 */
function splitStats (text) {
  const { masked, held } = holdMarks(text)
  return masked.split(/\s*(?:[/／>＞、,，]|≥)\s*/).map(x => releaseMarks(x.trim(), held)).filter(Boolean)
}

/**
 * 配队成员 / 武器条目的「名称（备注）」拆分：
 *   纳西妲（二命）→ { name: '纳西妲', note: '二命' }
 *   [[c:纳西妲]]（二命）→ { name: '纳西妲', note: '二命' }（标记名优先）
 * 括注内容原样进 note（由 schema.mjs 的 itemText 渲染成「（二命）」），名称走标准名。
 * 末尾没有括注时 note 为 ''。
 * @param {string} token
 * @returns {{name: string, note: string}}
 */
function splitNameNote (token) {
  const raw = String(token ?? '').trim()
  const marks = extractMarks(raw)
  if (marks.length) {
    const mk = marks[0]
    return { name: mk.name, note: raw.replace(mk.raw, '').trim().replace(/^[（(]|[）)]$/g, '').trim() }
  }
  const m = raw.match(/^(.+?)\s*[（(]([^（()）]+)[）)]\s*$/)
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
      const p = name.match(/^(.+?)(\d件套|\d\+\d件套|\d件套\+\d件套)$/)
      if (p) { name = p[1].trim(); pieces = p[2] }
    }
    if (!pieces) {
      // 「千岩牢固2」「绝缘之旗印2」这类尾部数字 = 两件套件数（不删数字）
      const q = name.match(/^(.+?)(\d)$/)
      if (q) { name = q[1].trim(); pieces = q[2] + '件套' }
    }
  }
  return { name, ...(pieces ? { pieces } : {}), ref: makeRef('artifact', name) }
}

/** 2+2 组合里的「+」 */
const SET_PLUS_RE = /\s*[+＋]\s*/

/** 渲染器按 sep 连接条目，所以 sep 里的分隔符必须带空格（' / '、' + '） */
const canonicalSep = (s) => String(s)
  .replace(/\s*\/\s*/g, ' / ')
  .replace(/\s*\+\s*/g, ' + ')
  .replace(/ {2,}/g, ' ')

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

/**
 * 套装行：把 sep 拆出来的每份交给 parseSetPlus，再按份数补上连接符，保证
 * sep.split(' ').length === sets.length - 1（渲染器按 sep 连接，份内用 ' + '，份间用原 sep）。
 * 字段顺序跟仓库既有写法一致：kind, label, sep, sets。
 * @param {string[]} segments
 * @param {string} baseSep splitItems 拆出来的份间分隔符
 * @param {(t: string) => object} parse
 * @returns {{ sets: object[], sep: string }}
 */
function buildSetRow (segments, baseSep, parse) {
  const base = canonicalSep(baseSep)
  const sets = []
  const seps = []
  segments.forEach((seg, i) => {
    if (i > 0) seps.push(base)
    const plus = parseSetPlus(seg, parse)
    if (plus) plus.forEach((set, j) => { if (j > 0) seps.push(' + '); sets.push(set) })
    else sets.push(parse(seg))
  })
  // 份间分隔符只可能是 splitItems 给出的 ' > ' / ' ≥ ' / ' / '
  const fallback = sets.length === 1 ? ' > ' : (base === ' > ' ? ' / ' : base)
  while (seps.length < sets.length - 1) seps.push(fallback)
  return {
    sets,
    sep: sets.length > 1 ? canonicalSep(seps.slice(0, sets.length - 1).join(' ')) : fallback
  }
}

/**
 * 配队成员：认识的角色名 → ref，其余留文字。
 * 成员带括注（纳西妲（二命））时拆成 {name:'纳西妲', note:'二命', ref:'character:纳西妲'}，
 * note 由 schema.mjs 的 itemText 原样渲染回「（二命）」，所以回推文本逐字不变。
 */
function parseMembers (text, index) {
  const chars = index.characters ?? []
  const parts = String(text).split(/\s*[+＋/／、]\s*/).map(x => x.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const members = parts.map(p => {
    const { name, note } = splitNameNote(p)
    return { name, ...(note ? { note } : {}), ref: makeRef('character', name) }
  })
  // 至少一半能对上角色名才认为是队伍
  const hit = members.filter(x => chars.includes(x.name)).length
  return hit >= Math.max(1, Math.floor(members.length / 2)) ? members : null
}

/** 主词条一行 → {时之沙:[], 空之杯:[], 理之冠:[]} */
function parseMainStats (text, into = { 时之沙: [], 空之杯: [], 理之冠: [] }) {
  const slots = ['时之沙', '空之杯', '理之冠']
  let current = null
  for (const seg of splitStats(text)) {
    const hit = slots.find(s => seg.startsWith(s + '：') || seg.startsWith(s + ':'))
    if (hit) {
      current = hit
      const v = seg.slice(hit.length + 1).trim()
      if (v) into[hit].push(v)
    } else if (current) {
      into[current].push(seg)
    } else {
      into['时之沙'].push(seg)
    }
  }
  return into
}

/**
 * 天赋字母：`Q` / `[[t:Q]]` 都能取到 Q。
 * 先 stripMarks 再取首字母，这样带标记的写法与纯文本写法解析结果完全一致。
 */
function talentItem (token) {
  const m = stripMarks(String(token)).trim().match(/^([AEQaeq])/)
  if (!m) return null
  const name = m[1].toUpperCase()
  return { name, ref: makeRef('talent', name) }
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
  const push = (name, level) => {
    const key = `${name}|${level}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name, ...(level ? { level } : {}), ref: makeRef('talent', name) })
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

/** 单个角色块 → v2 数据 */
function parseBlock (lines, index) {
  const data = { meta: {}, v2: { weapons: [], artifacts: [], talents: [], panels: [], constellations: [], teams: [] }, unparsed: {} }
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
    const un = (why) => { (data.unparsed[section || '其它'] ??= []).push(why ? `${line}` : line) }

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
      if (main) { data.v2.artifacts.push({ kind: 'main', stats: parseMainStats(main[1]) }); continue }
      const single = line.match(/^(时之沙|空之杯|理之冠)[:：]\s*(.*)$/)
      if (single) {
        const last = data.v2.artifacts[data.v2.artifacts.length - 1]
        if (last && last.kind === 'main') last.stats[single[1]] = splitStats(single[2])
        else data.v2.artifacts.push({ kind: 'main', stats: parseMainStats(`${single[1]}：${single[2]}`) })
        continue
      }
      const sub = line.match(/^副词条[:：]\s*(.*)$/)
      if (sub) {
        const { items: stats, sep } = splitItems(sub[1])
        if (stats.length) data.v2.artifacts.push({ kind: 'sub', stats, sep })
        continue
      }
      const setRow = line.match(/^(首选|次选|可选|过渡|套装)[:：]\s*(.*)$/)
      if (setRow) {
        const kind = { 首选: 'preferred', 过渡: 'transition', 次选: 'optional', 可选: 'optional', 套装: 'preferred' }[setRow[1]]
        const { items, sep } = splitItems(setRow[2])
        if (items.length) {
          const row = buildSetRow(items, sep, parseSetItem)
          data.v2.artifacts.push({ kind, label: null, sep: row.sep, sets: row.sets })
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
      const pri = line.match(/^优先级[:：]\s*(.*)$/)
      if (pri) {
        // raw 保留原文的分隔符写法（A＞E＞Q / E ≥ Q / E / Q），但要去掉标记 ——
        // 标记只影响 order 的解析；raw 带 [[t:]] 会让「标记版解析 == 原文档解析」出现无意义差异
        const order = splitStats(pri[1]).map(talentItem).filter(Boolean)
        if (order.length) { data.v2.talents.push({ kind: 'priority', order, raw: stripMarks(pri[1]).trim() }); continue }
      }
      const crown = line.match(/^皇冠[:：]\s*(.*)$/)
      if (crown) {
        const items = parseCrown(crown[1])
        if (items.length) { data.v2.talents.push({ kind: 'crown', items }); continue }
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
      un(); continue
    }

    if (section === '配队推荐') {
      const row = line.match(/^([^：:]{1,12})[:：]\s*(.*)$/)
      if (row) {
        const label = row[1].trim()
        const value = row[2].trim()
        const members = parseMembers(value, index)
        if (members) data.v2.teams.push({ label, members, text: '' })
        else data.v2.teams.push({ label, members: [], text: value })
        continue
      }
      un(); continue
    }
    un()
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

  const report = { doc: docFile, characters: [], totals: { characters: 0, weapons: 0, artifacts: 0, talents: 0, panels: 0, constellations: 0, teams: 0, unparsed: 0 }, issues: [] }
  for (const block of blocks) {
    const lines = block.filter(x => x !== '')
    if (!lines.length) continue
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
      ...(Object.keys(parsed.unparsed).length ? { unparsed: parsed.unparsed } : {}),
      tags: [],
      sections: [],
      source: prev.source ?? { guide: '原神·角色攻略.docx' }
    }
    data.tags = deriveTags(data)
    data.sections = deriveSections(data)
    const issues = validate(data, index)
    report.issues.push(...issues.map(x => ({ name: parsed.name, ...x })))
    const cnt = {
      name: parsed.name,
      weapons: data.v2.weapons.length,
      artifacts: data.v2.artifacts.length,
      talents: data.v2.talents.length,
      panels: data.v2.panels.length,
      constellations: data.v2.constellations.length,
      teams: data.v2.teams.length,
      unparsed: Object.values(parsed.unparsed).reduce((n, l) => n + l.length, 0)
    }
    report.characters.push(cnt)
    report.totals.characters++
    for (const k of ['weapons', 'artifacts', 'talents', 'panels', 'constellations', 'teams', 'unparsed']) report.totals[k] += cnt[k]
    if (!dry) {
      if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
      fs.writeFileSync(prevFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
    }
  }
  if (!dry) {
    fs.writeFileSync(path.join(dataDir, '_parse-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
    // 展示顺序按文档出现顺序重建（文档顺序 = 图鉴发布时间从远到近）
    const order = report.characters.map(c => c.name)
    fs.writeFileSync(path.join(giDir, '_order.json'), JSON.stringify(order, null, 2) + '\n', 'utf8')
  }
  console.log(`文档：${docFile}`)
  console.log(`角色块：${report.totals.characters}`)
  console.log(`武器行 ${report.totals.weapons} / 圣遗物行 ${report.totals.artifacts} / 天赋行 ${report.totals.talents} / 面板行 ${report.totals.panels} / 命座 ${report.totals.constellations} / 配队行 ${report.totals.teams}`)
  console.log(`未识别行：${report.totals.unparsed}${dry ? '（--dry 未写文件）' : ''}`)
  if (report.issues.length) {
    console.log(`名称校验问题：${report.issues.length} 条（详见 data/_parse-report.json）`)
    for (const it of report.issues.slice(0, 8)) console.log(`  · ${it.name} ${it.where} ${it.ref} — ${it.reason}`)
  }
  const worst = report.characters.filter(c => c.unparsed > 0).sort((a, b) => b.unparsed - a.unparsed).slice(0, 8)
  if (worst.length) {
    console.log('未识别行最多的角色：')
    for (const c of worst) console.log(`  · ${c.name}：${c.unparsed} 行`)
  }
}

main()
