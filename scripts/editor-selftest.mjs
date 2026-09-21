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
 *   6. 界面上的临时标记（`_new`）**不许落盘**。
 *
 * 用法：node scripts/editor-selftest.mjs        # 全绿则 exit 0
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

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
