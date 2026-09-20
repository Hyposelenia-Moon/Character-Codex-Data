/* 角色攻略编辑器 —— 原生 JS，无框架、无外部依赖 */
'use strict'

/* ============================================================ 常量 / 状态 */

var TALENTS = ['A', 'E', 'Q']
var TIERS = [1, 2, 3, 4, 5, 6]
var CN_NUM = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' }

/**
 * 圣遗物执行档位下拉的**界面用词**。
 *
 * ⚠ 这不是"另一份映射表"，只是浏览器脚本无法 import ESM 时的**显示镜像**；
 * 唯一权威是数据仓库 `scripts/lib/guide-display.mjs` 的
 * `ARTIFACT_KIND_LABEL`（kind → 来源写法）经 `displayLabel` 归一后的**三档显示词**：
 * `preferred → 推荐`、`transition → 过渡`、`optional → 可选`。
 * 改那边就必须同步这里（否则表单写 `过渡`、预览/面板显示 `可选`，两端漂移）。
 */
var ARTIFACT_KINDS = [
  { value: 'preferred', label: '推荐' },
  { value: 'transition', label: '过渡' },
  { value: 'optional', label: '可选' },
  { value: 'main', label: '主词条' },
  { value: 'sub', label: '副词条' },
  { value: 'text', label: '文本' },
  { value: 'note', label: '备注（注：）' }
]

/**
 * 圣遗物档位词 ↔ `kind`（**与 parse-docx 的 setRow 映射、`schema.renderArtifactRow` 同一份**）。
 *
 * 文档里一行**只有一个标签词**，所以 `label`（文档里的原词）与 `kind` 必须互相吻合：
 * `首选`/`套装`→preferred、`可选`/`次选`→optional、`过渡`→transition；
 * 认不出的自定义词（`输出向`）走 parse-docx 的兜底 → `kind: 'preferred'`。
 * 编辑器按同一规则联动下拉，保证「保存 → 写文档 → 再解析」不会漂移。
 */
var ARTIFACT_WORD_KIND = { 首选: 'preferred', 套装: 'preferred', 可选: 'optional', 次选: 'optional', 过渡: 'transition' }
var ARTIFACT_KIND_WORD = { preferred: '首选', transition: '过渡', optional: '可选' }

/**
 * 武器档位下拉：与面板 / 网页版同一套术语 —— 1/2/3 → 推荐 / 可选 / 过渡。
 * 仓库里数据只有 1~3 档；真出现第 4 档以上就显示「第N档」（不静默改写数据）。
 * @param {number|string} tier
 * @returns {string}
 */
function tierLabel (tier) {
  var n = Number(tier)
  if (n === 1) return '推荐'
  if (n === 2) return '可选'
  if (n === 3) return '过渡'
  if (Number.isInteger(n) && n > 3) return '第' + n + '档'
  return String(tier == null ? '' : tier)
}

/**
 * 行首标签的界面用词：数据里的来源写法在界面上显示为显示词汇（只改显示，不改数据）。
 * 与 `guide-display.mjs` 的 `TIER_LABEL` 同一套（唯一权威在那边）：
 * `首选`→推荐、`其他`/`次选`→可选、`套装`→推荐；`推荐`/`可选`/`过渡` 本身是显示词，原样。
 */
function labelText (label) {
  var s = str(label).trim()
  if (!s) return ''
  if (s === '首选' || s === '套装') return '推荐'
  if (s === '其他' || s === '次选') return '可选'
  return s
}

/** 标签输入框旁的「显示为」小字：数据值与显示层用词不同时给个提示（只读，不改数据） */
function labelHint (label) {
  var raw = str(label).trim()
  var shown = labelText(raw)
  if (!raw || shown === raw) return ''
  return '<span class="muted" style="font-size:11px" title="数据里存的是「' + esc(raw) + '」，面板 / 网页版显示为「' + esc(shown) + '」">显示为：' + esc(shown) + '</span>'
}

/**
 * 这一行的**档位标签**最终会显示成什么（只读预览，不改数据）。
 *
 * 与显示层 `scripts/lib/guide-display.mjs` 的 `displayLabel` 同口径：
 * **`label` 非空时它就是标签**（自定义词，如 `建议`），为空才看档位 `tier`。
 * 编辑器过去把自定义词写进 `label` 却仍显示档位词（网页版 / 预览按 tier 算），
 * 于是「档位=推荐 + 自定义词=建议」看起来「不生效」；现在两边都 label 优先。
 * @param {object} row
 * @returns {string}
 */
function resolvedLabelText (row, fallback) {
  var custom = str(row && row.label).trim()
  if (custom) return labelText(custom)
  if (fallback) return fallback
  return tierLabel(row && row.tier)
}

/** 圣遗物行的档位词（`kind` → 界面用词），作为 `label` 为空时的显示兜底 */
function artifactKindWord (kind) {
  for (var i = 0; i < ARTIFACT_KINDS.length; i++) if (ARTIFACT_KINDS[i].value === kind) return ARTIFACT_KINDS[i].label
  return str(kind)
}

/**
 * 自定义档位词 = 非空、且**不是**档位词本身（`推荐`/`可选`/`过渡` 直接写进 label 也算自定义，
 * 但那时它就是显示词，不再看 tier）。
 * @param {string} label
 * @returns {boolean}
 */
function isCustomLabel (label) {
  return !!str(label).trim()
}

/** 武器行 / 圣遗物行「标签」控件的说明文案（两者口径一致：自定义词顶掉档位词） */
var LABEL_TIP = '自定义标签：填了就显示你写的词（如把「推荐」写成「建议」），档位下拉会被清空；两处只能留一个 —— 文档里一行只有一个标签词，同时写会往返不一致'

/** 行首标签的「显示为」预览（武器行 / 圣遗物行共用；`fallback` = label 为空时的档位词） */
function resolvedHint (row, fallback) {
  var shown = resolvedLabelText(row, fallback)
  if (!shown) return '<span class="muted" style="font-size:11px">未设标签（该行不显示标签）</span>'
  return '<span class="muted" style="font-size:11px" title="' + esc(LABEL_TIP) + '">显示为：' + esc(shown) + '</span>'
}

/** 空模块占位文案（与面板 / 网页版一致） */
var EMPTY_TEXT = '暂无'

var REF_KINDS = {
  weapon: { type: 'weapon', list: 'dl-weapon', icon: '⚔', text: '武器' },
  artifact: { type: 'artifact', list: 'dl-artifact', icon: '❖', text: '圣遗物' },
  character: { type: 'character', list: 'dl-character', icon: '☺', text: '角色' }
}

var MAIN_SLOTS = ['时之沙', '空之杯', '理之冠']

/**
 * 主词条 / 副词条的**候选词表**（多值输入框的下拉候选）。
 *
 * 口径（用户定稿）：
 *   · 主词条**不写「百分比」**（主词条默认就是百分比）：`攻击力` / `生命值` / `防御力`；
 *     副词条才用大/小前缀区分：百分比 = `大攻击`、固定值 = `小攻击`。
 *   · 主词条里 `攻击力` 与副词条里 `小攻击` 是同一个属性的两种写法，**不同栏目、按栏目区分**。
 * 只用于输入提示（datalist / 选择器），**不校验、不改写**用户输入的任何值。
 */
var STAT_CANDIDATES = {
  时之沙: ['攻击力', '生命值', '防御力', '元素精通', '元素充能效率'],
  空之杯: ['攻击力', '生命值', '防御力', '元素精通', '元素伤害加成',
    '火元素伤害加成', '水元素伤害加成', '雷元素伤害加成', '冰元素伤害加成',
    '风元素伤害加成', '岩元素伤害加成', '草元素伤害加成', '物理伤害加成'],
  理之冠: ['攻击力', '生命值', '防御力', '元素精通', '暴击率', '暴击伤害', '治疗加成'],
  副词条: ['大攻击', '大生命', '大防御', '小攻击', '小生命', '小防御',
    '暴击率', '暴击伤害', '元素精通', '元素充能效率', '充能效率']
}

/** 主词条槽位 → datalist id */
var STAT_LIST_ID = { 时之沙: 'dl-stat-sand', 空之杯: 'dl-stat-goblet', 理之冠: 'dl-stat-circlet', 副词条: 'dl-stat-sub' }

var state = {
  index: { weapons: [], artifacts: [], characters: [], talents: [], constellations: [] },
  order: [],
  missing: [],
  items: [],
  current: null,
  model: null,
  before: null,          // 打开角色时的「形状快照」，保存后用来算改动摘要
  issues: [],
  issueMap: {},
  dirty: false,
  filter: '',
  view: 'search',        // 全局搜索框下拉里的内容：search | batch | library
  pendingFocus: null,    // 跳转过来要高亮的 rowId
  lastBackup: null,      // 最近一次批量替换的备份时间戳
  backupHistory: [],     // 本次会话里做过的批量替换（可依次回滚）
  usage: null,           // 名称库使用统计（/api/name-usage）
  usageAt: 0,
  batch: { type: 'weapon', from: '', to: '', preview: null },
  library: { type: 'weapon', filter: '', selected: null },
  gq: '',                // 工具箱里最后一次搜索词
  idleExit: 0,           // 服务端开启的空闲自动退出秒数（0 = 未开启）
  drawerOpen: false,     // 右侧抽屉（回收站 / 批量替换 / 名称库 / 全局检索）是否展开
  drawerTab: 'search',   // 抽屉当前页签
  previewOpen: false,    // 右侧「实时预览」面板是否展开
  previewText: false     // 预览显示形态：false = 渲染视图，true = 逐行文本
}

var $ = function (id) { return document.getElementById(id) }

/** 抽屉页签：id → 标题（次要操作都收进抽屉，工具条只留主操作） */
var DRAWER_TABS = [
  ['search', '全局检索'],
  ['batch', '批量替换'],
  ['library', '名称库'],
  ['trash', '回收站']
]

/* ============================================================ 通用小工具 */

function esc (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function clone (v) { return JSON.parse(JSON.stringify(v)) }

function str (v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)) }

function asArray (v) { return Array.isArray(v) ? v : [] }

function hasText (v) { return typeof v === 'string' && v.trim() !== '' }

/* ------------------------------------------------ 天赋等级 / 配队可替换项 */

/**
 * 天赋等级 → 输入框文本：`1` 显示 `1`、皇冠（10）显示 `10`、没写等级的旧数据显示 `1`
 * （用户口径：缺省就是 1，宁可写 1 也不留「未知」）
 */
function talentLevelText (v) {
  var m = str(v).trim().match(/^(\d{1,2})/)
  var n = m ? Number(m[1]) : 0
  return (n >= 1 && n <= 10) ? String(n) : '1'
}

/**
 * 一行天赋的**固定三格**：A / E / Q 各一格（顺序固定），等级来自优先级行
 * @param {object[]} rows v2.talents 的界面模型
 * @returns {Array<{name:string, level:string, crown:boolean, note?:string, extra?:boolean}>}
 */
function talentSlots (rows) {
  var row = asArray(rows).filter(function (r) { return r && r.kind === 'priority' })[0]
  var byName = {}
  asArray(row && row.slots).forEach(function (s) { byName[str(s && s.name).toUpperCase()] = s })
  var out = TALENTS.map(function (L) {
    var s = byName[L]
    var lv = s ? talentLevelText(s.level) : '1'
    var crown = !!(s && s.crown) || lv === '10'
    return { name: L, level: crown ? '10' : lv, crown: crown, note: str(s && s.note) }
  })
  // A/E/Q 之外的旧字母照原样带出来（保存时不丢）
  asArray(row && row.slots).forEach(function (s) {
    var L = str(s && s.name).toUpperCase()
    if (!L || TALENTS.indexOf(L) >= 0) return
    out.push({ name: str(s.name), level: talentLevelText(s.level), crown: !!s.crown, extra: true })
  })
  return out
}

/** 一格配队成员的名字 → 候选列表（`迪奥娜 / 阿罗夏` → ['迪奥娜','阿罗夏']） */
function memberCandidates (name) {
  return str(name).split(/\s*[/／]\s*/).map(function (s) { return s.trim() }).filter(Boolean)
}

/** 候选列表 → 一格的名字（多候选用 ` / ` 连接，与文档 / 面板 / 网页版同一写法） */
function joinCandidates (list) {
  var seen = {}
  var out = []
  asArray(list).forEach(function (x) {
    var n = str(typeof x === 'string' ? x : (x && x.name)).trim()
    if (!n || seen[n]) return
    seen[n] = true
    out.push(n)
  })
  return out.join(' / ')
}

/**
 * 把天赋行统一成「固定三格」形状：
 *   · 优先级行 → slots（A/E/Q 各一格）；缺字母补 1，多出的旧字母原样留着
 *   · 皇冠行的字母把对应格抬到 10（皇冠 = 已投，等级 10）后**并掉皇冠行**（等级只有一处真相）
 *   · 没有优先级行时补一行空的（界面上三格才有地方填）；**空的不会落盘**（见 buildBody）
 * @param {object[]} rows
 * @returns {object[]}
 */
function foldCrownRows (rows) {
  var list = asArray(rows).filter(function (r) { return r && typeof r === 'object' }).map(function (r) { return Object.assign({}, r) })
  var idx = -1
  list.forEach(function (r, i) { if (idx < 0 && r.kind === 'priority') idx = i })
  var slots = []
  if (idx >= 0) {
    // ⚠ 之前这里只读 `order`：而 normalizeData 造的界面模型只有 `slots`（没有 order），
    // 于是每次打开角色都把三格**重置成 1**，只有皇冠行能把对应格抬回 10 ——
    // 表现就是用户报的「只填数字不激活，只有点皇冠才生效」。
    // 现在**界面形状（slots）优先**，没有 slots 时才从数据形状（order）拆。
    var incoming = asArray(list[idx].slots)
    var order = asArray(list[idx].order)
    if (incoming.length) {
      slots = incoming.map(function (s) {
        return {
          name: str(s && s.name),
          level: talentLevelText(s && s.level),
          crown: !!(s && (s.crown === true || talentLevelText(s && s.level) === '10')),
          note: hasText(s && s.note) ? str(s.note) : undefined,
          extra: s && s.extra ? true : undefined
        }
      }).filter(function (s) { return hasText(s.name) })
    } else {
      slots = TALENTS.map(function (L) {
        var hit = order.filter(function (x) { return str(x && x.name).toUpperCase() === L })[0]
        return { name: L, level: talentLevelText(hit && hit.level), crown: !!(hit && (hit.crown === true || talentLevelText(hit && hit.level) === '10')) }
      })
      order.forEach(function (x) {
        var L = str(x && x.name).toUpperCase()
        if (!L || TALENTS.indexOf(L) >= 0) return
        slots.push({ name: str(x.name), level: talentLevelText(x.level), crown: x.crown === true, extra: true })
      })
    }
  } else {
    slots = TALENTS.map(function (L) { return { name: L, level: '1', crown: false } })
  }
  var byName = {}
  slots.forEach(function (s, i) { byName[str(s.name).toUpperCase()] = i })
  list.forEach(function (r) {
    if (r.kind !== 'crown') return
    asArray(r.items).forEach(function (it) {
      var L = str(it && it.name).toUpperCase()
      if (byName[L] === undefined) return
      slots[byName[L]].level = '10'
      slots[byName[L]].crown = true
      if (hasText(it && it.note) && !slots[byName[L]].note) slots[byName[L]].note = str(it.note)
    })
  })
  var others = list.filter(function (r) { return r.kind !== 'priority' && r.kind !== 'crown' })
  var pri = { kind: 'priority', slots: slots, raw: idx >= 0 ? str(list[idx].raw) : '', order: idx >= 0 ? asArray(list[idx].order) : [] }
  return [pri].concat(others)
}

/** v2 六个数组的空骨架 */
function emptyV2 () {
  return { weapons: [], artifacts: [], talents: [], panels: [], constellations: [], teams: [] }
}

/**
 * 把服务器返回（或新建模板）的 JSON 补成表单需要的完整形状
 * @param {object} data
 * @returns {object}
 */
function normalizeData (data) {
  var d = data && typeof data === 'object' ? data : {}
  var v2 = d.v2 && typeof d.v2 === 'object' ? d.v2 : {}
  var meta = d.meta && typeof d.meta === 'object' ? d.meta : {}
  const model = {
    schema: 2,
    name: str(d.name),
    game: str(d.game) || 'gi',
    meta: {
      '建议等级': str(meta['建议等级']),
      '定位': str(meta['定位']),
      '100级提升': str(meta['100级提升'])
    },
    v2: {
      weapons: asArray(v2.weapons).map(function (r) {
        return {
          label: str(r && r.label),
          tier: (r && Number.isInteger(r.tier)) ? r.tier : null,
          sep: str(r && r.sep) || ' > ',
          items: asArray(r && r.items).map(function (it) { return { name: str(it && it.name), note: str(it && it.note) } })
        }
      }),
      artifacts: asArray(v2.artifacts).map(function (r) {
        var kind = r && ARTIFACT_KINDS.some(function (k) { return k.value === r.kind }) ? r.kind : 'text'
        var row = { kind: kind, label: str(r && r.label), sep: str(r && r.sep) || ' > ' }
        if (kind === 'main') {
          var st = (r && r.stats) || {}
          row.stats = {}
          MAIN_SLOTS.forEach(function (slot) { row.stats[slot] = asArray(st[slot]).map(str) })
          // 主词条上的「命座/成本」括注（`水元素伤害加成（二命）`）：界面不改它，
          // 但**必须原样带回**（否则「打开→保存」会丢掉这条备注）
          if (hasText(str(r && r.note))) {
            row.note = str(r.note)
            if (hasText(str(r && r.noteSlot))) row.noteSlot = str(r.noteSlot)
          }
        } else if (kind === 'sub') {
          row.stats = asArray(r && r.stats).map(str)
        } else if (kind === 'text') {
          row.text = str(r && r.text)
        } else {
          row.sets = asArray(r && r.sets).map(function (s) { return { name: str(s && s.name), pieces: str(s && s.pieces) } })
        }
        return row
      }),
      talents: foldCrownRows(asArray(v2.talents).map(function (r) {
        if (r && r.kind === 'priority') {
          // 天赋等级：固定三格 A → E → Q，每格一个等级（1..10，10 = 皇冠）。
          // 界面只认这一份数据，皇冠由 level 决定（不再单独编辑皇冠行）。
          var slots = TALENTS.map(function (L) {
            var hit = asArray(r.order).filter(function (x) { return str(x && x.name).toUpperCase() === L })[0]
            return { name: L, level: talentLevelText(hit && hit.level), crown: !!(hit && (hit.crown === true || talentLevelText(hit && hit.level) === '10')) }
          })
          // 旧数据/脏数据里可能多出 A/E/Q 之外的字母：原样留着，保存时不丢
          var extra = asArray(r.order)
            .filter(function (x) { return TALENTS.indexOf(str(x && x.name).toUpperCase()) < 0 && hasText(str(x && x.name)) })
            .map(function (x) { return { name: str(x.name), level: talentLevelText(x.level), crown: x.crown === true, extra: true } })
          return { kind: 'priority', slots: slots.concat(extra), raw: str(r && r.raw) }
        }
        // 皇冠行：等级 10 归到对应字母那一格（数据里就是「这一格投了皇冠」）
        return {
          kind: 'crown',
          items: asArray(r && r.items).map(function (it) {
            return { name: str(it && it.name).toUpperCase(), level: talentLevelText(it && it.level), note: str(it && it.note) }
          })
        }
      })),
      panels: asArray(v2.panels).map(function (r) {
        if (r && hasText(str(r.k))) return { label: str(r.label), k: str(r.k), v: str(r.v) }
        return { label: str(r && r.label), text: str(r && r.text) }
      }),
      constellations: asArray(v2.constellations).map(function (r) {
        return { name: str(r && r.name), text: str(r && r.text) }
      }),
      teams: asArray(v2.teams).map(function (r) {
        // 段末备注行：整行就是备注（`{kind:'note', text}`），渲染层按它画一行
        if (r && r.kind === 'note') return { kind: 'note', text: str(r.text) }
        return {
          label: str(r && r.label),
          members: asArray(r && r.members).map(function (m) { return { name: str(m && m.name), note: str(m && m.note) } }),
          text: str(r && r.text)
        }
      })
    },
    unparsed: d.unparsed && typeof d.unparsed === 'object' && !Array.isArray(d.unparsed) ? d.unparsed : null,
    legacy: d.v2 == null,
    _raw: { source: d.source, highlight: d.highlight, meta: d.meta, game: d.game, schema: d.schema, unparsed: d.unparsed }
  }
  // 皇冠行条目的**原顺序**（A/E/Q 之外的写法，如 Q 在 A 前）：保存时照原样写回，
  // 保证「打开→保存」逐字节不变（皇冠行在界面上被折进三格，顺序靠这里记着）
  model.crownOrder = asArray(v2.talents)
    .filter(function (r) { return r && r.kind === 'crown' })
    .map(function (r) {
      return asArray(r.items).map(function (it) { return str(it && it.name).toUpperCase() }).filter(Boolean)
    })
  return model
}

