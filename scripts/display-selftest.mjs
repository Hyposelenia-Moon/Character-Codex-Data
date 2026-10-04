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
  displayLines, normalizeGuideSections, DISPLAY_SECTIONS, EMPTY_TEXT, WEAPON_REFINE_HINT, FREE_MODULE_HINTS,
  displayText, displayLabel, constellationNumber, crownItems, isZeroValue, isBlankDisplay, ARTIFACT_KIND_LABEL
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

/* ---------- 自定义档位词（label 优先于 tier）：三处口径必须一致 ---------- */
console.log('\n================ 自定义档位词（建议） ================')
{
  const { characterSections } = await import(pathToFileURL(path.join(root, 'scripts/build-html.mjs')).href)
  const { deriveSections, renderWeaponRow } = await import(pathToFileURL(path.join(root, 'scripts/lib/schema.mjs')).href)
  const mk = (row) => {
    const data = { schema: 2, name: '自检', game: 'gi', meta: {}, v2: { weapons: [row], artifacts: [], talents: [], panels: [], constellations: [], teams: [] } }
    // 网页版走 data.sections[].lines（= 文档层产物），所以这里必须像真实 JSON 一样带上
    data.sections = deriveSections(data)
    data.tags = []
    return { data, sections: data.sections }
  }
  const checks = []
  const push = (what, got, want) => checks.push({ what, got, want, ok: got === want })

  push('displayLabel(建议, tier=1) —— 自定义词顶掉档位词', displayLabel('建议', 1), '建议')
  push('displayLabel(空, tier=1) —— 没有自定义词才看档位', displayLabel('', 1), '推荐')

  const custom = mk({ label: '建议', tier: null, sep: ' > ', items: [{ name: '西风剑', ref: 'weapon:西风剑' }] })
  const docLine = (custom.sections.find(s => /武器/.test(s.title))?.lines ?? [])[0] ?? ''
  const webLabel = characterSections(custom.data).find(s => s.title === '武器')?.rows?.[0]?.label ?? ''
  console.log(`文档行   ${docLine}`)
  console.log(`网页版   ${webLabel}`)
  push('文档层写自定义词', docLine, '建议：西风剑')
  push('网页版显示自定义词', webLabel, '建议')

  // 档位行（没有自定义词）不受影响
  push('档位行文档层', renderWeaponRow({ tier: 2, sep: ' > ', items: [{ name: '西风剑' }] })[0], '第二档：西风剑')
  // 两个都有的历史数据：**label 优先**，且文档层不再拼出 `建议：第一档：…`
  push('label+tier 并存时文档层只写 label', renderWeaponRow({ label: '建议', tier: 1, sep: ' > ', items: [{ name: '西风剑' }] })[0], '建议：西风剑')
  const both = mk({ label: '建议', tier: 1, sep: ' > ', items: [{ name: '西风剑', ref: 'weapon:西风剑' }] })
  push('label+tier 并存时网页版显示 label', characterSections(both.data).find(s => s.title === '武器')?.rows?.[0]?.label ?? '', '建议')

  const bad = checks.filter(c => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
  console.log(`自定义档位词断言：${checks.length - bad.length}/${checks.length}${bad.length ? ' ← 有失败' : ' 全通过'}`)
  if (bad.length) process.exitCode = 1
}

/* ---------- 词条写法（主词条去百分比 / 副词条大小前缀 / 暴击率=暴击伤害） ---------- */
console.log('\n================ 词条写法 ================')
{
  const { characterSections } = await import(pathToFileURL(path.join(root, 'scripts/build-html.mjs')).href)
  const { deriveSections, renderArtifactRow } = await import(pathToFileURL(path.join(root, 'scripts/lib/schema.mjs')).href)
  const checks = []
  const push = (what, got, want) => checks.push({ what, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })
  const mk = (v2) => {
    const data = { schema: 2, name: '自检', game: 'gi', meta: {}, v2: Object.assign({ weapons: [], artifacts: [], talents: [], panels: [], constellations: [], teams: [] }, v2) }
    data.sections = deriveSections(data)
    data.tags = []
    return data
  }
  /** 某一行的渲染条目拼成一个字符串（文本 + 分隔符） */
  const rowText = (data, kw, idx = 0) => {
    const rows = characterSections(data).find(s => s.title === kw)?.rows ?? []
    return (rows[idx]?.items ?? []).map(it => it.text + (it.sepAfter || '')).join('')
  }

  // ① 主词条：不写「百分比」（默认就是百分比）；副词条：百分比 大X / 固定值 小X
  const flat = mk({ artifacts: [{ kind: 'sub', stats: ['小攻击', '小生命', '小防御', '大攻击', '暴击率'], sep: ' / ' }] })
  push('副词条：小X / 大X 原样显示（不被折成 攻击力 等）', rowText(flat, '圣遗物'), '小攻击＞小生命＞小防御＞大攻击＞暴击率')
  push('副词条：文档层仍是原词', (flat.sections.find(s => /圣遗物/.test(s.title))?.lines ?? [])[0], '副词条：小攻击 / 小生命 / 小防御 / 大攻击 / 暴击率')

  // ② 副词条同级对：`/` → `=`，其余 `>` → `＞`（逐档分隔符）
  const crit = mk({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害', '大攻击'], sep: ' / > ' }] })
  push('副词条：暴击率 = 暴击伤害 ＞ 大攻击（逐档分隔符）', rowText(crit, '圣遗物'), '暴击率=暴击伤害＞大攻击')
  push('副词条：文档层保留 `/` 与 `>` 原写法', (crit.sections.find(s => /圣遗物/.test(s.title))?.lines ?? [])[0], '副词条：暴击率 / 暴击伤害 > 大攻击')

  // ②b **只有暴击对是同级**（用户定稿：「只有暴击和爆伤是等价的，其他都是大于」）：
  //     非暴击对之间的 `/` 必须渲染成 `＞`；**暴击对无论写 `/` 还是 `>` 都渲染 `=`**
  const notCrit = mk({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害', '元素充能效率', '元素精通'], sep: ' / ' }] })
  push('副词条：全 `/` 行 —— 只有暴击对是 `=`，其余是 `＞`', rowText(notCrit, '圣遗物'), '暴击率=暴击伤害＞元素充能效率＞元素精通')
  const noCrit = mk({ artifacts: [{ kind: 'sub', stats: ['元素充能效率', '元素精通', '小攻击'], sep: ' / ' }] })
  push('副词条：没有暴击对时整行都是 `＞`', rowText(noCrit, '圣遗物'), '元素充能效率＞元素精通＞小攻击')
  push('副词条：只剩一侧是暴击（暴击率 ＞ 小攻击）', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['暴击率', '小攻击'], sep: ' / ' }] }), '圣遗物'), '暴击率＞小攻击')
  push('副词条：`暴击` 与 `暴伤` 也认（展开后是暴击对）', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['暴击', '暴伤', '大攻击'], sep: ' / ' }] }), '圣遗物'), '暴击率=暴击伤害＞大攻击')
  // 编辑器里改过词条的行：`sep` 会停留在 `' > '`，暴击对也必须渲染成 `=`（用户报的「这种情况双爆依旧是等价的」）
  push('副词条：暴击对写 `>` 也渲染 `=`', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['元素精通', '暴击率', '暴击伤害'], sep: ' > ' }] }), '圣遗物'), '元素精通＞暴击率=暴击伤害')
  push('副词条：暴击对写 `/` 渲染 `=`（顺序反过来也算）', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['暴击伤害', '暴击率'], sep: ' / ' }] }), '圣遗物'), '暴击伤害=暴击率')
  push('副词条：非暴击对写 `/` 仍渲染 `＞`', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['大攻击', '元素精通'], sep: ' / ' }] }), '圣遗物'), '大攻击＞元素精通')
  push('副词条：`≥` 原样保留', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['元素精通', '元素充能效率'], sep: ' ≥ ' }] }), '圣遗物'), '元素精通≥元素充能效率')

  // ②c **两两关系可改**（用户定稿 2026-09-21）：非双爆写 `=` / `≥` 一律原样渲染；
  //     **双爆固定 `=`，编辑器与攻略图都不可被覆盖**（源数据写 `≥` / `>` / `/` 都算 `=`）
  push('副词条：非双爆写 `=` 原样渲染（编辑器可改关系）', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['大攻击', '元素精通'], sep: ' = ' }] }), '圣遗物'), '大攻击=元素精通')
  push('副词条：非双爆写 `≥` 原样渲染', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['大攻击', '元素精通'], sep: ' ≥ ' }] }), '圣遗物'), '大攻击≥元素精通')
  push('副词条：混写 `/ = ≥` 逐档保留（双爆锁 `=`）', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害', '大攻击', '元素精通'], sep: ' / = ≥ ' }] }), '圣遗物'), '暴击率=暴击伤害=大攻击≥元素精通')
  push('副词条：双爆写 `≥` 也强制 `=`（不可被覆盖）', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害'], sep: ' ≥ ' }] }), '圣遗物'), '暴击率=暴击伤害')
  push('副词条：双爆写 `=` 仍是 `=`', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害'], sep: ' = ' }] }), '圣遗物'), '暴击率=暴击伤害')

  // ③ 圣遗物行：不显示件数；**同级（源文档 `/`）→ 画字面 `/`**（用户定稿：`教官/勇者`）
  const pieceRow = { kind: 'preferred', label: '首选', sep: ' / ', sets: [{ name: '翠绿之影', ref: 'artifact:翠绿之影' }, { name: '角斗士的终幕礼', ref: 'artifact:角斗士的终幕礼', pieces: '2件套' }] }
  push('圣遗物：件数不显示 + 同级画 /', rowText(mk({ artifacts: [pieceRow] }), '圣遗物'), '翠绿之影/角斗士的终幕礼')
  push('圣遗物：2+2 简写原样渲染 + 同级画 /', rowText(mk({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' / ', sets: [{ name: '翠绿之影' }, { name: '2攻击' }] }] }), '圣遗物'), '翠绿之影/2攻击')
  push('圣遗物：同级 `/` 例子（教官/烬城勇者绘卷）', rowText(mk({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' / ', sets: [{ name: '教官' }, { name: '烬城勇者绘卷' }] }] }), '圣遗物'), '教官/烬城勇者绘卷')
  push('圣遗物：优先级（`>`）仍画 `＞`', rowText(mk({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' > ', sets: [{ name: 'A套' }, { name: 'B套' }] }] }), '圣遗物'), 'A套＞B套')
  // **武器**：正常武器是优先级链 —— 源文档写 `/` 也渲染成 `＞`（用户定稿）
  push('武器：`/` 也渲染成 `＞`（正常武器是优先级）', rowText(mk({ weapons: [{ label: '满拐', tier: null, sep: ' / ', items: [{ name: 'A枪' }, { name: 'B枪' }] }] }), '武器'), 'A枪＞B枪')
  push('武器：`>` 渲染成 `＞`', rowText(mk({ weapons: [{ label: null, tier: 1, sep: ' > ', items: [{ name: 'A枪' }, { name: 'B枪' }] }] }), '武器'), 'A枪＞B枪')
  // 「同级且毫无区别」写在**条目文字**里（如 `88爆伤/44暴击武器`）：名字原样保留，不当分隔符
  push('武器：条目名里的 `/` 原样保留（同级无区别的写法）', rowText(mk({ weapons: [{ label: null, tier: 1, sep: ' > ', items: [{ name: '霜结的誓金枝' }, { name: '88爆伤/44暴击武器' }] }] }), '武器'), '霜结的誓金枝＞88暴击伤害/44暴击率武器')
  push('圣遗物：`+` 组合仍在一个 chip 内', rowText(mk({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' + ', sets: [{ name: '2生命' }, { name: '2充能' }] }] }), '圣遗物'), '2生命+2充能')
  // 件数简写**不参与同名去重**（真套装名才去重）：`2精通 + 2精通` 要两个都留着
  push('圣遗物：`2精通 + 2精通` 不去重', rowText(mk({ artifacts: [{ kind: 'transition', label: '过渡', sep: ' + ', sets: [{ name: '2精通' }, { name: '2精通' }] }] }), '圣遗物'), '2精通+2精通')
  // ③h **`+` 只在两侧都是件数简写时才算「同一组合」**（2+2 才凑满 4 件）；
  //     全套装名之间的 `+` 其实是**同级选项** → 显示 `/`（用户定稿 2026-09-20）
  const fullPlus = mk({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' + ', sets: [{ name: '如雷的盛怒' }, { name: '昔日宗室之仪' }] }] })
  push('圣遗物：全套装名之间的 `+` 显示 `/`（同级）', rowText(fullPlus, '圣遗物'), '如雷的盛怒/昔日宗室之仪')
  push('圣遗物：文档层仍保留 `+` 原写法（往返不动）', (fullPlus.sections.find(s => /圣遗物/.test(s.title))?.lines ?? [])[0], '首选：如雷的盛怒 + 昔日宗室之仪')
  push('圣遗物：`2X + 2X` 仍是同一 chip，全名是同级', rowText(mk({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' / + ', sets: [{ name: '昔日宗室之仪' }, { name: '2生命' }, { name: '2充能' }, { name: '角斗士的终幕礼' }] }] }), '圣遗物'), '昔日宗室之仪/2生命+2充能/角斗士的终幕礼')
  // ③i 主词条 / 副词条值末尾的括注 → 条目的 `note`（小字），两条链路同款（用户定稿 2026-09-20）
  {
    const rowOf = (v2, kw) => (characterSections(mk(v2)).find(s => s.title === '圣遗物')?.rows ?? []).find(r => new RegExp(kw).test(String(r.label)))
    const withNote = (r) => (r?.items ?? []).map(it => it.text + (it.note ? `⟨${it.note}⟩` : '') + (it.sepAfter || '')).join(' | ')
    push('主词条：值里的括注拆成 note', withNote(rowOf({ artifacts: [{ kind: 'main', stats: { 时之沙: ['防御力'], 空之杯: ['防御力'], 理之冠: ['暴击率', '防御力（特殊）'] } }] }, '主词条')), '时之沙：防御力 | 空之杯：防御力 | 理之冠：暴击率/防御力⟨特殊⟩')
    push('副词条：值里的括注拆成 note', withNote(rowOf({ artifacts: [{ kind: 'sub', stats: ['暴击（西风）', '大防御'], sep: ' > ' }] }, '副词条')), '暴击率⟨西风⟩＞ | 大防御')
    push('副词条：带括注的暴击对仍算同级（先拆括注再判分隔符）', rowText(mk({ artifacts: [{ kind: 'sub', stats: ['暴击率（西风）', '暴击伤害'], sep: ' > ' }] }), '圣遗物'), '暴击率=暴击伤害')
  }
  push('圣遗物：真套装名仍去重（A + A → A）', rowText(mk({ artifacts: [{ kind: 'transition', label: '过渡', sep: ' + ', sets: [{ name: '千岩牢固' }, { name: '千岩牢固' }] }] }), '圣遗物'), '千岩牢固')
  push('圣遗物：文档层保留原写法（旧数据里若仍有件数，往返不丢）', renderArtifactRow(pieceRow)[0], '首选：翠绿之影 / 角斗士的终幕礼（2件套）')

  // ③b **面板模块**（曾经整段渲染不出来：normalizePanelRows 只认 v2 的 `{k,v}`，
  //     而两条链路传的是 `{label, items}` → 每一行都被当空行丢掉 → 永远「暂无」）
  const panelSec = (v2) => {
    const d = mk({ panels: v2 })
    return characterSections(d).find(s => s.title === '面板') ?? { empty: true, rows: [] }
  }
  const panelText = (v2) => {
    const sec = panelSec(v2)
    return sec.empty ? '暂无' : sec.rows.map(r => (r.label ? r.label + '：' : '') + r.items.map(i => i.text + (i.sepAfter || '')).join('')).join(' ｜ ')
  }
  push('面板：v2 键值对 + 说明行都能渲染（说明行的 `/` 只用来拆分，不画出来）', panelText([
    { label: null, k: '暴击率', v: '70%+' },
    { label: null, k: '暴击伤害', v: '220%+' },
    { label: null, k: '攻击力', v: '2200+' },
    { label: '辅助向', text: '暴击率70% / 暴伤220%+' }
  ]), '暴击率：70%+\u3000暴击伤害：220%+\u3000攻击力：2200+ ｜ 辅助向：暴击率70%暴击伤害220%+')
  // 渲染模型形状（另一条链路传进来的就是 `{label, items}`）：直接测归一函数
  {
    const { normalizePanelRows } = await import(pathToFileURL(path.join(root, 'scripts/lib/guide-display.mjs')).href)
    const norm = normalizePanelRows([
      { label: '', items: [{ text: '暴击率：70%+', sepAfter: '' }] },
      { label: '', items: [{ text: '暴击伤害：220%+', sepAfter: '' }] }
    ])
    push('面板：渲染模型形状（label + items）也认', norm.map(r => (r.label ? r.label + '：' : '') + r.items.map(i => i.text + (i.sepAfter || '')).join('')).join(' ｜ '), '暴击率：70%+\u3000暴击伤害：220%+')
  }
  push('面板：只有键没值 → 不渲染（不打「暴击率：」这种空行）', panelText([{ label: null, k: '暴击率', v: '' }]), '暂无')
  push('面板：>3 条不合并（保持分行）', panelText([
    { label: null, k: '暴击率', v: '70%' },
    { label: null, k: '暴击伤害', v: '140%' },
    { label: null, k: '攻击力', v: '2000' },
    { label: null, k: '元素精通', v: '800' }
  ]), '暴击率：70% ｜ 暴击伤害：140% ｜ 攻击力：2000 ｜ 元素精通：800')
  // ③c **空标签的键值行跟随上一个标签**（用户 2026-09-20 指出的现象：梦见月瑞希的三条被拆成两行）
  //     源文档写法就是「主c：攻击力：2200+」后面跟裸行「暴击率：70%+」「暴击伤害：200%+」
  push('面板：裸数值行跟随上一行的标签（梦见月瑞希）', panelText([
    { label: '辅助', text: '精通：1000+' },
    { label: '辅助', text: '暴击率：65%' },
    { label: null, text: '暴击伤害：120%' }
  ]), '辅助：元素精通：1000+\u3000暴击率：65%\u3000暴击伤害：120%')
  push('面板：裸数值行跟随上一行的标签（温迪：主c 三条一行 + 辅助一行）', panelText([
    { label: '主c', text: '攻击力：2200+' },
    { label: null, text: '暴击率：70%' },
    { label: null, text: '暴击伤害：200%' },
    { label: '辅助', text: '元素充能效率：240%' }
  ]), '主c：攻击力：2200+\u3000暴击率：70%\u3000暴击伤害：200% ｜ 辅助：元素充能效率：240%')
  {
    const { normalizePanelRows } = await import(pathToFileURL(path.join(root, 'scripts/lib/guide-display.mjs')).href)
    const norm = normalizePanelRows([
      { label: '主c', items: [{ text: '攻击力：2200+', sepAfter: '' }] },
      { label: '', items: [{ text: '暴击率：70%+', sepAfter: '' }] },
      { label: '', items: [{ text: '暴击伤害：200%+', sepAfter: '' }] }
    ])
    push('面板：渲染模型形状同样跟随标签（合并成一行）', norm.map(r => (r.label ? r.label + '：' : '') + r.items.map(i => i.text + (i.sepAfter || '')).join('')).join(' ｜ '), '主c：攻击力：2200+\u3000暴击率：70%+\u3000暴击伤害：200%+')
    // >3 条分行时，键值行**照旧不带标签**（只借标签分组，不改「键值对行首留空」的约定）
    const norm2 = normalizePanelRows([
      { label: '主c', items: [{ text: '攻击力：2200+', sepAfter: '' }] },
      { label: '', items: [{ text: '暴击率：70%+', sepAfter: '' }] },
      { label: '', items: [{ text: '暴击伤害：200%+', sepAfter: '' }] },
      { label: '', items: [{ text: '元素精通：100+', sepAfter: '' }] }
    ])
    push('面板：>3 条分行时键值行仍不带标签', norm2.map(r => r.label || '(空)').join(','), '主c,(空),(空),(空)')
  }
  // ③e 配队成员的**括注**：网页版必须与面板同口径 —— 拆成 `note`，成本备注（`二命`）提到**行尾**
  //     （曾经网页版把括注当名字的一部分 → `希诺宁（二命）` 行内括注 vs 面板行尾备注，audit 报漂移）
  {
    const d = {
      schema: 2,
      name: '自检',
      game: 'gi',
      meta: {},
      v2: { teams: [] },
      sections: [{ title: '6. 配队推荐', lines: ['二命进月结晶：兹白 + 哥伦比娅 + 莉奈娅 + 希诺宁（二命）'] }]
    }
    const team = characterSections(d).find(s => s.kind === 'teams')?.teams?.[0] ?? {}
    // 用户定稿 2026-09-20：成员括注**留在成员上**（行内全角括弧，与圣遗物 `千岩牢固（四件套）` 同款），
    // 不再提到行尾当 `注：`；`注：` 只留给段落最下方那条纯文字行。
    push('配队：成员括注留在成员上（渲染成行内括弧）', (team.members ?? []).map(m => m.name + (m.note ? `（${m.note}）` : '')).join(' + '), '兹白 + 哥伦比娅 + 莉奈娅 + 希诺宁（二命）')
    push('配队：成员括注不再提到行尾（这一行没有「注：」）', team.notePrefix === true ? `注：${team.note}` : String(team.note ?? ''), '')
  }
  // ③f 段末那条**纯文字行**才用 `注：`；带档位词、整行就是内容的（`可选：自由选择`）不加
  {
    const d = {
      schema: 2,
      name: '自检',
      game: 'gi',
      meta: {},
      v2: { teams: [] },
      sections: [{ title: '6. 配队推荐', lines: ['首选：丝柯克 + 芙宁娜', '可选：自由选择', '注：建议二命及以上；高金配置'] }]
    }
    const teams = characterSections(d).find(s => s.kind === 'teams')?.teams ?? []
    const bottom = teams.find(t => /建议二命及以上/.test(String(t.note ?? ''))) ?? {}
    push('配队：段末纯文字行加「注：」', bottom.notePrefix === true ? `注：${bottom.note}` : String(bottom.note ?? ''), '注：建议二命及以上；高金配置')
    const freeChoice = teams.find(t => /自由选择/.test(String(t.note ?? ''))) ?? {}
    push('配队：`可选：自由选择`（整行就是内容）不加「注：」', freeChoice.notePrefix === true ? `注：${freeChoice.note}` : String(freeChoice.note ?? ''), '自由选择')
  }

  // ④ 天赋行**没有行首标签**（用户定稿 2026-09-21：去掉「推荐」chip；文档里仍写 `天赋：…`）
  const tal = mk({ talents: [{ kind: 'priority', raw: 'A1 E10 Q10', order: [{ name: 'A', level: 1 }, { name: 'E', level: 10, crown: true }, { name: 'Q', level: 10, crown: true }] }] })
  const talRow = characterSections(tal).find(s => s.title === '天赋')?.rows?.[0]
  push('天赋行没有行首标签（「推荐」chip 已去掉）', talRow?.label, '')
  push('天赋行仍带 kind=talents（判行不能只看标签）', talRow?.kind, 'talents')
  push('天赋行文档层仍写「天赋：」', (tal.sections.find(s => /天赋/.test(s.title))?.lines ?? [])[0], '天赋：A1 E10 Q10')

  // ⑤ 武器段的固定小字说明（用户定稿 2026-09-26：三星/四星武器默认为精5，条目不再逐个写「（精5）」）
  const wp = mk({ weapons: [{ label: null, tier: 1, sep: ' > ', items: [{ name: '西风猎弓', note: '精5' }] }] })
  push('武器段带「三星/四星默认精5」小字说明',
    characterSections(wp).find(s => s.title === '武器')?.hint, WEAPON_REFINE_HINT)
  push('说明文案与面板共用一份', WEAPON_REFINE_HINT, '（四星/三星武器默认为精5）')
  push('空武器段不挂说明（没有条目就谈不上默认满精）',
    characterSections(mk({})).find(s => s.title === '武器')?.hint ?? '', '')
  push('其它段不挂说明',
    characterSections(mk({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害'], sep: ' > ' }] })).find(s => s.title === '圣遗物')?.hint ?? '', '')
  push('说明不进文档层（文档 / JSON 都不用维护这句话）',
    (wp.sections.find(s => /武器/.test(s.title))?.lines ?? []).filter(l => /默认为精5/.test(l)).length, 0)

  // ⑥ 模块级「无需填写」（角色 JSON 顶层 freeModules）：空模块显示一行自由说明，替代「暂无」
  push('自由说明文案表齐全', Object.keys(FREE_MODULE_HINTS).join(','),
    'weapons,artifacts,talents,panels,constellations,teams')
  const freeSections = normalizeGuideSections([], { free: ['talents', 'panels'] })
  push('空模块 + 无需填写 → 挂自由说明（天赋）', freeSections.find(s => s.title === '天赋')?.hint, '无需加点')
  push('空模块 + 无需填写 → 挂自由说明（面板）', freeSections.find(s => s.title === '面板')?.hint, '无硬性要求')
  push('空模块 + 无需填写 → 不再标 empty（不显示「暂无」）', freeSections.find(s => s.title === '天赋')?.empty, false)
  push('没标记的空模块照旧「暂无」', freeSections.find(s => s.title === '命座')?.empty, true)
  push('没标记的空模块不挂说明', freeSections.find(s => s.title === '命座')?.hint ?? '', '')
  const withContent = normalizeGuideSections(
    [{ title: '武器', type: 'rows', rows: [{ label: '', items: [{ text: '西风剑' }] }] }], { free: ['weapons'] })
  const wsec = withContent.find(s => s.title === '武器')
  push('有内容的模块不受标记影响（内容优先，仍是自己那句精炼说明）',
    [wsec?.empty, wsec?.hint], [false, WEAPON_REFINE_HINT])
  push('不传 free 时行为不变', normalizeGuideSections([]).find(s => s.title === '天赋')?.empty, true)

  const bad = checks.filter(c => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
  console.log(`词条写法断言：${checks.length - bad.length}/${checks.length}${bad.length ? ' ← 有失败' : ' 全通过'}`)
  if (bad.length) process.exitCode = 1
}

/* ---------- 纯备注模块的判空（审核 #13） ---------- */
console.log('\n================ 纯备注模块判空（审核 #13） ================')
{
  const { characterSections, renderDisplaySection } = await import(pathToFileURL(path.join(root, 'scripts/build-html.mjs')).href)
  const checks = []
  const push = (what, got, want) => checks.push({ what, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })
  /** 只有 `sections[].lines` 的角色（网页版 / 面板两条链路共用的数据形状） */
  const mk = sections => ({ schema: 2, name: '自检', game: 'gi', meta: {}, v2: {}, sections })
  const secOf = (data, kw) => characterSections(data).find(s => s.title === kw) ?? {}

  // ① 天赋「三格全 1」（占位写法）+ 一条备注：旧代码只留下备注行，却按「除备注外无内容」判空
  //    → 渲染端只看 `empty`，先画「暂无」，留在 `rows` 里的备注行没人画（网页版与纯文本都只有「暂无」）
  const t111 = secOf(mk([{ title: '3. 天赋加点', lines: ['优先级：A1 E1 Q1', '注：仅使用二命重击玩法'] }]), '天赋')
  push('天赋 111 + 备注：不判空', t111.empty, false)
  push('天赋 111 + 备注：备注行仍在 rows 里',
    (t111.rows ?? []).some(r => r.kind === 'note' && /仅使用二命重击玩法/.test(r.items?.[0]?.text ?? '')), true)
  push('天赋 111 + 备注：HTML 不画「暂无」', renderDisplaySection(t111, 0, '.').includes(EMPTY_TEXT), false)
  push('天赋 111 + 备注：纯文本不出现「暂无」', sectionTexts([t111]).join('\n').includes(EMPTY_TEXT), false)

  // ② 同一风险的其它纯备注模块（武器 / 圣遗物 / 命座各一条 `注：…`；配队与面板本来就把备注算内容）
  const onlyNote = mk([
    { title: '1. 武器推荐', lines: ['注：武器备注'] },
    { title: '2. 圣遗物推荐', lines: ['注：圣遗物备注'] },
    { title: '3. 天赋加点', lines: ['注：天赋备注'] },
    { title: '5. 命座推荐', lines: ['注：命座备注'] }
  ])
  for (const kw of ['武器', '圣遗物', '天赋', '命座']) {
    const sec = secOf(onlyNote, kw)
    push(`只有一条「注：」的${kw}段：不判空（不画「暂无」）`, sec.empty, false)
  }

  // ③ 没有备注行时语义照旧 —— 这两条是防回归锚点：
  //    没有备注行时 `kept` 与「除备注外的内容」永远相等，所以本次修复对它们**取值完全无影响**
  push('天赋 111 无备注：照旧不判空（A/E/Q 三格照旧渲染，与修复前一致）',
    secOf(mk([{ title: '3. 天赋加点', lines: ['优先级：A1 E1 Q1'] }]), '天赋').empty, false)
  push('天赋段完全没有行：照旧判空 →「暂无」',
    normalizeGuideSections([{ title: '3. 天赋加点', type: 'rows', rows: [] }]).find(s => s.title === '天赋')?.empty, true)

  const bad = checks.filter(c => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
  console.log(`纯备注判空断言：${checks.length - bad.length}/${checks.length}${bad.length ? ' ← 有失败' : ' 全通过'}`)
  if (bad.length) process.exitCode = 1
}

/* ---------- guide.md 角色抬头「100级提升」（审核 #12） ---------- */
console.log('\n================ guide.md 抬头「100级提升」（审核 #12） ================')
{
  // build-doc.mjs 顶层会写 guide.md，所以这里只 import 它的导出函数
  //（该脚本已加「只有直接运行才写盘」的守卫，与 build-docx / build-index 同一写法）
  const { renderCharacter } = await import(pathToFileURL(path.join(root, 'scripts/build-doc.mjs')).href)
  const { deriveTags } = await import(pathToFileURL(path.join(root, 'scripts/lib/schema.mjs')).href)
  const checks = []
  const push = (what, got, want) => checks.push({ what, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })
  /** 与 data/gi/*.json 同形状：meta + 可选 highlight + 已落盘的派生 tags */
  const mkDoc = (meta, highlight) => ({ schema: 2, name: '自检', game: 'gi', meta, highlight, tags: deriveTags({ meta }) })
  /** 抬头区（第一个空行之前那几行）里那条「100级提升：…」 */
  const powerLine = data => {
    const lines = renderCharacter(data)
    const end = lines.indexOf('')
    return (end < 0 ? lines : lines.slice(0, end)).find(line => line.startsWith('100级提升：')) ?? ''
  }

  push('只有 meta（权威字段）→ 回落到派生标签，不再丢这一行', powerLine(mkDoc({ 建议等级: '90级', 定位: '岩系副C', '100级提升': '约 9%' })), '100级提升：约 9%')
  push('highlight 为空串时同样回落', powerLine(mkDoc({ '100级提升': '约 9%' }, '')), '100级提升：约 9%')
  push('highlight 有值 → 原样输出它（`（随命座）` 这类括注不丢）',
    powerLine(mkDoc({ '100级提升': '约 7.2%~7.8%' }, '100级提升：约 7.2%~7.8%（随命座）')), '100级提升：约 7.2%~7.8%（随命座）')
  push('meta 是占位 `___%` → 不输出这一行', powerLine(mkDoc({ '100级提升': '___%' })), '')
  push('meta 是 `0%` → 派生层本就不产出该标签，也不输出', powerLine(mkDoc({ '100级提升': '0%' })), '')

  // 真实数据交叉核对：抬头数 = 8 名只填了 meta + 6 名带 highlight；
  // 且「只有 meta 的那批」抬头必须与 meta 原文**逐字一致**（派生标签只做 stripMarks，不改数值写法）
  const powered = []
  const mismatched = []
  for (const file of fs.readdirSync(giDir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const data = readJson(path.join(giDir, file))
    const line = powerLine(data)
    if (!line) continue
    powered.push(data.name || file)
    if (isBlankDisplay(data.highlight ?? '')) {
      const want = `100级提升：${data.meta?.['100级提升'] ?? ''}`
      if (line !== want) mismatched.push(`${data.name || file}：${line} ≠ ${want}`)
    }
  }
  push('真实数据：带「100级提升：」抬头的角色数', powered.length, 14)
  push('真实数据：只有 meta 的那批，抬头与 meta 原文逐字一致', mismatched, [])

  const bad = checks.filter(c => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
  console.log(`100级提升抬头断言：${checks.length - bad.length}/${checks.length}${bad.length ? ' ← 有失败' : ' 全通过'}`)
  if (bad.length) process.exitCode = 1
}

/* ---------- sections[].items / fields / image 已停用（审核 #16） ---------- */
console.log('\n================ 段落正文历史写法已停用（审核 #16） ================')
{
  const { characterSections } = await import(pathToFileURL(path.join(root, 'scripts/build-html.mjs')).href)
  const { validate } = await import(pathToFileURL(path.join(root, 'scripts/lib/schema.mjs')).href)
  const checks = []
  const push = (what, got, want) => checks.push({ what, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })
  /** 与真实 JSON 同形状：角色名固定「自检」，段标题用能命中模块关键字的真实标题 */
  const mk = section => ({ schema: 2, name: '自检', game: 'gi', meta: {}, v2: {}, sections: [section] })
  /** 跑一段「预期抛错」的样例，返回错误信息（没抛就返回空串，交给断言报错） */
  const errOf = section => {
    try {
      characterSections(mk(section))
      return ''
    } catch (e) {
      return String(e?.message ?? e)
    }
  }
  const ITEMS = [{ name: '天赋名', desc: '说明' }]
  const FIELDS = [{ label: '暴击率', value: '70%' }]

  // ① `lines` 是唯一写法，照旧正常
  push('lines 正常：能建出六个模块的渲染模型', characterSections(mk({ title: '1. 武器推荐', lines: ['第一档：A枪 > B枪'] })).length, 6)
  push('lines 正常：内容照旧进模型（第一档两把枪）',
    (characterSections(mk({ title: '1. 武器推荐', lines: ['第一档：A枪 > B枪'] })).find(s => s.title === '武器')?.rows ?? [])
      .flatMap(r => (r.items ?? []).map(it => it.text + (it.sepAfter || ''))).join(''),
    'A枪＞B枪')

  // ② `items` / `fields` / `image` 非空 → **显式拒绝**（不能再静默忽略）
  const eItems = errOf({ title: '1. 武器推荐', items: ITEMS })
  const eFields = errOf({ title: '4. 毕业面板', fields: FIELDS })
  const eImage = errOf({ title: '1. 武器推荐', image: 'images/pic.png' })
  push('items 非空 → characterSections 抛错', Boolean(eItems), true)
  push('fields 非空 → characterSections 抛错', Boolean(eFields), true)
  push('image 非空 → characterSections 抛错', Boolean(eImage), true)
  // 错误信息必须能定位：角色名 + 段标题 + 是哪个字段 + 「只支持 lines」
  for (const [field, msg, title] of [['items', eItems, '1. 武器推荐'], ['fields', eFields, '4. 毕业面板'], ['image', eImage, '1. 武器推荐']]) {
    push(`${field} 的错误信息含角色名「自检」`, msg.includes('自检'), true)
    push(`${field} 的错误信息含段标题「${title}」`, msg.includes(title), true)
    push(`${field} 的错误信息含字段名 \`${field}\``, msg.includes(field), true)
    push(`${field} 的错误信息说明只支持 lines`, msg.includes('只支持 `lines`'), true)
  }

  // ③ 空数组 / 空串 / false 不算用旧写法（与「非空才算用」同口径，不误报）
  push('items: [] 空数组不报错', errOf({ title: '1. 武器推荐', lines: ['第一档：A枪'], items: [] }), '')
  push('fields: [] 空数组不报错', errOf({ title: '4. 毕业面板', lines: ['暴击率：70%'], fields: [] }), '')
  push('image: "" 空串不报错', errOf({ title: '1. 武器推荐', lines: ['第一档：A枪'], image: '' }), '')

  // ④ `validate()` 对这三种各报一条 issue（编辑器保存时就能看到 ⚠），where=段标题、ref=字段名
  const one = (section) => {
    const issues = validate(mk(section), {})
    return issues.length === 1 ? { where: issues[0].where, ref: issues[0].ref, reason: issues[0].reason } : { issues }
  }
  const WANT_REASON = '旧写法已停用，只有 lines 会被渲染，内容会丢失'
  push('validate：items 报一条（where/ref/reason）', one({ title: '1. 武器推荐', items: ITEMS }), { where: '1. 武器推荐', ref: 'items', reason: WANT_REASON })
  push('validate：fields 报一条（where/ref/reason）', one({ title: '4. 毕业面板', fields: FIELDS }), { where: '4. 毕业面板', ref: 'fields', reason: WANT_REASON })
  push('validate：image 报一条（where/ref/reason）', one({ title: '1. 武器推荐', image: 'images/pic.png' }), { where: '1. 武器推荐', ref: 'image', reason: WANT_REASON })
  push('validate：lines 正常段落不报 issue', validate(mk({ title: '1. 武器推荐', lines: ['第一档：A枪'] }), {}).length, 0)
  // 三种同时出现 → 三条 issue（不是只报第一条）
  push('validate：三种同段同时出现报三条', validate(mk({ title: '1. 武器推荐', items: ITEMS, fields: FIELDS, image: 'x.png' }), {}).length, 3)

  // ⑤ `validate()` 的图鉴白名单：有 authoritative 时**只用权威清单**，
  //    index.weapons 是「权威 + 本地候选」的合并清单，混进来会自证循环
  const refData = mk({ title: '1. 武器推荐', lines: ['第一档：甲 > 乙'] })
  refData.v2 = { weapons: [{ label: '第一档', tier: 1, sep: ' > ', items: [{ name: '甲', ref: 'weapon:甲' }, { name: '乙', ref: 'weapon:乙' }] }] }
  const merged = { weapons: ['甲'], artifacts: [], characters: [] }
  const withAuth = { weapons: ['甲'], authoritative: { weapons: ['乙'], artifacts: [], characters: [] }, artifacts: [], characters: [] }
  push('白名单：没有 authoritative → 退回旧行为，合并清单里的「甲」不报',
    validate(refData, merged).filter(i => i.ref === 'weapon:甲').length, 0)
  push('白名单：有 authoritative → 只用权威清单，「甲」被报（不在图鉴）',
    validate(refData, withAuth).filter(i => i.ref === 'weapon:甲').length, 1)
  push('白名单：有 authoritative → 权威清单里的「乙」不报',
    validate(refData, withAuth).filter(i => i.ref === 'weapon:乙').length, 0)
  push('白名单：有 authoritative → 只有 1 条（不多报）', validate(refData, withAuth).length, 1)
  push('白名单：authoritative 三项都空 → 按「没有图鉴」处理，不报',
    validate(refData, { weapons: ['甲', '乙'], authoritative: { weapons: [], artifacts: [], characters: [] }, artifacts: [], characters: [] }).length, 0)

  // ⑥ 真实数据交叉核对：131 个角色 JSON / 763 段（全部命中六模块），历史写法非空 0 处
  //    （所以上面的拒绝不会误伤现状，也不会让 guide.html 变化）
  //    口径与 build-html 的 listCharacters 一致：只数 data/<gameId>/ 下、非 `_` 开头的 .json
  //    （根目录的 data/_index.json 等元数据文件不算角色）
  let jsonCount = 0
  let sectionCount = 0
  const legacyHits = []
  for (const game of fs.readdirSync(path.join(root, 'data'), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => e.name)) {
    const dir = path.join(root, 'data', game)
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue
      jsonCount++
      const data = readJson(path.join(dir, file))
      for (const section of data.sections ?? []) {
        sectionCount++
        for (const field of ['items', 'fields', 'image']) {
          const v = section?.[field]
          if (Array.isArray(v) ? v.length > 0 : Boolean(v)) legacyHits.push(`${data.name || file} :: ${section?.title} :: ${field}`)
        }
      }
    }
  }
  push('真实数据：角色 JSON 数', jsonCount, 131)
  push('真实数据：sections 段数', sectionCount, 763)
  push('真实数据：items/fields/image 非空命中', legacyHits, [])

  const bad = checks.filter(c => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
  console.log(`历史写法已停用断言：${checks.length - bad.length}/${checks.length}${bad.length ? ' ← 有失败' : ' 全通过'}`)
  if (bad.length) process.exitCode = 1
}

/* ---------- 武器等价候选：`\` 与 `=` 等价（用户定稿 2026-10-04） ---------- */
console.log('\n================ 武器等价候选：反斜杠 ≡ 等号（用户定稿 2026-10-04） ================')
{
  const { characterSections } = await import(pathToFileURL(path.join(root, 'scripts/build-html.mjs')).href)
  const { validate } = await import(pathToFileURL(path.join(root, 'scripts/lib/schema.mjs')).href)
  const checks = []
  const push = (what, got, want) => checks.push({ what, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })

  // ① 渲染：一个条目里写的多把武器 = 等价候选，显示成 `A=B=C`，**条目数不变**（否则会撞同级 4 把上限）
  const mara = readJson(path.join(root, 'data', 'gi', '玛拉妮.json'))
  const maraRow0 = characterSections(mara).find(s => s.title.includes('武器')).rows[0]
  push('渲染：玛拉妮第一档仍是 3 条（`\\` 不拆成多条）', maraRow0.items.length, 3)
  push('渲染：`遗祀玉珑\\千夜浮梦` 显示为 `遗祀玉珑=千夜浮梦`', maraRow0.items[1].text, '遗祀玉珑=千夜浮梦')
  push('渲染：该行没有条目文本还留着反斜杠', maraRow0.items.some(it => it.text.includes('\\')), false)

  // ② 全库交叉核对：7 处反斜杠条目渲染后都不再出现反斜杠，且行内条数都没被撑大
  const giDir = path.join(root, 'data', 'gi')
  const index = readJson(path.join(root, 'data', '_index.json'))
  let slashItems = 0
  const leftover = []
  const compositeIssues = []
  for (const file of fs.readdirSync(giDir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const data = readJson(path.join(giDir, file))
    for (const row of (data.v2?.weapons ?? [])) {
      for (const it of (row.items ?? [])) if (String(it.name ?? '').includes('\\')) slashItems++
    }
    for (const section of characterSections(data)) {
      if (!section.title.includes('武器')) continue
      for (const row of section.rows) {
        for (const it of (row.items ?? [])) if (it.text.includes('\\')) leftover.push(`${data.name} :: ${it.text}`)
      }
    }
    for (const i of validate(data, index)) if (String(i.ref ?? '').includes('\\')) compositeIssues.push(`${data.name} :: ${i.ref}`)
  }
  push('真实数据：含反斜杠的武器条目数', slashItems, 7)
  push('真实数据：渲染后仍含反斜杠的条目', leftover, [])
  push('真实数据：复合名不再被整串误报（issue 的 ref 里不再出现反斜杠）', compositeIssues, [])

  // ③ 校验：按 `\` 拆开逐个部件核对，只报真正缺失的那一把
  const idx = { authoritative: { weapons: ['A枪', 'B枪'], artifacts: [], characters: [] } }
  const vd = ref => validate({ v2: { weapons: [{ items: [{ ref }] }] } }, idx)
  push('校验：两个部件都在图鉴 → 不报', vd('weapon:A枪\\B枪'), [])
  push('校验：只报缺失的那个部件（ref 精确到部件名）', vd('weapon:A枪\\X枪'), [{ where: '武器推荐', ref: 'weapon:X枪', reason: '武器名不在图鉴' }])
  push('校验：泛称部件照旧被报（例：精通武器）', vd('weapon:A枪\\精通武器'), [{ where: '武器推荐', ref: 'weapon:精通武器', reason: '武器名不在图鉴' }])

  const bad = checks.filter(c => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
  console.log(`等价候选断言：${checks.length - bad.length}/${checks.length}${bad.length ? ' ← 有失败' : ' 全通过'}`)
  if (bad.length) process.exitCode = 1
}
