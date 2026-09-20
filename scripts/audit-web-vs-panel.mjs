/**
 * 网页版 ↔ 面板模型 的**逐行渲染一致性**体检
 *
 * 同一份 JSON 分别走两条链路：
 *   - 网页版：scripts/build-html.mjs 的 characterSections（供 guide.html）
 *   - 面板：Atlas-Plugin/model/codexIndex/parse.js 的 parseGuideJson（供 codex.html）
 * 两边必须逐行同内容（分隔符字形 `>` / `＞`、`≥` 与 `/` 两侧空格视为等价，不计差异）。
 *
 * 用法：node scripts/audit-web-vs-panel.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const PLUGIN = process.env.DSH_PLUGIN_DIR ?? 'D:\\文件\\游戏\\原神\\Atlas-Plugin'

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const names = readJson(path.join(giDir, '_order.json'))
const { parseGuideJson } = await import(pathToFileURL(path.join(PLUGIN, 'model/codexIndex/parse.js')).href)
const build = await import(pathToFileURL(path.join(root, 'scripts/build-html.mjs')).href)
const { deriveSections } = await import(pathToFileURL(path.join(root, 'scripts/lib/schema.mjs')).href)

/** 去标签 + 去括注（件数/命座类括注只影响展示细节） */
const clean = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&gt;/g, '>').trim()
/** 分隔符字形与两侧空格归一（`＞`↔`>`、` / `↔`/`、`｜`↔`/`），语义等价不算差异 */
const canon = s => String(s ?? '')
  .replace(/[＞﹥]/g, '>')
  .replace(/[／｜]/g, '/')
  .replace(/\s+/g, ' ')
  .replace(/\s*([>≥=/])\s*/g, '$1')
  .trim()

/**
 * 行签名：条目文本 + **行内备注** + 分隔符。
 * 备注在网页版是嵌在文本里的全角括注、在面板是独立的 `note` 字段（渲染成小字），
 * 这里把两种形态都算进去，才真实反映「内容是否一致」。
 */
/**
 * 条目签名：文本 + 备注 + 等级 + 分隔符。
 * 三处载体差异都要归一：
 *   · 备注（网页版嵌在文本里的全角括注 / 面板独立的 `note` 字段）
 *   · 天赋等级（网页版 `level`、面板 `talentLevel`；面板还会把等级同时塞进 `note`）
 *   · 分隔符字形（`＞`↔`>`、`｜`↔`/`）
 */
const itemSig = (i, withLevel) => {
  const noteLevel = Number(String(i.note ?? '').replace(/^[（(]\s*|\s*[）)]$/g, '').replace(/<[^>]*>/g, '').trim())
  // 天赋等级只在**天赋行**里参与比对（面板把数字塞在 note、网页版在 level）
  let level = null
  if (withLevel) {
    level = Number.isInteger(Number(i.level)) ? Number(i.level)
      : (Number.isInteger(Number(i.talentLevel)) ? Number(i.talentLevel)
        : (Number.isInteger(noteLevel) ? noteLevel : null))
  }
  const noteIsLevel = withLevel && Number.isInteger(noteLevel) && String(i.note ?? '').trim() !== ''
  const noteText = i.note && !noteIsLevel ? `（${String(i.note).replace(/^[（(]|[）)]$/g, '')}）` : ''
  return canon(clean(i.text) + clean(noteText) + (level === null ? '' : `（${level}）`) + '|' + clean(i.sepAfter || ''))
}
// 天赋行靠 `kind === 'talents'` 认（**不能只按 label 认**：行首标签现在是显示词 `推荐`，
// 与武器 / 圣遗物行的标签同形，只按文字判会把它们混在一起）
const isTalentRow = row => row.kind === 'talents' || /天赋/.test(String(row.label || ''))
const rowSig = row => canon((row.items || []).map(it => itemSig(it, isTalentRow(row))).join(' '))
/**
 * 配队行：两端都把「成员为空的说明」当行尾备注看（网页版放在 text、面板放在 note）。
 * 备注的 `注：` 前缀由显示层按 `notePrefix` 决定（整行就是备注时不加），
 * 所以比对前先剥掉前缀，只比内容（前缀的有无另有专门断言）。
 */
/**
 * 配队行：并列成员（`+`）+ 可替换项（旧数据的 `options`，现已并进 `members`，这里只为兼容保留）。
 * 备注的 `注：` 前缀由显示层按 `notePrefix` 决定（整行就是备注时不加），比对前先剥掉前缀。
 */