/** 按 'a.b.0.c' 取值 */
function getPath (obj, path) {
  var cur = obj
  var parts = String(path).split('.')
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined
    cur = cur[parts[i]]
  }
  return cur
}

/** 按 'a.b.0.c' 赋值 */
function setPath (obj, path, value) {
  var parts = String(path).split('.')
  var cur = obj
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

/* ============================================================ HTTP */

function api (method, url, body) {
  var opts = { method: method, headers: {} }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8'
    opts.body = JSON.stringify(body)
  }
  return fetch(url, opts).then(function (res) {
    return res.text().then(function (text) {
      var data = null
      try { data = text ? JSON.parse(text) : null } catch (e) { data = null }
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : ('请求失败（HTTP ' + res.status + '）')
        throw new Error(msg)
      }
      return data
    })
  })
}

/* ============================================================ 状态提示 */

var statusTimer = null
function showStatus (text, kind, sticky) {
  var el = $('status')
  el.textContent = text
  el.className = 'status' + (kind ? ' ' + kind : '')
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null }
  if (!sticky && text) {
    statusTimer = setTimeout(function () { el.className = 'status hidden' }, 4200)
  }
}

function hideStatus () { showStatus('', 'hidden') }

/** 右下角 toast：保存/发布/批量替换后的改动摘要都走这里；opts.copy 提供「复制」按钮 */
var toastTimer = null
function toast (title, lines, kind, opts) {
  var el = $('toast')
  if (!el) return
  var body = asArray(lines).filter(Boolean)
  var actions = (opts && opts.text)
    ? '<div class="toast-actions"><button type="button" class="btn toast-copy">' + esc(opts.label || '复制') + '</button></div>'
    : ''
  el.innerHTML = '<div class="toast-title">' + esc(title) + '</div>' +
    (body.length ? '<ul>' + body.map(function (l) { return '<li>' + esc(l) + '</li>' }).join('') + '</ul>' : '') +
    actions
  if (opts && opts.text) {
    var btn = el.querySelector('.toast-copy')
    if (btn) {
      btn.addEventListener('click', function () {
        copyText(opts.text).then(function (ok) {
          btn.textContent = ok ? '已复制提交信息' : '复制失败（请手动选中）'
          showStatus(ok ? '提交信息已复制到剪贴板：' + (opts.title || '') : '复制失败，请手动选中摘要文本', ok ? 'ok' : 'warn', true)
        })
      })
    }
  }
  el.className = 'toast ' + (kind || 'ok')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(function () { el.className = 'toast hidden' }, (opts && opts.text) ? 20000 : (kind === 'error' ? 9000 : 6200))
}

/** 把文本复制到剪贴板（优先 Clipboard API，退回临时 textarea） */
function copyText (text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true }).catch(function () { return fallbackCopy(text) })
  }
  return Promise.resolve(fallbackCopy(text))
}

function fallbackCopy (text) {
  try {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', 'readonly')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    var ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) {
    return false
  }
}

/**
 * 模型「形状」快照：保存前后各取一次，用来算改动摘要。
 * 只数条数，不比对内容 —— 目的是告诉用户「这次动了什么」，不是逐字 diff。
 * @param {object} m 编辑器模型
 */
function snapshotShape (m) {
  var v2 = (m && m.v2) || {}
  var count = function (list, fn) {
    var n = 0
    asArray(list).forEach(function (r) { n += fn(r) ? 1 : 0 })
    return n
  }
  return {
    weapons: count(v2.weapons, function (r) { return asArray(r.items).length > 0 }),
    weaponItems: asArray(v2.weapons).reduce(function (n, r) { return n + asArray(r.items).length }, 0),
    artifacts: count(v2.artifacts, function () { return true }),
    teams: count(v2.teams, function () { return true }),
    members: asArray(v2.teams).reduce(function (n, r) { return n + asArray(r.members).length }, 0),
    talents: count(v2.talents, function () { return true }),
    panels: count(v2.panels, function () { return true }),
    constellations: count(v2.constellations, function () { return true }),
    meta: ['建议等级', '定位', '100级提升'].filter(function (k) { return hasText(m && m.meta && m.meta[k]) }).length
  }
}

var SHAPE_LABELS = {
  weapons: '武器行', weaponItems: '武器条目', artifacts: '圣遗物行', teams: '配队行',
  members: '配队成员', talents: '天赋行', panels: '面板行', constellations: '命座行', meta: '已填基本信息'
}

/** 两个形状快照 → 人类可读的改动摘要（没变化就返回空数组） */
function diffSummary (before, after) {
  if (!before || !after) return []
  var out = []
  Object.keys(SHAPE_LABELS).forEach(function (k) {
    var d = (after[k] || 0) - (before[k] || 0)
    if (d) out.push(SHAPE_LABELS[k] + ' ' + (d > 0 ? '+' : '') + d + '（' + before[k] + ' → ' + after[k] + '）')
  })
  return out
}

function markDirty (on) {
  state.dirty = !!on
  $('dirty').className = state.dirty ? 'dirty' : 'dirty hidden'
  // 改动后刷新实时预览（预览面板没开时是空操作）
  if (state.dirty) renderPreviewSoon()
}

/* ============================================================ 弹窗 */

function modal (opts) {
  return new Promise(function (resolve) {
    var mask = document.createElement('div')
    mask.className = 'modal-mask'
    var inputHtml = opts.input ? '<input id="modal-input" type="text" value="' + esc(opts.value || '') + '" placeholder="' + esc(opts.placeholder || '') + '">' : ''
    mask.innerHTML = '<div class="modal" role="dialog">' +
      '<h3>' + esc(opts.title || '') + '</h3>' +
      (opts.message ? '<p>' + esc(opts.message) + '</p>' : '') +
      inputHtml +
      '<div class="modal-foot">' +
      '<button type="button" class="btn" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>' +
      '<button type="button" class="btn ' + (opts.danger ? 'danger' : 'primary') + '" data-act="ok">' + esc(opts.okText || '确定') + '</button>' +
      '</div></div>'
    document.body.appendChild(mask)
    var input = mask.querySelector('#modal-input')
    function done (value) {
      document.body.removeChild(mask)
      document.removeEventListener('keydown', onKey, true)
      resolve(value)
    }
    function ok () { done(opts.input ? (input.value.trim() || null) : true) }
    function onKey (e) {
      if (e.key === 'Escape') { e.preventDefault(); done(null) }
      else if (e.key === 'Enter' && opts.input) { e.preventDefault(); ok() }
    }
    mask.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act')
      if (act === 'ok') ok()
      else if (act === 'cancel' || e.target === mask) done(null)
    })
    document.addEventListener('keydown', onKey, true)
    if (input) { input.focus(); input.select() }
  })
}

/* ============================================================ 渲染：类型徽标 */

/**
 * 类型徽标 + 带 datalist 的输入 + ⚠ 提示 + 「从名称库选」
 *
 * ⚠ 名字里**不能含 `/`、`／`、`｜`**：这些是文档里的条目分隔符，写回文档后再解析会被
 * 切成两条（`88爆伤/44暴击武器` → `88爆伤` + `44暴击武器`），往返立刻不一致 —— 所以这里打警告。
 */
function refField (kind, value, path) {
  var k = REF_KINDS[kind]
  var ref = kind + ':' + str(value).trim()
  var issue = state.issueMap[ref]
  var name = str(value).trim()
  var sepHit = /[/／｜]/.test(name)
    ? '<span class="warn-chip" title="名字里有 `/`（文档的条目分隔符）：写回文档后再解析会被切成两条，往返不一致 —— 请改成两条独立条目，或换个写法">⚠ 含分隔符</span>'
    : ''
  var warn = (issue
    ? '<span class="warn-chip" title="' + esc(issue) + '">⚠</span>'
    : '') + sepHit
  return '<span class="ref-wrap">' +
    '<span class="ref-field">' +
    '<span class="badge ' + kind + '" title="' + esc(k.text) + '"><span class="badge-icon">' + k.icon + '</span>' + esc(k.text) + '</span>' +
    '<input type="text" list="' + k.list + '" value="' + esc(value) + '" data-path="' + esc(path) + '" data-ref-kind="' + kind + '">' +
    '</span>' + warn +
    '<button type="button" class="pick-btn" data-pick="' + kind + '" data-path="' + esc(path) + '" title="从名称库选（可搜索 / 拼音首字母）">▾</button>' +
    '</span>'
}

/**
 * 天赋三格用不到下拉了（A/E/Q 固定），保留这个注释位说明字段形态：
 * 每格 = { name:'A'|'E'|'Q', level:'1'..'10', crown:boolean }
 */

/** 命座名输入（自动推导 index，显示为徽标 + 输入） */
function constellationField (value, path) {
  var idx = constellationIndex(value)
  var bad = hasText(value) && !idx
  return '<span class="ref-wrap">' +
    '<span class="ref-field">' +
    '<span class="badge constellation" title="命座"><span class="badge-icon">◈</span>命座</span>' +
    '<input type="text" value="' + esc(value) + '" data-path="' + esc(path) + '" data-ref-kind="constellation" placeholder="如 二命 / 6命">' +
    '</span>' +
    (bad ? '<span class="warn-chip bad-name" title="认不出命座序号，请用「一命」…「六命」或「1命」…「6命」">⚠</span>' : '') +
    '</span>'
}

/** 命座名 → 序号（一命=1 … 六命=6） */
function constellationIndex (name) {
  var s = str(name)
  var cn = s.match(/^([一二三四五六])命/)
  if (cn) return { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }[cn[1]]
  var n = s.match(/(\d+)\s*命/)
  return n ? Number(n[1]) : 0
}

/** 行级高亮标记：搜索命中 / 批量替换后可以用来闪烁定位 */
function rowAttr (rowId) {
  return rowId ? ' data-rowid="' + esc(rowId) + '"' : ''
}

/* ============================================================ 渲染：小控件 */

