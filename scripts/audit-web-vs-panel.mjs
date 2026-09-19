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
const itemSig = i => canon(clean(i.text) + clean(i.note ? `（${String(i.note).replace(/^[（(]|[）)]$/g, '')}）` : '') + '|' + clean(i.sepAfter || ''))
const rowSig = row => canon((row.items || []).map(itemSig).join(' '))
/** 配队行：两端都把「成员为空的说明」当行尾备注看（网页版放在 text、面板放在 note） */
const teamSig = t => canon([t.tag || '', (t.members || []).map(m => clean(m.name)).join('+'), clean(t.note || t.text || '')].join('|'))
/**
 * 插件侧把**段末备注行**（`注：…`）也塞进 `section.teams` 里渲染（v2TeamRows 之后的
 * note-row 是插件既有的展示细节）；网页版把它们归到行尾备注。为聚焦「角色 / 套装 / 档位」
 * 的一致性，这里把插件侧这类纯备注行排除（它们的文案本身两端相同）。
 */
const isPanelNoteRow = t => !t.tag && !(t.members || []).length && /^注[:：]/.test(String(t.note ?? ''))

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
console.log(`网页版与面板渲染不一致的角色：${bad.length}（应为 0）`)
for (const b of bad.slice(0, 8)) console.log('· ' + b)
process.exitCode = bad.length ? 1 : 0
