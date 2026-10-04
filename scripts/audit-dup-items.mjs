/**
 * 套装 / 武器行体检（网页版 guide.html + 面板模型 Atlas-Plugin）
 *
 * 规则：
 *   1. **同一行内不得出现重复条目名**（`饰金之梦 ＞ 饰金之梦`、`翠绿之影 ＞ 翠绿之影` 都要合并）
 *      —— 只合并相邻同名，不跨组合合并；
 *   2. **2+2 套装组合必须整体保留**：`A + B` 是同一档里的组合，不能被 `＞` / `/` 拆开；
 *      （数据里 `A + A` 这种同一组合内重复按一次显示）
 *   3. 网页版与面板两侧的套装条目序列要一致。
 *   4. **图鉴里没有、只有数据在用的名字**（审核 #8 的门禁）：`data/_index.json` 的合并清单
 *      （`weapons` / `artifacts` / `characters`）里出现、但不在对应 `authoritative` 里的名字，
 *      非空即退出码 1。以前索引把这类名字并进白名单，`validate()` 判「在不在图鉴」用的是同一批数组，
 *      于是错名（实测「祭礼残张」）写进 data 再保存就自我合法化；现在权威清单不再吸收数据里的名字，
 *      这道门禁负责把「谁又写进去了」钉住。
 *      ⚠ 只统计**已发布（有内容）角色**实际用到的名字：空档模板（`isFilledCharacter` 为假）的内容
 *      不进 docx / guide.html / 面板，它的名字不该让门禁失败（例：米提亚那本空模板的自动填充专武）。
 *
 * 用法：node scripts/audit-dup-items.mjs [--show]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { isFilledCharacter } from './build-docx.mjs'

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
// 2 件套预设白名单与 build-index.mjs 同源，不在这里再抄一份
const { ARTIFACT_PIECE_PRESETS } = await import(pathToFileURL(path.join(root, 'scripts/build-index.mjs')).href)

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

/* --------------------- 体检 4：图鉴里没有、只有数据在用的名字（审核 #8 门禁） --------------------- */

/** 合并清单 − 权威清单（missing 的那部分）；索引缺字段时返回空，绝不因为读不懂就误报 */
function localOnlyOf (index, key) {
  const merged = Array.isArray(index?.[key]) ? index[key] : []
  const authoritative = Array.isArray(index?.authoritative?.[key]) ? index.authoritative[key] : null
  if (!authoritative) return { supported: false, names: [] }
  const auth = new Set(authoritative)
  return { supported: true, names: merged.filter(n => !auth.has(n)) }
}

const indexFile = path.join(root, 'data', '_index.json')
let indexDoc = null
try {
  indexDoc = readJson(indexFile)
} catch { indexDoc = null }

/**
 * 「已发布（有内容）」角色实际用到的 ref 名字（按 weapon / character / artifact 分桶）。
 * 空档模板的内容不进 docx / guide.html / 面板，所以它们的名字不该被当成"数据在用"。
 * @returns {{weapon: Set<string>, character: Set<string>, artifact: Set<string>}}
 */
function refsUsedByFilledCharacters () {
  const out = { weapon: new Set(), character: new Set(), artifact: new Set() }
  const walk = (node) => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'ref' && typeof v === 'string') {
        const m = /^(weapon|character|artifact):(.+)$/.exec(v.trim())
        if (m) out[m[1]].add(m[2].trim())
      } else walk(v)
    }
  }
  for (const f of fs.readdirSync(giDir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    let d
    try { d = readJson(path.join(giDir, f)) } catch { continue }
    if (!isFilledCharacter(d)) continue
    walk(d.v2)
  }
  return out
}

const usedRefs = refsUsedByFilledCharacters()

let localOnlyTotal = 0
let draftOnlyTotal = 0
if (!indexDoc) {
  console.log('\n图鉴里没有、只有数据在用的名字：跳过（读不到 data/_index.json，先跑 node scripts/build-index.mjs）')
} else if (!indexDoc.authoritative) {
  console.log('\n图鉴里没有、只有数据在用的名字：跳过（这份 data/_index.json 还是旧格式，没有 authoritative 字段，重建索引后再跑）')
} else {
  const labels = { weapons: '武器', characters: '角色', artifacts: '圣遗物' }
  const types = { weapons: 'weapon', characters: 'character', artifacts: 'artifact' }
  const buckets = {}
  for (const key of ['weapons', 'characters', 'artifacts']) {
    const r = localOnlyOf(indexDoc, key)
    // 2 件套预设（`2攻击` / `2生命` / `2精通` / `2充能`）是编辑器候选里的**预设写法**，不是实体名，
    // 图鉴后端当然没有、validate 另有 isPieceShorthandName 豁免 —— 单独列出来豁免，不算门禁失败。
    const presets = key === 'artifacts' ? r.names.filter(n => ARTIFACT_PIECE_PRESETS.includes(n)) : []
    const rest = r.names.filter(n => !presets.includes(n))
    // 只出现在空档模板里的名字同样豁免（未发布内容，见文件头规则 4）
    const live = rest.filter(n => usedRefs[types[key]].has(n))
    const draft = rest.filter(n => !usedRefs[types[key]].has(n))
    buckets[key] = { presets, live, draft }
    localOnlyTotal += live.length
    draftOnlyTotal += draft.length
  }
  const presetAll = Object.values(buckets).flatMap(b => b.presets)
  const draftAll = Object.values(buckets).flatMap(b => b.draft)
  console.log(`\n图鉴里没有、只有数据在用的名字：${localOnlyTotal} 个（应为 0）`)
  if (presetAll.length) console.log(`（另有 ${presetAll.length} 个 2 件套预设写法已豁免，不算问题：${presetAll.join(' / ')}）`)
  if (draftOnlyTotal) console.log(`（另有 ${draftOnlyTotal} 个名字只出现在空档模板里（未发布，不进文档 / 网页 / 面板），已豁免：${draftAll.join(' / ')}）`)
  if (localOnlyTotal) {
    console.log('清单（每类最多 20 条）：')
    for (const key of ['weapons', 'characters', 'artifacts']) {
      const list = buckets[key].live
      if (!list.length) continue
      const head = list.slice(0, 20)
      console.log(`  · ${labels[key]}（${list.length}）：${head.join('、')}${list.length > head.length ? ` …（共 ${list.length} 个，只列前 20）` : ''}`)
    }
    console.log('  修法：要么把名字改成图鉴标准名，要么确认它真该在图鉴里（改 data/gi 数据本身，别去动索引白名单）。')
  }
}

process.exitCode = (dupWeb || dupPanel || mismatch || localOnlyTotal) ? 1 : 0