function input (label, path, value, cls, placeholder) {
  return '<label class="field"><span>' + esc(label) + '</span>' +
    '<input type="text" class="' + (cls || '') + '" data-path="' + esc(path) + '" value="' + esc(value) + '"' +
    (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + '></label>'
}

function plainInput (path, value, cls, placeholder, datalist) {
  return '<input type="text" class="' + (cls || '') + '" data-path="' + esc(path) + '" value="' + esc(value) + '"' +
    (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') +
    (datalist ? ' list="' + datalist + '"' : '') + '>'
}

function selectBox (path, value, options, cls) {
  var opts = options.map(function (o) {
    var v = o.value === null || o.value === undefined ? '' : String(o.value)
    return '<option value="' + esc(v) + '"' + (v === String(value) ? ' selected' : '') + '>' + esc(o.label) + '</option>'
  }).join('')
  return '<select class="' + (cls || '') + '" data-path="' + esc(path) + '">' + opts + '</select>'
}

/* 档位标签统一用上面那份 tierLabel（1/2/3 → 推荐/可选/过渡），这里不再重复定义 */

/** 结构按钮：data-act + data-path + data-i 由事件委托处理 */
function actBtn (act, path, text, cls, title, index) {
  return '<button type="button" class="' + (cls || 'btn mini') + '" data-act="' + act + '" data-path="' + esc(path) + '"' +
    (index === undefined ? '' : ' data-i="' + index + '"') +
    (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</button>'
}

/**
 * 一行是否「有内容」——与服务器 normalizeV2 里的 isEmptyRow 对应。
 * 仓库里有 16 行「主词条」是整行留空的占位（Word 转换产物），表单不显示它们，
 * 但保存时会原样带回，避免「打开再保存」就把占位行删掉。
 */
function rowVisible (row) {
  if (!row || typeof row !== 'object') return false
  // 墓碑（点了「删除行」）：位置留着不挪（保存时按下标与原文件对齐），但表单里不渲染。
  if (row.__deleted === true) return false
  // 刚点「＋ 新增一行」加出来的行**必须可见** —— 否则它在表单里根本不渲染，
  // 用户就会遇到「加了配队行却没法选角色 / 加了面板行却没法填」（用户报过）。
  // `_new` 只是界面上的临时标记，落盘前会被 buildBody 丢掉。
  if (row._new) return true
  switch (row.kind) {
    case 'main':
      return MAIN_SLOTS.some(function (slot) { return asArray(row.stats && row.stats[slot]).length > 0 }) || hasText(row.note)
    case 'sub':
      return asArray(row.stats).length > 0
    case 'note':
      return hasText(row.text)
    case 'text':
      return hasText(row.text) || hasText(row.label)
    case 'priority':
      return asArray(row.slots).length > 0 || asArray(row.order).length > 0
    case 'crown':
      return asArray(row.items).length > 0
    default:
      break
  }
  if (asArray(row.items).length || asArray(row.sets).length) return true
  return hasText(row.label) || hasText(row.k) || hasText(row.v) || hasText(row.text) || hasText(row.name)
}

/** 渲染某类行时用的可见行（保留原始下标） */
function visibleRows (list) {
  var out = []
  for (var i = 0; i < list.length; i++) if (rowVisible(list[i])) out.push({ i: i, row: list[i] })
  return out
}

/** 隐藏的占位行提示 */
function hiddenNote (list) {
  var hidden = 0
  for (var i = 0; i < list.length; i++) if (!rowVisible(list[i]) && !(list[i] && list[i].__deleted === true)) hidden++
  if (hidden <= 0) return ''
  return '<div class="muted" style="font-size:12px;margin:6px 0 0">已隐藏 ' + hidden + ' 个空占位行（旧数据里的待填行，保存时原样保留；点「删除行」可清掉）</div>'
}

/**
 * 已删除的行提示（墓碑）+ 撤销。
 *
 * 删除**不缩短数组**、只在原位放 `{__deleted:true}`：这样后面各行与原文件始终逐下标对齐，
 * 保存时服务器才能既做字段级保留、又真的把这一行删掉（以前按位置补齐 → 删了又回来，
 * 用户报的「预览与实际修改不符」）。
 */
function deletedNote (path, list) {
  var idx = []
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].__deleted === true) idx.push(i)
  if (!idx.length) return ''
  return '<div class="deleted-note">已删除 ' + idx.length + ' 行（保存后消失）：' +
    idx.map(function (i) {
      return '<button type="button" class="btn mini" data-act="undelete-row" data-path="' + esc(path) + '" data-i="' + i + '" title="把这一行恢复回来">撤销第 ' + (i + 1) + ' 行</button>'
    }).join(' ') + '</div>'
}

/** 行列表：rows → html 拼接 + 尾部「新增一行」按钮
 *  renderRow(row, i, path, rowId) —— rowId 用于搜索结果高亮定位 */
function rowList (path, rows, renderRow, addLabel) {
  var visible = visibleRows(rows)
  var html = visible.map(function (v) { return renderRow(v.row, v.i, path + '.' + v.i, path + '.' + v.i) }).join('')
  var body = visible.length ? html : emptyNote('还没有' + addLabel + '，点下面的按钮新增')
  return '<div class="row-list">' + body + '</div>' +
    '<div style="margin-top:8px">' + actBtn('add-row', path, '＋ ' + addLabel, 'btn mini') + '</div>' + deletedNote(path, rows) + hiddenNote(rows)
}

function emptyNote (text) {
  return '<div class="muted" style="padding:6px 2px;font-size:13px">' + esc(text) + '</div>'
}

/**
 * 多值输入：**可编辑**的 chips + 「＋」+ 每格一个「▾」候选选择器。
 *
 * 用户报过的问题：以前 chips 只是纯文本，点「＋」加进来一个空 chip **根本没法填 / 没法选**。
 * 现在每个 chip 是一个输入框：
 *   · 直接打字（`data-path` 走通用 input 事件写模型，不重绘 → 不丢焦点）；
 *   · 或者点「▾」从候选表里选（主词条按槽位给候选、副词条给大/小前缀那套）；
 *   · `list=` 让输入框自带浏览器下拉（开始打字就会提示）。
 * @param {string} label
 * @param {string} path
 * @param {string[]} values
 * @param {string} [placeholder]
 * @param {string} [statKind] 候选类别：时之沙 / 空之杯 / 理之冠 / 副词条（缺省不给候选）
 */
function multiValue (label, path, values, placeholder, statKind) {
  var listId = STAT_LIST_ID[statKind] || ''
  var chips = asArray(values).map(function (v, i) {
    return '<span class="mv-chip">' +
      '<input type="text" class="mv-in" data-path="' + esc(path + '.' + i) + '" value="' + esc(v) + '"' +
      (listId ? ' list="' + esc(listId) + '"' : '') +
      ' placeholder="' + esc(placeholder || '词条') + '">' +
      (listId ? actBtn('pick-item', path, '▾', 'mv-pick', '从候选里选', i) : '') +
      actBtn('del-item', path, '×', 'row-del', '删除这一项', i) +
      '</span>'
  }).join('')
  return '<div class="field"><span>' + esc(label) + '</span>' +
    '<div class="mv">' + chips + actBtn('add-item', path, '＋', 'mv-add', '添加一项') + '</div>' +
    (placeholder && !asArray(values).length ? '<span class="muted" style="font-size:12px">' + esc(placeholder) + '</span>' : '') +
    '</div>'
}

/* ============================================================ 渲染：各区块 */

function renderBasic () {
  var m = state.model
  var raw = m._raw || {}
  var notes = []
  if (hasText(raw.highlight)) notes.push('原文件有 highlight（' + raw.highlight + '），保存时原样保留（编辑器不改这一项）')
  if (m.unparsed) notes.push('原文件有 unparsed 未识别行，保存时原样保留')

  var body = '<div class="grid-3">' +
    input('建议等级', 'meta.建议等级', m.meta['建议等级'], '', '如 90级') +
    input('定位', 'meta.定位', m.meta['定位'], '', '如 站场主C') +
    input('100级提升', 'meta.100级提升', m.meta['100级提升'], '', '如 约 7.6%') +
    '</div>'

  if (m.legacy) {
    body += '<div class="alert" style="margin-top:10px">这是旧版数据（只有 sections 文本行、没有 v2 结构化字段）。' +
      '保存时会升级成 v2：tags / sections 由结构化字段重新生成，原来的文本行不会自动搬过来。' +
      '要保留旧内容，请先备份该文件。</div>'
  }

  if (notes.length) {
    body += '<div class="alert" style="margin-top:10px;margin-bottom:0">' + esc(notes.join('；')) + '</div>'
  }
  return card('基本信息', '', body, true)
}

function renderWeapons () {
  var s = state.model.v2
  var body = rowList('v2.weapons', s.weapons, function (row, i, p, rowId) {
    var items = row.items.map(function (it, j) {
      var q = p + '.items.' + j
      var prev = j > 0 ? row.items[j - 1] : null
      return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        refField('weapon', it.name, q + '.name') +
        '<input type="text" class="w-sm" data-path="' + q + '.note" value="' + esc(it.note) + '" placeholder="备注（如 精5）">' +
        (prev ? actBtn('copy-prev', q + '.name', '⧉ 上一条', 'btn mini', '复制上一条的武器名' + (prev.name ? '（' + prev.name + '）' : '')) : '') +
        actBtn('del-item', p + '.items', '×', 'row-del', '删除这个条目', j) +
        '</div>'
    }).join('')
    return '<div class="box"' + rowAttr(rowId) + '>' +
      '<div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="自定义标签（可空，如 建议 / 辅助向）" title="' + esc(LABEL_TIP) + '">' +
      selectBox(p + '.tier', row.tier === null ? '' : row.tier, [{ value: '', label: '档位：不标' }].concat(TIERS.map(function (t) { return { value: t, label: tierLabel(t) } })), 'w-sm') +
      (Number(row.tier) > 3 ? '<span class="warn-chip" title="数据里出现了第 ' + row.tier + ' 档：面板 / 网页版只认 1~3 档（推荐 / 可选 / 过渡），请确认是否该并档">⚠ 第 ' + row.tier + ' 档</span>' : '') +
      resolvedHint(row) +
      '<span class="spacer"></span>' +
      actBtn('move-row-up', 'v2.weapons', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.weapons', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.weapons', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>' +
      '<div class="sub-list">' + (items || '<div class="muted" style="font-size:12px">还没有条目</div>') + '</div>' +
      '<div style="margin-top:6px">' + actBtn('add-item', p + '.items', '＋ 条目', 'btn mini') + '</div>' +
      '</div>'
  }, '武器行')
  return card('武器推荐', s.weapons.length + ' 行', body, true)
}

function renderArtifacts () {
  var s = state.model.v2
  var body = rowList('v2.artifacts', s.artifacts, function (row, i, p, rowId) {
    var head = '<div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      selectBox(p + '.kind', row.kind, ARTIFACT_KINDS, 'w-sm') +
      (row.kind === 'main' ? '' : '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="自定义标签（可空，如 输出向 / 建议）" title="' + esc(LABEL_TIP) + '">' +
        resolvedHint(row, artifactKindWord(row.kind))) +
      '<span class="spacer"></span>' +
      actBtn('move-row-up', 'v2.artifacts', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.artifacts', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.artifacts', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>'

    var body2 = ''
    if (row.kind === 'main') {
      // 三个槽位是**并列**关系（槽内候选用 `/`）；这里实时显示当前渲染形态：
      // `时之沙：… ｜ 空之杯：… ｜ 理之冠：…`（副词条另有一套：`/` = 同级 → 显示 `=`、`>` = 优先级 → 显示 `＞`）
      var nowLine = MAIN_SLOTS
        .filter(function (slot) { return asArray(row.stats && row.stats[slot]).length })
        .map(function (slot) { return slot + '：' + asArray(row.stats[slot]).map(function (x) { return str(x).trim() }).filter(Boolean).join(' / ') })
        .join(' ｜ ')
      body2 = '<div class="muted main-hint">三个槽位是<strong>并列</strong>关系（槽内候选用 <code>/</code>，槽位之间渲染成 <code>｜</code>）。' +
        '副词条另有口径：<strong>只有 暴击率 ↔ 暴击伤害 是同级</strong>（源文档写 <code>/</code> → 渲染 <code>=</code>），' +
        '其余相邻词条一律<strong>优先级</strong>（写 <code>&gt;</code> → 渲染 <code>＞</code>）；固定术语 <code>双爆</code> 恒等于 <code>暴击率=暴击伤害</code>。' +
        (nowLine ? '<br>当前渲染：<code>主词条：' + esc(nowLine) + '</code>' : '<br>当前渲染：<code>（空，' + EMPTY_TEXT + '）</code>') +
        '</div>' +
        '<div class="grid-3">' + MAIN_SLOTS.map(function (slot) {
          return multiValue(slot, p + '.stats.' + slot, row.stats[slot], '如 ' + (STAT_CANDIDATES[slot] || [])[0], slot)
        }).join('') + '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">' +
        '<span class="muted" style="font-size:12px">主词条括注</span>' +
        '<input type="text" class="w-sm" data-path="' + p + '.note" value="' + esc(row.note) + '" placeholder="可空，如 二命">' +
        selectBox(p + '.noteSlot', row.noteSlot, [{ value: '', label: '挂在哪个部位？' }].concat(MAIN_SLOTS.map(function (s) { return { value: s, label: '挂在 ' + s } })), 'w-sm') +
        '<span class="muted" style="font-size:12px">对某个部位的**补充说明**才写这里（整行就是说明时不必写「注：」）</span>' +
        '</div>'
    } else if (row.kind === 'sub') {
      body2 = multiValue('副词条（**只有 暴击率↔暴击伤害 是同级**（写 `/` → 渲染 `=`），其余一律用 `>`（渲染 `＞`）；百分比写 `大生命`/`大攻击`/`大防御`，固定值写 `小生命`/`小攻击`/`小防御`）', p + '.stats', row.stats, '如 双爆 / 大攻击', '副词条')
    } else if (row.kind === 'note') {
      body2 = '<div class="field"><span>备注（注：）</span>' +
        '<input type="text" data-path="' + p + '.text" value="' + esc(row.text) + '" placeholder="该段落末尾的一行「注：…」，多条用「；」分隔">' +
        '<div class="muted" style="font-size:12px">渲染在该段正文最后一行之后；与其它同段备注合并成一行</div></div>'
    } else if (row.kind === 'text') {
      body2 = '<div class="field"><span>文本</span>' +
        '<textarea data-path="' + p + '.text" placeholder="自由文本，会原样出现在旧版输出里">' + esc(row.text) + '</textarea></div>'
    } else {
      var sets = (row.sets || []).map(function (set, j) {
        var q = p + '.sets.' + j
        var prev = j > 0 ? row.sets[j - 1] : null
        // 件数（`（2件套）`）**不再显示、也不再提供输入**（用户定稿：圣遗物旁边不要件数；
        // 2+2 直接写 `2精通 + 2精通` 这类简写）。旧数据里的 `pieces` 保存时原样带回，不丢。
        return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          refField('artifact', set.name, q + '.name') +
          (prev ? actBtn('copy-prev', q + '.name', '⧉ 上一条', 'btn mini', '复制上一条的套装名' + (prev.name ? '（' + prev.name + '）' : '')) : '') +
          actBtn('del-item', p + '.sets', '×', 'row-del', '删除这个套装', j) +
          '</div>'
      }).join('')
      body2 = '<div class="sub-list">' + (sets || '<div class="muted" style="font-size:12px">还没有套装</div>') + '</div>' +
        '<div style="margin-top:6px">' + actBtn('add-item', p + '.sets', '＋ 套装', 'btn mini') + '</div>'
    }
    return '<div class="box"' + rowAttr(rowId) + '>' + head + body2 + '</div>'
  }, '圣遗物行')
  return card('圣遗物推荐', s.artifacts.length + ' 行', body, true)
}

function renderTalents () {
  var s = state.model.v2
  var priorities = visibleRows(s.talents).filter(function (e) { return e.row.kind === 'priority' })
  // 数据里没有天赋行时，界面仍然给一行空的三格（有地方填），保存时空行不落盘
  if (!priorities.length) {
    s.talents = foldCrownRows(s.talents)
    priorities = visibleRows(s.talents).filter(function (e) { return e.row.kind === 'priority' })
  }
  var p0 = priorities.length ? 'v2.talents.' + priorities[0].i : ''
  var slots = talentSlots(s.talents)
  var slotHtml = slots.map(function (sl, j) {
    var q = p0 + '.slots.' + j
    return '<div class="talent-slot' + (sl.crown ? ' crowned' : '') + '"' + (sl.extra ? ' title="A/E/Q 之外的旧字母，保存时原样保留"' : '') + '>' +
      '<span class="ts-name" data-ref-kind="talent" data-path="' + esc(q + '.name') + '">' + esc(sl.name) + '</span>' +
      '<input class="ts-level" type="number" inputmode="numeric" min="1" max="10" step="1" value="' + esc(sl.level) + '"' +
      ' data-path="' + esc(q + '.level') + '" data-level="1" title="等级 1–10（10 = 皇冠；留空按 1）">' +
      '<button type="button" class="ts-crown" data-act="toggle-crown" data-path="' + esc(p0) + '" data-i="' + j + '"' +
      ' title="皇冠：点上 = 已投皇冠（等级 10）">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 4.4l2.9 2.1L8 2.6l3.5 3.9 2.9-2.1-1.3 8.1H2.9z" fill="currentColor"/>' +
      '<rect x="2.9" y="12.9" width="10.2" height="1.7" rx="0.85" fill="currentColor"/></svg></button>' +
      '</div>'
  }).join('')
  var rawHint = hasText(s.talents.filter(function (r) { return r.kind === 'priority' })[0] &&
    s.talents.filter(function (r) { return r.kind === 'priority' })[0].raw)
    ? '<span class="muted" style="font-size:12px">文档里的写法：' +
      esc(s.talents.filter(function (r) { return r.kind === 'priority' })[0].raw) + '</span>'
    : ''
  var body = '<div style="font-size:12px;color:var(--text-soft);margin-bottom:6px">天赋等级（固定 A → E → Q）</div>' +
    '<div class="box"' + rowAttr(p0) + '><div class="box-head">' +
    '<span class="box-title">A / E / Q</span>' + rawHint + '<span class="spacer"></span>' +
    '<span class="muted" style="font-size:12px">数字 = 等级（1–10，留空按 1）· 点皇冠 = 10</span>' +
    '</div><div class="talent-slots">' + slotHtml + '</div></div>'
  return card('天赋加点', s.talents.length + ' 行', body, true)
}

function renderPanels () {
  var s = state.model.v2
  var body = rowList('v2.panels', s.panels, function (row, i, p, rowId) {
    var isText = !hasText(row.k)
    // 面板是「键：值」结构：**只填一半保存时会被丢掉**，必须当场说清楚（曾经是静默丢弃）
    var warn = ''
    if (!isText && !hasText(row.v)) warn = '<span class="warn-chip" title="面板行是「键：值」结构，只有键没有值时写不出合法文档行，保存时会丢掉这一行">⚠ 缺值 v</span>'
    if (isText && hasText(row.v)) warn = '<span class="warn-chip" title="只有「值」没有「键」时文档行没有冒号、解析不回来，保存时会丢掉这一行；要么补上键，要么用「改成纯文本」">⚠ 缺键 k</span>'
    var head = '<div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="标签（可空，如 辅助向）">' +
      warn +
      '<span class="spacer"></span>' +
      actBtn('panel-to-text', p, isText ? '改成 键+值' : '改成纯文本', 'btn mini') +
      actBtn('move-row-up', 'v2.panels', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.panels', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.panels', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>'
    var body2 = isText
      ? '<input type="text" data-path="' + p + '.text" value="' + esc(row.text) + '" placeholder="纯文本（说明行，如 暴击率70% / 暴伤220%+）">'
      : '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<label class="field" style="flex:0 0 220px"><span>键 k</span>' + plainInput(p + '.k', row.k, '', '如 暴击率') + '</label>' +
        '<label class="field" style="flex:1 1 260px"><span>值 v</span>' + plainInput(p + '.v', row.v, '', '如 70%+') + '</label>' +
        '</div>'
    return '<div class="box"' + rowAttr(rowId) + '>' + head + body2 + '</div>'
  }, '面板行')
  return card('毕业面板参考', s.panels.length + ' 行', body, true)
}

function renderConstellations () {
  var s = state.model.v2
  var body = rowList('v2.constellations', s.constellations, function (row, i, p, rowId) {
    var idx = constellationIndex(row.name)
    // 命座名是必填（它决定 `命之座N` 与命座图标）：只有说明时文档行写成 `——说明`，解析不回来
    var nameWarn = hasText(row.name) ? '' : '<span class="warn-chip" title="命座名必填（决定「命之座N」与命座图标）；只填说明保存时会被丢掉">⚠ 缺命座名</span>'
    return '<div class="box"' + rowAttr(rowId) + '><div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      constellationField(row.name, p + '.name') +
      (idx ? '<span class="muted" style="font-size:12px">序号 ' + idx + '</span>' : '') +
      nameWarn +
      '<span class="spacer"></span>' +
      actBtn('move-row-up', 'v2.constellations', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.constellations', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.constellations', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>' +
      '<input type="text" data-path="' + p + '.text" value="' + esc(row.text) + '" placeholder="说明">' +
      '</div>'
  }, '命座行')
  return card('命座推荐', s.constellations.length + ' 行', body, true)
}

function renderTeams () {
  var s = state.model.v2
  var body = rowList('v2.teams', s.teams, function (row, i, p, rowId) {
    // 段末备注行（整行就是备注）：只显示文本输入，不做成员编辑
    if (row.kind === 'note') {
      return '<div class="box"' + rowAttr(rowId) + '><div class="box-head">' +
        '<span class="box-title">行 ' + (i + 1) + ' · 备注</span>' +
        '<span class="muted" style="font-size:12px">整行备注（写作 `注：…`，渲染时不加前缀）</span>' +
        '<span class="spacer"></span>' +
        actBtn('move-row-up', 'v2.teams', '↑', 'btn mini', '上移', i) +
        actBtn('move-row-down', 'v2.teams', '↓', 'btn mini', '下移', i) +
        actBtn('del-row', 'v2.teams', '删除行', 'btn mini danger', '删除这一行', i) +
        '</div><div class="field"><span>备注文本</span>' +
        '<input type="text" data-path="' + p + '.text" value="' + esc(str(row.text)) + '" placeholder="如 建议二命及以上"></div></div>'
    }
    var members = asArray(row.members).map(function (m, j) {
      var q = p + '.members.' + j
      var cands = memberCandidates(m.name)
      var multi = cands.length > 1
      // 一格里的可替换项显示成 `A / B`（斜杠不加中文标注）；名字那一行可点开候选选择器
      var nameHtml = cands.map(function (n, k) {
        return (k ? '<span class="cand-sep"> / </span>' : '') +
          '<span class="cand' + (k ? ' cand-alt' : '') + '" title="' + (k ? '可替换项' : '主选') + '">' + esc(n) + '</span>'
      }).join('')
      return '<span class="member' + (multi ? ' multi' : '') + '" draggable="true" data-m="' + j + '" title="点名字选择候选（可加可替换项）；左右拖动可排序">' +
        '<span class="pk-av">' + esc(cands[0] ? cands[0].slice(0, 1) : '') + '</span>' +
        '<button type="button" class="member-name" data-act="open-candidates" data-path="' + esc(q) + '">' + (nameHtml || '（未填）') + '</button>' +
        (multi ? '<span class="cand-tag" title="这一格有 ' + cands.length + ' 个候选（同一格二选一）">' + cands.length + ' 选</span>' : '') +
        '<input type="text" class="member-note" data-path="' + q + '.note" value="' + esc(m.note || '') + '" placeholder="备注" title="括注备注（如 二命 / 高金），输出为「名称（备注）」">' +
        actBtn('del-item', p + '.members', '×', 'row-del', '移除这一格', j) + '</span>'
    }).join('')
    return '<div class="box"' + rowAttr(rowId) + '><div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="标签（如 首选）" title="界面按显示层显示：首选 → 推荐、其他 → 可选（只改显示，不改数据）">' + labelHint(row.label) +
      '<span class="spacer"></span>' +
      actBtn('move-row-up', 'v2.teams', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.teams', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.teams', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>' +
      '<div class="field"><span>成员（点「＋ 成员」：**一格可以放多个名字** = 可替换角色，格内用 <b> / </b> 连接；' +
      '点某一格把它设为当前格，下一个名字就加进这一格；点名字可只改这一格的候选；拖动可排序）</span>' +
      '<div class="members" data-members="' + esc(p) + '">' + members +
      '<button type="button" class="btn mini" data-act="open-members" data-path="' + esc(p) + '">＋ 成员</button></div></div>' +
      '<div class="field" style="margin-top:8px"><span>文本' + (asArray(row.members).length ? '（成员之外的补充说明）' : '（没有拆成成员时，整行按文本输出）') + '</span>' +
      '<input type="text" data-path="' + p + '.text" value="' + esc(row.text) + '" placeholder="如 自由选择"></div>' +
      '</div>'
  }, '配队行')
  return card('配队推荐', s.teams.length + ' 行', body, true)
}

function renderUnparsed () {
  var un = state.model.unparsed
  if (!un) return ''
  var keys = Object.keys(un)
  if (!keys.length) return ''
  var body = '<div class="alert">这些行是 Word 转换时没识别的，编辑器只读；它们会在旧版输出（guide.html / guide.md / 插件）里原样保留。</div>' +
    keys.map(function (k) {
      var lines = asArray(un[k])
      return '<div class="unparsed-group"><h4>' + esc(k) + '（' + lines.length + ' 行）</h4><ul>' +
        lines.map(function (l) { return '<li>' + esc(l) + '</li>' }).join('') + '</ul></div>'
    }).join('')
  return card('未识别行', keys.length + ' 组', body, false, true)
}

/** 只渲染「配队推荐」这一块（界面自检 / 手工调试用，方便检查成员选择器的 DOM） */
function renderTeamsHtml () {
  return state.model ? renderTeams() : ''
}

function card (title, count, body, open, readonly) {
  // 空模块在标题旁显示「暂无」灰字提示（与面板 / 网页版的占位一致）
  var isEmpty = /^0(\s|行|$)/.test(String(count || ''))
  return '<details class="card"' + (open ? ' open' : '') + '>' +
    '<summary>' + esc(title) +
    '<span class="spacer"></span>' +
    (isEmpty ? '<span class="count empty">' + EMPTY_TEXT + '</span>' : (count ? '<span class="count">' + esc(count) + '</span>' : '')) +
    (readonly ? '<span class="count">只读</span>' : '') +
    '</summary><div class="card-body">' + body + '</div></details>'
}

/* ============================================================ 整体渲染 */

function renderIssueBar () {
  var el = $('status')
  if (!state.current) return
  if (state.issues && state.issues.length) {
    var parts = state.issues.slice(0, 6).map(function (i) { return i.where + '：' + i.ref + ' — ' + i.reason })
    var more = state.issues.length > 6 ? '（共 ' + state.issues.length + ' 条）' : ''
    showStatus('⚠ 名称校验：' + parts.join('；') + more, 'warn', true)
  } else {
    hideStatus()
  }
}

function renderForm () {
  if (!state.model) return
  $('empty').className = 'empty hidden'
  var form = $('form')
  form.className = 'form'
  form.innerHTML = renderBasic() + renderWeapons() + renderArtifacts() + renderTalents() +
    renderPanels() + renderConstellations() + renderTeams() + renderUnparsed()
  $('current-name').textContent = state.current + (state.model.name !== state.current ? '（文件内 name：' + state.model.name + '）' : '')
  renderIssueBar()
  if (state.pendingFocus) {
    var rowId = state.pendingFocus
    state.pendingFocus = null
    focusRow(rowId)
  }
}

/**
 * 高亮 + 滚动到某一行（全局搜索 / 批量替换后跳转用）
 * @param {string} rowId 形如 v2.weapons.2
 */
function focusRow (rowId) {
  var el = document.querySelector('#form [data-rowid="' + attrSelectorValue(rowId) + '"]')
  if (!el) return false
  try {
    var details = el.closest ? el.closest('details') : null
    if (details) details.open = true
  } catch (e) { /* 忽略 */ }
  el.classList.add('hl')
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  setTimeout(function () { el.classList.remove('hl') }, 3600)
  return true
}

function renderList () {
  var box = $('list')
  var kw = state.filter.trim().toLowerCase()
  var items = state.items.filter(function (it) { return !kw || it.name.toLowerCase().indexOf(kw) >= 0 })
  if (!items.length) {
    box.innerHTML = '<div class="muted" style="padding:8px;font-size:13px">没有匹配的角色</div>'
    return
  }
  box.innerHTML = items.map(function (it) {
    var meta = []
    if (it.weapons) meta.push('武' + it.weapons)
    if (it.artifacts) meta.push('圣' + it.artifacts)
    if (it.hasUnparsed) meta.push('<span class="un">未识别</span>')
    return '<div class="list-item' + (it.name === state.current ? ' active' : '') + '" data-name="' + esc(it.name) + '">' +
      '<span class="nm" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
      '<span class="meta">' + meta.join(' ') + '</span></div>'
  }).join('')
}

/** 当前列表里可见的角色名（键盘 ↑↓ 用） */
function visibleListNames () {
  var kw = state.filter.trim().toLowerCase()
  return state.items
    .filter(function (it) { return !kw || it.name.toLowerCase().indexOf(kw) >= 0 })
    .map(function (it) { return it.name })
}

/** 下拉候选 */
function renderDatalists () {
  var fill = function (id, list) {
    var el = $(id)
    // 页面可能是**旧缓存**（index.html 里还没有新加的 datalist）→ 取不到就跳过，
    // 绝不因为少一个候选项就把整个 init 抛异常（那会连带心跳都不发、服务 20s 后自杀）
    if (!el) return
    el.innerHTML = asArray(list).map(function (n) { return '<option value="' + esc(n) + '"></option>' }).join('')
  }
  fill('dl-weapon', state.index.weapons)
  fill('dl-artifact', state.index.artifacts)
  fill('dl-character', state.index.characters)
  // 主词条 / 副词条候选（多值输入框的 list=）
  Object.keys(STAT_LIST_ID).forEach(function (kind) { fill(STAT_LIST_ID[kind], STAT_CANDIDATES[kind]) })
}

/* ============================================================ 全局搜索 */

var G_TYPE_LABEL = { weapon: '武器', artifact: '圣遗物', character: '角色', talent: '天赋', constellation: '命座' }
var gTimer = null
var gLast = { names: [], text: [], q: '' }

function globalSearchNow () {
  var q = $('gsearch').value.trim()
  if (!q) { showGResults(''); return }
  showGResults('<div class="muted" style="padding:8px">搜索中…</div>')
  api('GET', '/api/search?q=' + encodeURIComponent(q)).then(function (data) {
    gLast = { names: asArray(data.names), text: asArray(data.text), q: q }
    renderGResults(data)
  }).catch(function (e) {
    showGResults('<div class="status error" style="padding:8px">搜索失败：' + esc(e.message) + '</div>')
  })
}

function showGResults (html) {
  var box = $('gresults')
  box.innerHTML = html
  box.className = 'gresults' + (html ? '' : ' hidden')
}

function renderGResults (data) {
  var names = asArray(data.names)
  var text = asArray(data.text)
  var html = '<div class="gr-head">' +
    '「' + esc(data.q) + '」：引用命中 <b>' + data.totalHits + '</b> 处 · 正文命中 <b>' + data.totalText + '</b> 行' +
    (data.fuzzy ? '（名称按包含匹配）' : '') +
    '<span class="spacer"></span><button type="button" class="btn mini" data-g="close">关闭</button></div>'

  if (!names.length && !text.length) {
    html += '<div class="muted" style="padding:10px">没有找到与「' + esc(data.q) + '」相关的内容</div>'
  }

  names.forEach(function (g, gi) {
    html += '<div class="gr-group">' +
      '<div class="gr-title"><span class="badge ' + g.type + '">' + esc(G_TYPE_LABEL[g.type] || g.type) + '</span>' +
      '<b>' + esc(g.name) + '</b><span class="muted">' + (g.total ? '被 ' + g.characters.length + ' 个角色用到 ' + g.total + ' 处' : '没有任何角色用到（未使用）') + '</span>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn mini" data-g="batch" data-gi="' + gi + '">批量替换…</button>' +
      '<button type="button" class="btn mini" data-g="usage" data-gi="' + gi + '">谁用了</button>' +
      '</div>'
    if (g.total) {
      html += '<ul class="gr-list">' + g.hits.map(function (h) {
        return '<li><a href="#" data-g="jump" data-name="' + esc(h.name) + '" data-row="' + esc(h.rowId) + '">' +
          esc(h.name) + '</a> <span class="muted">' + esc(h.section) + ' · ' + esc(h.line === undefined ? '' : '第 ' + h.line + ' 行') + '</span>' +
          '<span class="gr-text">' + esc(h.text) + '</span></li>'
      }).join('') + '</ul>'
    }
    html += '</div>'
  })

  if (text.length) {
    html += '<div class="gr-group"><div class="gr-title"><b>正文关键词</b><span class="muted">' + text.length + ' 行</span></div>' +
      '<ul class="gr-list">' + text.slice(0, 60).map(function (t) {
        return '<li><a href="#" data-g="jump" data-name="' + esc(t.name) + '" data-hit="' + esc(t.hitId) + '">' +
          esc(t.name) + '</a> <span class="muted">' + esc(t.title) + ' · 第 ' + t.line + ' 行</span>' +
          '<span class="gr-text">' + esc(t.text) + '</span></li>'
      }).join('') + '</ul></div>'
  }
  showGResults(html)
}

/** 搜索面板里点一个名字 → 打开「谁用了」详情 */
function showUsageDetail (type, name) {
  loadUsage().then(function () {
    var hits = []
    // 直接用搜索接口拿精确命中（比在客户端重算更省事）
    return api('GET', '/api/search?q=' + encodeURIComponent(name) + '&type=' + encodeURIComponent(type) + '&scope=name')
  }).then(function (data) {
    var groups = asArray(data.names)
    var html = '<div class="gr-head">「' + esc(name) + '」用在哪<span class="spacer"></span>' +
      '<button type="button" class="btn mini" data-g="close">关闭</button></div>'
    if (!groups.length || !groups[0].total) {
      html += '<div class="muted" style="padding:10px">没有被任何角色用到（未使用）</div>'
    } else {
      groups[0].hits.forEach(function (h) {
        html += '<div class="gr-row"><a href="#" data-g="jump" data-name="' + esc(h.name) + '" data-row="' + esc(h.rowId) + '">' +
          esc(h.name) + '</a> <span class="muted">' + esc(h.section) + ' · 第 ' + h.line + ' 行</span> <span class="gr-text">' + esc(h.text) + '</span></div>'
      })
    }
    showGResults(html)
  }).catch(function (e) { showGResults('<div class="status error" style="padding:8px">查询失败：' + esc(e.message) + '</div>') })
}

/** 跳转到某个角色的某一行并高亮 */
function jumpTo (name, rowId) {
  state.pendingFocus = rowId || null
  showGResults('')
  return selectCharacter(name).then(function () {
    if (state.pendingFocus === rowId && rowId) {
      // selectCharacter 没换角色时不会重绘，这里补一次
      state.pendingFocus = null
      renderForm()
    }
    if (rowId && !state.pendingFocus) focusRow(rowId)
  }).catch(function (e) { showStatus('跳转失败：' + e.message, 'error', true) })
}

/* ============================================================ 右侧抽屉（次要工具） */

/** 抽屉页签：全局检索 / 批量替换 / 名称库 / 回收站（主操作留在工具条上） */
function renderDrawer () {
  var drawer = $('drawer')
  var mask = $('drawer-mask')
  if (!drawer) return
  var open = !!state.drawerOpen
  drawer.className = 'drawer' + (open ? '' : ' hidden')
  if (mask) mask.className = 'drawer-mask' + (open ? '' : ' hidden')
  if (!open) return
  var tab = state.drawerTab
  var tabs = $('drawer-tabs')
  if (tabs) {
    tabs.innerHTML = DRAWER_TABS.map(function (t) {
      return '<button type="button" class="btn tab' + (t[0] === tab ? ' primary' : '') + '" data-drawer="' + t[0] + '">' + t[1] + '</button>'
    }).join('')
  }
  var body = $('drawer-body')
  if (!body) return
  body.innerHTML = tab === 'batch' ? batchPanelHtml()
    : (tab === 'library' ? libraryPanelHtml()
      : (tab === 'trash' ? trashPanelHtml() : searchPanelHtml()))
  if (tab === 'library') renderLibraryList()
  if (tab === 'trash') renderTrash()
}

/** 打开 / 切换抽屉页签 */
function openDrawer (tab) {
  state.drawerOpen = true
  if (tab) state.drawerTab = tab
  renderDrawer()
}

function closeDrawer () {
  state.drawerOpen = false
  renderDrawer()
}

/** 兼容旧调用名（工具条「工具箱」按钮 → 抽屉） */
function renderToolPanel () { renderDrawer() }

/** 工具箱 - 全局搜索 tab */
function searchPanelHtml () {
  return '<div class="tool-row">' +
    '<input id="tools-q" class="grow" type="search" placeholder="搜名称（武器/圣遗物/角色/套装）或正文关键词（回车）" value="' + esc(state.gq || '') + '" autocomplete="off">' +
    '<button type="button" class="btn primary" id="tools-search">搜索</button>' +
    '</div>' +
    '<div class="muted" style="font-size:12px">结果会显示在顶栏搜索框下拉里（点击条目可跳转到该角色并高亮所在行）。</div>'
}

/** 工具箱 - 批量替换 tab */
function batchPanelHtml () {
  var b = state.batch || (state.batch = { type: 'weapon', from: '', to: '', preview: null })
  var types = [['weapon', '武器'], ['artifact', '圣遗物套装'], ['character', '角色（配队成员）'], ['talent', '天赋 A/E/Q'], ['constellation', '命座名']]
  var dv = b.type === 'character' ? 'dl-character' : (b.type === 'artifact' ? 'dl-artifact' : (b.type === 'weapon' ? 'dl-weapon' : ''))
  var html = '<div class="tool-row">' +
    '<label class="field"><span>替换哪一类</span><select id="batch-type">' +
    types.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === b.type ? ' selected' : '') + '>' + t[1] + '</option>' }).join('') +
    '</select></label>' +
    '<label class="field"><span>原名称 from</span><input id="batch-from" type="text" list="' + dv + '" value="' + esc(b.from) + '" placeholder="如 薙草之稻光"></label>' +
    '<label class="field"><span>新名称 to</span><input id="batch-to" type="text" list="' + dv + '" value="' + esc(b.to) + '" placeholder="如 香韵奏者"></label>' +
    '<div class="tool-btns">' +
    '<button type="button" class="btn" id="batch-preview">预览命中</button>' +
    '<button type="button" class="btn primary" id="batch-run">执行替换</button>' +
    '</div></div>' +
    '<div class="muted" style="font-size:12px">只改 v2 引用（name / ref），不动 note；执行前会把要改的文件复制到 <code>data/_backup/&lt;时间戳&gt;/</code>，可回滚。</div>'

  if (b.preview) {
    var p = b.preview
    html += '<div class="batch-preview">' +
      '<div class="gr-title">预览：命中 <b>' + p.total + '</b> 处，涉及 <b>' + p.files + '</b> 个角色</div>' +
      (asArray(p.warnings).length ? '<div class="alert">' + p.warnings.map(esc).join('<br>') + '</div>' : '') +
      (p.total
        ? '<div class="muted" style="font-size:12px">按角色：' + p.perCharacter.map(function (c) { return esc(c.name) + '（' + c.count + '）' }).join('、') + '</div>' +
          '<ul class="gr-list">' + p.hits.slice(0, 200).map(function (h) {
            return '<li><a href="#" data-batch-jump="1" data-name="' + esc(h.name) + '" data-row="' + esc(h.rowId) + '">' + esc(h.name) + '</a>' +
              ' <span class="muted">' + esc(h.section) + ' · 第 ' + h.line + ' 行</span>' +
              '<span class="gr-text">' + esc(h.text) + '</span></li>'
          }).join('') + '</ul>' + (p.hits.length > 200 ? '<div class="muted">（只显示前 200 条，共 ' + p.hits.length + ' 条）</div>' : '')
        : '<div class="muted">没有任何引用命中这个名字</div>') +
      '</div>'
  }

  if (state.backupHistory.length) {
    html += '<div class="batch-preview"><div class="gr-title">可回滚的备份（本次会话）</div>' +
      state.backupHistory.map(function (h) {
        return '<div class="gr-row">' + esc(h.stamp) + ' · ' + esc(h.type) + '：' + esc(h.from) + ' → ' + esc(h.to) +
          '（' + h.changed + ' 处 / ' + h.files + ' 个文件）' +
          ' <button type="button" class="btn mini danger" data-undo="' + esc(h.stamp) + '">回滚</button></div>'
      }).join('') + '</div>'
  }
  return html
}

/** 工具箱 - 名称库浏览 tab */
function libraryPanelHtml () {
  var lib = state.library || (state.library = { type: 'weapon', filter: '', selected: null })
  var types = [['weapon', '武器'], ['artifact', '圣遗物套装'], ['character', '角色']]
  return '<div class="tool-row">' +
    types.map(function (t) {
      return '<button type="button" class="btn ' + (t[0] === lib.type ? 'primary' : '') + ' tab" data-lib="' + t[0] + '">' + t[1] + '</button>'
    }).join('') +
    '<input id="lib-filter" class="grow" type="search" placeholder="过滤名称（支持拼音首字母）" value="' + esc(lib.filter) + '" autocomplete="off">' +
    '<button type="button" class="btn" id="lib-refresh">刷新用量</button>' +
    '</div>' +
    '<div class="lib-wrap"><div id="lib-list" class="lib-list muted">正在统计使用情况…</div>' +
    '<div id="lib-detail" class="lib-detail muted">点左边的名字看它用在哪里</div></div>'
}

/** 名称库列表：名称 + 用量徽标（未使用 / 被 N 个角色用到） */
function renderLibraryList () {
  var box = $('lib-list')
  if (!box) return
  var lib = state.library
  loadUsage().then(function (usage) {
    var list = usage[lib.type] || []
    var indexNames = lib.type === 'weapon' ? state.index.weapons : (lib.type === 'artifact' ? state.index.artifacts : state.index.characters)
    var q = lib.filter.trim()
    var pinyin = window.Pinyin
    var names = asArray(indexNames).slice()
    // 名称库里没有、但数据里在用的名字也列出来（方便批量改名）
    asArray(list).forEach(function (u) { if (names.indexOf(u.name) < 0) names.push(u.name) })
    var filtered = names.filter(function (n) {
      if (!q) return true
      if (n.toLowerCase().indexOf(q.toLowerCase()) >= 0) return true
      if (n.indexOf(q) >= 0) return true
      if (pinyin && typeof pinyin.match === 'function') { try { return pinyin.match(n, q) } catch (e) { return false } }
      return false
    }).sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN') })

    var usedMap = {}
    asArray(list).forEach(function (u) { usedMap[u.name] = u })
    var usedCount = filtered.filter(function (n) { return usedMap[n] && usedMap[n].total }).length
    box.className = 'lib-list'
    box.innerHTML = '<div class="muted" style="font-size:12px;padding:2px 4px">共 ' + filtered.length + ' 个名称，其中 ' + usedCount + ' 个被用到</div>' +
      filtered.map(function (n) {
        var u = usedMap[n]
        var badge = (u && u.total) ? '<span class="lib-used">' + u.total + ' 处 / ' + u.characters.length + ' 角色</span>' : '<span class="lib-unused">未使用</span>'
        return '<div class="lib-item' + (lib.selected === n ? ' active' : '') + '" data-libname="' + esc(n) + '">' +
          '<span class="nm">' + esc(n) + '</span>' + badge + '</div>'
      }).join('')
  }).catch(function (e) {
    box.innerHTML = '<div class="muted" style="padding:8px">统计失败：' + esc(e.message) + '</div>'
  })
}

/** 名称库右侧详情：谁用了它 + 发起批量替换 */
function renderLibraryDetail (name) {
  var box = $('lib-detail')
  if (!box) return
  var type = state.library.type
  box.className = 'lib-detail'
  box.innerHTML = '<div class="muted" style="padding:8px">查询中…</div>'
  api('GET', '/api/search?q=' + encodeURIComponent(name) + '&type=' + encodeURIComponent(type) + '&scope=name').then(function (data) {
    var g = asArray(data.names)[0]
    var html = '<div class="gr-title"><b>' + esc(name) + '</b><span class="spacer"></span>' +
      '<button type="button" class="btn mini primary" data-libbatch="' + esc(name) + '">批量替换这个名字…</button></div>'
    if (!g || !g.total) html += '<div class="muted" style="padding:8px">没有被任何角色用到（未使用）</div>'
    else {
      html += '<div class="muted" style="font-size:12px">' + g.total + ' 处 / ' + g.characters.length + ' 个角色：' +
        g.characters.map(function (c) { return esc(c.name) + '（' + c.count + '）' }).join('、') + '</div>' +
        '<ul class="gr-list">' + g.hits.map(function (h) {
          return '<li><a href="#" data-g="jump" data-name="' + esc(h.name) + '" data-row="' + esc(h.rowId) + '">' + esc(h.name) + '</a>' +
            ' <span class="muted">' + esc(h.section) + ' · 第 ' + h.line + ' 行</span><span class="gr-text">' + esc(h.text) + '</span></li>'
        }).join('') + '</ul>'
    }
    box.innerHTML = html
  }).catch(function (e) { box.innerHTML = '<div class="muted" style="padding:8px">查询失败：' + esc(e.message) + '</div>' })
}

/** 打开工具箱并定位到某个 tab */
function openTools (tab) {
  openDrawer(tab)
}

/** 批量替换：先预览，再执行 */
function batchPreview () {
  syncBatchForm()
  var b = state.batch
  if (!b.from || !b.to) { showStatus('请填写 from 与 to', 'warn'); return Promise.resolve(null) }
  showStatus('正在扫描全部角色…', '', true)
  return api('POST', '/api/batch-replace', { type: b.type, from: b.from, to: b.to, dry: true }).then(function (res) {
    state.batch.preview = res
    renderDrawer()
    showStatus('预览：命中 ' + res.total + ' 处，涉及 ' + res.files + ' 个角色' +
      (asArray(res.warnings).length ? '；' + res.warnings.join('；') : ''), asArray(res.warnings).length ? 'warn' : 'ok', true)
    return res
  }).catch(function (e) {
    showStatus('预览失败：' + e.message, 'error', true)
    return null
  })
}

function batchRun () {
  syncBatchForm()
  var b = state.batch
  if (!b.from || !b.to) { showStatus('请填写 from 与 to', 'warn'); return Promise.resolve(null) }
  if (b.from === b.to) { showStatus('from 与 to 相同，不需要替换', 'warn'); return Promise.resolve(null) }
  return api('POST', '/api/batch-replace', { type: b.type, from: b.from, to: b.to, dry: true }).then(function (res) {
    if (!res.total) {
      showStatus('没有命中，未做任何改动', 'warn', true)
      return null
    }
    return modal({
      title: '确认批量替换',
      message: '把 ' + res.total + ' 处「' + b.from + '」替换成「' + b.to + '」，涉及 ' + res.files + ' 个角色文件（会先备份到 data/_backup/）。' +
        (asArray(res.warnings).length ? ' 注意：' + res.warnings.join('；') : ''),
      okText: '执行替换',
      danger: true
    }).then(function (yes) {
      if (!yes) return null
      return api('POST', '/api/batch-replace', { type: b.type, from: b.from, to: b.to }).then(function (done) {
        state.lastBackup = done.stamp
        state.backupHistory.unshift({ stamp: done.stamp, type: b.type, from: b.from, to: b.to, changed: done.changed, files: done.files })
        state.batch.preview = null
        state.batch.from = b.to
        state.batch.to = ''
        return refreshIndex().then(refreshList).then(function () {
          if (state.current) return openCharacter(state.current).catch(function () {})
        }).then(function () {
          renderDrawer()
          toast('批量替换完成', [
            '「' + b.from + '」→「' + b.to + '」',
            '改动 ' + done.changed + ' 处，涉及 ' + done.files + ' 个文件',
            '备份时间戳：' + done.stamp + '（可在面板里回滚）'
          ])
          showStatus('已替换 ' + done.changed + ' 处（备份 ' + done.stamp + '）', 'ok', true)
          return done
        })
      })
    })
  }).catch(function (e) {
    showStatus('替换失败：' + e.message, 'error', true)
    return null
  })
}

function batchUndo (stamp) {
  return modal({
    title: '回滚批量替换',
    message: '用备份 ' + stamp + ' 还原当时的文件。注意：替换之后对该文件的其它手工改动也会被一起还原。',
    okText: '回滚',
    danger: true
  }).then(function (yes) {
    if (!yes) return null
    return api('POST', '/api/batch-replace/undo', { stamp: stamp }).then(function (res) {
      state.backupHistory = state.backupHistory.filter(function (h) { return h.stamp !== stamp })
      if (state.lastBackup === stamp) state.lastBackup = null
      return refreshIndex().then(refreshList).then(function () {
        if (state.current) return openCharacter(state.current).catch(function () {})
      }).then(function () {
        renderDrawer()
        toast('已回滚', ['备份 ' + res.stamp + ' 已还原 ' + res.files + ' 个文件：' + asArray(res.characters).join('、')])
        showStatus('已回滚 ' + res.files + ' 个文件', 'ok', true)
        return res
      })
    }).catch(function (e) {
      showStatus('回滚失败：' + e.message, 'error', true)
      return null
    })
  })
}

/** 把批量替换面板里的输入同步回 state */
function syncBatchForm () {
  var b = state.batch
  if (!b || !$('batch-type')) return
  b.type = $('batch-type').value
  b.from = $('batch-from').value.trim()
  b.to = $('batch-to').value.trim()
}

function refreshList () {
  return api('GET', '/api/characters').then(function (data) {
    state.order = asArray(data.order)
    state.items = asArray(data.items)
    state.missing = asArray(data.missing)
    renderList()
    return data
  })
}

function refreshIndex () {
  return api('GET', '/api/index').then(function (data) {
    state.index = {
      weapons: asArray(data.weapons),
      artifacts: asArray(data.artifacts),
      characters: asArray(data.characters),
      talents: TALENTS.slice(),
      constellations: ['1', '2', '3', '4', '5', '6']
    }
    state.usage = null
    state.usageAt = 0
    renderDatalists()
    renderDrawer()
  })
}

/** 名称库使用统计（谁用了这个名字），带 5 秒缓存 */
function loadUsage (force) {
  var fresh = state.usage && (Date.now() - state.usageAt < 5000)
  if (fresh && !force) return Promise.resolve(state.usage)
  return api('GET', '/api/name-usage').then(function (data) {
    state.usage = { weapons: asArray(data.weapons), artifacts: asArray(data.artifacts), characters: asArray(data.characters), indexTotal: data.indexTotal || {} }
    state.usageAt = Date.now()
    return state.usage
  })
}

function buildIssueMap (issues) {
  var map = {}
  asArray(issues).forEach(function (i) {
    if (i && i.ref && !map[i.ref]) map[i.ref] = i.where + '：' + i.reason
  })
  return map
}

function openCharacter (name) {
  return api('GET', '/api/character?name=' + encodeURIComponent(name)).then(function (data) {
    state.current = name
    state.model = normalizeData(data)
    state.before = snapshotShape(state.model)
    state.issues = asArray(data.issues)
    state.issueMap = buildIssueMap(state.issues)
    markDirty(false)
    renderForm()
    renderList()
    return data
  })
}

function selectCharacter (name) {
  if (name === state.current && state.model) return Promise.resolve()
  var go = function () { return openCharacter(name) }
  if (state.dirty) {
    return modal({
      title: '有未保存的改动',
      message: '「' + state.current + '」还有改动没保存，切换会丢失。要先保存吗？',
      okText: '保存并切换',
      cancelText: '放弃改动'
    }).then(function (answer) {
      if (answer) return save().then(go)
      return go()
    })
  }
  return go()
}

/** 保存前把引用输入框里的当前文本同步回模型（用户可能没触发 blur） */
function syncRefInputs () {
  var inputs = document.querySelectorAll('#form [data-ref-kind]')
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i]
    var path = el.getAttribute('data-path')
    var kind = el.getAttribute('data-ref-kind')
    // 天赋三格的字母是 <span>（没有 .value），引用字段（select/input）才有 —— 两种都取到文本
    var val = String(el.value !== undefined ? el.value : (el.textContent || '')).trim()
    setPath(state.model, path, val)
    // 模型里同时存 ref 结构
    var parentPath = path.replace(/\.[^.]+$/, '')
    var parent = getPath(state.model, parentPath)
    if (parent) parent.ref = kind + ':' + val
  }
}

/** 去掉空行/空项，返回可直接提交的 body */
function buildBody () {
  var m = state.model
  var mv2 = m.v2

  function cleanRow (row) {
    var out = { label: hasText(row.label) ? row.label : null }
    if (row.sep) out.sep = row.sep
    return out
  }

  var weapons = mv2.weapons.map(function (row) {
    // 删除行：原位提交墓碑（位置不动 → 后面各行仍与原文件逐下标对齐）
    if (row && row.__deleted === true) return { __deleted: true }
    var out = { label: hasText(row.label) ? row.label : null }
    // 自定义标签与档位**互斥**：文档一行只有一个标签词（label 非空 → 文档写 `建议：`，
    // 写不进「第N档」）。输入时已联动清空，这里是保存前的兜底，防止手工改过 JSON 的行带进来。
    out.tier = out.label ? null : row.tier
    out.items = row.items.filter(function (it) { return hasText(it.name) }).map(function (it) {
      // `note` 显式提交（清空就提交 null）：否则「清掉一条备注」会被原文件顶回来
      return { name: it.name.trim(), note: hasText(it.note) ? it.note.trim() : null, ref: 'weapon:' + it.name.trim() }
    })
    return out
    // ⚠ 这里**不再过滤空行**：每行都要占一个下标（删行靠墓碑表达），
    //   空行由服务器 normalizeV2 丢掉（main 占位行按设计保留）。
  })

  var artifacts = mv2.artifacts.map(function (row) {
    if (row && row.__deleted === true) return { __deleted: true }
    if (row.kind === 'note') return { kind: 'note', text: str(row.text).trim() }
    if (row.kind === 'main') {
      var stats = {}
      MAIN_SLOTS.forEach(function (slot) {
        stats[slot] = asArray(row.stats && row.stats[slot]).map(function (x) { return x.trim() }).filter(Boolean)
      })
      // note / noteSlot 显式提交（清空 → null），否则清不掉
      var main = { kind: 'main', note: hasText(row.note) ? row.note.trim() : null }
      if (hasText(row.noteSlot)) main.noteSlot = row.noteSlot
      main.stats = stats
      return main
    }
    if (row.kind === 'sub') {
      var o2 = { kind: 'sub', stats: asArray(row.stats).map(function (x) { return x.trim() }).filter(Boolean) }
      if (row.sep) o2.sep = row.sep
      return o2
    }
    if (row.kind === 'text') return { kind: 'text', label: hasText(row.label) ? row.label : null, text: str(row.text) }
    var o3 = cleanRow(row)
    o3.kind = row.kind
    // 圣遗物档位行的 `label` 就是**文档里的原词**（首选 / 过渡 / 可选 / 自定义词）：
    // 留空的话文档会退回写 kind 的头词，解析回来 label 就多出一个词（往返不一致），
    // 所以这里补上 kind 对应的文档词（与 schema.renderArtifactRow 的 head 同一份映射）。
    if (!hasText(o3.label) && ARTIFACT_KIND_WORD[row.kind]) o3.label = ARTIFACT_KIND_WORD[row.kind]
    o3.sets = asArray(row.sets).filter(function (s) { return hasText(s.name) }).map(function (s) {
      var o = { name: s.name.trim(), ref: 'artifact:' + s.name.trim() }
      if (hasText(s.pieces)) o.pieces = s.pieces.trim()
      return o
    })
    return o3
  })

  var talents = []
  mv2.talents.forEach(function (row) {
    if (row.kind !== 'priority') return
    // 数据里没有天赋行的角色：界面会补一行空三格（有地方填），但**没填就不落盘**，
    // 否则「打开再保存」会凭空多出一行 A1 E1 Q1（还会多出一个「3. 天赋加点」段）。
    // 判据：这一行**既没有 raw、也没有 A/E/Q 之外的旧字母**，且三格都还是默认的 1（没勾皇冠）
    var slots = talentSlots(mv2.talents)
    var blank = !hasText(row.raw) && slots.every(function (s) { return !s.extra && s.level === '1' && !s.crown })
    if (blank) return
    // 固定三格：A/E/Q 顺序写回；每格一个等级（1..10），10 = 皇冠（crown:true）
    var order = slots.map(function (s) {
      var o = { name: s.name, level: Number(s.level) === 10 ? 10 : (Number(s.level) || 1), ref: 'talent:' + s.name }
      if (o.level === 10) o.crown = true
      return o
    })
    // raw 按仓库口径生成（`A1 E10 Q10`）：服务器在顺序没变时会保留原写法，变了就用这份
    talents.push({ kind: 'priority', order: order, raw: order.map(function (o) { return o.name + o.level }).join(' ') })
    // 皇冠行与优先级行**同形**（数据里就是这样两份）：能让服务端按下标稳定合并，
    // 也避免「只在模型里折平、却把皇冠行留在旧文件里」的隐性依赖。
    // 条目顺序沿用原文件的皇冠行顺序（如 `Q` 在 `A` 前），保证「打开→保存」逐字节不变
    var crownMap = {}
    order.filter(function (o) { return o.level === 10 }).forEach(function (o) { crownMap[o.name] = o })
    var prevOrder = asArray(asArray(m.crownOrder)[0])
    var names = prevOrder.filter(function (n) { return crownMap[n] })
    Object.keys(crownMap).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n) })
    var crowns = names.map(function (n) { return { name: n, level: 10, crown: true, ref: 'talent:' + n } })
    if (crowns.length) talents.push({ kind: 'crown', items: crowns })
  })

  var panels = mv2.panels.map(function (row) {
    if (row && row.__deleted === true) return { __deleted: true }
    var label = hasText(row.label) ? row.label : null
    if (hasText(row.k)) return { label: label, k: row.k.trim(), v: str(row.v).trim() }
    return { label: label, text: str(row.text).trim() }
    // 空行不再在这里丢掉（要占下标）；服务器 normalizeV2 会丢弃没有 k / text 的行
  })

  var constellations = mv2.constellations.map(function (row) {
    if (row && row.__deleted === true) return { __deleted: true }
    // 名字为空 → 提交 null（占着下标，服务器按「没有名字」丢掉）
    return {
      name: hasText(row.name) ? row.name.trim() : null,
      index: constellationIndex(row.name),
      text: str(row.text).trim()
    }
  })

  var teams = mv2.teams.map(function (row) {
    if (row && row.__deleted === true) return { __deleted: true }
    // 段末备注行（`{kind:'note'}`）原样带回（界面不改它，但丢了就是数据损失）
    if (row.kind === 'note') return { kind: 'note', text: str(row.text).trim() }
    var members = asArray(row.members).filter(function (m) { return hasText(m.name) }).map(function (m) {
      // 一格可以带可替换项（`迪奥娜 / 阿罗夏`）：落盘仍是**一格一个 name**、格内用 ` / ` 连接，
      // ref 取**第一个候选**（面板 / 网页版取图标同款口径）
      var cands = memberCandidates(m.name)
      var name = cands.length > 1 ? joinCandidates(cands) : cands[0]
      // note 显式提交（清空 → null），否则成员括注清不掉
      return { name: name, note: hasText(m.note) ? m.note.trim() : null, ref: 'character:' + (cands[0] || name) }
    })
    return { label: hasText(row.label) ? row.label : null, members: members, text: str(row.text).trim() }
  })

  return {
    name: state.current,
    game: state.model.game || 'gi',
    meta: {
      '建议等级': str(m.meta['建议等级']).trim(),
      '定位': str(m.meta['定位']).trim(),
      '100级提升': str(m.meta['100级提升']).trim()
    },
    v2: {
      weapons: weapons,
      artifacts: artifacts,
      talents: talents,
      panels: panels,
      constellations: constellations,
      teams: teams
    },
    unparsed: m.unparsed || undefined
  }
}

