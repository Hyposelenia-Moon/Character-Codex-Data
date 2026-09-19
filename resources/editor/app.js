/* 角色攻略编辑器 —— 原生 JS，无框架、无外部依赖 */
'use strict'

/* ============================================================ 常量 / 状态 */

var TALENTS = ['A', 'E', 'Q']
var TIERS = [1, 2, 3, 4, 5, 6]
var CN_NUM = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' }

var ARTIFACT_KINDS = [
  { value: 'preferred', label: '首选' },
  { value: 'transition', label: '过渡' },
  { value: 'optional', label: '可选' },
  { value: 'main', label: '主词条' },
  { value: 'sub', label: '副词条' },
  { value: 'text', label: '文本' }
]

var REF_KINDS = {
  weapon: { type: 'weapon', list: 'dl-weapon', icon: '⚔', text: '武器' },
  artifact: { type: 'artifact', list: 'dl-artifact', icon: '❖', text: '圣遗物' },
  character: { type: 'character', list: 'dl-character', icon: '☺', text: '角色' }
}

var MAIN_SLOTS = ['时之沙', '空之杯', '理之冠']

var state = {
  index: { weapons: [], artifacts: [], characters: [] },
  order: [],
  missing: [],
  items: [],
  current: null,
  model: null,
  issues: [],
  issueMap: {},
  dirty: false,
  filter: ''
}

