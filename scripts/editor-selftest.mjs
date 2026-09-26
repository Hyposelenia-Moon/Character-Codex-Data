/**
 * 编辑器（浏览器脚本）的**规则自检** —— 不需要浏览器，用最小 DOM 桩把 `resources/editor/app.js`
 * 跑起来，只调用里面的纯函数与 `toJson()`，把用户报过的坑逐条钉住。
 *
 * 覆盖（每条都对应一次真实反馈）：
 *   1. 天赋：**只填数字不激活**？→ `foldCrownRows` 曾经只读 `order`、把三格重置成 1
 *      （只有皇冠行能抬回 10），现在界面形状 `slots` 优先，数字必须原样留住。
 *   2. 「＋ 新增一行」后配队 / 面板 / 命座行**不显示**（也就没法选角色）→ `rowVisible` 认 `_new`。
 *   3. 主词条 / 副词条加进来**没法填、没法选** → `multiValue` 现在渲染输入框 + 候选项。
 *   4. 自定义标签与档位**只能留一个**（文档一行只有一个标签词）。
 *   5. 配队：一格可以放多个名字（` / ` 可替换），落盘仍是**一格一个 name**。
 *   5b. 配队：新增一行后**只加了成员、还没填标签**必须生效 → `rowVisible` / 服务端 `isEmptyRow`
 *      都要认具名成员（用户报：「新增配队行后不激活」）。
 *   5c. 副词条两两优先级关系（`＞` / `≥` / `=`）写进行的 `sep`，双爆固定 `=`。
 *   5d. 武器行同一套关系规则（默认 `＞`），条目排成同一行（不换行）。
 *   5e. 面板（毕业面板参考）改版：**一行两个控件**（属性下拉 + 数值输入），百分比属性自动补 `%`、
 *      数值不留尾部 `+`；**空模块里新增的行直接就是这两个控件**（用户报：「新增行没按新格式激活」）。
 *   6. 界面上的临时标记（`_new`）**不许落盘**。
 *
 * 用法：node scripts/editor-selftest.mjs        # 全绿则 exit 0
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const code = fs.readFileSync(path.join(root, 'resources/editor/app.js'), 'utf8')

/* ---------------------------------------------------------------- DOM 桩 */
const noop = () => {}
const stub = () => new Proxy(function () {}, {
  get: (t, k) => {
    if (k === 'length') return 0
    if (k === 'classList') return { contains: () => false, add: noop, remove: noop, toggle: noop }
    if (k === 'style' || k === 'dataset' || k === 'files') return {}
    if (k === 'value' || k === 'textContent' || k === 'innerHTML') return ''
    if (k === 'children' || k === 'childNodes') return []
    if (k === 'getAttribute') return () => null
    if (k === 'querySelectorAll') return () => []
    if (k === 'querySelector') return () => null
    if (k === 'closest') return () => null
    if (k === 'addEventListener' || k === 'removeEventListener' || k === 'appendChild' || k === 'focus') return noop
    return stub()
  },
  set: () => true,
  apply: () => stub(),
  has: () => true
})

const ctx = {
  console,
  document: stub(),
  navigator: stub(),
  location: { search: '', href: 'http://127.0.0.1/', hash: '' },
  localStorage: stub(),
  sessionStorage: stub(),
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  setTimeout: () => 0,
  clearTimeout: noop,
  setInterval: () => 0,
  clearInterval: noop,
  requestAnimationFrame: noop,
  alert: noop,
  confirm: () => false,
  prompt: () => null,
  addEventListener: noop,
  removeEventListener: noop,
  Blob: function () {},
  URL: { createObjectURL: () => '', revokeObjectURL: noop },
  Event: function () {},
  CustomEvent: function () {},
  JSON, Math, Date, String, Number, Array, Object, Boolean, RegExp, Error, Promise,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN
}
ctx.window = ctx
ctx.globalThis = ctx
vm.createContext(ctx)

try {
  vm.runInContext(code, ctx, { filename: 'resources/editor/app.js' })
} catch (e) {
  console.log(`✗ app.js 未能在 DOM 桩下加载：${e.message}`)
  process.exit(1)
}

/* ---------------------------------------------------------------- 断言 */
const checks = []
const push = (what, got, want) => checks.push({ what, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })
/** app.js 把纯函数挂在 `window.__editor`（浏览器里供调试 / 自动化用） */
const api = ctx.__editor
if (!api) { console.log('✗ app.js 没有导出 window.__editor'); process.exit(1) }
const fn = (name) => {
  const f = api[name] !== undefined ? api[name] : ctx[name]
  if (typeof f !== 'function') throw new Error(`app.js 里找不到 ${name}（改名了？）`)
  return f
}

/** 造一个最小角色 JSON（v2 + 只有我们关心的那一块） */
const mkData = (v2, name = '自检') => ({
  schema: 2,
  name,
  game: 'gi',
  meta: { 建议等级: '90级', 定位: '测试', '100级提升': '约 5%' },
  v2: Object.assign({ weapons: [], artifacts: [], talents: [], panels: [], constellations: [], teams: [] }, v2)
})