function save () {
  if (!state.current || !state.model) return Promise.resolve(false)
  syncRefInputs()
  var before = state.before
  var after = snapshotShape(state.model)
  var diff = diffSummary(before, after)
  var body = buildBody()
  showStatus('正在保存…', '', true)
  return api('PUT', '/api/character?name=' + encodeURIComponent(state.current), body).then(function (res) {
    state.issues = asArray(res && res.issues)
    state.issueMap = buildIssueMap(state.issues)
    markDirty(false)
    state.before = snapshotShape(state.model)
    renderForm()
    // 保存后服务器会自动重建 data/_index.json（索引已刷新 / 重建失败只算警告，不影响保存）
    var idxNote = (res && res.indexRefreshed) ? '，索引已刷新' : ''
    var idxWarn = (res && res.indexWarning) ? res.indexWarning : ''
    return refreshIndex().then(refreshList).then(function () {
      var lines = diff.length ? diff : ['内容与上次打开时一致（只有格式/顺序层面的改动）']
      lines.push('武器行 ' + after.weapons + ' / 圣遗物行 ' + after.artifacts + ' / 配队行 ' + after.teams + ' / 命座行 ' + after.constellations)
      if (state.issues.length) lines.push('⚠ ' + state.issues.length + ' 处名称不在图鉴（输入框旁的 ⚠ 可看详情）')
      if (idxWarn) lines.push(idxWarn)
      toast('已保存 ' + state.current + '.json' + idxNote, lines, (state.issues.length || idxWarn) ? 'warn' : 'ok')
      if (state.issues.length) {
        showStatus('已保存' + idxNote + '；但有 ' + state.issues.length + ' 处名称不在图鉴里（输入框旁的 ⚠ 可看详情）' + (idxWarn ? '；' + idxWarn : ''), 'warn', true)
      } else {
        showStatus('已保存 ' + state.current + '.json' + idxNote + (idxWarn ? '；' + idxWarn : ''), idxWarn ? 'warn' : 'ok', !!idxWarn)
      }
      return true
    })
  }).catch(function (e) {
    showStatus('保存失败：' + e.message, 'error', true)
    toast('保存失败', [e.message], 'error')
    return false
  })
}