const teamSig = (t) => {
  // 成员之间用 `§` 分隔（**不能用 `/` 或 `+`**：canon 会把 ` / ` 归一成 `/`，
  // 而成员格内的 `迪奥娜 / 阿罗夏` 就长这样，会被误判成分隔符）
  const members = (t.members || []).map(m => clean(m.name).replace(/\s*\/\s*/g, '/')).join('§')
  const options = (t.options || []).map(m => clean(m.name)).join('§')
  const note = clean(String(t.note || t.text || '').replace(/^注\s*[:：]/, ''))
  // `注：` 前缀**也要比**（用户定稿：只有段末那条纯文字行才加），
  // 以前这里把前缀剥掉再比 → 「网页版漏了注：」这类漂移查不出来。
  const prefixed = note ? (t.notePrefix === true ? '注：' : '〔无前缀〕') : ''
  return canon([t.tag || '', members, options, prefixed + note].join('|'))
}
/**
 * 插件侧把**段末备注行**（`注：…`）也塞进 `section.teams` 里渲染成「只有备注、没有成员」的一行；
 * 网页版（build-html.mjs）现在也画同样的一行（曾经是漏的），所以这里**不再排除**它们 ——
 * 两端必须逐字一致（备注的 `注：` 前缀由 `notePrefix` 决定，比对前统一剥掉）。
 */
const isPanelNoteRow = () => false

let rows = 0
let teams = 0
const bad = []
for (const n of names) {
  const d = readJson(path.join(giDir, `${n}.json`))
  const web = []
  for (const s of build.characterSections(d)) {
    if (s.empty) { web.push(`[${s.title}] 暂无`); continue }
    if (s.kind === 'teams') { for (const t of s.teams) web.push(`[${s.title}] ${teamSig(t)}`); continue }
    for (const r of s.rows) web.push(`[${s.title}/${clean(r.label)}] ${rowSig(r)}`)
  }
  const card = parseGuideJson(d, { fileDir: giDir, fileName: n })
  const panel = []
  for (const s of card.sections) {
    if (s.empty) { panel.push(`[${s.title}] 暂无`); continue }
    if (s.type === 'teams') {
      for (const t of s.teams) { if (!isPanelNoteRow(t)) panel.push(`[${s.title}] ${teamSig(t)}`) }
      continue
    }
    for (const r of s.rows ?? []) panel.push(`[${s.title}/${clean(r.label)}] ${rowSig(r)}`)
  }
  rows += Math.max(web.length, panel.length)
  teams += web.filter(x => x.includes('+')).length
  if (web.join('\n') !== panel.join('\n')) {
    const diff = []
    for (let i = 0; i < Math.max(web.length, panel.length); i++) {
      if (web[i] !== panel[i]) diff.push(`  web  [${i}] ${web[i]}\n  panel[${i}] ${panel[i]}`)
    }
    bad.push(`${n}\n${diff.slice(0, 4).join('\n')}`)
  }
}

console.log(`角色 ${names.length} 个 / 渲染行 ${rows} 行`)

/* ------------------------------------------------------------------ *
 * 合成样例：**自定义档位词**（用户反馈过「编辑器里把推荐改成建议，网页版 / 预览还是推荐」）
 *
 * 真实数据里目前没有 `label` 与 `tier` 并存的行，所以这条规则只能靠合成数据守住：
 * 网页版过去按 `tier` 算标签（`weaponLabelHints`），面板按 `label` 算 → 两端漂移。
 * 现在两边同口径：**label 非空就用它，为空才看 tier**（文档层 `renderWeaponRow` 同理，
 * 且 label 非空时不再写「第N档」，避免 `建议：第一档：…`）。
 * ------------------------------------------------------------------ */
const synthCases = [
  ['自定义档位词（建议）', { label: '建议', tier: null, sep: ' > ', items: [{ name: '西风剑', ref: 'weapon:西风剑' }] }],
  ['自定义词 + 档位并存（建议 / 第一档）', { label: '建议', tier: 1, sep: ' > ', items: [{ name: '西风剑', ref: 'weapon:西风剑' }] }],
  ['档位词（第一档）', { label: null, tier: 1, sep: ' > ', items: [{ name: '西风剑', ref: 'weapon:西风剑' }] }]
]
let synthBad = 0
for (const [名称, weapon] of synthCases) {
  const data = { schema: 2, name: '合成样例', game: 'gi', meta: {}, v2: { weapons: [weapon], artifacts: [], talents: [], panels: [], constellations: [], teams: [] } }
  data.sections = deriveSections(data) // 网页版走 sections[].lines（= 文档层产物），与真实 JSON 一致
  const sig = (rows) => (rows ?? []).map(r => `[武器/${clean(r.label)}] ${rowSig(r)}`)
  const web = sig(build.characterSections(data).find(s => s.title === '武器')?.rows)
  const panel = sig(parseGuideJson(data, { fileDir: giDir, fileName: '合成样例' }).sections.find(s => s.title === '武器')?.rows)
  const same = web.join('\n') === panel.join('\n')
  if (same) rows += Math.max(web.length, panel.length)
  else synthBad++
  console.log(`合成样例（${名称}）：网页版 ${web.join(' ') || '(空)'} ｜ 面板 ${panel.join(' ') || '(空)'} —— ${same ? '一致' : '不一致 ← 漂移'}`)
  if (!same) bad.push(`合成样例（${名称}）\n  web  ${web.join('\n  web  ')}\n  panel${panel.join('\n  panel')}`)
}

console.log(`网页版与面板渲染不一致的角色：${bad.length - synthBad}（应为 0）；合成样例不一致：${synthBad}（应为 0）`)
for (const b of bad.slice(0, 8)) console.log('· ' + b)
process.exitCode = bad.length ? 1 : 0
