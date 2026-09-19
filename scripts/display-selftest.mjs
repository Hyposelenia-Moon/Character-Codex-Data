/**
 * 显示级归一的自检（不需要浏览器 / 图鉴）
 *
 * 1. 用插件侧的渲染模型（Atlas-Plugin/model/codexIndex/parse.js）跑一遍归一，
 *    打印六个模块的渲染文本（武器 / 圣遗物 / 天赋 / 命座 / 面板 / 配队）；
 * 2. 用数据侧的文本行（data.sections[].lines）跑 displayLines，确认两条路径措辞一致；
 * 3. 造几个边界样例（空模块 / 100级提升 0% / 皇冠必需 / 括注）验证规则。
 *
 * 用法：node scripts/display-selftest.mjs [角色名 ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import {
  displayLines, normalizeGuideSections, DISPLAY_SECTIONS, EMPTY_TEXT,
  displayText, displayLabel, constellationNumber, crownItems, isZeroValue, ARTIFACT_KIND_LABEL
} from './lib/guide-display.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const PLUGIN = process.env.DSH_PLUGIN_DIR ?? 'D:\\文件\\游戏\\原神\\Atlas-Plugin'

/** 要核对的角色（命令行可覆盖） */
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['芙宁娜', '梦见月瑞希', '旅行者·火']

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))

/** 面板模型 → 六个模块的纯文本（去掉 HTML 标签，便于肉眼核对与 diff） */
function sectionTexts (sections) {
  const strip = s => String(s ?? '').replace(/<[^>]*>/g, '')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const joinRow = row => [
    row.label ? `${strip(row.label)}：` : '',
    (row.items || []).map(it => strip(it.text) + (it.sepAfter ? ` ${strip(it.sepAfter)} ` : '')).join('').replace(/\s+$/, '')
  ].join('')
  return sections.map(sec => {
    const head = sec.title
    if (sec.empty) return `${head}：${EMPTY_TEXT}`
    if (sec.kind === 'teams') {
      return [`${head}：`, ...sec.teams.map(t => [
        t.tag ? `${t.tag}：` : '',
        (t.members || []).map(m => strip(m.name) + (m.note ? `（${strip(m.note)}）` : '')).join(' + '),
        t.note ? `${t.tag || t.members.length ? ' ' : ''}${strip(t.note)}` : ''
      ].join(''))].join('\n')
    }
    if (sec.kind === 'rows' || sec.kind === 'stats') return [`${head}：`, ...sec.rows.map(joinRow)].join('\n')
    if (sec.kind === 'list') return [`${head}：`, ...sec.items.map(i => strip(i.name))].join('\n')
    if (sec.kind === 'fields') return [`${head}：`, ...sec.fields.map(f => `${strip(f.label)}：${strip(f.value)}`)].join('\n')
    return `${head}：（未识别类型）`
  })
}

/** 数据侧：sections[].lines → 显示级文本行 */
function linesOf (data, keyword) {
  const sec = (data.sections ?? []).find(s => String(s.title).includes(keyword))
  return sec ? displayLines(sec.lines) : [`（无 ${keyword} 段）`]
}

const names = targets

let parseGuideJson = null
try {
  const mod = await import(pathToFileURL(path.join(PLUGIN, 'model/codexIndex/parse.js')).href)
  parseGuideJson = mod.parseGuideJson
} catch (e) {
  console.log(`⚠ 插件 parse.js 不可用（${e.message}），只跑数据侧文本行`)
}

for (const name of targets) {
  const data = readJson(path.join(giDir, `${name}.json`))
  console.log(`\n================ ${name} ================`)
  if (parseGuideJson) {
    const card = parseGuideJson(data, { fileDir: giDir, fileName: name })
    const sections = normalizeGuideSections(card.sections)
    console.log('--- 面板模型（六个模块） ---')
    for (const t of sectionTexts(sections)) console.log(t)
    const missing = DISPLAY_SECTIONS.filter(d => !sections.some(s => s.title === d.title)).map(d => d.title)
    console.log(`模块数 ${sections.length}/6${missing.length ? ` 缺 ${missing.join(',')}` : ''}`)
  }
  console.log('--- 数据侧文本行（网页版路径） ---')
  for (const kw of ['武器', '圣遗物', '天赋', '命座', '面板', '配队']) {
    console.log(`[${kw}] ` + linesOf(data, kw).join(' ｜ '))
  }
}

/* ---------- 边界样例 ---------- */
console.log('\n================ 边界样例 ================')
const cases = [
  ['档位标签', () => [displayLabel('第一档'), displayLabel('第二档'), displayLabel('第三档'), displayLabel('首选'), displayLabel('其他'), displayLabel('过渡'), displayLabel('月感电'), displayLabel('', 1), displayLabel('', 2)]],
  ['简写展开', () => [displayText('双爆'), displayText('暴伤'), displayText('充能'), displayText('精通'), displayText('大生命'), displayText('大攻击'), displayText('小防御'), displayText('暴击率 / 暴击伤害'), displayText('充能 > 精通')]],
  ['命座序号', () => [constellationNumber('一命'), constellationNumber('二命'), constellationNumber('2命'), constellationNumber('命之座6'), constellationNumber('输出向')]],
  ['皇冠必需', () => [crownItems('E（必须）Q（建议）'), crownItems('EQ（必须）'), crownItems('A（可选）')]],
  ['0% 判定', () => [isZeroValue('0%'), isZeroValue('0'), isZeroValue('+0%'), isZeroValue('10%'), isZeroValue('0.5')]],
  ['皇冠并入优先级', () => displayLines(['优先级：Q > E > A', '皇冠：E（必须）Q（建议）', '注：建议二命及以上'])],
  ['皇冠全可选', () => displayLines(['优先级：Q > E > A', '皇冠：E（可选）Q（无需）'])],
  ['空模块', () => sectionTexts(normalizeGuideSections([]))],
  ['0% 面板行', () => sectionTexts(normalizeGuideSections([
    { title: '4. 毕业面板参考', type: 'stats', rows: [{ label: '', items: [{ text: '100级提升：0%' }, { text: '充能：240%+' }] }] }
  ]))],
  ['配队括注', () => sectionTexts(normalizeGuideSections([
    { title: '6. 配队推荐', type: 'teams', teams: [{ tag: '首选', members: [{ name: '丝柯克' }, { name: '希诺宁', note: '二命' }], text: '' }] }
  ]))]
]

