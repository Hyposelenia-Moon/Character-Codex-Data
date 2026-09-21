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

  // ④ 天赋行的行首标签是**显示词 `推荐`**（文档里仍写 `天赋：…`）
  const tal = mk({ talents: [{ kind: 'priority', raw: 'A1 E10 Q10', order: [{ name: 'A', level: 1 }, { name: 'E', level: 10, crown: true }, { name: 'Q', level: 10, crown: true }] }] })
  const talRow = characterSections(tal).find(s => s.title === '天赋')?.rows?.[0]
  push('天赋行标签是「推荐」', talRow?.label, '推荐')
  push('天赋行仍带 kind=talents（判行不能只看标签）', talRow?.kind, 'talents')
  push('天赋行文档层仍写「天赋：」', (tal.sections.find(s => /天赋/.test(s.title))?.lines ?? [])[0], '天赋：A1 E10 Q10')

  const bad = checks.filter(c => !c.ok)
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
  console.log(`词条写法断言：${checks.length - bad.length}/${checks.length}${bad.length ? ' ← 有失败' : ' 全通过'}`)
  if (bad.length) process.exitCode = 1
}