/**
 * 发布：把改动铺到全链路（Ctrl+Shift+S）。
 * 服务端的 /api/publish 会依次：写角色 JSON（给了 name 才写）→ 重建 _index.json →
 * 写回主文档 .docx（自动备份）→ 生成 guide.html → 产出提交摘要（**不自动 commit**）。
 * 响应形状以 steps[] + summary 为准；同时兼容旧形状的 files[]。
 */
function publish () {
  showStatus('正在发布（索引 / 主文档 / guide.html）…', '', true)
  return api('POST', '/api/publish', {}).then(function (res) {
    var lines = []
    asArray(res.steps).forEach(function (s) { lines.push((s.ok ? '✓ ' : '✗ ') + s.step + (s.detail ? '：' + s.detail : '')) })
    asArray(res.files).forEach(function (f) { lines.push(f.file + '（' + String(f.mtime).replace('T', ' ').slice(0, 19) + '）') })
    if (res.docx && res.docx.path) lines.push('主文档：' + res.docx.path.split(/[\\/]/).pop() + '（备份 ' + (res.docx.backup ? res.docx.backup.split(/[\\/]/).pop() : '无') + '）')
    var changed = asArray(res.summary && res.summary.changedFiles)
    if (changed.length) lines.push('变更文件：' + changed.map(function (c) { return c.path + '（' + c.status + '）' }).join('、'))
    lines.push('未执行 git 提交' + (res.summary && res.summary.suggestedMessage ? '；建议提交信息：' + res.summary.suggestedMessage : ''))
    asArray(res.errors).forEach(function (e) { lines.push('⚠ ' + e) })
    toast(res.ok === false ? '发布有错误' : '已发布', lines, res.ok === false ? 'error' : 'ok')
    var failed = asArray(res.steps).filter(function (s) { return s.ok === false })
    showStatus(res.ok === false || failed.length
      ? ('发布失败：' + (res.error || failed.map(function (s) { return s.step + ' — ' + s.detail }).join('；')))
      : ('已发布：' + asArray(res.steps).map(function (s) { return s.step }).join(' → ') + '（未提交，摘要见 ' + (res.summaryFile || 'out/_commit-summary.md') + '）'),
    (res.ok === false || failed.length) ? 'error' : 'ok', true)
    if (state.current) { refreshIndex().then(refreshList).catch(function () {}) }
    return res
  }).catch(function (e) {
    showStatus('发布失败：' + e.message, 'error', true)
    toast('发布失败', [e.message], 'error')
    return null
  })
}

