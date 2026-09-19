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
   * 多选：配队成员用。
   * opts: { members, pool, title, onConfirm(members) }
   * 支持：回车添加、↑↓ 选择、点选切换、已选 chip 拖动排序（也支持 ←→ 键重排）
   */
  function openMembers (opts) {
    var pool = Array.isArray(opts.pool) ? opts.pool.map(function (n) { return { name: String(n) } }) : []
    var selected = normalizeMembers(opts.members)
    var hl = 0
    var filtered = []
    var dragFrom = -1
    var api = openShell({
      title: opts.title || '选择配队成员',
      placeholder: '输入中文 / 拼音首字母（如 ldjj）过滤，回车添加',
      confirmText: opts.confirmText || '确定（' + selected.length + '）',
      onOk: function () {
        var out = selected.slice()
        api.close()
        if (typeof opts.onConfirm === 'function') opts.onConfirm(out)
      }
    })
    var listEl = api.q('list')
    var chipsEl = api.q('chips')

    function selectedIndex (name) {
      for (var i = 0; i < selected.length; i++) if (selected[i].name === name) return i
      return -1
    }

    function renderChips () {
      api.q('count').textContent = '已选 ' + selected.length + ' 人 / 候选 ' + pool.length + ' 人'
      api.q('ok').textContent = (opts.confirmText || '确定') + '（' + selected.length + '）'
      chipsEl.className = 'picker-chips' + (selected.length ? '' : ' hidden')
      chipsEl.innerHTML = selected.map(function (m, i) {
        return '<span class="pk-chip" draggable="true" data-i="' + i + '" title="拖动可排序（也可选中后用 ←/→ 移动）">' +
          '<span class="pk-av">' + esc(m.name.slice(0, 1)) + '</span>' +
          '<span class="pk-nm">' + esc(m.name) + '</span>' +
          '<span class="pk-x" data-del="' + i + '" title="移除">×</span></span>'
      }).join('')
    }

    function renderList () {
      var query = api.q('search').value
      filtered = filter(pool, query)
      if (hl >= filtered.length) hl = Math.max(0, filtered.length - 1)
      var rows = filtered.slice(0, 400).map(function (c, i) {
        var name = String(c.name)
        var idx = selectedIndex(name)
        return '<div class="pick-item' + (i === hl ? ' hl' : '') + (idx >= 0 ? ' on' : '') + '" data-i="' + i + '" data-name="' + esc(name) + '">' +
          '<span class="pk-av">' + esc(name.slice(0, 1)) + '</span>' +
          '<span class="pi-name">' + esc(name) + '</span>' +
          '<span class="pi-tag">' + (idx >= 0 ? '已选 ' + (idx + 1) : '') + '</span></div>'
      }).join('')
      var typed = String(query).trim()
      if (typed && !filtered.some(function (c) { return String(c.name) === typed }) && selectedIndex(typed) < 0) {
        rows = '<div class="pick-item pick-new" data-new="' + esc(typed) + '"><span class="pi-name">＋ 用自定义名字「' + esc(typed) + '」</span></div>' + rows
      }
      listEl.innerHTML = rows || '<div class="muted" style="padding:8px">没有匹配的角色</div>'
      var cur = listEl.querySelector('.pick-item.hl')
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' })
    }

    function toggle (name) {
      var i = selectedIndex(name)
      if (i >= 0) selected.splice(i, 1)
      else {
        var r = appendMember(selected, name)
        selected = r.list
      }
    }

    function refresh () { renderChips(); renderList() }

    api.q('search').oninput = function () { hl = 0; renderList() }
    api.q('search').onkeydown = function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, filtered.length - 1); renderList() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); renderList() }
      else if (e.key === 'Enter') {
        e.preventDefault()
        var typed = String(api.q('search').value).trim()
        var pick = filtered[hl] ? String(filtered[hl].name) : ''
        if (pick && (!typed || compact(pick).indexOf(compact(typed)) >= 0 || filtered.length === 1)) {
          toggle(pick)
          api.q('search').value = ''
          hl = 0
          refresh()
        } else if (typed) {
          var r = appendMember(selected, typed)
          selected = r.list
          api.q('search').value = ''
          hl = 0
          refresh()
        }
      } else if (e.key === 'Backspace' && !api.q('search').value && selected.length) {
        selected.pop()
        refresh()
      }
    }

    listEl.onclick = function (e) {
      var t = e.target
      var custom = t && t.closest ? t.closest('.pick-new') : null
      if (custom) {
        var r = appendMember(selected, custom.getAttribute('data-new'))
        selected = r.list
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
      var del = e.target && e.target.getAttribute ? e.target.getAttribute('data-del') : null
      if (del == null) return
      selected.splice(Number(del), 1)
      refresh()
    }
    chipsEl.onkeydown = function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('.pk-chip') : null
      if (!chip) return
      var i = Number(chip.getAttribute('data-i'))
      if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); selected = moveMember(selected, i, i - 1); refresh(); focusChip(i - 1) }
      else if (e.key === 'ArrowRight' && i < selected.length - 1) { e.preventDefault(); selected = moveMember(selected, i, i + 1); refresh(); focusChip(i + 1) }
      else if (e.key === 'Delete') { e.preventDefault(); selected.splice(i, 1); refresh() }
    }
    function focusChip (i) {
      var el = chipsEl.querySelector('.pk-chip[data-i="' + i + '"]')
      if (el) el.focus()
    }

    chipsEl.ondragstart = function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('.pk-chip') : null
      if (!chip) return
      dragFrom = Number(chip.getAttribute('data-i'))
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', String(dragFrom)) } catch (err) {}
      }
    }
    chipsEl.ondragover = function (e) {
      if (dragFrom < 0) return
      e.preventDefault()
      var chips = [].slice.call(chipsEl.querySelectorAll('.pk-chip'))
      var rects = chips.map(function (c) { return c.getBoundingClientRect() })
      var to = insertIndexFromRects(rects, e.clientX)
      if (to === dragFrom || to === dragFrom + 1) return
      selected = moveMember(selected, dragFrom, to > dragFrom ? to - 1 : to)
      dragFrom = to > dragFrom ? to - 1 : to
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
    insertIndexFromRects: insertIndexFromRects,
    sameMembers: sameMembers,
    openRef: openRef,
    openMembers: openMembers,
    _els: function () { return { root: root, ui: ui } }
  }
})()

if (typeof window !== 'undefined') window.Picker = Picker
if (typeof module !== 'undefined' && module.exports) module.exports = Picker
