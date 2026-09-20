/* 可搜索选择器：引用字段（单选）与配队成员（多选 + 拖动排序）
 * 原生 JS，无依赖；拼音由 /pinyin.js（scripts/lib/pinyin.mjs 的浏览器版）提供，
 * 加载失败时自动降级为「原名子串匹配」，不会报错。
 */
'use strict'

var Picker = (function () {
  /* ------------------------------------------------------------ 纯函数：可单测 */
  var EMPTY = { name: '', note: '', ref: '' }

  /** 去掉空白与大小写差异，方便匹配 */
  function compact (s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase() }

  /** 候选过滤：原名子串 / 全拼 / 拼音首字母（有 Pinyin 时） */
  function filter (candidates, query) {
    var list = Array.isArray(candidates) ? candidates.map(function (x) {
      return typeof x === 'string' ? { name: x } : (x || EMPTY)
    }) : []
    var q = compact(query)
    if (!q) return list
    var pinyin = (typeof window !== 'undefined' && window.Pinyin) ? window.Pinyin : null
    return list.filter(function (c) {
      var name = String(c.name || '')
      if (compact(name).indexOf(q) >= 0) return true
      if (pinyin && typeof pinyin.match === 'function') {
        try { if (pinyin.match(name, q)) return true } catch (e) { /* 拼音表缺字时忽略 */ }
      }
      return false
    })
  }

  /** 成员条目 → {name, ref, [note]}：ref 缺失或与 name 不符时按 character:name 重建 */
  function normalizeMember (m) {
    if (m == null) return null
    var name = typeof m === 'string' ? String(m).trim() : String(m.name == null ? '' : m.name).trim()
    if (!name) return null
    var ref = 'character:' + name
    var out = { name: name, ref: ref }
    var note = typeof m === 'object' && m.note != null ? String(m.note).trim() : ''
    if (note) out.note = note
    return out
  }

  /** 成员数组：去空、去重（同名保留第一条的 note）、保持顺序 */
  function normalizeMembers (list) {
    var out = []
    var seen = {}
    ;(Array.isArray(list) ? list : []).forEach(function (m) {
      var n = normalizeMember(m)
      if (!n || seen[n.name]) return
      seen[n.name] = true
      out.push(n)
    })
    return out
  }

  /** 追加成员（已存在则原样返回 false） */
  function appendMember (members, name) {
    var list = normalizeMembers(members)
    var n = normalizeMember(name)
    if (!n) return { list: list, added: false }
    for (var i = 0; i < list.length; i++) if (list[i].name === n.name) return { list: list, added: false }
    list.push(n)
    return { list: list, added: true }
  }

  /** 把第 from 个成员移动到 to 位置（拖动排序用，越界自动收敛） */
  function moveMember (members, from, to) {
    var list = normalizeMembers(members)
    if (from < 0 || from >= list.length) return list
    var item = list.splice(from, 1)[0]
    var j = Math.max(0, Math.min(list.length, to))
    list.splice(j, 0, item)
    return list
  }

  /* ---------------------------------------------------- 槽位（配队成员用） */

  /** 一格 = { names: ['迪奥娜','阿罗夏'], note: '' }；格内是**可替换项**（渲染成 `A / B`） */
  function emptySlot () { return { names: [], note: '' } }

  /**
   * 成员数组 → 槽位数组。`{name:'迪奥娜 / 阿罗夏', note:'二命'}` → `[{names:['迪奥娜','阿罗夏'],note:'二命'}]`
   * （`/` 是**格内**的可替换分隔符，用户口径：不加任何中文标注）
   */
  function slotsFromMembers (list) {
    var out = []
    ;(Array.isArray(list) ? list : []).forEach(function (m) {
      if (m == null) return
      var raw = typeof m === 'string' ? m : String(m.name == null ? '' : m.name)
      var names = raw.split(/\s*[/／]\s*/).map(function (s) { return s.trim() }).filter(Boolean)
      if (!names.length) return
      var note = typeof m === 'object' && m.note != null ? String(m.note).trim() : ''
      out.push({ names: names, note: note })
    })
    return out
  }

  /** 槽位数组 → 成员数组（格内 ` / ` 连接，note 跟着这一格） */
  function membersFromSlots (slots) {
    var out = []
    ;(Array.isArray(slots) ? slots : []).forEach(function (s) {
      var names = (s && Array.isArray(s.names) ? s.names : []).map(function (n) { return String(n == null ? '' : n).trim() }).filter(Boolean)
      if (!names.length) return
      var m = { name: names.join(' / '), ref: 'character:' + names[0] }
      if (s && String(s.note || '').trim()) m.note = String(s.note).trim()
      out.push(m)
    })
    return out
  }

  /** 移动槽位（拖动 / ←→ 排序用） */
  function moveSlot (slots, from, to) {
    var list = (Array.isArray(slots) ? slots : []).slice()
    if (from < 0 || from >= list.length) return list
    var item = list.splice(from, 1)[0]
    list.splice(Math.max(0, Math.min(list.length, to)), 0, item)
    return list
  }

  /** 按指针位置算插入点：在某个 chip 左半边 → 它之前，右半边 → 它之后 */
  function insertIndexFromRects (rects, x) {
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i]
      if (x < r.left + r.width / 2) return i
    }
    return rects.length
  }

  function sameMembers (a, b) {
    var x = normalizeMembers(a)
    var y = normalizeMembers(b)
    if (x.length !== y.length) return false
    for (var i = 0; i < x.length; i++) {
      if (x[i].name !== y[i].name) return false
      if (String(x[i].note || '') !== String(y[i].note || '')) return false
    }
    return true
  }

  /* --------------------------------------------------------------- DOM 部分 */

  var root = null
  var ui = null            // { title, kindLabel, pool, multi, confirmText }

  function doc () { return typeof document === 'undefined' ? null : document }

  function buildRoot () {
    var d = doc()
    if (!d) return null
    if (root) return root
    root = d.createElement('div')
    root.id = 'picker-root'
    root.className = 'picker-root hidden'
    root.innerHTML =
      '<div class="picker-mask" data-pk="mask"></div>' +
      '<div class="picker-pop" role="dialog" aria-label="选择器">' +
      '  <div class="picker-head">' +
      '    <span class="picker-title" data-pk="title">选择</span>' +
      '    <span class="picker-count muted" data-pk="count"></span>' +
      '    <span class="spacer"></span>' +
      '    <button type="button" class="btn mini" data-pk="close">✕</button>' +
      '  </div>' +
      '  <div class="picker-chips" data-pk="chips"></div>' +
      '  <input class="picker-search" type="search" data-pk="search" placeholder="输入中文名 / 拼音首字母过滤…" autocomplete="off">' +
      '  <div class="picker-list" data-pk="list"></div>' +
      '  <div class="picker-foot">' +
      '    <span class="muted picker-hint">↑↓ 选择 · Enter 确定 · Esc 取消' + '</span>' +
      '    <span class="spacer"></span>' +
      '    <button type="button" class="btn" data-pk="cancel">取消</button>' +
      '    <button type="button" class="btn primary" data-pk="ok">确定</button>' +
      '  </div>' +
      '</div>'
    d.body.appendChild(root)
    return root
  }

  /** 统一的打开/关闭骨架：把「选中态 + 回调」交给各模式自己实现 */
  function openShell (opts) {
    var d = doc()
    if (!d) return { close: function () {} }
    var el = buildRoot()
    var q = function (sel) { return el.querySelector('[data-pk="' + sel + '"]') }
    q('title').textContent = opts.title || '选择'
    q('search').placeholder = opts.placeholder || '输入中文名 / 拼音首字母过滤…'
    q('search').value = ''
    q('ok').textContent = opts.confirmText || '确定'
    el.className = 'picker-root'
    el.querySelector('[data-pk="mask"]').className = 'picker-mask' + (opts.mask !== false ? '' : ' transparent')
    setTimeout(function () { try { q('search').focus() } catch (e) {} }, 0)
    var api = {
      el: el,
      q: q,
      close: function () {
        el.className = 'picker-root hidden'
        el.querySelector('[data-pk="list"]').innerHTML = ''
        el.querySelector('[data-pk="chips"]').innerHTML = ''
        if (opts.onClose) opts.onClose()
      }
    }
    el.onclick = function (e) {
      var t = e.target
      var act = t && t.getAttribute ? t.getAttribute('data-pk') : null
      if (act === 'close' || act === 'cancel' || act === 'mask' || t === el.querySelector('[data-pk="mask"]')) api.close()
      else if (act === 'ok' && opts.onOk) opts.onOk()
    }
    el.onkeydown = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); api.close() }
    }
    return api
  }

  /** 单选：给引用字段用。candidates 是名字数组（或 {name} 数组） */
  function openRef (opts) {
    var candidates = Array.isArray(opts.candidates) ? opts.candidates : []
    var current = compact(opts.value)
    var hl = 0
    var filtered = []
    var api = openShell({
      title: opts.title || '从名称库选',
      confirmText: '采用',
      onOk: function () {
        var pick = filtered[hl]
        if (!pick) { api.close(); return }
        var name = String(pick.name)
        api.close()
        if (typeof opts.onPick === 'function') opts.onPick(name)
      }
    })
    var listEl = api.q('list')
    api.q('chips').className = 'picker-chips hidden'

    function render () {
      filtered = filter(candidates, api.q('search').value)
      api.q('count').textContent = '共 ' + filtered.length + ' 个候选'
      if (hl >= filtered.length) hl = Math.max(0, filtered.length - 1)
      listEl.innerHTML = filtered.length
        ? filtered.slice(0, 500).map(function (c, i) {
          var name = String(c.name)
          return '<div class="pick-item' + (i === hl ? ' hl' : '') + (compact(name) === current ? ' current' : '') + '" data-i="' + i + '">' +
            '<span class="pi-name">' + esc(name) + '</span>' +
            (compact(name) === current ? '<span class="pi-tag">当前</span>' : '') + '</div>'
        }).join('')
        : '<div class="muted" style="padding:8px">没有匹配的名称</div>'
      var cur = listEl.querySelector('.pick-item.hl')
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' })
    }

    listEl.onclick = function (e) {
      var item = e.target && e.target.closest ? e.target.closest('.pick-item') : null
      if (!item) return
      hl = Number(item.getAttribute('data-i'))
      var pick = filtered[hl]
      api.close()
      if (pick && typeof opts.onPick === 'function') opts.onPick(String(pick.name))
    }
    api.q('search').oninput = function () { hl = 0; render() }
    api.q('search').onkeydown = function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, filtered.length - 1); render() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); render() }
      else if (e.key === 'Enter') { e.preventDefault(); api.q('ok').click() }
    }
    render()
    return api
  }

  /**
   * 多选（配队成员）：**按「槽位」多选** —— 一个槽位可以放多个名字（=` / ` 可替换），
   * 点名字＝加进**当前槽位**，点「＋ 新槽位」再放下一个队友。
   *
   * 例：先点 迪奥娜、再点 阿罗夏（同一槽位）→ `[迪奥娜 / 阿罗夏]`；
   *     点「＋ 新槽位」后点 芙宁娜 → `[迪奥娜 / 阿罗夏] + [芙宁娜]`。
   *
   * 用户口径：格内用 ` / ` 连接可替换角色，成员之间用 ` + `（`+` 由编辑器落盘时按槽位拼）。
   *
   * opts: { members, pool, title, onConfirm(members) }
   * 支持：回车添加、↑↓ 选择、点选切换、拖动槽位排序（也可选中后用 ←/→ 键移动）。
   */
  function openMembers (opts) {
    var pool = Array.isArray(opts.pool) ? opts.pool.map(function (n) { return { name: String(n) } }) : []
    var slots = slotsFromMembers(opts.members)
    if (!slots.length) slots = [emptySlot()]
    var active = slots.length - 1
    var hl = 0
    var filtered = []
    var dragFrom = -1
    var api = openShell({
      title: opts.title || '选择配队成员',
      placeholder: '输入中文 / 拼音首字母（如 ldjj）过滤，回车加进当前槽位',
      confirmText: opts.confirmText || '确定',
      onOk: function () {
        var out = membersFromSlots(slots)
        api.close()
        if (typeof opts.onConfirm === 'function') opts.onConfirm(out)
      }
    })
    var listEl = api.q('list')
    var chipsEl = api.q('chips')

    function allNames () {
      var out = []
      slots.forEach(function (s) { s.names.forEach(function (n) { out.push(n) }) })
      return out
    }
    function slotOf (name) {
      for (var i = 0; i < slots.length; i++) if (slots[i].names.indexOf(name) >= 0) return i
      return -1
    }

    function renderChips () {
      var total = allNames().length
      api.q('count').textContent = '已选 ' + total + ' 人 / ' + slots.filter(function (s) { return s.names.length }).length +
        ' 格（格内 ` / ` = 可替换）/ 候选 ' + pool.length + ' 人'
      api.q('ok').textContent = (opts.confirmText || '确定') + '（' + total + '）'
      chipsEl.className = 'picker-chips' + (total ? '' : ' hidden')
      chipsEl.innerHTML = slots.map(function (s, i) {
        var names = s.names.map(function (n, k) {
          return (k ? '<span class="pk-sep"> / </span>' : '') +
            '<span class="pk-chip' + (i === active ? ' on' : '') + '" draggable="true" data-s="' + i + '" data-k="' + k + '"' +
            ' title="第 ' + (i + 1) + ' 格' + (s.names.length > 1 ? '（格内有 ' + s.names.length + ' 个可替换项）' : '') + '；拖动可排序">' +
            '<span class="pk-av">' + esc(n.slice(0, 1)) + '</span>' +
            '<span class="pk-nm">' + esc(n) + '</span>' +
            '<span class="pk-x" data-del="' + i + ':' + k + '" title="移除">×</span></span>'
        }).join('')
        return '<span class="pk-slot' + (i === active ? ' active' : '') + '" data-slot="' + i + '" title="点一下把这一格设为当前格（下一个名字会加进来）">' +
          '<span class="pk-slot-no">' + (i + 1) + '</span>' + names +
          (s.names.length ? '' : '<span class="pk-empty">（空，下一个名字加这里）</span>') +
          '</span>'
      }).join('') + '<button type="button" class="btn mini" data-pk="addslot" title="再开一格（放另一个队友）">＋ 新槽位</button>'
      api.q('ok').textContent = (opts.confirmText || '确定') + '（' + total + '）'
    }

    function renderList () {
      var query = api.q('search').value
      filtered = filter(pool, query)
      if (hl >= filtered.length) hl = Math.max(0, filtered.length - 1)
      var rows = filtered.slice(0, 400).map(function (c, i) {
        var name = String(c.name)
        var si = slotOf(name)
        return '<div class="pick-item' + (i === hl ? ' hl' : '') + (si >= 0 ? ' on' : '') + '" data-i="' + i + '" data-name="' + esc(name) + '">' +
          '<span class="pk-av">' + esc(name.slice(0, 1)) + '</span>' +
          '<span class="pi-name">' + esc(name) + '</span>' +
          '<span class="pi-tag">' + (si >= 0 ? '第 ' + (si + 1) + ' 格' : '') + '</span></div>'
      }).join('')
      var typed = String(query).trim()
      if (typed && !filtered.some(function (c) { return String(c.name) === typed }) && slotOf(typed) < 0) {
        rows = '<div class="pick-item pick-new" data-new="' + esc(typed) + '"><span class="pi-name">＋ 用自定义名字「' + esc(typed) + '」</span></div>' + rows
      }
      listEl.innerHTML = rows || '<div class="muted" style="padding:8px">没有匹配的角色</div>'
      var cur = listEl.querySelector('.pick-item.hl')
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' })
    }

    /** 点名字：已在某一格 → 移除；否则加进**当前槽位** */
    function toggle (name) {
      var n = String(name == null ? '' : name).trim()
      if (!n) return
      var si = slotOf(n)
      if (si >= 0) {
        slots[si].names.splice(slots[si].names.indexOf(n), 1)
        active = si
        return
      }
      if (active < 0 || active >= slots.length) active = Math.max(0, slots.length - 1)
      slots[active].names.push(n)
    }

    function refresh () {
      if (active >= slots.length) active = Math.max(0, slots.length - 1)
      renderChips()
      renderList()
    }

    api.q('search').oninput = function () { hl = 0; renderList() }
    api.q('search').onkeydown = function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, filtered.length - 1); renderList() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); renderList() }
      else if (e.key === 'Enter') {
        e.preventDefault()
        var typed = String(api.q('search').value).trim()
        var pick = filtered[hl] ? String(filtered[hl].name) : ''
        if (pick && (!typed || compact(pick).indexOf(compact(typed)) >= 0 || filtered.length === 1)) toggle(pick)
        else if (typed) toggle(typed)
        else return
        api.q('search').value = ''
        hl = 0
        refresh()
      } else if (e.key === 'Backspace' && !api.q('search').value) {
        var last = -1
        for (var i = slots.length - 1; i >= 0; i--) if (slots[i].names.length) { last = i; break }
        if (last >= 0) { slots[last].names.pop(); active = last; refresh() }
      }
    }

    listEl.onclick = function (e) {
      var t = e.target
      var custom = t && t.closest ? t.closest('.pick-new') : null
      if (custom) {
        toggle(custom.getAttribute('data-new'))
        api.q('search').value = ''
        hl = 0
        refresh()
        return
      }
      var item = t && t.closest ? t.closest('.pick-item') : null
      if (!item) return
      var name = item.getAttribute('data-name')
      hl = Number(item.getAttribute('data-i'))
      if (name) { toggle(name); refresh() }
    }

    chipsEl.onclick = function (e) {
      var t = e.target
      if (!t || !t.getAttribute) return
      if (t.getAttribute('data-pk') === 'addslot') {
        slots.push(emptySlot())
        active = slots.length - 1
        refresh()
        return
      }
      var del = t.getAttribute('data-del')
      if (del != null) {
        var parts = String(del).split(':')
        var si = Number(parts[0]); var k = Number(parts[1])
        if (slots[si]) {
          slots[si].names.splice(k, 1)
          active = si
          refresh()
        }
        return
      }
      var chip = t.closest ? t.closest('.pk-chip') : null
      if (chip) { active = Number(chip.getAttribute('data-s')); refresh() }
    }
    chipsEl.onkeydown = function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('.pk-chip') : null
      if (!chip) return
      var si = Number(chip.getAttribute('data-s'))
      var k = Number(chip.getAttribute('data-k'))
      if (e.key === 'ArrowLeft' && si > 0) { e.preventDefault(); slots = moveSlot(slots, si, si - 1); active = si - 1; refresh() }
      else if (e.key === 'ArrowRight' && si < slots.length - 1) { e.preventDefault(); slots = moveSlot(slots, si, si + 1); active = si + 1; refresh() }
      else if (e.key === 'Delete') { e.preventDefault(); slots[si].names.splice(k, 1); active = si; refresh() }
    }

    chipsEl.ondragstart = function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('.pk-chip') : null
      if (!chip) return
      dragFrom = Number(chip.getAttribute('data-s'))
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', String(dragFrom)) } catch (err) {}
      }
    }
    chipsEl.ondragover = function (e) {
      if (dragFrom < 0) return
      e.preventDefault()
      var boxes = [].slice.call(chipsEl.querySelectorAll('.pk-slot'))
      var rects = boxes.map(function (c) { return c.getBoundingClientRect() })
      var to = insertIndexFromRects(rects, e.clientX)
      if (to === dragFrom || to === dragFrom + 1) return
      var moved = moveSlot(slots, dragFrom, to > dragFrom ? to - 1 : to)
      slots = moved
      active = to > dragFrom ? to - 1 : to
      dragFrom = active
      renderChips()
    }
    chipsEl.ondrop = function (e) { e.preventDefault(); dragFrom = -1 }
    chipsEl.ondragend = function () { dragFrom = -1 }

    renderChips()
    renderList()
    return api
  }

  function esc (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  return {
    filter: filter,
    normalizeMember: normalizeMember,
    normalizeMembers: normalizeMembers,
    appendMember: appendMember,
    moveMember: moveMember,
    slotsFromMembers: slotsFromMembers,
    membersFromSlots: membersFromSlots,
    moveSlot: moveSlot,
    insertIndexFromRects: insertIndexFromRects,
    sameMembers: sameMembers,
    openRef: openRef,
    openMembers: openMembers,
    _els: function () { return { root: root, ui: ui } }
  }
})()

if (typeof window !== 'undefined') window.Picker = Picker
if (typeof module !== 'undefined' && module.exports) module.exports = Picker
