/**
 * 套装 / 武器行体检（网页版 guide.html + 面板模型 Atlas-Plugin）
 *
 * 规则：
 *   1. **同一行内不得出现重复条目名**（`饰金之梦 ＞ 饰金之梦`、`翠绿之影 ＞ 翠绿之影` 都要合并）
 *      —— 只合并相邻同名，不跨组合合并；
 *   2. **2+2 套装组合必须整体保留**：`A + B` 是同一档里的组合，不能被 `＞` / `/` 拆开；
 *      （数据里 `A + A` 这种同一组合内重复按一次显示）
 *   3. 网页版与面板两侧的套装条目序列要一致。
 *
 * 用法：node scripts/audit-dup-items.mjs [--show]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const PLUGIN = process.env.DSH_PLUGIN_DIR ?? 'D:\\文件\\游戏\\原神\\Atlas-Plugin'
const SHOW = process.argv.includes('--show')

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const names = readJson(path.join(giDir, '_order.json'))
const strip = s => String(s ?? '').replace(/<[^>]*>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()

const { parseGuideJson } = await import(pathToFileURL(path.join(PLUGIN, 'model/codexIndex/parse.js')).href)
const build = await import(pathToFileURL(path.join(root, 'scripts/build-html.mjs')).href)

/** 条目名归一（去套装件数括注、去空白） */
const itemKey = s => strip(s).replace(/[（(][^）)]*[）)]/g, '').trim()

/**
 * 一行内的**相邻**重复名（A ＞ A / A / A 这类要合并）。
 *
 * 只看相邻：`2+2+2` 这种一行多组合的写法里，同一套装名会出现在不同组合
 * （`炽烈的炎之魔女 / 流浪大地的乐团 / 角斗士的终幕礼 / 炽烈的炎之魔女`），
 * 那是**组合语义**不是重复，不能跨组合合并。
 */
function duplicateNames (texts) {
  const keys = texts.map(itemKey).filter(Boolean)
  const dup = []
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] === keys[i - 1]) dup.push(`${keys[i]}（相邻重复，位置 ${i}）`)
  }
  return dup
}

let dupWeb = 0
let dupPanel = 0
let comboWeb = 0
let comboPanel = 0
let mismatch = 0
const samples = { web: [], panel: [], mismatch: [] }

for (const name of names) {
  const data = readJson(path.join(giDir, `${name}.json`))

  // ---- 网页版模型 ----
  for (const section of build.characterSections(data)) {
    if (section.kind !== 'rows') continue
    for (const row of section.rows) {
      const texts = (row.items ?? []).map(it => it.text)
      const dup = duplicateNames(texts)
      if (dup.length) {
        dupWeb++
        if (SHOW || samples.web.length < 4) samples.web.push(`${name} [${section.title}/${strip(row.label)}] ${dup.join(',')} :: ${texts.join(' ｜ ')}`)
      }
      for (const t of texts) if (/\S\+\S/.test(String(t))) comboWeb++
    }
  }

  // ---- 面板模型 ----
  const card = parseGuideJson(data, { fileDir: giDir, fileName: name })
  const panelArtifacts = []
  for (const section of card.sections) {
    if (section.type !== 'rows' && section.type !== 'stats') continue
    for (const row of section.rows ?? []) {
      const texts = (row.items ?? []).map(it => it.text)
      const dup = duplicateNames(texts)
      if (dup.length) {
        dupPanel++
        if (SHOW || samples.panel.length < 4) samples.panel.push(`${name} [${section.title}/${strip(row.label)}] ${dup.join(',')} :: ${texts.join(' ｜ ')}`)
      }
      for (const t of texts) if (/\S\+\S/.test(String(t))) comboPanel++
      if (section.title === '圣遗物' && /首选|推荐|可选|过渡/.test(strip(row.label))) {
        panelArtifacts.push(texts.map(itemKey).join(' / '))
      }
    }
  }

  // ---- 两侧套装条目序列一致性 ----
  const webArtifacts = []
  for (const section of build.characterSections(data)) {
    if (section.title !== '圣遗物') continue
    for (const row of section.rows) {
      if (/首选|推荐|可选|过渡/.test(strip(row.label))) {
        webArtifacts.push((row.items ?? []).map(it => itemKey(it.text)).join(' / '))
      }
    }
  }
  if (webArtifacts.join(' ; ') !== panelArtifacts.join(' ; ')) {
    mismatch++
    if (SHOW || samples.mismatch.length < 4) samples.mismatch.push(`${name}\n      web  : ${webArtifacts.join(' ; ')}\n      panel: ${panelArtifacts.join(' ; ')}`)
  }
}

console.log(`角色 ${names.length} 个`)
console.log(`同一行内重复名：网页版 ${dupWeb} 处 / 面板 ${dupPanel} 处（应为 0）`)
console.log(`含 2+2 组合（同一档 `+` 连接）的条目：网页版 ${comboWeb} 条 / 面板 ${comboPanel} 条`)
console.log(`网页版 vs 面板 套装条目序列不一致：${mismatch} 个角色（应为 0）`)
for (const [k, label] of [['web', '重复名样例（网页版）'], ['panel', '重复名样例（面板）'], ['mismatch', '序列不一致样例']]) {
  if (samples[k].length) {
    console.log(`\n${label}：`)
    for (const s of samples[k]) console.log('  · ' + s)
  }
}
process.exitCode = (dupWeb || dupPanel || mismatch) ? 1 : 0