/* ---------- JSON v2 → 渲染模型（不依赖插件，用来单独核对本模块） ---------- */
const CN = ['', '一', '二', '三', '四', '五', '六']
function localModel (v2) {
  const out = []
  const rows = []
  for (const r of v2.weapons ?? []) {
    rows.push({
      label: String(r.label ?? '').trim() || (r.tier ? `第${CN[r.tier]}档` : ''),
      items: (r.items ?? []).map((it, i, a) => ({ text: it.name, note: it.note ?? '', ref: it.ref, sepAfter: i < a.length - 1 ? String(r.sep ?? ' > ').trim().split(/\s+/)[0] : '' }))
    })
  }
  out.push({ title: '1. 武器推荐', type: 'rows', rows })
  const arows = []
  for (const r of v2.artifacts ?? []) {
    if (r.kind === 'main') {
      const slots = ['时之沙', '空之杯', '理之冠'].filter(s => (r.stats?.[s] ?? []).length)
      arows.push({
        label: '主词条',
        items: slots.map((s, i) => ({ text: `${s}：${(r.stats[s] ?? []).join(' / ')}`, note: '', ref: '', sepAfter: i < slots.length - 1 ? '/' : '' }))
      })
      continue
    }
    if (r.kind === 'sub') {
      arows.push({
        label: '副词条',
        items: (r.stats ?? []).map((s, i, a) => ({ text: s, note: '', ref: '', sepAfter: i < a.length - 1 ? String(r.sep ?? ' / ').trim().split(/\s+/)[0] : '' }))
      })
      continue
    }
    // 档位名走共享映射（**来源写法**），与 data/gi 的 `v2.artifacts[].label` 词汇一致
    const head = ARTIFACT_KIND_LABEL[r.kind] ?? ''
    arows.push({
      label: String(r.label ?? '').trim() || head,
      items: (r.sets ?? []).map((s, i, a) => ({ text: s.name + (s.pieces ? `（${s.pieces}）` : ''), note: s.note ?? '', ref: s.ref, sepAfter: i < a.length - 1 ? String(r.sep ?? ' / ').trim().split(/\s+/)[0] : '' }))
    })
  }
  out.push({ title: '2. 圣遗物推荐', type: 'rows', rows: arows })
  const trows = []
  for (const r of v2.talents ?? []) {
    if (r.kind === 'priority') trows.push({ label: '优先级', items: (r.order ?? []).map((o, i, a) => ({ text: o.name, note: '', ref: o.ref, sepAfter: i < a.length - 1 ? '＞' : '' })) })
    if (r.kind === 'crown') trows.push({ label: '皇冠', items: (r.items ?? []).map(o => ({ text: o.name, level: o.level, ref: o.ref, sepAfter: '' })) })
  }
  out.push({ title: '3. 天赋加点', type: 'rows', rows: trows })
  out.push({
    title: '4. 毕业面板参考',
    type: 'stats',
    rows: (v2.panels ?? []).map(r => ({
      label: String(r.label ?? ''),
      items: r.k != null
        ? [{ text: `${r.k}：${r.v ?? ''}`, note: '', ref: '', sepAfter: '' }]
        : (String(r.text ?? '').split(' / ').map((t, i, a) => ({ text: t, note: '', ref: '', sepAfter: i < a.length - 1 ? '/' : '' })))
    }))
  })
  out.push({
    title: '5. 命座推荐',
    type: 'rows',
    rows: (v2.constellations ?? []).map(r => ({ label: r.name, items: r.text ? [{ text: r.text, note: '', ref: `constellation:${r.index}`, sepAfter: '' }] : [] }))
  })
  out.push({
    title: '6. 配队推荐',
    type: 'teams',
    teams: (v2.teams ?? []).map(r => ({ tag: String(r.label ?? ''), members: (r.members ?? []).map(m => ({ name: m.name, note: m.note ?? '', ref: m.ref })), text: String(r.text ?? '') }))
  })
  return out
}

console.log('\n================ 本模块独立核对（JSON v2 → 模型 → 归一） ================')
for (const name of targets) {
  const data = readJson(path.join(giDir, `${name}.json`))
  console.log(`--- ${name} ---`)
  for (const t of sectionTexts(normalizeGuideSections(localModel(data.v2 ?? {})))) console.log(t)
}

for (const [name, fn] of cases) {
  const out = fn()
  console.log(`[${name}]`)
  for (const line of out) console.log('  ' + line)
}