var $ = function (id) { return document.getElementById(id) }

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
  return {
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
        } else if (kind === 'sub') {
          row.stats = asArray(r && r.stats).map(str)
        } else if (kind === 'text') {
          row.text = str(r && r.text)
        } else {
          row.sets = asArray(r && r.sets).map(function (s) { return { name: str(s && s.name), pieces: str(s && s.pieces) } })
        }
        return row
      }),
      talents: asArray(v2.talents).map(function (r) {
        if (r && r.kind === 'priority') {
          return { kind: 'priority', order: asArray(r.order).map(function (it) { return str(it && it.name).toUpperCase() }) }
        }
        return {
          kind: 'crown',
          items: asArray(r && r.items).map(function (it) { return { name: str(it && it.name).toUpperCase(), level: str(it && it.level) } })
        }
      }),
      panels: asArray(v2.panels).map(function (r) {
        if (r && hasText(str(r.k))) return { label: str(r.label), k: str(r.k), v: str(r.v) }
        return { label: str(r && r.label), text: str(r && r.text) }
      }),
      constellations: asArray(v2.constellations).map(function (r) {
        return { name: str(r && r.name), text: str(r && r.text) }
      }),
      teams: asArray(v2.teams).map(function (r) {
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

function markDirty (on) {
  state.dirty = !!on
  $('dirty').className = state.dirty ? 'dirty' : 'dirty hidden'
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

/** 类型徽标 + 带 datalist 的输入 + ⚠ 提示 */
function refField (kind, value, path) {
  var k = REF_KINDS[kind]
  var ref = kind + ':' + str(value).trim()
  var issue = state.issueMap[ref]
  var warn = issue
    ? '<span class="warn-chip" title="' + esc(issue) + '">⚠</span>'
    : ''
  return '<span class="ref-wrap">' +
    '<span class="ref-field">' +
    '<span class="badge ' + kind + '" title="' + esc(k.text) + '"><span class="badge-icon">' + k.icon + '</span>' + esc(k.text) + '</span>' +
    '<input type="text" list="' + k.list + '" value="' + esc(value) + '" data-path="' + esc(path) + '" data-ref-kind="' + kind + '">' +
    '</span>' + warn + '</span>'
}

/** 天赋 A/E/Q 下拉（带徽标） */
function talentField (value, path, extraClass) {
  var name = str(value).toUpperCase()
  if (TALENTS.indexOf(name) === -1) name = 'A'
  var issue = state.issueMap['talent:' + name]
  var opts = TALENTS.map(function (t) {
    return '<option value="' + t + '"' + (t === name ? ' selected' : '') + '>' + t + '</option>'
  }).join('')
  return '<span class="ref-wrap">' +
    '<span class="ref-field">' +
    '<span class="badge talent" title="天赋"><span class="badge-icon">✦</span>天赋</span>' +
    '<select class="' + (extraClass || '') + '" data-path="' + esc(path) + '" data-ref-kind="talent">' + opts + '</select>' +
    '</span>' + (issue ? '<span class="warn-chip" title="' + esc(issue) + '">⚠</span>' : '') + '</span>'
}

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

function tierLabel (tier) {
  var n = Number(tier)
  return CN_NUM[n] ? '第' + CN_NUM[n] + '档' : String(tier)
}

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
  switch (row.kind) {
    case 'main':
      return MAIN_SLOTS.some(function (slot) { return asArray(row.stats && row.stats[slot]).length > 0 })
    case 'sub':
      return asArray(row.stats).length > 0
    case 'text':
      return hasText(row.text) || hasText(row.label)
    case 'priority':
      return asArray(row.order).length > 0
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
  var hidden = list.length - visibleRows(list).length
  if (hidden <= 0) return ''
  return '<div class="muted" style="font-size:12px;margin:6px 0 0">已隐藏 ' + hidden + ' 个空占位行（旧数据里的待填行，保存时原样保留；点「删除行」可清掉）</div>'
}

/** 行列表：rows → html 拼接 + 尾部「新增一行」按钮 */
function rowList (path, rows, renderRow, addLabel) {
  var visible = visibleRows(rows)
  var html = visible.map(function (v) { return renderRow(v.row, v.i, path + '.' + v.i) }).join('')
  var body = visible.length ? html : emptyNote('还没有' + addLabel + '，点下面的按钮新增')
  return '<div class="row-list">' + body + '</div>' +
    '<div style="margin-top:8px">' + actBtn('add-row', path, '＋ ' + addLabel, 'btn mini') + '</div>' + hiddenNote(rows)
}

function emptyNote (text) {
  return '<div class="muted" style="padding:6px 2px;font-size:13px">' + esc(text) + '</div>'
}

/** 多值输入：chips + 「＋」 */
function multiValue (label, path, values, placeholder) {
  var chips = asArray(values).map(function (v, i) {
    return '<span class="mv-chip">' + esc(v) +
      actBtn('del-item', path, '×', 'row-del', '删除这一项', i) + '</span>'
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
  var body = rowList('v2.weapons', s.weapons, function (row, i, p) {
    var items = row.items.map(function (it, j) {
      var q = p + '.items.' + j
      return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        refField('weapon', it.name, q + '.name') +
        '<input type="text" class="w-sm" data-path="' + q + '.note" value="' + esc(it.note) + '" placeholder="备注（如 精5）">' +
        actBtn('del-item', p + '.items', '×', 'row-del', '删除这个条目', j) +
        '</div>'
    }).join('')
    return '<div class="box">' +
      '<div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="标签（可空，如 辅助向）">' +
      selectBox(p + '.tier', row.tier === null ? '' : row.tier, [{ value: '', label: '档位：不标' }].concat(TIERS.map(function (t) { return { value: t, label: tierLabel(t) } })), 'w-sm') +
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
  var body = rowList('v2.artifacts', s.artifacts, function (row, i, p) {
    var head = '<div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      selectBox(p + '.kind', row.kind, ARTIFACT_KINDS, 'w-sm') +
      (row.kind === 'main' ? '' : '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="标签（可空，如 输出向）">') +
      '<span class="spacer"></span>' +
      actBtn('move-row-up', 'v2.artifacts', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.artifacts', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.artifacts', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>'

    var body2 = ''
    if (row.kind === 'main') {
      body2 = '<div class="grid-3">' + MAIN_SLOTS.map(function (slot) {
        return multiValue(slot, p + '.stats.' + slot, row.stats[slot], '如 攻击力')
      }).join('') + '</div>'
    } else if (row.kind === 'sub') {
      body2 = multiValue('副词条（按优先级从左到右）', p + '.stats', row.stats, '如 双爆')
    } else if (row.kind === 'text') {
      body2 = '<div class="field"><span>文本</span>' +
        '<textarea data-path="' + p + '.text" placeholder="自由文本，会原样出现在旧版输出里">' + esc(row.text) + '</textarea></div>'
    } else {
      var sets = (row.sets || []).map(function (set, j) {
        var q = p + '.sets.' + j
        return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          refField('artifact', set.name, q + '.name') +
          '<input type="text" class="w-xs" data-path="' + q + '.pieces" value="' + esc(set.pieces) + '" placeholder="件数">' +
          actBtn('del-item', p + '.sets', '×', 'row-del', '删除这个套装', j) +
          '</div>'
      }).join('')
      body2 = '<div class="sub-list">' + (sets || '<div class="muted" style="font-size:12px">还没有套装</div>') + '</div>' +
        '<div style="margin-top:6px">' + actBtn('add-item', p + '.sets', '＋ 套装', 'btn mini') + '</div>'
    }
    return '<div class="box">' + head + body2 + '</div>'
  }, '圣遗物行')
  return card('圣遗物推荐', s.artifacts.length + ' 行', body, true)
}

function renderTalents () {
  var s = state.model.v2
  var priorities = visibleRows(s.talents).filter(function (e) { return e.row.kind === 'priority' })
  var crowns = visibleRows(s.talents).filter(function (e) { return e.row.kind === 'crown' })

  var priBody
  if (!priorities.length) {
    priBody = emptyNote('还没有优先级行') + '<div style="margin-top:6px">' + actBtn('add-priority', 'v2.talents', '＋ 优先级', 'btn mini') + '</div>'
  } else {
    priBody = priorities.map(function (entry) {
      var row = entry.row
      var i = entry.i
      var p = 'v2.talents.' + i
      var steps = row.order.map(function (t, j) {
        return '<span class="talent-row" style="gap:2px">' +
          '<span class="idx">' + (j + 1) + '</span>' +
          talentField(t, p + '.order.' + j + '.name', 'w-xs') +
          actBtn('move-item-up', p + '.order', '↑', 'row-del', '前移', j) +
          actBtn('move-item-down', p + '.order', '↓', 'row-del', '后移', j) +
          actBtn('del-item', p + '.order', '×', 'row-del', '删除', j) +
          '</span>'
      }).join('<span class="muted"> &gt; </span>')
      return '<div class="box"><div class="box-head">' +
        '<span class="box-title">优先级（从左到右）</span><span class="spacer"></span>' +
        actBtn('add-item', p + '.order', '＋ 天赋', 'btn mini') +
        actBtn('del-row', 'v2.talents', '删除行', 'btn mini danger', '删除这一行', i) +
        '</div><div class="talent-row" style="flex-wrap:wrap">' + steps + '</div></div>'
    }).join('')
    priBody += '<div style="margin-top:8px">' + actBtn('add-priority', 'v2.talents', '＋ 再加一条优先级', 'btn mini') + '</div>'
  }

  var crownBody
  if (!crowns.length) {
    crownBody = emptyNote('还没有皇冠行') + '<div style="margin-top:6px">' + actBtn('add-crown', 'v2.talents', '＋ 皇冠', 'btn mini') + '</div>'
  } else {
    crownBody = crowns.map(function (entry) {
      var row = entry.row
      var i = entry.i
      var p = 'v2.talents.' + i
      var items = row.items.map(function (it, j) {
        var q = p + '.items.' + j
        return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          talentField(it.name, q + '.name') +
          '<input type="text" class="w-sm" data-path="' + q + '.level" value="' + esc(it.level) + '" placeholder="等级文本（如 建议/必须）">' +
          actBtn('del-item', p + '.items', '×', 'row-del', '删除', j) +
          '</div>'
      }).join('')
      return '<div class="box"><div class="box-head">' +
        '<span class="box-title">皇冠</span><span class="spacer"></span>' +
        actBtn('add-item', p + '.items', '＋ 天赋', 'btn mini') +
        actBtn('del-row', 'v2.talents', '删除行', 'btn mini danger', '删除这一行', i) +
        '</div><div class="sub-list">' + items + '</div></div>'
    }).join('')
    crownBody += '<div style="margin-top:8px">' + actBtn('add-crown', 'v2.talents', '＋ 再加一条皇冠', 'btn mini') + '</div>'
  }

  var body = '<div style="font-size:12px;color:var(--text-soft);margin-bottom:6px">优先级</div>' + priBody +
    '<div style="font-size:12px;color:var(--text-soft);margin:12px 0 6px">皇冠</div>' + crownBody
  return card('天赋加点', s.talents.length + ' 行', body, true)
}

function renderPanels () {
  var s = state.model.v2
  var body = rowList('v2.panels', s.panels, function (row, i, p) {
    var isText = !hasText(row.k)
    var head = '<div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="标签（可空，如 辅助向）">' +
      '<span class="spacer"></span>' +
      actBtn('panel-to-text', p, isText ? '改成 键+值' : '改成纯文本', 'btn mini') +
      actBtn('move-row-up', 'v2.panels', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.panels', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.panels', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>'
    var body2 = isText
      ? '<input type="text" data-path="' + p + '.text" value="' + esc(row.text) + '" placeholder="纯文本">'
      : '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<label class="field" style="flex:0 0 220px"><span>键 k</span>' + plainInput(p + '.k', row.k, '', '如 暴击率') + '</label>' +
        '<label class="field" style="flex:1 1 260px"><span>值 v</span>' + plainInput(p + '.v', row.v, '', '如 70%+') + '</label>' +
        '</div>'
    return '<div class="box">' + head + body2 + '</div>'
  }, '面板行')
  return card('毕业面板参考', s.panels.length + ' 行', body, true)
}

function renderConstellations () {
  var s = state.model.v2
  var body = rowList('v2.constellations', s.constellations, function (row, i, p) {
    var idx = constellationIndex(row.name)
    return '<div class="box"><div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      constellationField(row.name, p + '.name') +
      (idx ? '<span class="muted" style="font-size:12px">序号 ' + idx + '</span>' : '') +
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
  var body = rowList('v2.teams', s.teams, function (row, i, p) {
    var members = row.members.map(function (m, j) {
      return '<span class="member">' + refField('character', m.name, p + '.members.' + j + '.name') +
        '<input type="text" class="member-note" data-path="' + p + '.members.' + j + '.note" value="' + esc(m.note || '') + '" placeholder="备注" title="括注备注（如 二命 / 高金），输出为「名称（备注）」">' +
        actBtn('del-item', p + '.members', '×', 'row-del', '移除成员', j) + '</span>'
    }).join('')
    return '<div class="box"><div class="box-head">' +
      '<span class="box-title">行 ' + (i + 1) + '</span>' +
      '<input type="text" class="w-sm" data-path="' + p + '.label" value="' + esc(row.label) + '" placeholder="标签（如 首选）">' +
      '<span class="spacer"></span>' +
      actBtn('move-row-up', 'v2.teams', '↑', 'btn mini', '上移', i) +
      actBtn('move-row-down', 'v2.teams', '↓', 'btn mini', '下移', i) +
      actBtn('del-row', 'v2.teams', '删除行', 'btn mini danger', '删除这一行', i) +
      '</div>' +
      '<div class="field"><span>成员（用角色名，自动带上角色图标引用）</span>' +
      '<div class="members">' + members + actBtn('add-member', p + '.members', '＋ 成员', 'btn mini') + '</div></div>' +
      '<div class="field" style="margin-top:8px"><span>文本' + (row.members.length ? '（成员之外的补充说明）' : '（没有拆成成员时，整行按文本输出）') + '</span>' +
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

function card (title, count, body, open, readonly) {
  return '<details class="card"' + (open ? ' open' : '') + '>' +
    '<summary>' + esc(title) +
    '<span class="spacer"></span>' +
    (count ? '<span class="count">' + esc(count) + '</span>' : '') +
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

/** 下拉候选 */
function renderDatalists () {
  var fill = function (id, list) {
    $(id).innerHTML = asArray(list).map(function (n) { return '<option value="' + esc(n) + '"></option>' }).join('')
  }
  fill('dl-weapon', state.index.weapons)
  fill('dl-artifact', state.index.artifacts)
  fill('dl-character', state.index.characters)
}

/* ============================================================ 加载 / 保存 */

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
      characters: asArray(data.characters)
    }
    renderDatalists()
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
    var val = el.value.trim()
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
    var out = { label: hasText(row.label) ? row.label : null }
    out.tier = row.tier
    out.items = row.items.filter(function (it) { return hasText(it.name) }).map(function (it) {
      var o = { name: it.name.trim(), ref: 'weapon:' + it.name.trim() }
      if (hasText(it.note)) o.note = it.note.trim()
      return o
    })
    return out
    // 完全空白的行不提交（旧数据里的空行由服务器 mergeV2 按位置带回来）
  }).filter(function (row) { return row.items.length > 0 })

  var artifacts = mv2.artifacts.map(function (row) {
    if (row.kind === 'main') {
      var stats = {}
      MAIN_SLOTS.forEach(function (slot) {
        stats[slot] = asArray(row.stats && row.stats[slot]).map(function (x) { return x.trim() }).filter(Boolean)
      })
      return { kind: 'main', stats: stats }
    }
    if (row.kind === 'sub') {
      var o2 = { kind: 'sub', stats: asArray(row.stats).map(function (x) { return x.trim() }).filter(Boolean) }
      if (row.sep) o2.sep = row.sep
      return o2
    }
    if (row.kind === 'text') return { kind: 'text', label: hasText(row.label) ? row.label : null, text: str(row.text) }
    var o3 = cleanRow(row)
    o3.kind = row.kind
    o3.sets = asArray(row.sets).filter(function (s) { return hasText(s.name) }).map(function (s) {
      var o = { name: s.name.trim(), ref: 'artifact:' + s.name.trim() }
      if (hasText(s.pieces)) o.pieces = s.pieces.trim()
      return o
    })
    return o3
  }).filter(function (row) {
    // 主词条行永远保留（旧数据里有整行留空的占位行，丢掉就是数据损失）
    if (row.kind === 'main') return true
    if (row.kind === 'sub') return row.stats.length > 0
    if (row.kind === 'text') return hasText(row.text)
    return row.sets.length || hasText(row.label)
  })

  var talents = mv2.talents.map(function (row) {
    if (row.kind === 'priority') {
      var order = row.order.filter(function (t) { return TALENTS.indexOf(t) >= 0 })
        .map(function (t) { return { name: t, ref: 'talent:' + t } })
      // 不带 raw：服务器会在顺序没变时原样保留原文件的写法（A＞E＞Q / E ≥ Q / E / Q 等）
      return { kind: 'priority', order: order }
    }
    var items = row.items.filter(function (it) { return TALENTS.indexOf(it.name) >= 0 }).map(function (it) {
      var o = { name: it.name, ref: 'talent:' + it.name }
      if (hasText(it.level)) o.level = it.level.trim()
      return o
    })
    return { kind: 'crown', items: items }
  }).filter(function (row) { return row.order ? row.order.length : row.items.length })

  var panels = mv2.panels.map(function (row) {
    var label = hasText(row.label) ? row.label : null
    if (hasText(row.k)) return { label: label, k: row.k.trim(), v: str(row.v).trim() }
    return { label: label, text: str(row.text).trim() }
  }).filter(function (row) { return hasText(row.k) || hasText(row.text) })

  var constellations = mv2.constellations.filter(function (row) { return hasText(row.name) }).map(function (row) {
    var idx = constellationIndex(row.name)
    return { name: row.name.trim(), index: idx, text: str(row.text).trim() }
  })

  var teams = mv2.teams.map(function (row) {
    var members = asArray(row.members).filter(function (m) { return hasText(m.name) }).map(function (m) {
      var o = { name: m.name.trim(), ref: 'character:' + m.name.trim() }
      if (hasText(m.note)) o.note = m.note.trim()
      return o
    })
    return { label: hasText(row.label) ? row.label : null, members: members, text: str(row.text).trim() }
  }).filter(function (row) { return row.members.length || hasText(row.text) || hasText(row.label) })

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
  var body = buildBody()
  showStatus('正在保存…', '', true)
  return api('PUT', '/api/character?name=' + encodeURIComponent(state.current), body).then(function (res) {
    state.issues = asArray(res && res.issues)
    state.issueMap = buildIssueMap(state.issues)
    markDirty(false)
    renderForm()
    // 保存后服务器会自动重建 data/_index.json（索引已刷新 / 重建失败只算警告，不影响保存）
    var idxNote = (res && res.indexRefreshed) ? '，索引已刷新' : ''
    var idxWarn = (res && res.indexWarning) ? res.indexWarning : ''
    return refreshIndex().then(refreshList).then(function () {
      if (state.issues.length) {
        showStatus('已保存' + idxNote + '；但有 ' + state.issues.length + ' 处名称不在图鉴里（输入框旁的 ⚠ 可看详情）' + (idxWarn ? '；' + idxWarn : ''), 'warn', true)
      } else {
        showStatus('已保存 ' + state.current + '.json' + idxNote + (idxWarn ? '；' + idxWarn : ''), idxWarn ? 'warn' : 'ok', !!idxWarn)
      }
      return true
    })
  }).catch(function (e) {
    showStatus('保存失败：' + e.message, 'error', true)
    return false
  })
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
  switch (kind) {
    case 'weapons': return { label: '', tier: null, sep: ' > ', items: [{ name: '', note: '' }] }
    case 'artifacts': return { kind: 'preferred', label: '', sep: ' > ', sets: [{ name: '', pieces: '' }] }
    case 'panels': return { label: '', k: '', v: '' }
    case 'constellations': return { name: '', text: '' }
    case 'teams': return { label: '', members: [], text: '' }
    default: return {}
  }
}

function handleAction (act, path, i, el) {
  var model = state.model
  var listPath = path
  var target = getPath(model, path)
  var changed = true

  if (act === 'add-row') {
    target.push(newRow(path.split('.').pop()))
  } else if (act === 'del-row') {
    target.splice(i, 1)
  } else if (act === 'move-row-up') {
    changed = moveRow(target, i, -1)
  } else if (act === 'move-row-down') {
    changed = moveRow(target, i, 1)
  } else if (act === 'add-item') {
    if (listPath.indexOf('v2.weapons') === 0) target.push({ name: '', note: '' })
    else if (listPath.indexOf('v2.artifacts') === 0) {
      if (/\.sets$/.test(listPath)) target.push({ name: '', pieces: '' })
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
    var lastPriority = -1
    model.v2.talents.forEach(function (r, k) { if (r.kind === 'priority') lastPriority = k })
    model.v2.talents.splice(lastPriority + 1, 0, { kind: 'priority', order: ['A', 'E', 'Q'] })
  } else if (act === 'add-crown') {
    model.v2.talents.push({ kind: 'crown', items: [{ name: 'A', level: '' }] })
  } else if (act === 'add-member') {
    target.push({ name: nextTeamMember(getPath(model, path.replace(/\.members$/, '')), target), note: '' })
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

/* ============================================================ 事件绑定 */

function formEvents () {
  var form = $('form')

  form.addEventListener('input', function (e) {
    var el = e.target
    if (!el || !el.getAttribute) return
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
  })

  form.addEventListener('change', function (e) {
    var el = e.target
    if (!el || !el.getAttribute) return
    if (el.tagName === 'SELECT' && el.getAttribute('data-path') && !el.getAttribute('data-ref-kind')) {
      var path = el.getAttribute('data-path')
      if (/\.tier$/.test(path)) setPath(state.model, path, el.value === '' ? null : Number(el.value))
      else if (/\.kind$/.test(path)) setPath(state.model, path, el.value)
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
    var act = el.getAttribute('data-act')
    if (!act) return
    e.preventDefault()
    var path = el.getAttribute('data-path')
    var i = el.hasAttribute('data-i') ? Number(el.getAttribute('data-i')) : -1
    handleAction(act, path, i, el)
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

  document.addEventListener('keydown', function (e) {
    var key = String(e.key || '').toLowerCase()
    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault()
      save()
    }
  })

  window.addEventListener('beforeunload', function (e) {
    if (!state.dirty) return
    e.preventDefault()
    e.returnValue = ''
  })
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
  refreshList: refreshList,
  refreshIndex: refreshIndex,
  openCharacter: openCharacter,
  selectCharacter: selectCharacter,
  reorderBy: reorderBy,
  internals: {
    normalizeData: normalizeData,
    buildBody: buildBody,
    renderForm: renderForm,
    handleAction: handleAction,
    applyRef: applyRef,
    constellationIndex: constellationIndex
  }
}