/* ==================================================== 保存并发布（全链路） */

/** 「保存并发布」的四个阶段（用于进度提示） */
var PUBLISH_STEPS = ['写角色 JSON', '重建 data/_index.json', '写回主文档（含备份）', '生成 guide.html', '三方一致性校验', '自动提交（不推送）']

/**
 * 保存并发布（Ctrl+Shift+S，按钮「保存并发布」）：
 *   写 JSON → 重建索引 → build-docx 写回 Word 主文档（含备份）→ build-html 生成 guide.html
 *   → **三方一致性校验**（数据/文档/网页/分隔符，全过才继续）→ `git add` + `git commit`
 *   （**绝不 push**，推送由人工执行）。
 * 校验不过或提交失败都不回滚：文档与网页保持可用，返回里说明原因与手动提交命令。
 * 摘要落盘 out/_commit-summary.md（+ 最近 5 份时间戳副本）。
 */
function saveAndPublish () {
  if (!state.current || !state.model) return Promise.resolve(false)
  syncRefInputs()
  var body = buildBody()
  showStatus('保存并发布：' + PUBLISH_STEPS.join(' → ') + ' …', '', true)
  toast('保存并发布中…', PUBLISH_STEPS.map(function (s, i) { return (i + 1) + '. ' + s }), 'ok')
  return api('POST', '/api/publish', { name: state.current, character: body, targets: ['html'] }).then(function (res) {
    markDirty(false)
    state.issues = asArray(res.issues)
    state.before = snapshotShape(state.model)
    return refreshIndex().then(refreshList).then(function () {
      renderForm()
      var s = (res && res.summary) || {}
      var lines = []
      asArray(s.characterChanges).forEach(function (c) { lines.push(c.name + '：' + fieldChangeText(c.fields)) })
      asArray(res.steps).forEach(function (st) { lines.push((st.ok ? '✓ ' : '✗ ') + st.step + (st.detail ? '：' + st.detail : '')) })
      if (s.suggestedMessage) lines.push('提交信息：' + s.suggestedMessage)
      lines.push('主文档备份：' + ((res.docx && res.docx.backup) || '（无）'))
      asArray(res.verify && res.verify.checks).forEach(function (c) {
        if (c.advisory) return
        lines.push((c.ok ? '✓ ' : '✗ ') + c.name + '：' + c.detail)
      })
      if (res.commitExecuted) lines.push('✓ 已自动提交 ' + (res.commit || '') + '（**未推送**，push 请人工执行）')
      else if (res.step === 'verify') lines.push('⚠ 三方校验未通过，已跳过提交：' + (res.detail || ''))
      else if (res.commitError) lines.push('⚠ 自动提交失败（保存与生成已完成）：' + res.commitError + '　→ 请手动 git add && git commit')
      else lines.push('无改动可提交（' + (res.commitSkipped || '工作区已干净') + '）')
      lines.push('摘要文件：' + (res.summaryFile || 'out/_commit-summary.md'))
      var failed = asArray(res.steps).filter(function (st) { return st.ok === false })
      var blocked = res.ok === false && res.step === 'verify'
      toast(failed.length ? '保存并发布有失败步骤' : (blocked ? '已保存并发布；三方校验未通过，未提交' : (res.commitExecuted ? '已保存并发布并提交（未推送）' : '已保存并发布（未提交）')), lines, (failed.length || blocked) ? 'warn' : 'ok', {
        text: s.markdown,
        label: '复制提交信息',
        title: s.suggestedMessage || s.title
      })
      showStatus(failed.length
        ? ('保存并发布失败：' + failed.map(function (st) { return st.step + ' — ' + st.detail }).join('；'))
        : blocked
          ? ('保存并发布：三方一致性校验未通过，未提交 — ' + (res.detail || ''))
          : ('已保存并发布 ' + state.current + '；主文档已写回（备份 ' + ((res.docx && res.docx.backup) || '无') + '）'
            + (res.commitExecuted ? '；已提交 ' + res.commit + '（未推送）' : (res.commitError ? '；自动提交失败，请手动提交' : '；无改动可提交'))
            + '；摘要 ' + (res.summaryFile || 'out/_commit-summary.md')),
      (failed.length || blocked) ? 'error' : 'ok', true)
      return res
    })
  }).catch(function (e) {
    showStatus('保存并发布失败：' + e.message, 'error', true)
    toast('保存并发布失败', [e.message], 'error')
    return null
  })
}

/** 角色字段变化 → 一行中文摘要（服务端 summary.characterChanges[].fields） */
function fieldChangeText (fields) {
  var parts = []
  asArray(fields).forEach(function (f) {
    var bits = []
    if (f.changed) bits.push(f.changed + ' 改')
    if (f.added) bits.push(f.added + ' 增')
    if (f.removed) bits.push(f.removed + ' 删')
    if (bits.length) parts.push(f.label + ' ' + bits.join(' '))
  })
  return parts.length ? parts.join(' / ') : '无字段变化'
}

/* ============================================================ 结构操作 */

function moveRow (arr, i, delta) {
  var j = i + delta
  if (j < 0 || j >= arr.length) return false
  var tmp = arr[i]
  arr[i] = arr[j]
  arr[j] = tmp
  return true
}

function newRow (kind) {
  // `_new: true` = 界面上的「刚加的空行」标记：rowVisible 见到它就渲染（否则空行会被整行隐藏），
  // buildBody 落盘时不会带上它（各栏目都是显式构造对象）。详见 rowVisible。
  switch (kind) {
    case 'weapons': return { label: '', tier: null, sep: ' > ', items: [{ name: '', note: '' }] }
    case 'artifacts': return { kind: 'preferred', label: '', sep: ' > ', sets: [{ name: '' }] }
    case 'panels': return { _new: true, label: '', k: '', v: '' }
    case 'constellations': return { _new: true, name: '', text: '' }
    case 'teams': return { _new: true, label: '', members: [], text: '' }
    default: return {}
  }
}

/**
 * 多值路径 → 候选类别（主词条按槽位、副词条一套）：
 *   `v2.artifacts.0.stats.时之沙` → `时之沙`；`v2.artifacts.0.stats` → `副词条`
 */
function statKindOfPath (path) {
  var m = String(path).match(/\.stats\.(时之沙|空之杯|理之冠)$/)
  if (m) return m[1]
  return /\.stats$/.test(String(path)) ? '副词条' : ''
}

function handleAction (act, path, i, el) {
  var model = state.model
  var listPath = path
  var target = getPath(model, path)
  var changed = true

  if (act === 'add-row') {
    target.push(newRow(path.split('.').pop()))
  } else if (act === 'del-row') {
    // **不缩短数组**：原位放墓碑，保存时服务器才知道"这一行被删了"（否则按位置又补回来）。
    // 撤销 = undelete-row（见下）。
    if (target[i] && typeof target[i] === 'object') target[i] = { __deleted: true }
    else target.splice(i, 1)
  } else if (act === 'undelete-row') {
    var dead = target[i]
    if (dead && dead.__deleted === true) delete target[i].__deleted
  } else if (act === 'move-row-up') {
    changed = moveRow(target, i, -1)
  } else if (act === 'move-row-down') {
    changed = moveRow(target, i, 1)
  } else if (act === 'add-item') {
    if (listPath.indexOf('v2.weapons') === 0) target.push({ name: '', note: '' })
    else if (listPath.indexOf('v2.artifacts') === 0) {
      if (/\.sets$/.test(listPath)) target.push({ name: '' })
      else target.push('')  // 主词条/副词条多值
    } else if (/\.order$/.test(listPath)) target.push('A')
    else if (/\.items$/.test(listPath)) {
      if (listPath.indexOf('v2.talents') === 0) target.push({ name: 'A', level: '' })
      else target.push({ name: '', note: '' })
    } else if (/\.members$/.test(listPath)) target.push({ name: '', note: '' })
    else target.push('')
  } else if (act === 'del-item') {
    target.splice(i, 1)
  } else if (act === 'move-item-up') {
    changed = moveRow(target, i, -1)
  } else if (act === 'move-item-down') {
    changed = moveRow(target, i, 1)
  } else if (act === 'add-priority') {
    // 天赋只有一行固定三格（A/E/Q）：空段就把三格补出来（等级默认 1）
    model.v2.talents = foldCrownRows(model.v2.talents)
  } else if (act === 'toggle-crown') {
    // 皇冠格：点一下就切到 10 / 回到 1（等级是唯一真相）
    var crownRow = getPath(model, path)
    var cslot = getPath(model, path + '.slots.' + i)
    if (crownRow && cslot && typeof cslot === 'object') {
      cslot.level = (talentLevelText(cslot.level) === '10' && cslot.crown) ? '1' : '10'
      cslot.crown = cslot.level === '10'
      if (crownRow.kind === 'priority') crownRow.raw = ''
    }
  } else if (act === 'add-member') {
    target.push({ name: nextTeamMember(getPath(model, path.replace(/\.members$/, '')), target), note: '' })
  } else if (act === 'open-members') {
    // 配队成员：可搜索多选选择器（path 是这一行的路径，如 v2.teams.0）
    openMemberPicker(path)
    changed = false
  } else if (act === 'open-candidates') {
    // 这一格的候选（可替换项）：一格可以有多个候选，格内用 ` / ` 连接
    openSlotCandidates(path)
    changed = false
  } else if (act === 'pick-item') {
    // 主词条 / 副词条某一格的「▾」：从候选词条里选（不校验、可继续手改）
    var statKind = statKindOfPath(path)
    var cands = STAT_CANDIDATES[statKind] || []
    if (typeof window.Picker === 'undefined') { showStatus('选择器组件没加载（/picker.js 404？）', 'error', true) }
    else if (!cands.length) { showStatus('这一栏没有候选表，直接输入即可', 'warn') }
    else {
      window.Picker.openRef({
        title: '选择词条（' + (statKind || '') + '）',
        candidates: cands,
        value: getPath(model, path + '.' + i),
        onPick: function (name) {
          setPath(model, path + '.' + i, name)
          markDirty(true)
          renderForm()
        }
      })
    }
    changed = false
  } else if (act === 'copy-prev') {
    // 「复制上一条」：把同一个列表里上一条的名字填进来（含 ref）
    var cur = String(getPath(model, path) || '').trim()
    var parts2 = path.split('.')
    var field = parts2.pop()
    var idx = Number(parts2.pop())
    var list = getPath(model, parts2.join('.'))
    var prevItem = asArray(list)[idx - 1]
    if (prevItem && idx > 0) {
      var val = str(prevItem.name || prevItem)
      setPath(model, path, val)
      var holder = asArray(list)[idx]
      if (holder && typeof holder === 'object') holder.ref = (path.indexOf('v2.teams') === 0 ? 'character:' : (path.indexOf('v2.artifacts') === 0 ? 'artifact:' : 'weapon:')) + val
      if (cur === val) changed = false
    } else {
      changed = false
    }
  } else if (act === 'panel-to-text') {
    var row = getPath(model, path)
    if (hasText(row.k)) {
      row.text = [row.k, row.v].filter(Boolean).join('：')
      delete row.k
      delete row.v
    } else {
      row.k = str(row.text)
      row.v = ''
      delete row.text
    }
  } else {
    changed = false
  }

  if (changed) {
    markDirty(true)
    renderForm()
  }
}

/** 新增配队成员时，尝试从该行的文本里按顺序挑一个还没用到的角色名 */
function nextTeamMember (team, members) {
  if (!team || !hasText(team.text)) return ''
  var used = asArray(members).map(function (m) { return m && m.name })
  var parts = String(team.text).split(/\s*[+＋]\s*/).map(function (x) { return x.trim() }).filter(Boolean)
  for (var i = 0; i < parts.length; i++) {
    if (state.index.characters.indexOf(parts[i]) >= 0 && used.indexOf(parts[i]) < 0) return parts[i]
  }
  return ''
}

/* ============================================================ 配队成员选择器 */

/** 配队成员候选池：名称库里的角色 + 当前行已有成员（保证已选的一定在列表里） */
function memberPool (extra) {
  var out = asArray(state.index.characters).slice()
  asArray(extra).forEach(function (m) {
    var n = str(m && m.name).trim()
    if (n && out.indexOf(n) < 0) out.push(n)
  })
  return out
}

/**
 * 打开配队成员多选选择器（可搜索 / 拼音首字母、回车添加、拖动排序）
 * @param {string} path 形如 v2.teams.0
 */
function openMemberPicker (path) {
  var team = getPath(state.model, path)
  if (!team) { showStatus('找不到这一行配队', 'error'); return }
  if (typeof window.Picker === 'undefined') { showStatus('选择器组件没加载（/picker.js 404？）', 'error', true); return }
  window.Picker.openMembers({
    title: '配队成员（第 ' + ((team.members || []).length + 1) + ' 行）：点名字 = 加进当前格，格内可多选（` / ` 可替换）',
    pool: memberPool(team.members),
    members: team.members,
    onConfirm: function (members) {
      var before = clone(team.members)
      if (window.Picker.sameMembers(before, members)) return
      // 一格一个候选（普通成员）：第一个候选作为主名，其余候选并进同一格（`A / B`）
      team.members = members.map(function (m, i) {
        var cands = memberCandidates(m.name)
        return { name: joinCandidates(cands), note: str(m.note), ref: 'character:' + (cands[0] || m.name) }
      })
      markDirty(true)
      renderForm()
      var tip = team.members.map(function (m) { return memberCandidates(m.name)[0] }).filter(Boolean)
      showStatus('已更新成员：' + (tip.length ? tip.join(' + ') : '（空）'), 'ok')
    }
  })
}

/**
 * 「选择这一格的候选（可替换项）」：一格可以有多个候选，第一个是主选、其余是备选。
 * 候选并进**同一格**，格内用 ` / ` 连接（用户口径：不加任何中文标注）。
 * @param {string} path 形如 v2.teams.0.members.2
 */
function openSlotCandidates (path) {
  var teamPath = path.replace(/\.members\.\d+$/, '')
  var idx = Number((path.match(/\.members\.(\d+)$/) || [])[1])
  var team = getPath(state.model, teamPath)
  var member = getPath(state.model, path)
  if (!team || !member || !Number.isInteger(idx)) { showStatus('找不到这一格成员', 'error'); return }
  if (typeof window.Picker === 'undefined') { showStatus('选择器组件没加载（/picker.js 404？）', 'error', true); return }
  window.Picker.openMembers({
    title: '这一格的候选（顺序即优先级，第一个是主选）',
    pool: memberPool(team.members),
    members: memberCandidates(member.name).map(function (n) { return { name: n, ref: 'character:' + n } }),
    confirmText: '确定候选',
    onConfirm: function (members) {
      var cands = members.map(function (m) { return memberCandidates(m.name)[0] }).filter(Boolean)
      if (!cands.length) { showStatus('至少留一个候选', 'error'); return }
      var before = memberCandidates(member.name)
      var after = joinCandidates(cands)
      if (before.join(' / ') === after) return
      member.name = after
      member.ref = 'character:' + cands[0]
      markDirty(true)
      renderForm()
      showStatus('这一格：' + after, 'ok')
    }
  })
}

/** 配队行里拖动成员排序（HTML5 drag & drop） */
function moveMemberAt (team, from, to) {
  if (!team || from < 0 || from >= team.members.length) return false
  var members = team.members.slice()
  var item = members.splice(from, 1)[0]
  members.splice(Math.max(0, Math.min(members.length, to)), 0, item)
  team.members = members
  return true
}

/**
 * 天赋三格：把输入框里的数字写回模型（**只填数字就生效**，不需要点皇冠）。
 *
 * ⚠ 曾经这里是 `var slot = getPath(model, 'v2.talents.0.slots.0.level')` ——
 *   路径以 `.level` 结尾，`getPath` 返回的是**那个字符串值**而不是格子对象，
 *   于是 `typeof slot === 'object'` 永远为假、赋值被跳过：**打字完全没反应，
 *   只有点皇冠（走对象路径）才生效**。这里改为先去掉 `.level` 再取对象。
 * @param {object} model
 * @param {string} lvPath 形如 `v2.talents.0.slots.1.level`
 * @param {string|number} rawValue 输入框里的原始值
 * @returns {boolean} 是否写进了模型
 */