/* 1. 天赋：非皇冠的数字必须留住（用户：「只填数字不激活」） */
{
  const data = mkData({ talents: [{ kind: 'priority', raw: 'A5 E7 Q1', order: [{ name: 'A', level: 5 }, { name: 'E', level: 7 }, { name: 'Q', level: 1 }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  const slots = fn('talentSlots')(model.v2.talents)
  push('天赋：A5 E7 Q1 打开后三格等级', slots.map(s => s.level), ['5', '7', '1'])
  push('天赋：非皇冠格不带 crown', slots.map(s => !!s.crown), [false, false, false])
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('天赋：落盘 order 等级', (out.v2.talents.find(r => r.kind === 'priority') || {}).order.map(o => o.level), [5, 7, 1])
  push('天赋：只有 10 才写 crown', (out.v2.talents.find(r => r.kind === 'priority') || {}).order.filter(o => o.crown).length, 0)
  push('天赋：raw 跟着等级走', (out.v2.talents.find(r => r.kind === 'priority') || {}).raw, 'A5 E7 Q1')
}
{
  const data = mkData({ talents: [{ kind: 'priority', raw: 'A1 E10 Q10', order: [{ name: 'A', level: 1 }, { name: 'E', level: 10, crown: true }, { name: 'Q', level: 10, crown: true }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  const slots = fn('talentSlots')(model.v2.talents)
  push('天赋：皇冠仍是 10 + crown', slots.map(s => s.level + (s.crown ? '★' : '')), ['1', '10★', '10★'])
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('天赋：皇冠行按 10 重建', (out.v2.talents.find(r => r.kind === 'crown') || {}).items.map(i => i.name), ['E', 'Q'])
}

/* 1b. 天赋：**在输入框里打字**（走 setTalentSlotLevel）必须立刻生效 —— 不需要点皇冠。
 *     这条以前是坏的：`getPath(model,'…slots.0.level')` 返回的是那个字符串值、不是格子对象，
 *     于是赋值被 `typeof slot === 'object'` 挡掉，打字完全没反应（只有点皇冠生效）。 */
{
  const data = mkData({ talents: [{ kind: 'priority', raw: 'A1 E1 Q1', order: [{ name: 'A', level: 1 }, { name: 'E', level: 1 }, { name: 'Q', level: 1 }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  const setLv = fn('setTalentSlotLevel')
  push('天赋输入：A 写 6 → 返回 true', setLv(model, 'v2.talents.0.slots.0.level', '6'), true)
  push('天赋输入：A 格子 level = "6"', model.v2.talents[0].slots[0].level, '6')
  push('天赋输入：6 不是皇冠', !!model.v2.talents[0].slots[0].crown, false)
  setLv(model, 'v2.talents.0.slots.1.level', '10')
  push('天赋输入：E 写 10 → 自动算皇冠', [model.v2.talents[0].slots[1].level, !!model.v2.talents[0].slots[1].crown], ['10', true])
  setLv(model, 'v2.talents.0.slots.2.level', '')
  push('天赋输入：留空按 1', model.v2.talents[0].slots[2].level, '1')
  setLv(model, 'v2.talents.0.slots.2.level', '99')
  push('天赋输入：越界按 1', model.v2.talents[0].slots[2].level, '1')
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('天赋输入：落盘 order = [6,10,1]', (out.v2.talents.find(r => r.kind === 'priority') || {}).order.map(o => o.level), [6, 10, 1])
  push('天赋输入：raw 跟着改成 A6 E10 Q1', (out.v2.talents.find(r => r.kind === 'priority') || {}).raw, 'A6 E10 Q1')
}

/* 2. 新增的空行必须可见（否则「加了配队行没法选角色」） */
push('新行可见：配队', fn('rowVisible')({ _new: true, label: '', members: [], text: '' }), true)
push('新行可见：面板', fn('rowVisible')({ _new: true, label: '', k: '', v: '' }), true)
push('新行可见：命座', fn('rowVisible')({ _new: true, name: '', text: '' }), true)
push('空行判定：rowVisible 为假（是否渲染由下面的「空占位行」开关决定）', fn('rowVisible')({ label: '', members: [], text: '' }), false)

/* 2a. 空占位行**默认显示**，按钮可折叠（用户定稿 2026-09-20：不自动隐藏） */
{
  const empties = [
    { kind: 'sub', stats: [], sep: ' > ' },
    { kind: 'preferred', label: '首选', sep: ' > ', sets: [] }
  ]
  const filled = { kind: 'sub', stats: ['暴击率'], sep: ' > ' }
  const dead = { __deleted: true }
  const v = fn('visibleRows')
  api.setShowEmptyForTest(true)
  push('空占位行默认显示（不自动隐藏）', v([...empties, filled, dead]).length, 3)
  api.setShowEmptyForTest(false)
  push('折叠后只剩有内容的行（墓碑永远不显示）', v([...empties, filled, dead]).length, 1)
  api.setShowEmptyForTest(true)
}

/* 2b. 界面标记不许落盘 */
{
  const data = mkData({ teams: [{ _new: true, label: '', members: [], text: '' }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('_new 不落盘（teams）', JSON.stringify(out).includes('_new'), false)
  // 删行靠**原位墓碑**表达，所以每行都要占一个下标；「空的新行要不要留」由服务器
  // 按 isEmptyRow 决定（空行不落盘）——客户端只负责把模型原样提交、位置不乱。
  // 空行不落盘这条保证由 `.dsh/verify-editor-delete.mjs` 对着真实保存结果钉住。
  push('空的新行仍占一个下标（位置不乱，服务器据此对齐）', out.v2.teams.length, 1)
  push('空的新行不带墓碑（不是「删除」，只是空）', out.v2.teams.filter(r => r.__deleted).length, 0)
}

/* 3. 主词条 / 副词条：多值输入框可填可选 */
{
  const html = fn('multiValue')('时之沙', 'v2.artifacts.0.stats.时之沙', ['攻击力'], '如 攻击力', '时之沙')
  push('多值输入：渲染成 input', /<input[^>]+class="mv-in"/.test(html), true)
  push('多值输入：带候选项 datalist', /list="dl-stat-sand"/.test(html), true)
  push('多值输入：带「▾」候选按钮', /data-act="pick-item"/.test(html), true)
  push('槽位→候选类别：时之沙', fn('statKindOfPath')('v2.artifacts.0.stats.时之沙'), '时之沙')
  push('槽位→候选类别：副词条', fn('statKindOfPath')('v2.artifacts.0.stats'), '副词条')
  const cand = api.STAT_CANDIDATES
  push('主词条候选不含「百分比」写法', cand['时之沙'].some(x => /百分比/.test(x)), false)
  push('副词条候选同时有 大攻击 / 小攻击', [cand['副词条'].includes('大攻击'), cand['副词条'].includes('小攻击')], [true, true])
}

/* 4. 自定义标签与档位互斥（文档一行只有一个标签词） */
{
  const data = mkData({ weapons: [{ label: '建议', tier: 1, sep: ' > ', items: [{ name: '西风剑', ref: 'weapon:西风剑' }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('武器：自定义标签优先、tier 清空', [out.v2.weapons[0].label, out.v2.weapons[0].tier], ['建议', null])
}
{
  const data = mkData({ artifacts: [{ kind: 'transition', label: '', sep: ' > ', sets: [{ name: '千岩牢固', ref: 'artifact:千岩牢固' }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('圣遗物：label 空时按 kind 补文档词（首选/过渡/可选）', out.v2.artifacts[0].label, '过渡')
}

/* 5. 配队：一格多个候选仍是一格 */
{
  const data = mkData({ teams: [{ label: '首选', members: [{ name: '迪奥娜 / 阿罗夏', note: '二命' }, { name: '芙宁娜' }], text: '' }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('配队：格内 ` / ` 原样保留', out.v2.teams[0].members.map(m => m.name), ['迪奥娜 / 阿罗夏', '芙宁娜'])
  push('配队：ref 取第一个候选', out.v2.teams[0].members.map(m => m.ref), ['character:迪奥娜', 'character:芙宁娜'])
  push('配队：备注跟着这一格', out.v2.teams[0].members[0].note, '二命')
}
push('配队：候选拆分', fn('memberCandidates')('迪奥娜 / 阿罗夏'), ['迪奥娜', '阿罗夏'])

/* 5b. 新增配队行 + 只加了成员（还没填标签）必须「生效」（用户报：「新增配队行后不激活」）
 *     · 客户端：`rowVisible` 认具名成员（否则这一行在表单里被整行隐藏）
 *     · 服务端：`isEmptyRow` 认具名成员（否则保存 / 预览时被判成空行丢掉）
 *     · 显示层：配队段优先按 `v2.teams` 渲染（按文档行猜会把**一个成员**的队伍误判成备注）
 */
{
  const data = mkData({ teams: [] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  fn('handleAction')('add-row', 'v2.teams', undefined, null)
  const row = model.v2.teams[0]
  push('新增配队行：members 是数组', Array.isArray(row.members), true)
  row.members.push({ name: '阿贝多', note: '', ref: 'character:阿贝多' })
  delete row._new   // 模拟「保存后再打开」：界面标记已经没了
  push('客户端 rowVisible：只有成员的配队行可见', ctx.__editor.rowVisible(row), true)
  push('客户端 visibleRows：这一行在列表里', ctx.__editor.visibleRows(model.v2.teams).length, 1)
  const out = fn('toJson')()
  push('落盘：这一行保留', (out.v2.teams || []).length, 1)
  push('落盘：成员名保留', ((out.v2.teams || [])[0] || {}).members.map(m => m.name), ['阿贝多'])
}

{
  const { isEmptyRow, filledModules, normalizeV2 } = await import(pathToFileURL(path.join(root, 'scripts', 'editor.mjs')).href)
  const { foldMainNoteIntoStats } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'schema.mjs')).href)
  push('服务端 isEmptyRow：只有成员的配队行不算空行', isEmptyRow({ label: null, members: [{ name: '阿贝多', ref: 'character:阿贝多' }], text: '' }), false)
  push('服务端 isEmptyRow：只有空名字成员仍算空行', isEmptyRow({ label: null, members: [{ name: '', ref: 'character:' }], text: '' }), true)
  // 目录里的「未填」判据：**有真内容才算填**（空占位行不算）
  push('filledModules：只有标签没有条目 → 武器未填', filledModules({ weapons: [{ label: '首选', items: [] }] }).weapons, false)
  push('filledModules：有具名武器 → 武器已填', filledModules({ weapons: [{ items: [{ name: '西风剑' }] }] }).weapons, true)
  push('filledModules：主词条三槽全空 → 圣遗物未填', filledModules({ artifacts: [{ kind: 'main', stats: { 时之沙: [], 空之杯: [], 理之冠: [] } }] }).artifacts, false)
  push('filledModules：副词条有词条 → 圣遗物已填', filledModules({ artifacts: [{ kind: 'sub', stats: ['暴击率'] }] }).artifacts, true)
  push('filledModules：配队只有空成员 → 配队未填', filledModules({ teams: [{ members: [{ name: '' }], text: '' }] }).teams, false)
  push('filledModules：整行备注算配队有内容', filledModules({ teams: [{ kind: 'note', text: '二命' }] }).teams, true)
  push('filledModules：六个键都在', Object.keys(filledModules({})).join(','), 'weapons,artifacts,talents,panels,constellations,teams')
  // 天赋：**三格全 1 不算填**（用户定稿 2026-09-24：默认 111 只是「界面按 111 正常显示」的占位，
  // 补过默认行的角色在目录里依旧要显示「未填：… 天 …」）
  const pri = (levels, crown) => ({ kind: 'priority', raw: levels.join(''), order: levels.map((lv, i) => ({ name: 'AEQ'[i], level: lv, crown: lv === 10 || crown === true })) })
  push('filledModules：天赋 111 → 未填', filledModules({ talents: [pri([1, 1, 1])] }).talents, false)
  push('filledModules：天赋 E 升到 2 → 已填', filledModules({ talents: [pri([1, 2, 1])] }).talents, true)
  push('filledModules：三格全 1 但有皇冠行 → 已填',
    filledModules({ talents: [{ kind: 'crown', items: [{ name: 'E', level: 10 }] }] }).talents, true)
  push('filledModules：只有空 note 行不算天赋已填',
    filledModules({ talents: [{ kind: 'note', text: '' }] }).talents, false)

  // 主词条括注：**保存时必须折进值里**（用户 2026-09-26 报「保存并发布」失败：
  // 文档层只认值内括注，留 note/noteSlot 字段的话 data → docx → data 对不上）
  const mainRow = { kind: 'main', note: '高命', noteSlot: '时之沙', stats: { 时之沙: ['攻击力', '元素精通'], 空之杯: ['攻击力'], 理之冠: ['暴击伤害', '暴击率'] } }
  const folded = normalizeV2({ artifacts: [mainRow] }).artifacts[0]
  push('主词条括注：折进 noteSlot 指定部位的最后一个值',
    folded.stats['时之沙'].join(' / '), '攻击力 / 元素精通（高命）')
  push('主词条括注：不再落 note / noteSlot 字段',
    [folded.note === undefined, folded.noteSlot === undefined].join(','), 'true,true')
  push('主词条括注：其它部位原样不动',
    [folded.stats['空之杯'].join(''), folded.stats['理之冠'].join('/')].join(' | '), '攻击力 | 暴击伤害/暴击率')
  push('主词条括注：没写 noteSlot 时挂在第一个还没括注的部位（部位顺序 时之沙 → 空之杯 → 理之冠）',
    foldMainNoteIntoStats({ note: '二命', stats: { 时之沙: ['攻击力'], 空之杯: ['生命值'], 理之冠: [] } })['时之沙'][0],
    '攻击力（二命）')
  push('主词条括注：没写 noteSlot、第一个部位已有括注时顺延到下一个部位',
    foldMainNoteIntoStats({ note: '二命', stats: { 时之沙: ['攻击力（高命）'], 空之杯: ['生命值'], 理之冠: [] } })['空之杯'][0],
    '生命值（二命）')
  push('主词条括注：值里已经有同一条括注 → 不重复追加（幂等）',
    foldMainNoteIntoStats({ note: '高命', noteSlot: '时之沙', stats: { 时之沙: ['攻击力', '元素精通（高命）'] } })['时之沙'].join(' / '),
    '攻击力 / 元素精通（高命）')
  push('主词条括注：值里本来就是括注写法 → 原样透过（再存一次不会变）',
    normalizeV2({ artifacts: [{ kind: 'main', stats: { 时之沙: ['攻击力', '元素精通（高命）'], 空之杯: [], 理之冠: [] } }] }).artifacts[0].stats['时之沙'].join(' / '),
    '攻击力 / 元素精通（高命）')
  push('主词条括注：没有 note 时值一个字都不改（老数据打开再保存不变）',
    JSON.stringify(normalizeV2({ artifacts: [{ kind: 'main', stats: { 时之沙: ['攻击力'], 空之杯: ['防御力'], 理之冠: ['暴击率'] } }] }).artifacts[0].stats),
    JSON.stringify({ 时之沙: ['攻击力'], 空之杯: ['防御力'], 理之冠: ['暴击率'] }))
}

/* 5c. 副词条两两关系可改（用户定稿 2026-09-21）：`＞` / `≥` / `=` 写进行的 `sep`；
 *     **双爆固定 `=`，编辑器改不动**（与显示层 subSepBetween 同一口径） */
{
  const data = mkData({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害', '大攻击', '元素精通'], sep: ' / > > ' }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  push('副词条：读到逐档 token', ctx.__editor.subSepTokens('v2.artifacts.0', 4), ['/', '>', '>'])
  push('副词条：双爆判据（暴击率 ↔ 暴击伤害）', ctx.__editor.isCritPairValues('暴击率', '暴击伤害'), true)
  push('副词条：非双爆不是双爆对', ctx.__editor.isCritPairValues('大攻击', '元素精通'), false)
  push('副词条：把第 2 档改成 ≥', ctx.__editor.setSubSep('v2.artifacts.0', 1, '≥'), true)
  push('副词条：改后 sep 逐档规范化', model.v2.artifacts[0].sep, ' / ≥ > ')
  push('副词条：把第 3 档改成 =', ctx.__editor.setSubSep('v2.artifacts.0', 2, '='), true)
  push('副词条：改后 sep', model.v2.artifacts[0].sep, ' / ≥ = ')
  push('副词条：双爆那一档改不动（锁死 =）', ctx.__editor.setSubSep('v2.artifacts.0', 0, '≥'), false)
  push('副词条：锁定档的写法没被改动', model.v2.artifacts[0].sep, ' / ≥ = ')
  push('副词条：全同写法收成单 token', ctx.__editor.subSepCanonical(['=', '=', '=', '=']), ' = ')
  const out = fn('toJson')()
  push('副词条：落盘保留新关系', out.v2.artifacts[0].sep, ' / ≥ = ')
  push('副词条：界面字形表', [ctx.__editor.SEP_GLYPH['>'], ctx.__editor.SEP_GLYPH['≥'], ctx.__editor.SEP_GLYPH['=']], ['＞', '≥', '='])
  // 界面上真的画出控件：3 档 2 个间隔，双爆那一档禁用（锁死 `=`）
  const html = ctx.__editor.multiValue('副词条', 'v2.artifacts.0.stats', ['暴击率', '暴击伤害', '大攻击'], '如 双爆 / 大攻击', '副词条')
  push('副词条：界面出现 2 个关系选择器（3 档 2 个间隔）', (html.match(/class="mv-sep/g) || []).length, 2)
  push('副词条：双爆那一档是禁用态', /class="mv-sep mv-sep-locked"[^>]*disabled/.test(html), true)
  push('副词条：非双爆那一档可选 `≥`', /data-sep-gap="1"[\s\S]{0,160}>≥<\/option>/.test(html), true)
  push('副词条：主词条不加关系选择器', (ctx.__editor.multiValue('时之沙', 'v2.artifacts.0.stats.时之沙', ['攻击力', '元素精通'], 'x', '时之沙').match(/mv-sep/g) || []).length, 0)
}

/* 5d. 武器行：与副词条同一套关系规则（可自定义 `＞/≥/=`，默认 `＞`），条目排成**同一行** */
{
  const data = mkData({ weapons: [{ label: '辅助', tier: null, sep: ' ≥ ', items: [{ name: '甲枪', ref: 'weapon:甲枪' }, { name: '乙枪', ref: 'weapon:乙枪' }, { name: '丙枪', ref: 'weapon:丙枪' }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  push('武器行：读到逐档 token', ctx.__editor.rowSepTokens('v2.weapons.0', 3), ['≥', '≥'])
  push('武器行：默认 token 是 `>`', ctx.__editor.normSepToken('随便写的'), '>')
  push('武器行：把第 2 档改成 `=`', ctx.__editor.setWeaponSep('v2.weapons.0', 1, '='), true)
  push('武器行：改后 sep 逐档规范化', model.v2.weapons[0].sep, ' ≥ = ')
  push('武器行：把第 1 档改回优先级', ctx.__editor.setWeaponSep('v2.weapons.0', 0, '>'), true)
  push('武器行：改后 sep', model.v2.weapons[0].sep, ' > = ')
  push('武器行：越界的档改不动', ctx.__editor.setWeaponSep('v2.weapons.0', 5, '>'), false)
  const html = ctx.__editor.internals.renderWeaponsHtml()
  push('武器行：条目排在同一行（.weapon-line）', /class="mv weapon-line"/.test(html), true)
  push('武器行：3 个条目 → 2 个关系选择器', (html.match(/class="mv-sep/g) || []).length, 2)
  push('武器行：界面里没有 flex-wrap:wrap（不换行）', /flex-wrap:\s*wrap/.test(html), false)
  const out2 = fn('toJson')()
  push('武器行：落盘带上关系', (out2.v2.weapons[0] || {}).sep, ' > = ')
  if (process.env.DBG_WEAPON) console.log('[DBG] toJson.v2.weapons = ' + JSON.stringify(out2.v2.weapons) + '\n[DBG] model.v2.weapons = ' + JSON.stringify(model.v2.weapons))
}

/* 5e. 面板模块改版（用户定稿 2026-09-21）：**一行两个控件** —— 属性下拉 + 数值输入；
 *     百分比属性（暴击率 / 暴击伤害 / 元素充能效率）自动补 `%`，数值不留尾部 `+`；
 *     **空模块里「＋ 面板行」加出来的行直接就是这两个控件**（用户报：「新增行没按新格式激活」）。
 */
{
  // ① 属性词表与归一
  push('面板：属性词表就是七种', ctx.__editor.PANEL_ATTRS,
    ['攻击力', '防御力', '生命值', '暴击率', '暴击伤害', '元素精通', '元素充能效率'])
  push('面板：历史写法「充能」→ 元素充能效率', ctx.__editor.panelAttrOf('充能'), '元素充能效率')
  push('面板：历史写法「暴伤」→ 暴击伤害', ctx.__editor.panelAttrOf('暴伤'), '暴击伤害')
  push('面板：认不出的写法返回空串', ctx.__editor.panelAttrOf('双爆'), '')
  push('面板：百分比属性判据', ['暴击率', '暴击伤害', '元素充能效率', '攻击力'].map(a => ctx.__editor.isPanelPct(a)),
    [true, true, true, false])
  const nv = ctx.__editor.normPanelValue
  push('面板：百分比属性自动补 %', nv('暴击率', '70'), '70%')
  push('面板：已经有 % 就不重复', nv('暴击率', '70%'), '70%')
  push('面板：数值去掉尾部 +', nv('攻击力', '2200+'), '2200')
  push('面板：充能 240+ → 240%', nv('元素充能效率', '240+'), '240%')
  push('面板：非百分比属性不补 %', nv('元素精通', '800'), '800')
  push('面板：`+` 后面只跟括号备注时也算尾部 `+`', nv('元素精通', '800+（非讨龙）'), '800（非讨龙）')

  // ② 打开老数据：键值行归一；说明行里写着「属性：数值」也认成结构化行
  const model = ctx.__editor.internals.normalizeData(mkData({
    panels: [
      { label: null, k: '充能', v: '240%+' },
      { label: '输出向', text: '暴伤220%+' },
      { label: null, k: '元素精通', v: '800+' },
      { label: '辅助', text: '各种直伤纯色队' }
    ]
  }))
  api.setModelForTest(model)
  push('面板：打开时属性归一 + 去尾部 `+`', [model.v2.panels[0].k, model.v2.panels[0].v], ['元素充能效率', '240%'])
  push('面板：打开时补 `%`（和落盘同一口径）', [model.v2.panels[2].k, model.v2.panels[2].v], ['元素精通', '800'])
  push('面板：带标签的说明行认出「属性：数值」',
    [model.v2.panels[1].label, model.v2.panels[1].k, model.v2.panels[1].v], ['输出向', '暴击伤害', '220%'])
  push('面板：认不出的是真正的说明行',
    [ctx.__editor.panelRowIsText(model.v2.panels[3]), model.v2.panels[3].text], [true, '各种直伤纯色队'])

  // ③ 界面：一行两个控件（属性下拉 + 数值输入）
  const html = ctx.__editor.internals.renderPanelsHtml()
  push('面板界面：三行结构化行', (html.match(/class="mv panel-line"/g) || []).length, 3)
  push('面板界面：每行一个属性下拉', (html.match(/<select class="mv-attr" data-panel-attr=/g) || []).length, 3)
  push('面板界面：每个下拉列出七种属性', (html.match(/<option value="(攻击力|防御力|生命值|暴击率|暴击伤害|元素精通|元素充能效率)"/g) || []).length, 21)
  push('面板界面：每行一个数值输入', (html.match(/data-panel-value="v2\.panels\./g) || []).length, 3)
  push('面板界面：百分比属性的数值框带 mv-pct', (html.match(/class="mv-in mv-pct"/g) || []).length, 2)
  push('面板界面：非百分比属性不带 mv-pct', /class="mv-in" data-panel-value="v2\.panels\.2"/.test(html), true)
  push('面板界面：按属性给数值候选（datalist 七份）', (html.match(/<datalist id="dl-panel-/g) || []).length, 7)
  push('面板界面：数值框挂上对应属性的候选表', /list="dl-panel-元素充能效率"/.test(html), true)
  push('面板界面：说明行仍是文本框', /data-path="v2\.panels\.3\.text"/.test(html), true)
  push('面板界面：整行不换行（没有 flex-wrap:wrap）', /flex-wrap:\s*wrap/.test(html), false)

  // ④ 落盘形状：无标签 → `{k,v}`；有标签 → 说明行 `{label, text:'k：v'}`（往返闭合的那两种）
  const out = fn('toJson')()
  push('面板落盘：无标签行 → {k,v}', out.v2.panels[0], { k: '元素充能效率', v: '240%' })
  push('面板落盘：有标签行 → {label, text:"k：v"}', out.v2.panels[1], { label: '输出向', text: '暴击伤害：220%' })
  push('面板落盘：说明行原样留着', out.v2.panels[3], { label: '辅助', text: '各种直伤纯色队' })
  push('面板落盘：界面标记不落盘', JSON.stringify(out).includes('_new') || JSON.stringify(out).includes('_text'), false)

  // ⑤ 空模块里新增一行：直接激活成「属性 + 数值」
  const m2 = ctx.__editor.internals.normalizeData(mkData({ panels: [] }))
  api.setModelForTest(m2)
  fn('handleAction')('add-row', 'v2.panels', undefined, null)
  push('新增面板行：不是说明行（直接给两个控件）', ctx.__editor.panelRowIsText(m2.v2.panels[0]), false)
  const html2 = ctx.__editor.internals.renderPanelsHtml()
  push('新增面板行：表单里出现属性下拉', /data-panel-attr="v2\.panels\.0"/.test(html2), true)
  push('新增面板行：表单里出现数值输入', /data-panel-value="v2\.panels\.0"/.test(html2), true)
  push('新增面板行：还没选属性时给出提示', /属性要在下拉里选/.test(html2), true)
  m2.v2.panels[0].k = '元素充能效率'
  m2.v2.panels[0].v = ctx.__editor.normPanelValue('元素充能效率', '240+')
  push('新增面板行：落盘补 % 去 +', fn('toJson')().v2.panels[0], { k: '元素充能效率', v: '240%' })

  // ⑥ 「改成说明行 / 改成属性+数值」来回切不丢内容
  const m3 = ctx.__editor.internals.normalizeData(mkData({ panels: [{ label: '输出向', text: '暴击率：70%' }] }))
  api.setModelForTest(m3)
  push('面板：说明行打开时折成结构化', [m3.v2.panels[0].k, m3.v2.panels[0].v], ['暴击率', '70%'])
  fn('handleAction')('panel-to-text', 'v2.panels.0', undefined, null)
  push('面板：结构化 → 说明行', [m3.v2.panels[0].text, !!m3.v2.panels[0].k], ['暴击率：70%', false])
  push('面板：切回说明行后按说明行渲染', ctx.__editor.panelRowIsText(m3.v2.panels[0]), true)
  fn('handleAction')('panel-to-text', 'v2.panels.0', undefined, null)
  push('面板：再切回结构化', [m3.v2.panels[0].k, m3.v2.panels[0].v], ['暴击率', '70%'])
}

/* 5f. 武器行「放得下几把」（用户定稿 2026-09-21）：**同级上限 4 把**，名字短就放得下 4 把、
 *     名字长就只放得下 3 把；编辑器按**实际量出来的宽度**给提示。
 *     宽度公式（与 app.js 的 planRowFit 同一套）：n 个 chip + (n-1) 个分隔符 + 1 个「＋」按钮，
 *     间隔 = 子元素数 - 1 个 gap。
 */
{
  const fit = fn('planRowFit')
  const base = { avail: 1000, sepWidth: 30, addWidth: 24, gap: 3, cap: 4 }
  const m = (extra) => Object.assign({}, base, extra)
  // 4 把短名（150/把）：4*150 + 3*30 + 24 + 7*3 = 735
  push('武器行：放得下 4 把 → 提示「可加入 4 把」', fit(m({ chipWidths: [150, 150, 150], candidateWidth: 150 })).hint, '可加入 4 把')
  push('武器行：上限常量 = 4', ctx.__editor.WEAPON_ROW_CAP, 4)
  // 4 把长名（300/把）：4*300 + 3*30 + 24 + 21 = 1341 > 1000
  push('武器行：名字长只放得下 3 把 → 提示「仅可加入 3 把」',
    fit(m({ chipWidths: [300, 300, 300], candidateWidth: 300 })).hint, '仅可加入 3 把')
  push('武器行：刚好 735px 放得下 4 把', fit(m({ avail: 735, chipWidths: [150, 150, 150], candidateWidth: 150 })).hint, '可加入 4 把')
  push('武器行：734px 就差 1px → 仅可加入 3 把', fit(m({ avail: 734, chipWidths: [150, 150, 150], candidateWidth: 150 })).hint, '仅可加入 3 把')
  push('武器行：已经 4 把 → 已达同级上限', fit(m({ chipWidths: [100, 100, 100, 100], candidateWidth: 100 })).hint, '已达同级上限（4 把）')
  push('武器行：2 把短名可以加满 4 把', fit(m({ chipWidths: [100, 100], candidateWidth: 100 })).maxFit, 4)
  push('武器行：当前就放不下时 over = true', fit(m({ chipWidths: [400, 400, 400], candidateWidth: 400 })).over, true)
  push('武器行：放得下时 over = false', fit(m({ chipWidths: [150, 150, 150], candidateWidth: 150 })).over, false)
}

/* 5g. 角色目录右侧：只报「还没填的模块」（用户定稿 2026-09-21：不再显示「武2 圣3」计数） */
{
  const html = ctx.__editor.renderListHtml([
    { name: '甲', filled: { weapons: false, artifacts: false, talents: true, panels: true, constellations: true, teams: true } },
    { name: '乙', filled: { weapons: true, artifacts: true, talents: true, panels: true, constellations: true, teams: true } },
    { name: '丙', filled: { weapons: true, artifacts: true, talents: false, panels: false, constellations: false, teams: false }, hasUnparsed: true },
    { name: '丁', filled: null, broken: true }
  ])
  push('目录：未填模块写成「未填：武 圣」', /未填：武 圣/.test(html), true)
  push('目录：全部模块已填的行不出现「未填」', /乙[\s\S]*?<\/div>/.test(html) && !/乙[\s\S]*?未填/.test(html.split('丙')[0]), true)
  push('目录：模块顺序按文档顺序（天 面 命 配）', /未填：天 面 命 配/.test(html), true)
  push('目录：未识别单独标记', /未识别/.test(html), true)
  push('目录：坏文件标「读取失败」且不误报未填', /读取失败/.test(html) && !/丁[\s\S]*?未填/.test(html), true)
  push('目录：六个模块短名齐全', ctx.__editor.MODULE_SHORT.map(function (kv) { return kv[1] }).join(''), '武圣天面命配')

  // 旅行者 / 奇偶：目录不显示「未填」（用户定稿 2026-09-26），也不参与「未填优先」排序
  const none = { weapons: false, artifacts: false, talents: false, panels: false, constellations: false, teams: false }
  const exemptHtml = ctx.__editor.renderListHtml([
    { name: '旅行者·火', filled: none }, { name: '旅行者·草', filled: none },
    { name: '奇偶·男性', filled: none }, { name: '奇偶·女性', filled: none },
    { name: '甲', filled: none }
  ])
  push('目录：旅行者不显示「未填」', /旅行者·火[\s\S]*?<\/div>/.test(exemptHtml) && !/旅行者·火<\/span><span class="meta">[^<]*未填/.test(exemptHtml), true)
  push('目录：奇偶不显示「未填」', !/奇偶·[男女]性<\/span><span class="meta">[^<]*未填/.test(exemptHtml), true)
  push('目录：同一份数据里普通角色照旧显示「未填」', (exemptHtml.match(/未填：/g) || []).length, 1)
  push('目录：旅行者行的提示词说明豁免', /title="旅行者·火：旅行者 \/ 奇偶不显示未填项"/.test(exemptHtml), true)
  push('未填豁免判据：只认「旅行者 / 奇偶」这个名字族',
    ['旅行者·火', '旅行者·草', '奇偶·男性', '奇偶·女性', '旅行者', '奇偶'].every(n => ctx.__editor.unfilledExempt(n)) &&
    ['琴', '丽莎', '奇偶性'].every(n => !ctx.__editor.unfilledExempt(n)), true)
  push('未填豁免判据：空名不豁免（坏文件不缺字段）', ctx.__editor.unfilledExempt('') || ctx.__editor.unfilledExempt(null), false)

  // 排序（用户定稿 2026-09-24）：**未填优先**，组内保持默认顺序；全都填完就是默认顺序
  const mk = (name, all) => ({ name, filled: { weapons: all, artifacts: all, talents: all, panels: all, constellations: all, teams: all } })
  const sort = ctx.__editor.sortListItems
  push('目录排序：未填的排前面、组内保持默认顺序',
    sort([mk('甲', true), mk('乙', false), mk('丙', true), mk('丁', false)]).map(x => x.name), ['乙', '丁', '甲', '丙'])
  push('目录排序：一个未填都没有 → 就是默认顺序',
    sort([mk('甲', true), mk('乙', true), mk('丙', true)]).map(x => x.name), ['甲', '乙', '丙'])
  push('目录排序：缺 filled 信息的行按「已填」沉底',
    sort([{ name: '甲' }, mk('乙', false)]).map(x => x.name), ['乙', '甲'])
  push('目录排序：旅行者 / 奇偶按「没有未填」处理（沉到已填那一组）',
    sort([mk('旅行者·火', false), mk('甲', true), mk('奇偶·女性', false), mk('乙', false)]).map(x => x.name),
    ['乙', '旅行者·火', '甲', '奇偶·女性'])
}

/* 5h. `sep` 的 token 数必须跟着条目数走（薇斯纳的副词条：5 个词条只存了 3 个 token，
 *     渲染层用最后一个补齐 → 读回来 4 个 token → 往返不闭合、回写被挡下）。
 *     加/删条目、以及保存时，都要按**落盘后的条目数**重新规范化。 */
{
  const data = mkData({ artifacts: [{ kind: 'sub', stats: ['暴击率', '暴击伤害', '大攻击', '元素充能效率'], sep: ' / > > ' }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  push('sep 同步：4 个词条 + 3 个 token → 规范化后仍是 3 个',
    ctx.__editor.canonicalSep(model.v2.artifacts[0], 4), ' / > > ')
  // 点「＋」加一条：模型里是 5 格（含一个空条目）→ 4 个 token；保存时空条目被过滤 → 落盘回到 3 个
  fn('handleAction')('add-item', 'v2.artifacts.0.stats', undefined, null)
  push('sep 同步：加一条空词条 → 模型按 5 格算 4 个 token', model.v2.artifacts[0].sep, ' / > > > ')
  push('sep 同步：空条目落盘被过滤 → 文件里仍是 3 个 token', fn('toJson')().v2.artifacts[0].sep, ' / > > ')
  // 把新条目填上名字 → 5 条，落盘就该有 4 个 token
  model.v2.artifacts[0].stats[4] = '元素精通'
  let out = fn('toJson')()
  push('sep 同步：第 5 条填上名字 → 落盘 4 个 token', out.v2.artifacts[0].sep, ' / > > > ')
  push('sep 同步：词条确实是 5 条', out.v2.artifacts[0].stats.length, 5)
  // 删一条 → 回到 4 条 / 3 个 token
  api.setModelForTest(model)
  fn('handleAction')('del-item', 'v2.artifacts.0.stats', 4, null)
  out = fn('toJson')()
  push('sep 同步：删掉第 5 条 → 回落 3 个 token', out.v2.artifacts[0].sep, ' / > > ')
  // 武器行同理
  const w = ctx.__editor.internals.normalizeData(mkData({ weapons: [{ label: '推荐', tier: 1, sep: ' > ', items: [{ name: '甲枪' }, { name: '乙枪' }] }] }))
  api.setModelForTest(w)
  fn('handleAction')('add-item', 'v2.weapons.0.items', undefined, null)
  w.v2.weapons[0].items[2] = { name: '丙枪', note: '' }
  // 三档全是 `>` → 仓库约定收成**单个** token（不是 `> >`）
  push('sep 同步：武器行加到第 3 把、全是优先级 → 收成单 token', fn('toJson')().v2.weapons[0].sep, ' > ')
  w.v2.weapons[0].sep = ' > = '
  push('sep 同步：混合写法按落盘条目数展开成 2 个 token', fn('toJson')().v2.weapons[0].sep, ' > = ')
  // 只剩一条时回到默认写法（parse-docx 对单条目行也回 `> `）
  api.setModelForTest(w)
  fn('handleAction')('del-item', 'v2.weapons.0.items', 2, null)
  fn('handleAction')('del-item', 'v2.weapons.0.items', 1, null)
  push('sep 同步：只剩一条 → 回落单 token 写法', fn('toJson')().v2.weapons[0].sep, ' > ')
}

/* 6. 圣遗物行不再有「件数」输入（件数已从文档 / 数据 / 显示全部去掉） */
{
  const data = mkData({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' > ', sets: [{ name: '千岩牢固', ref: 'artifact:千岩牢固' }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  const out = fn('toJson')()
  push('圣遗物：落盘不带 pieces', JSON.stringify(out.v2.artifacts).includes('pieces'), false)
}

/* 7. 删除行 / 清空字段：编辑器提交的形状（用户报「预览与实际修改不符」）
 *    · 删行 = 原位墓碑 `{__deleted:true}`（**不缩短数组**，位置不乱 → 服务器才能按下标对齐）
 *    · 清空 = 显式提交 null（以前省略这个键，被服务器当成「没改」→ 原文件的值顶回来）
 *    · 空占位行是用户的：留/删都由用户决定，编辑器不替用户丢
 */
{
  const mkWeapons = () => mkData({
    weapons: [
      { label: '满拐', tier: null, sep: ' > ', items: [{ name: '岩峰巡歌', ref: 'weapon:岩峰巡歌' }, { name: '圣显之钥', ref: 'weapon:圣显之钥' }] },
      { label: '循环', tier: null, sep: ' > ', items: [{ name: '西风剑', ref: 'weapon:西风剑' }] }
    ]
  })
  {
    const model = ctx.__editor.internals.normalizeData(mkWeapons())
    model.v2.weapons[0].__deleted = true
    api.setModelForTest(model)
    const out = fn('toJson')()
    push('删行：提交原位墓碑、数组不缩短', out.v2.weapons.map(w => (w.__deleted ? '(墓碑)' : (w.label ?? '(无)'))), ['(墓碑)', '循环'])
    push('删行：墓碑行在表单里不渲染', fn('rowVisible')(model.v2.weapons[0]), false)
  }
  {
    const model = ctx.__editor.internals.normalizeData(mkWeapons())
    model.v2.weapons[0].label = ''
    model.v2.weapons[0].items[0].note = ''
    api.setModelForTest(model)
    const out = fn('toJson')()
    push('清空标签：显式提交 null', [out.v2.weapons[0].label, out.v2.weapons[0].tier], [null, null])
    push('清空条目备注：显式提交 null', out.v2.weapons[0].items[0].note, null)
  }
  {
    const model = ctx.__editor.internals.normalizeData(mkData({ artifacts: [{ kind: 'main', stats: { 时之沙: [], 空之杯: [], 理之冠: [] } }] }))
    api.setModelForTest(model)
    const out = fn('toJson')()
    push('空占位行（main）照旧提交（留/删由用户决定）', out.v2.artifacts.filter(r => r.kind === 'main').length, 1)
  }
  {
    const model = ctx.__editor.internals.normalizeData(mkWeapons())
    model.v2.teams = [{ _new: true, label: '', members: [], text: '' }]
    api.setModelForTest(model)
    const out = fn('toJson')()
    push('界面标记 `_new` 不落盘', JSON.stringify(out).includes('_new') || JSON.stringify(out).includes('__deleted'), false)
  }
}

/* 8. 切 kind 后行必须**立刻可用**（用户报：「添加副词条行之后无法点加号添加词条」）
 *    根因：下拉只改了 kind，行里没有 stats → `＋` 往 undefined 里 push、静默失败。
 */
{
  const data = mkData({ artifacts: [{ kind: 'preferred', label: '首选', sep: ' > ', sets: [{ name: '千岩牢固' }] }] })
  const model = ctx.__editor.internals.normalizeData(data)
  api.setModelForTest(model)
  const row = model.v2.artifacts[0]

  row.kind = 'sub'
  fn('normalizeArtifactRowShape')(row)
  push('切成副词条：stats 立刻补成数组', Array.isArray(row.stats), true)
  fn('handleAction')('add-item', 'v2.artifacts.0.stats', undefined, null)
  push('副词条点「＋」能加进一条空词条', row.stats.length, 1)

  row.kind = 'main'
  fn('normalizeArtifactRowShape')(row)
  push('切成主词条：三个槽位都是数组', ['时之沙', '空之杯', '理之冠'].map(s => Array.isArray(row.stats[s])), [true, true, true])
  fn('handleAction')('add-item', 'v2.artifacts.0.stats.时之沙', undefined, null)
  push('主词条点「＋」能加进一条空词条', row.stats['时之沙'].length, 1)

  row.kind = 'preferred'
  fn('normalizeArtifactRowShape')(row)
  push('切回档位行：sets 仍在（切来切去不丢数据）', Array.isArray(row.sets) && row.sets.length, 1)
}

/* ---------------------------------------------------------------- 汇总 */
let failed = 0
for (const c of checks) {
  if (!c.ok) failed++
  console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
}
console.log(`\n编辑器规则自检：${checks.length - failed}/${checks.length}${failed ? ' ← 有失败' : ' 全通过 ✅'}`)
process.exitCode = failed ? 1 : 0