function setTalentSlotLevel (model, lvPath, rawValue) {
  var path = str(lvPath)
  var text = String(rawValue == null ? '' : rawValue).trim()
  var row = getPath(model, path.replace(/\.slots\.\d+\.level$/, ''))
  var slot = getPath(model, path.replace(/\.level$/, ''))
  var n = Number(text)
  if (!text) n = 1
  if (!(n >= 1 && n <= 10)) n = 1
  if (!slot || typeof slot !== 'object') return false
  slot.level = String(n)
  slot.crown = n === 10
  if (row && row.kind === 'priority') row.raw = ''
  return true
}

/* ============================================================ 事件绑定 */

function formEvents () {
  var form = $('form')

  form.addEventListener('input', function (e) {
    var el = e.target
    if (!el || !el.getAttribute) return
    // 天赋等级输入框：1–10；写 10 = 皇冠，写 1–9 = 取消皇冠；留空按 1
    if (el.getAttribute('data-level')) {
      setTalentSlotLevel(state.model, el.getAttribute('data-path'), el.value)
      markDirty(true)
      return
    }
    var path = el.getAttribute('data-path')
    if (!path) return
    var kind = el.getAttribute('data-ref-kind')
    var value = el.value
    if (kind === 'talent') value = String(value).toUpperCase()
    setPath(state.model, path, value)
    if (kind) {
      var parent = getPath(state.model, path.replace(/\.[^.]+$/, ''))
      if (parent) {
        if (String(value).trim()) parent.ref = kind + ':' + String(value).trim()
        else delete parent.ref
      }
    }
    markDirty(true)

    // 行首标签：文档里**一行只有一个标签词**，所以「自定义词」与「档位」必须二选一。
    // 不联动的话会拼出 `建议：第一档：西风剑`（parse-docx 认不出，往返必然不一致），
    // 或者 `输出向：…` 把 kind 丢掉（解析回来变 preferred）——两种都会让「保存并发布」后文档与 JSON 漂移。
    var labelRow = /^v2\.(weapons|artifacts)\.\d+\.label$/.test(path)
      ? getPath(state.model, path.replace(/\.label$/, ''))
      : null
    if (labelRow) {
      var word = str(value).trim()
      if (/^v2\.weapons\./.test(path)) {
        // 武器：自定义词进 label，文档就不写「第N档」，所以档位必须清空
        if (word && labelRow.tier !== null && labelRow.tier !== undefined) {
          labelRow.tier = null
          showStatus('已清空「档位」下拉：自定义标签会顶掉档位词（文档一行只有一个标签词）', 'ok')
        }
      } else if (word) {
        // 圣遗物：label 就是文档里的原词，kind 按同一份映射跟着走
        var wantKind = ARTIFACT_WORD_KIND[word] || 'preferred'
        if (labelRow.kind !== wantKind) {
          labelRow.kind = wantKind
          showStatus('已把档位改为「' + (ARTIFACT_KIND_WORD[wantKind] || wantKind) + '」：这一行的标签词由自定义标签决定（文档一行只有一个标签词）', 'ok')
        }
      }
      markDirty(true)
    }
  })

  form.addEventListener('change', function (e) {
    var el = e.target
    if (!el || !el.getAttribute) return
    if (el.tagName === 'SELECT' && el.getAttribute('data-path') && !el.getAttribute('data-ref-kind')) {
      var path = el.getAttribute('data-path')
      if (/\.tier$/.test(path)) {
        setPath(state.model, path, el.value === '' ? null : Number(el.value))
        // 档位是文档里的「第N档」写法，装不下自定义词 → 二选一（见上面的 input 联动）
        var wRow = getPath(state.model, path.replace(/\.tier$/, ''))
        if (el.value !== '' && wRow && str(wRow.label).trim()) {
          wRow.label = ''
          showStatus('已清空「自定义标签」：档位词（推荐 / 可选 / 过渡）会写进文档，一行只有一个标签词', 'ok')
        }
      } else if (/\.kind$/.test(path)) {
        setPath(state.model, path, el.value)
        // 圣遗物：kind 决定文档里的档位词（首选 / 过渡 / 可选），所以 label 要跟着改，
        // 否则「label=输出向 + kind=transition」会让文档只写出 `输出向：…`，解析回来 kind 变 preferred。
        var aRow = getPath(state.model, path.replace(/\.kind$/, ''))
        var kindWord = ARTIFACT_KIND_WORD[el.value]
        if (aRow && kindWord && str(aRow.label).trim() !== kindWord) {
          var had = str(aRow.label).trim()
          aRow.label = kindWord
          if (had && !ARTIFACT_WORD_KIND[had]) showStatus('已把自定义标签「' + had + '」改为「' + kindWord + '」：档位下拉的词会写进文档，一行只有一个标签词', 'ok')
        }
      }
      markDirty(true)
      renderForm()
      return
    }
    if (el.getAttribute('data-ref-kind')) markDirty(true)
  })

  // 引用字段失焦：写成 {name, ref:"类型:名称"}；值没变就不重绘（避免光标/滚动跳动）
  form.addEventListener('focusout', function (e) {
    var el = e.target
    if (!el || !el.getAttribute || !el.getAttribute('data-ref-kind')) return
    if (applyRef(el)) renderForm()
  })

  form.addEventListener('click', function (e) {
    var el = e.target
    if (!el || !el.getAttribute) return
    // 「从名称库选」：引用字段旁边的小按钮
    var pickBtn = el.closest ? el.closest('[data-pick]') : null
    if (pickBtn) {
      e.preventDefault()
      openRefPickerFor(pickBtn.getAttribute('data-pick'), pickBtn.getAttribute('data-path'))
      return
    }
    var act = el.getAttribute('data-act')
    if (!act) return
    e.preventDefault()
    var path = el.getAttribute('data-path')
    var i = el.hasAttribute('data-i') ? Number(el.getAttribute('data-i')) : -1
    handleAction(act, path, i, el)
  })

  // 成员备注：只更新模型，不重绘（避免输入时丢焦点）
  form.addEventListener('input', function (e) {
    var el = e.target
    if (!el || !el.classList || !el.classList.contains('member-note')) return
    var path = el.getAttribute('data-path')
    if (path) { setPath(state.model, path, el.value); markDirty(true) }
  })

  // 配队成员拖动排序（HTML5 drag & drop）
  var dragM = { from: -1, path: null }
  form.addEventListener('dragstart', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('.members .member') : null
    if (!chip) return
    var box = chip.closest('.members')
    dragM = { from: Number(chip.getAttribute('data-m')), path: box ? box.getAttribute('data-members') : null }
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', String(dragM.from)) } catch (err) {}
    }
  })
  form.addEventListener('dragover', function (e) {
    var box = e.target && e.target.closest ? e.target.closest('.members') : null
    if (!box || dragM.from < 0 || dragM.path !== box.getAttribute('data-members')) return
    e.preventDefault()
    var team = getPath(state.model, dragM.path)
    if (!team) return
    var chips = [].slice.call(box.querySelectorAll('.member'))
    var rects = chips.map(function (c) { return c.getBoundingClientRect() })
    var x = e.clientX
    var to = rects.length
    for (var k = 0; k < rects.length; k++) {
      if (x < rects[k].left + rects[k].width / 2) { to = k; break }
    }
    if (to === dragM.from || to === dragM.from + 1) return
    if (moveMemberAt(team, dragM.from, to > dragM.from ? to - 1 : to)) {
      dragM.from = to > dragM.from ? to - 1 : to
      markDirty(true)
      renderForm()
    }
  })
  form.addEventListener('drop', function (e) {
    if (dragM.from < 0) return
    e.preventDefault()
    dragM = { from: -1, path: null }
    showStatus('已调整成员顺序', 'ok')
  })
  form.addEventListener('dragend', function () { dragM = { from: -1, path: null } })
}

/** 引用字段 → 名称库候选（角色字段直接用角色清单，可以搜拼音首字母） */
function candidatesFor (kind) {
  if (kind === 'weapon') return state.index.weapons
  if (kind === 'artifact') return state.index.artifacts
  if (kind === 'character') return state.index.characters
  if (kind === 'talent') return TALENTS.slice()
  if (kind === 'constellation') return ['一命', '二命', '三命', '四命', '五命', '六命']
  return []
}

/** 路径 → 可放进 CSS 属性选择器的字面量（优先用 CSS.escape） */
function attrSelectorValue (value) {
  var s = String(value == null ? '' : value)
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 打开「从名称库选」并写回模型 */
function openRefPickerFor (kind, path) {
  if (typeof window.Picker === 'undefined') { showStatus('选择器组件没加载（/picker.js 404？）', 'error', true); return }
  var el = document.querySelector('#form [data-ref-kind="' + kind + '"][data-path="' + attrSelectorValue(path) + '"]')
  var current = el ? el.value : str(getPath(state.model, path))
  var label = REF_KINDS[kind] ? REF_KINDS[kind].text : kind
  window.Picker.openRef({
    title: '从名称库选' + label + '（共 ' + candidatesFor(kind).length + ' 个候选）',
    candidates: candidatesFor(kind),
    value: current,
    onPick: function (name) {
      if (el) el.value = name
      if (applyRef({ path: path, kind: kind, value: name })) {
        markDirty(true)
        renderForm()
        showStatus('已选择：' + label + '「' + name + '」', 'ok')
      }
    }
  })
}

/** 把某个引用输入框的文本写进模型（含 name/ref），返回是否发生变化
 *  参数可以是 DOM 元素，也可以是 { path, kind, value }（自动化检查用） */
function applyRef (el) {
  var spec = (el && typeof el.getAttribute === 'function')
    ? { path: el.getAttribute('data-path'), kind: el.getAttribute('data-ref-kind'), value: el.value }
    : (el || {})
  var path = spec.path
  var kind = spec.kind
  if (!path || !kind) return false
  var val = String(spec.value == null ? '' : spec.value).trim()
  var before = str(getPath(state.model, path))
  if (before === val) return false
  setPath(state.model, path, val)
  var parentPath = path.replace(/\.[^.]+$/, '')
  var parent = getPath(state.model, parentPath)
  if (!parent) return true
  if (kind === 'constellation') {
    parent.index = constellationIndex(val)
    if (!val) delete parent.ref
    else parent.ref = 'constellation:' + (parent.index || val)
  } else {
    if (!val) delete parent.ref
    else parent.ref = kind + ':' + val
  }
  return true
}

/* ============================================================ 回收站 */

/** 抽屉里的回收站面板骨架（内容由 renderTrash 填充） */
function trashPanelHtml () {
  return '<div class="tool-row"><span class="muted" id="trash-count"></span>' +
    '<span class="spacer"></span>' +
    '<button type="button" class="btn mini danger" id="btn-trash-empty" title="把回收站里的角色全部彻底删除（不可撤销）">清空回收站</button>' +
    '</div>' +
    '<div id="trash-list" class="trash-list"></div>'
}

/**
 * 打开回收站（抽屉页签）：列出 data/_trash/ 里被软删除的角色，
 * 支持「恢复」（移回 data/gi/ 并把名字补回 _order.json 末尾）/「彻底删除」/「清空」。
 * 三个写操作都要二次确认；恢复撞名时服务端返回 409，这里给出中文提示。
 */
function openTrash () {
  openDrawer('trash')
}

function closeTrash () {
  closeDrawer()
}

function renderTrash () {
  var box = $('trash-list')
  var countEl = $('trash-count')
  if (!box) return
  box.innerHTML = '<div class="muted" style="padding:8px">读取中…</div>'
  api('GET', '/api/trash').then(function (data) {
    var items = asArray(data.items)
    if (countEl) countEl.textContent = '共 ' + items.length + ' 个（data/_trash/）'
    if (!items.length) {
      box.innerHTML = '<div class="empty-trash muted">回收站是空的。删除角色时会先移到这里，可以随时恢复。</div>'
      return
    }
    box.innerHTML = items.map(function (it) {
      var s = it.summary || {}
      var meta = []
      if (s.weapons) meta.push('武 ' + s.weapons)
      if (s.artifacts) meta.push('圣 ' + s.artifacts)
      if (s.teams) meta.push('配队 ' + s.teams)
      if (s.constellations) meta.push('命座 ' + s.constellations)
      return '<div class="trash-item' + (it.broken ? ' broken' : '') + '">' +
        '<div class="ti-main">' +
        '<div class="ti-name">' + esc(it.name) + (it.broken ? ' <span class="warn-chip" title="这个文件不是合法 JSON，恢复后需要手工修复">⚠</span>' : '') + '</div>' +
        '<div class="ti-meta muted">删除时间 ' + esc(String(it.deletedAt).replace('T', ' ').slice(0, 19)) +
        ' · ' + Math.max(1, Math.round((it.bytes || 0) / 1024)) + ' KB' +
        (meta.length ? ' · ' + meta.join(' / ') : '') +
        (it.conflicts ? ' · <span class="warn-chip" title="data/gi/ 里已有同名文件，恢复会失败">⚠ 同名已存在</span>' : '') +
        '</div></div>' +
        '<div class="ti-btns">' +
        '<button type="button" class="btn mini primary" data-trt="restore" data-name="' + esc(it.name) + '">恢复</button>' +
        '<button type="button" class="btn mini danger" data-trt="delete" data-name="' + esc(it.name) + '">彻底删除</button>' +
        '</div></div>'
    }).join('')
  }).catch(function (e) {
    box.innerHTML = '<div class="muted" style="padding:8px">读取回收站失败：' + esc(e.message) + '</div>'
  })
}

/** 恢复一个：二次确认 → POST /api/trash/restore → 刷新列表与角色清单 */
function trashRestore (name) {
  return modal({
    title: '恢复角色',
    message: '把「' + name + '.json」从回收站移回 data/gi/，并把名字补回 _order.json 末尾。继续吗？',
    okText: '恢复'
  }).then(function (yes) {
    if (!yes) return null
    return api('POST', '/api/trash/restore', { name: name }).then(function (res) {
      return refreshIndex().then(refreshList).then(function () {
        renderTrash()
        var idxNote = res.indexRefreshed ? '，索引已刷新' : ''
        showStatus('已恢复 ' + name + '（移回 data/gi/，并补回 _order.json）' + idxNote, 'ok', true)
        toast('已恢复角色', [name + '.json 已回到 data/gi/', '名字已补回 _order.json 末尾'])
        return res
      })
    }).catch(function (e) {
      showStatus('恢复失败：' + e.message, 'error', true)
      return null
    })
  })
}

/** 彻底删除一个：二次确认 */
function trashDeleteForever (name) {
  return modal({
    title: '彻底删除（不可撤销）',
    message: '会把 data/_trash/' + name + '.json 直接删掉，之后无法恢复。确定吗？',
    okText: '彻底删除',
    danger: true
  }).then(function (yes) {
    if (!yes) return null
    return api('DELETE', '/api/trash?name=' + encodeURIComponent(name)).then(function (res) {
      renderTrash()
      showStatus('已彻底删除 ' + name, 'ok', true)
      return res
    }).catch(function (e) {
      showStatus('删除失败：' + e.message, 'error', true)
      return null
    })
  })
}

/** 清空回收站：二次确认 → DELETE /api/trash */
function trashEmpty () {
  return api('GET', '/api/trash').then(function (data) {
    var items = asArray(data.items)
    if (!items.length) {
      showStatus('回收站已经是空的', 'warn')
      return null
    }
    return modal({
      title: '清空回收站（不可撤销）',
      message: '会彻底删除回收站里的 ' + items.length + ' 个角色：' + items.map(function (i) { return i.name }).slice(0, 8).join('、') +
        (items.length > 8 ? ' 等' : '') + '。这一步无法撤销，确定吗？',
      okText: '清空（' + items.length + ' 个）',
      danger: true
    }).then(function (yes) {
      if (!yes) return null
      return api('DELETE', '/api/trash').then(function (res) {
        renderTrash()
        showStatus('已清空回收站（删除 ' + res.removed + ' 个）', 'ok', true)
        toast('已清空回收站', ['彻底删除 ' + res.removed + ' 个角色：' + asArray(res.names).slice(0, 8).join('、')])
        return res
      }).catch(function (e) {
        showStatus('清空失败：' + e.message, 'error', true)
        return null
      })
    })
  })
}

/* ============================================== 心跳 / 关闭服务（空闲自动退出） */

var HEARTBEAT_MS = 5000
var heartbeatTimer = null
var serverClosed = false

/**
 * 每 5 秒给服务端一次心跳，让它知道「页面还开着」。
 * 服务端只有带 --exit-on-idle 时才真的用这个信号（否则只是 200 no-op，命令行用户行为不变）。
 *
 * ⚠ **切到后台也照发**（以前这里遇到 visibilityState === 'hidden' 就 `return`，于是
 *   "切到别的窗口看一会儿" 会被服务端当成"人走了"，20 秒后把服务杀掉，切回来就是
 *   「预览失败 / 保存失败：Failed to fetch」）。现在隐藏时也发，并在心跳体里带 `hidden: true`，
 *   服务端据此把阈值放宽（浏览器会给后台标签页的定时器降频，不能只靠这里的 5 秒定时器）。
 *   真正关窗口仍由 pagehide 的 `/api/close` 负责，服务端 5 秒后收掉。
 */
function startHeartbeat () {
  if (heartbeatTimer) return
  var beat = function () {
    if (serverClosed) return
    var hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    api('POST', '/api/heartbeat', { hidden: hidden }).catch(function () { /* 服务已经关了，静默 */ })
  }
  beat()
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS)
  // 切前台 / 切后台的瞬间各补一次：立刻把最新的 hidden 状态告诉服务端
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', beat)
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', beat)
  }
}

/** 问一次服务端：有没有开空闲自动退出？有就提示用户 */
function checkIdleExit () {
  return api('POST', '/api/heartbeat', {}).then(function (res) {
    if (res && res.exitOnIdle) {
      state.idleExit = res.idleSeconds || 20
      showStatus('服务已开启空闲自动退出：关掉网页约 ' + state.idleExit + ' 秒后自动结束（多标签页只要有一个还在就不会退）', 'ok', true)
    }
    return res
  }).catch(function () { return null })
}

/**
 * 通知服务端「页面要关了」：用 sendBeacon 保证卸载时也能发出去。
 * 服务端收到后等 5 秒再退，5 秒内又来心跳（刷新/马上重开）就取消 —— 所以刷新不会误杀服务。
 */
function signalClose (manual) {
  serverClosed = true
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  var url = '/api/close'
  try {
    if (!manual && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      return navigator.sendBeacon(url)   // 卸载路径：beacon 不阻塞页面关闭
    }
  } catch (e) { /* 退回到 fetch */ }
  return api('POST', url, {}).catch(function () { return null })
}

/** 界面上手动「关闭服务」：二次确认后调 /api/close */
function closeServerManually () {
  return modal({
    title: '关闭编辑器服务',
    message: '会停掉后台的 node 服务（页面随后就打不开了）。已保存的数据不受影响，下次双击快捷方式即可重新启动。确定吗？',
    okText: '关闭服务',
    danger: true
  }).then(function (yes) {
    if (!yes) return null
    showStatus('已发送关闭信号，服务即将退出…', 'warn', true)
    return api('POST', '/api/close', {}).then(function () {
      toast('编辑器服务正在关闭', ['后台 node 进程会在几秒内结束', '要再次打开：双击桌面「打开攻略编辑器」'])
      return true
    }).catch(function () {
      toast('编辑器服务已关闭', ['连接已断开（服务应该已经退出）'])
      return false
    })
  })
}

/* ============================================================ 实时预览 */

var previewTimer = null
var previewLast = null

/** 打开 / 收起预览面板（右侧） */
function togglePreview (on) {
  var el = $('preview')
  if (!el) return
  var next = on === undefined ? el.classList.contains('hidden') : !!on
  state.previewOpen = next
  el.className = 'preview' + (next ? '' : ' hidden')
  if (next) renderPreviewNow()
}

/** 延迟渲染（编辑时每 400ms 最多一次，避免每敲一个字都打接口） */
function renderPreviewSoon () {
  if (!state.previewOpen) return
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(renderPreviewNow, 400)
}

/**
 * 调 /api/preview 拿渲染结果。
 * 服务端用的是与面板 / 网页版**同一份显示归一**（scripts/lib/guide-display.mjs），
 * 所以这里看到的就是最终效果；接口幂等、不改数据。
 */
function renderPreviewNow () {
  var box = $('preview-body')
  if (!box) return
  if (!state.current || !state.model) {
    box.innerHTML = '<div class="muted" style="padding:10px">先选一个角色。</div>'
    return
  }
  syncRefInputs()
  var body = buildBody()
  var token = String(Date.now()) + Math.random()
  previewLast = token
  box.innerHTML = '<div class="muted" style="padding:10px">渲染中…</div>'
  api('POST', '/api/preview', body).then(function (res) {
    if (previewLast !== token) return   // 有更新的请求了，丢弃这次结果
    previewLast = res
    var nameEl = $('preview-name')
    if (nameEl) nameEl.textContent = state.current + (asArray(res.issues).length ? '（⚠ ' + res.issues.length + ' 处名称待确认）' : '')
    if (state.previewText) {
      box.innerHTML = '<pre class="preview-lines">' + esc(asArray(res.lines).join('\n')) + '</pre>'
    } else {
      box.innerHTML = '<div class="guide-preview">' + res.html + '</div>'
    }
  }).catch(function (e) {
    if (previewLast !== token) return
    box.innerHTML = '<div class="muted" style="padding:10px">预览失败：' + esc(e.message) + '</div>'
  })
}

/** 切换「渲染视图 / 逐行文本」 */
function togglePreviewText () {
  state.previewText = !state.previewText
  var btn = $('btn-preview-text')
  if (btn) btn.textContent = state.previewText ? '渲染视图' : '逐行文本'
  renderPreviewNow()
}

function globalEvents () {
  $('search').addEventListener('input', function (e) {
    state.filter = e.target.value
    renderList()
  })

  $('list').addEventListener('click', function (e) {
    var item = e.target.closest ? e.target.closest('.list-item') : null
    if (!item) return
    var name = item.getAttribute('data-name')
    if (!name) return
    selectCharacter(name).catch(function (err) { showStatus('打开失败：' + err.message, 'error', true) })
  })

  $('btn-save').addEventListener('click', function () { save() })

  $('btn-new').addEventListener('click', function () {
    modal({ title: '新增角色', message: '输入角色名（将创建 data/gi/<角色名>.json）', input: true, placeholder: '如 娜维娅', okText: '创建' })
      .then(function (name) {
        if (!name) return
        return api('POST', '/api/character', { name: name }).then(function (res) {
          return refreshIndex().then(refreshList).then(function () { return res })
        }).then(function (res) {
          return openCharacter(name).then(function () {
            var idxNote = (res && res.indexRefreshed) ? '，索引已刷新' : ''
            var idxWarn = (res && res.indexWarning) ? '；' + res.indexWarning : ''
            showStatus('已创建 ' + name + '.json（空白 v2 模板）' + idxNote + idxWarn, idxWarn ? 'warn' : 'ok', !!idxWarn)
          })
        })
      })
      .catch(function (e) { showStatus('新增失败：' + e.message, 'error', true) })
  })

  $('btn-rename').addEventListener('click', function () {
    if (!state.current) return
    var from = state.current
    modal({ title: '重命名角色', message: '同时改文件名和 _order.json：' + from, input: true, value: from, okText: '重命名' })
      .then(function (to) {
        if (!to || to === from) return
        return api('POST', '/api/rename', { from: from, to: to }).then(function (res) {
          state.current = null
          state.model = null
          markDirty(false)
          return refreshIndex().then(refreshList).then(function () { return res })
        }).then(function (res) {
          return openCharacter(to).then(function () {
            var idxNote = (res && res.indexRefreshed) ? '，索引已刷新' : ''
            var idxWarn = (res && res.indexWarning) ? '；' + res.indexWarning : ''
            showStatus('已重命名为 ' + to + idxNote + idxWarn, idxWarn ? 'warn' : 'ok', !!idxWarn)
          })
        })
      })
      .catch(function (e) { showStatus('重命名失败：' + e.message, 'error', true) })
  })

  $('btn-delete').addEventListener('click', function () {
    if (!state.current) return
    var name = state.current
    modal({
      title: '删除角色',
      message: '会把 ' + name + '.json 移到 data/_trash/（可从那里恢复），并从 _order.json 移除。确定吗？',
      okText: '删除',
      danger: true
    }).then(function (yes) {
      if (!yes) return
      return api('DELETE', '/api/character?name=' + encodeURIComponent(name)).then(function (res) {
        state.current = null
        state.model = null
        $('form').className = 'form hidden'
        $('form').innerHTML = ''
        $('empty').className = 'empty'
        $('current-name').textContent = '未选择角色'
        markDirty(false)
        hideStatus()
        return refreshIndex().then(refreshList).then(function () {
          var idxNote = (res && res.indexRefreshed) ? '，索引已刷新' : ''
          var idxWarn = (res && res.indexWarning) ? '；' + res.indexWarning : ''
          showStatus('已删除 ' + name + '（移入 data/_trash/）' + idxNote + idxWarn, idxWarn ? 'warn' : 'ok', !!idxWarn)
        })
      })
    }).catch(function (e) { showStatus('删除失败：' + e.message, 'error', true) })
  })

  $('btn-up').addEventListener('click', function () { reorderBy(-1) })
  $('btn-down').addEventListener('click', function () { reorderBy(1) })

  /* ------------------------------------------------ 全局搜索框（顶栏） */
  $('gsearch').addEventListener('input', function () {
    if (gTimer) clearTimeout(gTimer)
    gTimer = setTimeout(globalSearchNow, 220)
  })
  $('gsearch').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); if (gTimer) clearTimeout(gTimer); globalSearchNow() }
    else if (e.key === 'Escape') showGResults('')
  })
  $('gresults').addEventListener('click', function (e) {
    var t = e.target
    var btn = t && t.closest ? t.closest('[data-g]') : null
    if (!btn) return
    e.preventDefault()
    var act = btn.getAttribute('data-g')
    if (act === 'close') { showGResults(''); return }
    if (act === 'jump') { jumpTo(btn.getAttribute('data-name'), btn.getAttribute('data-row')); return }
    if (act === 'usage') {
      var g = gLast.names[Number(btn.getAttribute('data-gi'))]
      if (g) showUsageDetail(g.type, g.name)
      return
    }
    if (act === 'batch') {
      var g2 = gLast.names[Number(btn.getAttribute('data-gi'))]
      if (!g2) return
      state.batch = { type: g2.type, from: g2.name, to: '', preview: null }
      openTools('batch')
      showGResults('')
    }
  })

  /* ------------------------------------------------ 右侧抽屉（更多工具） */
  $('btn-drawer').addEventListener('click', function () { state.drawerOpen ? closeDrawer() : openDrawer() })
  $('btn-drawer-close').addEventListener('click', function () { closeDrawer() })
  $('drawer-mask').addEventListener('click', function () { closeDrawer() })
  $('drawer-tabs').addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.getAttribute) return
    var tab = t.getAttribute('data-drawer')
    if (tab) openDrawer(tab)
  })
  $('drawer').addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.getAttribute) return
    var trt = t.getAttribute('data-trt')
    if (trt === 'restore') { trashRestore(t.getAttribute('data-name')); return }
    if (trt === 'delete') { trashDeleteForever(t.getAttribute('data-name')); return }
    var undo = t.getAttribute('data-undo')
    if (undo) { batchUndo(undo); return }
    var libName = t.getAttribute('data-libname')
    if (libName) {
      state.library.selected = libName
      renderLibraryList()
      renderLibraryDetail(libName)
      return
    }
    var libBatch = t.getAttribute('data-libbatch')
    if (libBatch) {
      state.batch = { type: state.library.type, from: libBatch, to: '', preview: null }
      openTools('batch')
      return
    }
    var jump = t.closest ? t.closest('[data-g="jump"]') : null
    if (jump) { e.preventDefault(); jumpTo(jump.getAttribute('data-name'), jump.getAttribute('data-row')); return }
    var bjump = t.closest ? t.closest('[data-batch-jump]') : null
    if (bjump) { e.preventDefault(); jumpTo(bjump.getAttribute('data-name'), bjump.getAttribute('data-row')) }
  })
  $('drawer').addEventListener('click', function (e) {
    var t = e.target
    if (!t) return
    var libTab = t.getAttribute ? t.getAttribute('data-lib') : null
    if (libTab) { state.library.type = libTab; state.library.selected = null; renderDrawer(); return }
    var id = t.id
    if (id === 'tools-search') runToolsSearch()
    else if (id === 'batch-preview') batchPreview()
    else if (id === 'batch-run') batchRun()
    else if (id === 'lib-refresh') { loadUsage(true).then(function () { renderLibraryList() }) }
    else if (id === 'btn-trash-empty') trashEmpty()
  })
  $('drawer').addEventListener('input', function (e) {
    var t = e.target
    if (!t || !t.id) return
    if (t.id === 'lib-filter') {
      state.library.filter = t.value
      renderLibraryList()
      return
    }
    if (t.id === 'batch-from' || t.id === 'batch-to') syncBatchForm()
  })
  $('drawer').addEventListener('change', function (e) {
    if (e.target && e.target.id === 'batch-type') {
      syncBatchForm()
      state.batch.preview = null
      renderDrawer()
    }
  })
  $('drawer').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return
    var t = e.target
    if (!t || !t.id) return
    if (t.id === 'tools-q') { e.preventDefault(); runToolsSearch() }
    else if (t.id === 'batch-from' || t.id === 'batch-to') { e.preventDefault(); batchPreview() }
    else if (t.id === 'lib-filter') { e.preventDefault(); renderLibraryList() }
  })

  $('btn-publish').addEventListener('click', function () { publish() })
  if ($('btn-publish-all')) $('btn-publish-all').addEventListener('click', function () { saveAndPublish() })

  /* ------------------------------------------------ 回收站（在抽屉里，事件见上） */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    if (state.drawerOpen) { e.preventDefault(); closeDrawer(); return }
    if (state.previewOpen) { e.preventDefault(); togglePreview(false) }
  })

  /* ------------------------------------------------ 实时预览 */
  $('btn-preview').addEventListener('click', function () { togglePreview() })
  $('btn-preview-close').addEventListener('click', function () { togglePreview(false) })
  $('btn-preview-refresh').addEventListener('click', function () { renderPreviewNow() })
  $('btn-preview-text').addEventListener('click', function () { togglePreviewText() })

  /* ------------------------------------------------ 快捷键 */
  document.addEventListener('keydown', function (e) {
    var key = String(e.key || '').toLowerCase()
    var mod = e.ctrlKey || e.metaKey
    if (mod && key === 's') {
      e.preventDefault()
      if (e.shiftKey) saveAndPublish()
      else save()
      return
    }
    if (mod && key === 'f') {
      e.preventDefault()
      $('gsearch').focus()
      $('gsearch').select()
      return
    }
    if (mod && key === 'p') {
      // Ctrl+P 默认是打印，这里改成实时预览
      e.preventDefault()
      togglePreview()
      return
    }
    // 角色列表：↑↓ 切换（输入框里不抢键）
    if (key === 'arrowdown' || key === 'arrowup') {
      var t = e.target
      var tag = t && t.tagName ? String(t.tagName).toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      var names = visibleListNames()
      if (!names.length) return
      e.preventDefault()
      var i = state.current ? names.indexOf(state.current) : -1
      var j = i < 0 ? (key === 'arrowdown' ? 0 : names.length - 1) : i + (key === 'arrowdown' ? 1 : -1)
      if (j < 0 || j >= names.length) return
      selectCharacter(names[j]).catch(function (err) { showStatus('打开失败：' + err.message, 'error', true) })
      var active = document.querySelector('#list .list-item.active')
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' })
      return
    }
    if (key === 'enter') {
      // 侧栏搜索框里回车 = 打开第一个匹配
      if (e.target && e.target.id === 'search') {
        var list = visibleListNames()
        if (list.length) { e.preventDefault(); selectCharacter(list[0]) }
      }
    }
  })

  window.addEventListener('beforeunload', function (e) {
    // 关页面 / 刷新都先给服务端一个关闭信号：它等 5 秒再退，刷新时新页面的心跳会把它取消
    signalClose(false)
    if (!state.dirty) return
    e.preventDefault()
    e.returnValue = ''
  })
  // pagehide 才是 iOS/Safari 与 bfcache 场景下真正会触发的事件
  window.addEventListener('pagehide', function () { signalClose(false) })

  if ($('btn-close-server')) $('btn-close-server').addEventListener('click', function () { closeServerManually() })
}

/** 工具箱 - 全局搜索 tab 的搜索按钮 */
function runToolsSearch () {
  var el = $('tools-q')
  if (!el) return
  state.gq = el.value.trim()
  var g = $('gsearch')
  if (g) g.value = state.gq
  if (!state.gq) { showStatus('请输入关键词', 'warn'); return }
  globalSearchNow()
}

/** 在当前 _order.json 顺序里上下移动选中角色 */
function reorderBy (delta) {
  if (!state.current) { showStatus('先选一个角色', 'warn'); return }
  var order = state.items.map(function (it) { return it.name })
  var i = order.indexOf(state.current)
  if (i < 0) { showStatus('这个角色不在清单里，刷新后重试', 'warn'); return }
  var j = i + delta
  if (j < 0 || j >= order.length) { showStatus('已经到头了', 'warn'); return }
  var tmp = order[i]; order[i] = order[j]; order[j] = tmp
  api('POST', '/api/reorder', { order: order }).then(function (res) {
    state.order = asArray(res && res.order)
    return refreshList().then(function () {
      renderList()
      showStatus('已更新 _order.json（' + state.current + ' → 第 ' + (j + 1) + ' 位）', 'ok')
    })
  }).catch(function (e) { showStatus('排序失败：' + e.message, 'error', true) })
}

/* ============================================================ 启动 */

function boot () {
  formEvents()
  globalEvents()
  checkIdleExit()   // 先在状态条里说清楚「关掉网页会不会自动退」
  startHeartbeat()  // 之后每 5 秒一次心跳（服务端没开 --exit-on-idle 时是 no-op）
  Promise.all([refreshIndex(), refreshList()])
    .then(function () {
      var withData = state.items.filter(function (it) { return it.weapons || it.artifacts })[0]
      var first = withData || state.items[0]
      if (first) return openCharacter(first.name)
    })
    .catch(function (e) {
      showStatus('初始化失败：' + e.message, 'error', true)
    })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()

/* 供手工调试 / 自动化检查 */
window.__editor = {
  state: state,
  save: save,
  publish: publish,
  refreshList: refreshList,
  refreshIndex: refreshIndex,
  loadUsage: loadUsage,
  openCharacter: openCharacter,
  selectCharacter: selectCharacter,
  reorderBy: reorderBy,
  globalSearchNow: globalSearchNow,
  openTools: openTools,
  batchPreview: batchPreview,
  batchRun: batchRun,
  batchUndo: batchUndo,
  openMemberPicker: openMemberPicker,
  openSlotCandidates: openSlotCandidates,
  // 纯函数（供自动化检查：天赋三格 / 候选并格 / 落盘形状）
  talentSlots: talentSlots,
  talentLevelText: talentLevelText,
  setTalentSlotLevel: setTalentSlotLevel,
  foldCrownRows: foldCrownRows,
  rowVisible: rowVisible,
  multiValue: multiValue,
  statKindOfPath: statKindOfPath,
  memberCandidates: memberCandidates,
  joinCandidates: joinCandidates,
  STAT_CANDIDATES: STAT_CANDIDATES,
  /** 供自动化检查：把合成模型直接塞进状态（不联网、不读文件），配合 toJson 验证落盘形状 */
  setModelForTest: function (model) {
    state.model = model
    state.current = str(model && model.name) || '自检'
    state.before = null
    return state.model
  },
  syncRefInputs: syncRefInputs,
  toJson: buildBody,
  openRefPickerFor: openRefPickerFor,
  jumpTo: jumpTo,
  focusRow: focusRow,
  toast: toast,
  openTrash: openTrash,
  closeTrash: closeTrash,
  renderTrash: renderTrash,
  trashRestore: trashRestore,
  trashDeleteForever: trashDeleteForever,
  trashEmpty: trashEmpty,
  startHeartbeat: startHeartbeat,
  checkIdleExit: checkIdleExit,
  signalClose: signalClose,
  closeServerManually: closeServerManually,
  internals: {
    normalizeData: normalizeData,
    buildBody: buildBody,
    renderForm: renderForm,
    renderList: renderList,
    renderTeamsHtml: renderTeamsHtml,
    handleAction: handleAction,
    applyRef: applyRef,
    constellationIndex: constellationIndex,
    snapshotShape: snapshotShape,
    diffSummary: diffSummary,
    memberPool: memberPool,
    moveMemberAt: moveMemberAt,
    visibleListNames: visibleListNames,
    candidatesFor: candidatesFor
  }
}
