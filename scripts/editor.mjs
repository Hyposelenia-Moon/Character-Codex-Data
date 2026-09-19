/**
 * 图形化角色 JSON 编辑器 —— 后端 HTTP 服务（零依赖，仅用 node: 内置模块）
 *
 * 用法：
 *   node scripts/editor.mjs [--port 8787] [--no-open] [--exit-on-idle[=<秒>]]
 *   默认端口 8787，端口被占用时自动 +1 重试（最多 10 次）
 *   --exit-on-idle 默认关闭；开了之后「连续 N 秒（默认 20）没有页面心跳」就自动退出，
 *   页面关闭（navigator.sendBeacon('/api/close')）后再等 5 秒退出。
 *
 * 页面与静态资源：resources/editor/（`/` → index.html）
 * API（全部 JSON、UTF-8 无 BOM）：
 *   GET    /api/index                  → data/_index.json（不存在时返回空清单）
 *   GET    /api/characters             → { order, items:[{name,weapons,artifacts,hasUnparsed}], missing }
 *   GET    /api/character?name=X       → 角色 JSON + issues（validate 结果）
 *   PUT    /api/character?name=X       → 保存（body 为完整 JSON；强制 schema:2，tags/sections 由服务器重建）
 *                                        保存后自动重建 data/_index.json，响应带 indexRefreshed / indexWarning
 *   POST   /api/character              → { name } 新建空白 v2 模板（已存在 409）
 *   POST   /api/rename                 → { from, to } 改文件名 + _order.json
 *   DELETE /api/character?name=X       → 软删除到 data/_trash/
 *   POST   /api/reorder                → { order: [...] } 重写 _order.json
 *   GET    /api/search?q=&type=&scope= → 全局检索：名称引用（哪些角色/段落/第几行）+ 正文关键词
 *   POST   /api/batch-replace          → { type, from, to, dry? } 批量替换引用；执行前备份到 data/_backup/<stamp>/
 *   POST   /api/batch-replace/undo     → { stamp } 用备份回滚一次批量替换
 *   POST   /api/publish                → 「保存并发布」：写 JSON → 重建索引 → build-docx 写回主文档（含备份）
 *                                        → build-html 生成 guide.html → 生成提交摘要（out/_commit-summary.md，
 *                                          另留最近 5 份 out/_commit-summary-<时间戳>.md）并回传
 *                                        **不执行 git add / git commit**
 *   POST   /api/commit                 → { message? } 显式提交（默认不用；界面默认不触发）
 *   GET|POST /api/heartbeat            → 页面心跳（配合 --exit-on-idle；未开启时只是 200 no-op）
 *   POST   /api/close                  → 页面关闭信号：5 秒宽限期后退出（期间又来心跳则取消）
 *
 * 索引自动刷新：保存 / 新增 / 重命名 / 删除之后调用 build-index.mjs 的 buildIndex() 重建
 * data/_index.json（含新角色文件名）。重建失败不影响保存本身 —— 保存照常 200，
 * 只在响应里带 indexWarning 说明原因。
 *
 * 安全：name 必须是单层文件名（拒绝 / \ .. : 等），所有文件操作限制在 data/gi/ 下。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deriveSections, deriveTags, validate, parseRef, itemText } from './lib/schema.mjs'
import { renderGuideSectionsHtml, renderGuideSectionsText, characterSections, renderCard } from './build-html.mjs'
import { verifyThreeWay, snapshotMainDoc, sha1File } from './lib/publish-verify.mjs'
import { buildIndex } from './build-index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const giDir = path.join(dataDir, 'gi')
const trashDir = path.join(dataDir, '_trash')
const backupDir = path.join(dataDir, '_backup')
const indexPath = path.join(dataDir, '_index.json')
const orderPath = path.join(giDir, '_order.json')
const editorDir = path.join(root, 'resources', 'editor')
/** 主文档（「保存即发布」会写回它；build-docx 会先备份） */
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'
/** 提交摘要落盘位置（out/ 已在 .gitignore 里，不污染仓库） */
const SUMMARY_FILE = path.join(root, 'out', '_commit-summary.md')

const DEFAULT_PORT = 8787
const MAX_PORT_TRIES = 10
const MAX_BODY = 8 * 1024 * 1024
/** 收到关闭信号后的宽限期（毫秒）：给刷新页面 / 马上重开留余地 */
const CLOSE_GRACE_MS = 5000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
}

const V2_KEYS = ['weapons', 'artifacts', 'talents', 'panels', 'constellations', 'teams']
const KEEP_KEYS = ['source', 'highlight', 'meta', 'unparsed']

/* ---------------------------------------------------------------- 基础工具 */

const err = (status, message) => Object.assign(new Error(message), { status })

/** 只读 JSON（容忍 UTF-8 BOM） */
function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/** 写 JSON（UTF-8 无 BOM、2 空格缩进、末尾换行） */
function writeJsonFile (file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/**
 * 校验角色名：必须是单层文件名（不允许路径分隔符、.. 、冒号、通配符等）
 * @param {unknown} raw
 * @returns {string}
 */
function safeName (raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw err(400, '缺少角色名')
  if (name.length > 64) throw err(400, '角色名过长（超过 64 字）')
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.includes('..')) throw err(400, `角色名不合法（含路径字符）：${name}`)
  if (name.startsWith('_')) throw err(400, '角色名不能以下划线开头（保留给元数据文件）')
  const file = path.join(giDir, `${name}.json`)
  const rel = path.relative(giDir, file)
  if (rel.split(path.sep).length !== 1 || path.isAbsolute(rel)) throw err(400, `角色名不合法：${name}`)
  return name
}

/** 是否合法名字（不抛异常版） */
function isValidName (raw) {
  try {
    safeName(raw)
    return true
  } catch {
    return false
  }
}

const characterFile = (name) => path.join(giDir, `${name}.json`)

const asArray = (v) => (Array.isArray(v) ? v : [])

/** 「有内容」判断：空串、null、纯空白都算空 */
const hasText = (v) => typeof v === 'string' && v.trim() !== ''

/** 排序：先按 _order.json，再按拼音 */
function orderList (list, order) {
  const rank = (name) => {
    const i = order.indexOf(name)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...list].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh-Hans-CN'))
}

/* ------------------------------------------------------------ 数据读写/规范化 */

function readOrder () {
  try {
    const doc = readJson(orderPath)
    const list = Array.isArray(doc) ? doc : asArray(doc?.order)
    return list.map(x => String(x))
  } catch {
    return []
  }
}

function writeOrder (list) {
  if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
  writeJsonFile(orderPath, list)
}

/** _order.json 追加名字（已存在则不动） */
function appendOrder (name) {
  const order = readOrder()
  if (!order.includes(name)) {
    order.push(name)
    writeOrder(order)
  }
  return order
}

/** _order.json 移除名字 */
function removeFromOrder (name) {
  const order = readOrder()
  const next = order.filter(x => x !== name)
  if (next.length !== order.length) writeOrder(next)
  return next
}

/** data/gi 下所有角色文件名（不含 .json，跳过 `_` 开头） */
function listCharacterNames () {
  let entries = []
  try {
    entries = fs.readdirSync(giDir)
  } catch {
    return []
  }
  return entries
    .filter(f => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
    .map(f => f.slice(0, -'.json'.length))
    .filter(isValidName)
}

/** 读取图鉴索引（容错：不存在或损坏都返回带 generatedAt 的空结构） */
function readIndex () {
  try {
    const doc = readJson(indexPath)
    return {
      generatedAt: doc?.generatedAt ?? null,
      weapons: asArray(doc?.weapons).map(String),
      characters: asArray(doc?.characters).map(String),
      artifacts: asArray(doc?.artifacts).map(String)
    }
  } catch {
    return { generatedAt: null, weapons: [], characters: [], artifacts: [] }
  }
}

/**
 * 重建 data/_index.json（保存 / 新增 / 重命名 / 删除之后调用）。
 *
 * 索引是「标准名白名单」，除图鉴后端外还会并入 data/gi 的文件名（新角色因此立刻能被 validate 认识），
 * 所以数据变动后必须重建。重建失败**不能**影响保存本身：这里捕获异常，
 * 由调用方把 message 放进响应的 indexWarning。
 * @returns {{refreshed: boolean, generatedAt?: string, weapons?: number, characters?: number, artifacts?: number, warning?: string}}
 */
function refreshIndexFile () {
  try {
    const info = buildIndex({ outFile: indexPath })
    return {
      refreshed: true,
      generatedAt: info.index.generatedAt,
      weapons: info.weapons,
      characters: info.characters,
      artifacts: info.artifacts
    }
  } catch (e) {
    return { refreshed: false, warning: `索引重建失败：${String(e?.message ?? e)}` }
  }
}

/**
 * 一行是否「空行」（保存时丢掉编辑器留下的空行）
 * 注意：kind === 'main' 的行即使三个部位都为空也不算空行 —— 它是 Word 转换器的占位行，
 *       必须保留（前端表单不显示它，但保存要原样带回）。
 * @param {object} row
 * @returns {boolean}
 */
function isEmptyRow (row) {
  if (!row || typeof row !== 'object') return true
  switch (row.kind) {
    case 'priority': return asArray(row.order).length === 0
    case 'crown': return asArray(row.items).length === 0
    case 'main': return false
    case 'sub': return false
    case 'text': return !hasText(row.text)
    default: break
  }
  if (asArray(row.items).length || asArray(row.sets).length) return false
  if (hasText(row.text)) return false
  if (hasText(row.label) || hasText(row.name) || hasText(row.k) || hasText(row.v)) return false
  return true
}

/**
 * 是不是「段末备注」行（`{kind:'note', text}`）—— 文档里渲染成一行 `注：…`。
 * 六个 v2 数组都可能带这类行；编辑器把它们原样保留，不参与结构化编辑。
 */
function isNoteRow (row) {
  return !!row && typeof row === 'object' && row.kind === 'note'
}

/** 值算不算「编辑器的有效输入」 */
function isProvided (v) {  if (v === undefined || v === null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'string') return v.trim() !== ''
  if (typeof v === 'object') return Object.keys(v).length > 0
  return true
}

/** 数组里还有没有「有内容」的元素（全是空串/空对象就算空） */
function hasContent (arr) {
  return asArray(arr).some(v => isProvided(typeof v === 'object' && v !== null ? (v.name || v.text || v.ref) : v))
}

/** 行数组字段的合并：编辑器给了有内容的数组就用它，否则沿用原文件 */
function mergeField (x, y) {
  if (!isProvided(x)) return y
  if (Array.isArray(x) && Array.isArray(y) && !hasContent(x)) return y
  return x
}

/**
 * 把两个行数组按位置合并：以编辑器提交的为准，缺的字段从原文件取。
 * 为什么需要：编辑器只提交自己认识的字段（例如不提交 raw、不提交套装件数 pieces 之外的老写法），
 * 「打开再保存」时未被编辑的字段必须从 data/gi/<角色>.json 里带回来，避免静默丢数据。
 * @param {unknown} a 编辑器提交的数组
 * @param {unknown} b 原文件里的数组
 * @returns {object[]}
 */
function mergeRows (a, b) {
  const left = asArray(a)
  const right = asArray(b)
  const n = Math.max(left.length, right.length)
  const out = []
  for (let i = 0; i < n; i++) {
    const x = left[i]
    const y = right[i]
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const row = { ...y }
      for (const [k, v] of Object.entries(x)) row[k] = mergeField(v, y[k])
      out.push(row)
    } else if (isProvided(x) || !isProvided(y)) {
      out.push(x)
    } else {
      out.push(y)
    }
  }
  return out
}

/** v2 六个数组与「原文件」按位置合并 */
function mergeV2 (bodyV2, prevV2) {
  const a = bodyV2 && typeof bodyV2 === 'object' ? bodyV2 : {}
  const b = prevV2 && typeof prevV2 === 'object' ? prevV2 : {}
  const out = {}
  for (const key of V2_KEYS) out[key] = mergeRows(a[key], b[key])
  return out
}

/**
 * 规范化 v2：只保留已知字段、按仓库既有写法固定字段顺序、丢掉编辑器留下的空行/空条目。
 *
 * 关于「空行」：仓库里有 16 行「主词条」是整行留空的占位（stats 三项都是 []），
 * 它们是 Word 转换器的产物、旧渲染器会跳过，但属于原数据。编辑器的表单不渲染这类空行
 * （见 resources/editor/app.js 的 rowVisible），保存时会原样带回来，避免「打开再保存」就丢数据。
 *
 * @param {object} v2 合并后的 v2（见 mergeV2）
 * @returns {object}
 */
function normalizeV2 (v2) {
  const src = v2 && typeof v2 === 'object' ? v2 : {}
  const out = {}

  out.weapons = asArray(src.weapons)
    .filter(r => r && typeof r === 'object')
    .map(row => {
      // 备注行（段末 `注：`）：整行只有 kind + text，原样保留
      if (isNoteRow(row)) return { kind: 'note', text: String(row.text ?? '').trim() }
      const items = asArray(row.items)
        .filter(it => it && typeof it === 'object' && hasText(it.name))   // 空条目（只有空名字）不落盘
        .map(it => {
          // 字段顺序跟仓库既有写法一致：name, [note], [level], ref
          const item = { name: typeof it.name === 'string' ? it.name.trim() : '' }
          if (hasText(it.note)) item.note = it.note.trim()
          if (hasText(it.level)) item.level = String(it.level).trim()
          item.ref = hasText(it.ref) ? String(it.ref).trim() : `weapon:${item.name}`
          return item
        })
      const r = {
        label: hasText(row.label) ? row.label.trim() : null,
        tier: Number.isInteger(row.tier) && row.tier >= 1 && row.tier <= 6 ? row.tier : null
      }
      if (hasText(row.sep)) r.sep = row.sep
      r.items = items
      return r
    })
    .filter(r => !isEmptyRow(r))

  out.artifacts = asArray(src.artifacts)
    .filter(r => r && typeof r === 'object')
    .map(row => {
      // 备注行（段末 `注：`）
      if (isNoteRow(row)) return { kind: 'note', text: String(row.text ?? '').trim() }
      const kind = ['preferred', 'transition', 'optional', 'main', 'sub', 'text'].includes(row.kind) ? row.kind : 'text'
      const label = hasText(row.label) ? row.label.trim() : null
      if (kind === 'main') {
        const st = row.stats && typeof row.stats === 'object' ? row.stats : {}
        // 主词条行不写 sep（渲染器只用它拼多值），三个部位键始终齐全
        // note / noteSlot：括注（`水元素伤害加成（二命）`）与它挂在哪个部位，
        // 字段顺序保持 kind, note, noteSlot, stats
        const r = { kind }
        if (hasText(row.note)) {
          r.note = String(row.note).trim()
          if (hasText(row.noteSlot) && ['时之沙', '空之杯', '理之冠'].includes(row.noteSlot)) r.noteSlot = row.noteSlot
        }
        r.stats = {
          时之沙: asArray(st['时之沙']).map(x => String(x).trim()).filter(Boolean),
          空之杯: asArray(st['空之杯']).map(x => String(x).trim()).filter(Boolean),
          理之冠: asArray(st['理之冠']).map(x => String(x).trim()).filter(Boolean)
        }
        return r
      }
      if (kind === 'sub') {
        const r = { kind, stats: asArray(row.stats).map(x => String(x).trim()).filter(Boolean) }
        if (hasText(row.sep)) r.sep = row.sep
        return r
      }
      if (kind === 'text') {
        const r = { kind, label }
        if (hasText(row.sep)) r.sep = row.sep
        r.text = hasText(row.text) ? row.text.trim() : ''
        return r
      }
      const sets = asArray(row.sets)
        .filter(s => s && typeof s === 'object')
        .map(s => {
          const ref = hasText(s.ref) ? String(s.ref).trim() : `artifact:${String(s.name ?? '').trim()}`
          const set = { name: typeof s.name === 'string' ? s.name.trim() : '', ref }
          if (hasText(s.pieces)) set.pieces = s.pieces.trim()
          return set
        })
      const r = { kind, label }
      if (hasText(row.sep)) r.sep = row.sep
      if (hasText(row.title)) r.title = row.title.trim()
      r.sets = sets
      return r
    })
    .filter(r => !isEmptyRow(r))

  out.talents = asArray(src.talents)
    .filter(r => r && typeof r === 'object')
    .map(row => {
      if (isNoteRow(row)) return { kind: 'note', text: String(row.text ?? '').trim() }
      if (row.kind === 'priority') {
        const order = asArray(row.order)
          .map(it => {
            const text = typeof it === 'string' ? it : (it?.name ?? '')
            const name = String(text).trim().toUpperCase()
            if (!/^[AEQ]$/.test(name)) return null
            return { name, ref: `talent:${name}` }
          })
          .filter(Boolean)
        // raw：编辑器没改动顺序就原样保留原文件的写法（仓库里有 A＞E＞Q、E ≥ Q、E / Q、A=Q＞E 等）；
        //      顺序真的变了才按 A > E > Q 重新生成
        const raw = (() => {
          const generated = order.map(x => x.name).join(' > ')
          const prevRaw = hasText(row.raw) ? String(row.raw).trim() : ''
          if (!prevRaw) return generated
          const prevNames = asArray(row.order)
            .map(it => String(typeof it === 'string' ? it : (it?.name ?? '')).trim().toUpperCase())
            .filter(x => /^[AEQ]$/.test(x))
            .join(',')
          const nextNames = order.map(x => x.name).join(',')
          return prevNames === nextNames ? prevRaw : generated
        })()
        return { kind: 'priority', order, raw }
      }
      if (row.kind === 'crown') {
        const items = asArray(row.items)
          .map(it => {
            const name = String(typeof it === 'string' ? it : (it?.name ?? '')).trim().toUpperCase()
            if (!/^[AEQ]$/.test(name)) return null
            const item = { name }
            if (hasText(it?.level)) item.level = String(it.level).trim()
            item.ref = `talent:${name}`
            return item
          })
          .filter(Boolean)
        return { kind: 'crown', items }
      }
      return null
    })
    .filter(r => r && !isEmptyRow(r))

  out.panels = asArray(src.panels)
    .filter(r => r && typeof r === 'object')
    .map(row => {
      if (isNoteRow(row)) return { kind: 'note', text: String(row.text ?? '').trim() }
      const label = hasText(row.label) ? row.label.trim() : null
      if (hasText(row.k)) return { label, k: row.k.trim(), v: hasText(row.v) ? row.v.trim() : '' }
      if (hasText(row.text)) return { label, text: row.text.trim() }
      return null
    })
    .filter(Boolean)

  out.constellations = asArray(src.constellations)
    .filter(r => r && typeof r === 'object')
    .map(row => {
      if (isNoteRow(row)) return { kind: 'note', text: String(row.text ?? '').trim() }
      const name = hasText(row.name) ? row.name.trim() : ''
      if (!name) return null
      const index = constellationIndex(name) || (Number.isInteger(row.index) ? row.index : 0)
      const text = hasText(row.text) ? row.text.trim() : ''
      return { name, index, text }
    })
    .filter(Boolean)

  out.teams = asArray(src.teams)
    .filter(r => r && typeof r === 'object')
    .map(row => {
      if (isNoteRow(row)) return { kind: 'note', text: String(row.text ?? '').trim() }
      const members = asArray(row.members)
        .filter(m => m && typeof m === 'object')
        .map(m => {
          // 字段顺序跟仓库既有写法一致：name, [note], ref
          const name = typeof m.name === 'string' ? m.name.trim() : ''
          const member = { name }
          if (hasText(m.note)) member.note = String(m.note).trim()
          member.ref = hasText(m.ref) ? String(m.ref).trim() : `character:${name}`
          return member
        })
      return {
        label: hasText(row.label) ? row.label.trim() : null,
        members,
        text: hasText(row.text) ? row.text.trim() : ''
      }
    })
    .filter(r => !isEmptyRow(r))

  return out
}

/** 命座名 → 序号（一命=1 … 六命=6，取不到 0） */
function constellationIndex (name) {  const s = String(name ?? '')
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }
  const cn = s.match(/^([一二三四五六])命/)
  if (cn) return map[cn[1]]
  const n = s.match(/(\d+)\s*命/)
  return n ? Number(n[1]) : 0
}

/**
 * 用前端提交的数据组装要落盘的完整 JSON
 * - 强制 schema:2、name、game
 * - tags / sections 一律由服务器重建（丢弃前端传来的这两个字段）
 * - source / highlight / meta 缺省时沿用原文件
 * @param {object} body
 * @param {string} name
 * @param {object} prev 原文件（不存在则 {}）
 * @returns {object}
 */
function buildCharacter (body, name, prev = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw err(400, '请求体必须是 JSON 对象')
  const GAMES = ['gi', 'hsr', 'zzz']
  // game：原文件有就沿用，否则接受请求体里的合法值，最后兜底 gi
  let game = hasText(prev.game) ? String(prev.game).trim() : ''
  if (!game) {
    const asked = hasText(body.game) ? String(body.game).trim() : ''
    game = GAMES.includes(asked) ? asked : 'gi'
  }

  // 顶层字段顺序按仓库既有文件的写法，保证「原样保存」不会产生无意义 diff：
  //   schema, name, game, [highlight], meta, v2, [unparsed], tags, sections, source
  const data = { schema: 2, name, game }

  if (hasText(prev.highlight)) data.highlight = prev.highlight

  data.meta = {}
  const meta = body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : {}
  const prevMeta = prev.meta && typeof prev.meta === 'object' && !Array.isArray(prev.meta) ? prev.meta : {}
  for (const key of ['建议等级', '定位', '100级提升']) {
    const has = hasText(meta[key])
    const value = has ? String(meta[key]).trim() : ''
    // 仓库里有些文件只写了「建议等级」这一项（没有空键）。编辑器提交的空值如果不改，
    // 就沿用原文件的结构，免得「打开再保存」凭空多出两个空键。
    if (!has && !(key in prevMeta)) continue
    data.meta[key] = value
  }

  data.v2 = normalizeV2(mergeV2(body.v2, prev.v2))

  const unparsed = body.unparsed ?? prev.unparsed
  if (unparsed && typeof unparsed === 'object' && !Array.isArray(unparsed)) {
    const cleaned = {}
    for (const [k, lines] of Object.entries(unparsed)) {
      const arr = asArray(lines).map(x => String(x)).filter(x => x.trim() !== '')
      if (arr.length) cleaned[k] = arr
    }
    if (Object.keys(cleaned).length) data.unparsed = cleaned
  }

  data.tags = deriveTags(data)
  data.sections = deriveSections(data)
  data.source = prev.source && typeof prev.source === 'object' ? prev.source : { guide: '原神·角色攻略' }

  // 原文件里的其它顶层字段（未知字段）原样保留，避免编辑器静默丢数据
  for (const key of Object.keys(prev)) {
    if (key in data) continue
    if (['schema', 'name', 'game', 'meta', 'v2', 'unparsed', 'tags', 'sections', ...KEEP_KEYS].includes(key)) continue
    data[key] = prev[key]
  }
  return data
}

/** 空白模板（新建角色用）：meta 三项空、v2 六个数组为空 */
export function emptyCharacter (name) {
  const data = {
    schema: 2,
    name,
    game: 'gi',
    meta: { '建议等级': '', '定位': '', '100级提升': '' },
    v2: { weapons: [], artifacts: [], talents: [], panels: [], constellations: [], teams: [] },
    tags: [],
    sections: [],
    source: { guide: '原神·角色攻略' }
  }
  data.tags = deriveTags(data)
  data.sections = deriveSections(data)
  return data
}

/* ------------------------------------------------- 批量替换 / 全局检索引擎 */

/**
 * 名称 → 它在本仓库里是「哪一类」
 * 用于对输入做温和提示：例如用 artifact 类型去替换一个武器名，会返回 warning。
 * @param {string} name
 * @param {{weapons: string[], artifacts: string[], characters: string[]}} index
 * @returns {string} '' 表示不在名称库里
 */
function nameKindInIndex (name, index) {
  if (asArray(index.characters).includes(name)) return 'character'
  if (asArray(index.weapons).includes(name)) return 'weapon'
  if (asArray(index.artifacts).includes(name)) return 'artifact'
  return ''
}

/**
 * 扫描全部 data/gi/*.json，列出命中「某个引用名」的位置。
 *
 * 只看 v2 引用（name / ref / 天赋 order / 命座），不看 note、也不看 tags / sections —— 
 * note 是人工备注（如「精5」「二命」），批量替换它只会把文字改坏。
 *
 * 返回项字段：{file,name(角色),section,where,path,line,kind,ref,text,hitId,note}
 *   · path   —— 形如 `v2.weapons.0.items.1`，供 undo 精确定位
 *   · line   —— 段落内第几行（同一条武器/配队行的多个条目共享行号，对应 guide 输出的一行）
 *   · hitId  —— `${file}#${path}`，前端用来高亮
 * @returns {Array<object>}
 */
function collectRefHits (type, fromName) {
    const wanted = String(fromName ?? '').trim()
    if (!wanted) return []
    const nameOf = (v) => String(v ?? '').trim()
    const out = []
    const push = (name, section, path, line, entry) => {
      const ref = hasText(entry?.ref) ? String(entry.ref).trim() : ''
      const { name: refName } = parseRef(ref)
      let hit = false
      if (refName === wanted) hit = true
      // 天赋行 ref 写的是 talent:A，名称相同就算；命座行没有 ref，按 names 匹配
      if (!hit && type === 'character' && ref === `talent:${wanted}`) hit = true
      if (!hit && type === 'character' && nameOf(entry?.name ?? entry) === wanted) hit = true
      if (!hit) return
    out.push({
      file: '',
      name,
      section,
      where: `${section} · ${lineLabel(type, line)}`,
      path,
      rowId: rowPathOf(path),
      line,
      kind: type,
      ref: ref || `${type}:${wanted}`,
      text: itemText(entry),
      hitId: '',
      note: hasText(entry?.note) ? String(entry.note).trim() : ''
    })
  }

  for (const name of listCharacterNames()) {
    let data
    try {
      data = readJson(characterFile(name))
    } catch {
      continue
    }
    const v2 = data?.v2 ?? {}
    const before = out.length

    if (type === 'weapon') {
      asArray(v2.weapons).forEach((row, i) => {
        asArray(row?.items).forEach((it, j) => {
          push(name, '武器推荐', `v2.weapons.${i}.items.${j}`, i + 1, it)
        })
      })
    } else if (type === 'artifact') {
      asArray(v2.artifacts).forEach((row, i) => {
        asArray(row?.sets).forEach((s, j) => {
          push(name, '圣遗物推荐', `v2.artifacts.${i}.sets.${j}`, i + 1, s)
        })
      })
    } else if (type === 'character') {
      asArray(v2.teams).forEach((row, i) => {
        asArray(row?.members).forEach((m, j) => {
          push(name, '配队推荐', `v2.teams.${i}.members.${j}`, i + 1, m)
        })
      })
    } else if (type === 'talent') {
      asArray(v2.talents).forEach((row, i) => {
        if (row?.kind === 'priority') {
          asArray(row.order).forEach((t, j) => {
            const nm = String(typeof t === 'string' ? t : (t?.name ?? '')).trim().toUpperCase()
            if (nm === wanted.toUpperCase()) {
              const entry = typeof t === 'object' && t !== null ? t : { name: nm, ref: `talent:${nm}` }
              push(name, '天赋加点', `v2.talents.${i}.order.${j}`, i + 1, entry)
            }
          })
        } else if (row?.kind === 'crown') {
          asArray(row.items).forEach((it, j) => {
            const nm = String(typeof it === 'string' ? it : (it?.name ?? '')).trim().toUpperCase()
            if (nm === wanted.toUpperCase()) push(name, '天赋加点', `v2.talents.${i}.items.${j}`, i + 1, it)
          })
        }
      })
    } else if (type === 'constellation') {
      asArray(v2.constellations).forEach((row, i) => {
        if (String(row?.name ?? '').trim() === wanted) push(name, '命座推荐', `v2.constellations.${i}.name`, i + 1, row)
      })
    }

    for (let i = before; i < out.length; i++) {
      out[i].file = `${name}.json`
      out[i].hitId = `${name}.json#${out[i].path}`
    }
  }
  return out
}

/**
 * 命中路径 → 所属「行」的路径（界面上每一行是一个 .box，带 data-rowid）
 * 例如 v2.weapons.0.items.1 → v2.weapons.0；v2.constellations.2.name → v2.constellations.2
 */
function rowPathOf (p) {
  const parts = String(p).split('.')
  const keys = ['items', 'sets', 'members', 'order', 'name', 'level', 'note', 'ref', 'pieces']
  while (parts.length > 1 && keys.includes(parts[parts.length - 1])) parts.pop()
  return parts.join('.')
}

/** 段落内的「行」标签 */
function lineLabel (type, line) {  if (type === 'character') return `配队第 ${line} 行`
  if (type === 'artifact') return `圣遗物第 ${line} 行`
  if (type === 'talent') return `天赋第 ${line} 行`
  if (type === 'constellation') return `命座第 ${line} 行`
  return `武器第 ${line} 行`
}

/** 把命中按角色汇总 → 预览/执行结果共用 */
function summarizeHits (hits) {
  const per = new Map()
  for (const h of hits) per.set(h.name, (per.get(h.name) ?? 0) + 1)
  return [...per].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/**
 * 在内存里把一处命中的 name / ref 改成新名字
 * @returns {{from: string, oldName: string, oldRef: string, to: string, newRef: string}|null}
 */
function applyRefHit (container, key, toName, type) {
  const entry = container?.[key]
  if (entry == null) return null
  const isObj = typeof entry === 'object'
  const before = String(isObj ? (entry.name ?? '') : entry).trim()
  const oldRef = isObj && hasText(entry.ref) ? String(entry.ref).trim() : ''

  if (type === 'talent') {
    const upper = toName.toUpperCase()
    if (isObj) {
      entry.name = upper
      if ('ref' in entry) entry.ref = `talent:${upper}`
    } else {
      container[key] = upper
    }
  } else if (isObj) {
    entry.name = toName
    if ('ref' in entry) entry.ref = `${type}:${toName}`
  } else {
    container[key] = toName
  }
  const after = isObj ? String(entry.name ?? '') : String(container[key])
  const newRef = isObj && hasText(entry.ref) ? String(entry.ref).trim() : `${type}:${after}`
  return { from: before, oldName: before, oldRef, to: after, newRef }
}

/** 备份目录名：文件名安全的时间戳（本地时间） */
function makeStamp () {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** data/_backup/<stamp>/ 是否存在（并要求是目录） */
function findStampDir (stamp) {
  const name = String(stamp ?? '').trim()
  if (!name || !/^[0-9]{8}-[0-9]{6}(-\d+)?$/.test(name)) throw err(400, `时间戳不合法：${stamp}`)
  const dir = path.join(backupDir, name)
  if (!fs.existsSync(dir)) throw err(404, `找不到备份：${name}`)
  return { name, dir }
}

/** 把待改文件复制到 data/_backup/<stamp>/，并写 manifest.json */
function writeBackup (stamp, files, manifest) {
  const dir = path.join(backupDir, stamp)
  fs.mkdirSync(dir, { recursive: true })
  for (const name of files) {
    fs.copyFileSync(characterFile(name), path.join(dir, `${name}.json`))
  }
  writeJsonFile(path.join(dir, 'manifest.json'), { stamp, createdAt: new Date().toISOString(), done: false, files, ...manifest })
  return dir
}

/**
 * 执行批量替换：只改 ref/name，并回推 tags / sections（两者都是派生的，必须同步重建）。
 * @param {{type: string, from: string, to: string}} opts
 * @returns {{stamp: string, files: number, perCharacter: object[], changed: number}}
 */
function runBatchReplace ({ type, from, to }) {
  const hits = collectRefHits(type, from)
  const byFile = new Map()
  for (const h of hits) {
    if (!byFile.has(h.name)) byFile.set(h.name, [])
    byFile.get(h.name).push(h)
  }
  const stamp = makeStamp()
  const names = [...byFile.keys()]
  const dir = writeBackup(stamp, names, { type, from, to, hits: hits.length })

  let changed = 0
  const perCharacter = []
  for (const [name, fileHits] of byFile) {
    const file = characterFile(name)
    const data = readJson(file)
    let n = 0
    for (const h of fileHits) {
      const parts = h.path.split('.')
      const key = parts.pop()
      let container = data
      for (const p of parts) container = container?.[p]
      if (applyRefHit(container, key, to, type)) n++
    }
    if (!n) continue
    data.tags = deriveTags(data)
    data.sections = deriveSections(data)
    writeJsonFile(file, data)
    changed += n
    perCharacter.push({ name, count: n })
  }
  // 索引里并入了「数据里出现过的 ref 名」，替换后必须重建，否则旧名字还会被当成合法名
  const idx = refreshIndexFile()
  writeJsonFile(path.join(dir, 'manifest.json'), {
    stamp, createdAt: new Date().toISOString(), done: true, files: names, type, from, to,
    hits: hits.length, changed, indexRefreshed: idx.refreshed
  })
  return { stamp, files: names.length, perCharacter, changed }
}

/**
 * 用备份回滚：逐字节还原备份里的文件。
 * 注意备份是「执行替换那一刻的快照」，所以替换之后的其它手工改动会被一起覆盖掉 —— 界面上要提醒。
 * @param {string} stamp
 */
function undoBatchReplace (stamp) {
  const { name, dir } = findStampDir(stamp)
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json') && f !== 'manifest.json')
  const restored = []
  for (const f of files) {
    const target = path.join(giDir, f)
    if (!fs.existsSync(target)) continue
    fs.copyFileSync(path.join(dir, f), target)
    restored.push(f)
  }
  // 备份整目录删掉：回滚后它就没有意义了，留着容易误用
  fs.rmSync(dir, { recursive: true, force: true })
  const idx = refreshIndexFile()
  return { stamp: name, files: restored.length, characters: restored.map(f => f.slice(0, -'.json'.length)), indexRefreshed: idx.refreshed }
}

/* --------------------------------------------------- 心跳 / 空闲自动退出 */

/**
 * 空闲自动退出（`--exit-on-idle[=<秒>]`，默认关闭）
 *
 * 背景：桌面快捷方式用 powershell -WindowStyle Hidden 后台起服务，窗口一关，
 * 服务就成了「任务管理器里才找得到的幽灵进程」。开启这个开关后改用**心跳**判断页面还在不在：
 *
 *   · 打开页面后前端每 5 秒 POST /api/heartbeat
 *   · 页面 pagehide / beforeunload 时 navigator.sendBeacon('/api/close') 发关闭信号
 *   · 「连续 idleSeconds 秒没有任何心跳」→ 自动退出（覆盖关窗口、崩溃、断网等一切情况）
 *   · 收到关闭信号后再等 CLOSE_GRACE_MS（5 秒）退出 —— 给「刷新页面」「关掉再马上开」留余地：
 *     这 5 秒内只要又来一次心跳，就取消这次退出
 *   · 多标签页天然正确：只记「最近一次心跳时间」，任一标签还在心跳就不会超时
 *
 * @param {number} idleSeconds 心跳超时秒数
 * @param {() => void} onExit 真正退出时调用（默认 process.exit(0)）
 * @returns {{heartbeat: Function, requestClose: Function, stop: Function, state: Function}}
 */
export function createIdleWatcher (idleSeconds, onExit = () => process.exit(0)) {  const idleMs = Math.max(1, Number(idleSeconds) || 20) * 1000
  let lastBeat = Date.now()
  let closeRequested = false
  let closeAt = 0
  let fired = false
  const log = (msg) => console.log(`[idle] ${msg}`)

  const heartbeat = () => {
    lastBeat = Date.now()
    if (closeRequested) {
      // 关闭信号后又来心跳（刷新 / 快速重开）→ 取消这次退出
      closeRequested = false
      closeAt = 0
      log('收到心跳，取消本次退出')
    }
    return { ok: true, idleSeconds: idleMs / 1000 }
  }

  const requestClose = () => {
    if (!closeRequested) {
      closeRequested = true
      closeAt = Date.now() + CLOSE_GRACE_MS
      log(`收到关闭信号，${CLOSE_GRACE_MS / 1000}s 后退出（期间有心跳则取消）`)
    }
    return { ok: true, graceMs: CLOSE_GRACE_MS }
  }

  const tick = () => {
    if (fired) return
    const now = Date.now()
    if (closeRequested) {
      if (now >= closeAt) {
        fired = true
        log(`关闭信号后 ${CLOSE_GRACE_MS / 1000}s 内无心跳，自动退出`)
        onExit()
      }
      return
    }
    const silent = now - lastBeat
    if (silent >= idleMs) {
      fired = true
      log(`无心跳 ${Math.round(silent / 1000)}s（阈值 ${idleMs / 1000}s），自动退出`)
      onExit()
    }
  }

  const timer = setInterval(tick, 500)
  if (timer.unref) timer.unref() // 别让这个定时器自己拖住进程
  return {
    heartbeat,
    requestClose,
    stop: () => clearInterval(timer),
    state: () => ({ lastBeat, closeRequested, closeAt, idleMs, fired })
  }
}

/** 当前进程的空闲看门狗（只有 main 里开了 --exit-on-idle 才存在） */
let idleWatcher = null
let idleSeconds = null

/* ------------------------------------------------------------------- 路由 */

function sendJson (res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

const sendError = (res, status, message) => sendJson(res, status, { error: message })

/** 读请求体（大小上限内），返回 Buffer */
function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(err(413, '请求体过大（上限 8MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 读请求体并解析 JSON */
async function readJsonBody (req) {
  const buf = await readBody(req)
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (e) {
    throw err(400, `请求体不是合法 JSON：${e.message}`)
  }
}

/* --------------------------------------------------------------- 各 API 实现 */

function apiIndex (res) {
  sendJson(res, 200, readIndex())
}

function apiCharacters (res) {
  const order = readOrder()
  const names = listCharacterNames()
  const items = []
  for (const name of orderList(names, order)) {
    let data = null
    try {
      data = readJson(characterFile(name))
    } catch {
      items.push({ name, weapons: 0, artifacts: 0, hasUnparsed: false, broken: true })
      continue
    }
    const v2 = data?.v2 ?? {}
    const unparsed = data?.unparsed ?? {}
    items.push({
      name,
      weapons: asArray(v2.weapons).length,
      artifacts: asArray(v2.artifacts).length,
      hasUnparsed: Object.values(unparsed).some(lines => asArray(lines).length > 0)
    })
  }
  // 有文件但没写进 _order.json 的角色（编辑器会用「↑/↓ 排序」把它们补进去）
  const missing = items.map(x => x.name).filter(n => !order.includes(n))
  sendJson(res, 200, { order, items, missing })
}

function apiGetCharacter (res, url) {
  const name = safeName(url.searchParams.get('name'))
  const file = characterFile(name)
  if (!fs.existsSync(file)) return sendError(res, 404, `角色不存在：${name}`)
  let data
  try {
    data = readJson(file)
  } catch (e) {
    return sendError(res, 500, `读取失败：${name}.json —— ${e.message}`)
  }
  const index = readIndex()
  const issues = validate(data, index)
  sendJson(res, 200, { ...data, issues })
}

async function apiPutCharacter (req, res, url) {
  const name = safeName(url.searchParams.get('name'))
  if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
  const file = characterFile(name)
  let prev = {}
  if (fs.existsSync(file)) {
    try {
      prev = readJson(file)
    } catch (e) {
      throw err(500, `原文件不是合法 JSON，请先手工修复：${name}.json —— ${e.message}`)
    }
  }
  const body = await readJsonBody(req)
  const data = buildCharacter(body, name, prev)
  writeJsonFile(file, data)
  appendOrder(name)
  const idx = refreshIndexFile()
  const issues = validate(data, readIndex())
  // 保存成功一律 200：issues 是「名称不在图鉴」之类的提醒，indexWarning 是索引重建失败的提醒，都不是保存失败
  sendJson(res, 200, {
    ok: true,
    issues,
    indexRefreshed: idx.refreshed,
    ...(idx.refreshed ? { indexGeneratedAt: idx.generatedAt } : {}),
    ...(idx.warning ? { indexWarning: idx.warning } : {})
  })
}

async function apiCreateCharacter (req, res) {
  const body = await readJsonBody(req)
  const name = safeName(body?.name)
  const file = characterFile(name)
  if (fs.existsSync(file)) return sendError(res, 409, `角色已存在：${name}`)
  if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
  writeJsonFile(file, emptyCharacter(name))
  appendOrder(name)
  const idx = refreshIndexFile()
  sendJson(res, 200, {
    ok: true,
    name,
    indexRefreshed: idx.refreshed,
    ...(idx.warning ? { indexWarning: idx.warning } : {})
  })
}

async function apiRename (req, res) {
  const body = await readJsonBody(req)
  const from = safeName(body?.from)
  const to = safeName(body?.to)
  if (from === to) return sendJson(res, 200, { ok: true, name: to })
  const fromFile = characterFile(from)
  const toFile = characterFile(to)
  if (!fs.existsSync(fromFile)) return sendError(res, 404, `角色不存在：${from}`)
  if (fs.existsSync(toFile)) return sendError(res, 409, `目标已存在：${to}`)

  let prev = {}
  try {
    prev = readJson(fromFile)
  } catch (e) {
    return sendError(res, 500, `原文件不是合法 JSON：${from}.json —— ${e.message}`)
  }
  // 用与保存同一套逻辑重写（字段顺序、tags/sections 与 normalizeV2 的写法都保持一致）
  writeJsonFile(toFile, buildCharacter({ game: prev.game, meta: prev.meta, v2: prev.v2, unparsed: prev.unparsed }, to, prev))
  fs.unlinkSync(fromFile)

  const order = readOrder()
  const i = order.indexOf(from)
  if (i === -1) appendOrder(to)
  else {
    order[i] = to
    writeOrder(order)
  }
  const idx = refreshIndexFile()
  sendJson(res, 200, {
    ok: true,
    name: to,
    indexRefreshed: idx.refreshed,
    ...(idx.warning ? { indexWarning: idx.warning } : {})
  })
}

function apiDeleteCharacter (res, url) {
  const name = safeName(url.searchParams.get('name'))
  const file = characterFile(name)
  if (!fs.existsSync(file)) return sendError(res, 404, `角色不存在：${name}`)
  if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true })
  fs.renameSync(file, path.join(trashDir, `${name}.json`))
  removeFromOrder(name)
  const idx = refreshIndexFile()
  sendJson(res, 200, {
    ok: true,
    name,
    trashed: path.relative(root, path.join(trashDir, `${name}.json`)).split(path.sep).join('/'),
    indexRefreshed: idx.refreshed,
    ...(idx.warning ? { indexWarning: idx.warning } : {})
  })
}

/* -------------------------------------------------------------- 回收站 */

/** data/_trash/ 里被软删除的角色（按删除时间倒序，最新的在前） */
function listTrash () {
  let entries = []
  try {
    entries = fs.readdirSync(trashDir, { withFileTypes: true })
  } catch {
    return []
  }
  const items = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const base = entry.name.slice(0, -'.json'.length)
    if (!isValidName(base)) continue
    const full = path.join(trashDir, entry.name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    let data = null
    try {
      data = readJson(full)
    } catch {
      data = null
    }
    const v2 = data?.v2 ?? {}
    items.push({
      name: base,
      file: path.relative(root, full).split(path.sep).join('/'),
      bytes: stat.size,
      deletedAt: stat.mtime.toISOString(),
      schema: data?.schema ?? null,
      broken: !data,
      summary: {
        weapons: asArray(v2.weapons).length,
        artifacts: asArray(v2.artifacts).length,
        teams: asArray(v2.teams).length,
        constellations: asArray(v2.constellations).length
      },
      // 恢复了会不会撞名（data/gi 里已经有同名文件）
      conflicts: fs.existsSync(characterFile(base))
    })
  }
  return items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
}

/** 回收站里的某个角色对应的文件（校验名字合法性） */
function trashFile (raw) {
  const name = safeName(raw)
  const file = path.join(trashDir, `${name}.json`)
  if (!fs.existsSync(file)) throw err(404, `回收站里没有这个角色：${name}`)
  return { name, file }
}

/** GET /api/trash → { items, total } */
function apiTrashList (res) {
  const items = listTrash()
  sendJson(res, 200, { ok: true, total: items.length, items })
}

/** POST /api/trash/restore { name } → 移回 data/gi/ 并补回 _order.json 末尾 */
async function apiTrashRestore (req, res) {
  const body = await readJsonBody(req)
  const { name, file } = trashFile(body?.name)
  const target = characterFile(name)
  if (fs.existsSync(target)) return sendError(res, 409, `data/gi/ 里已经有「${name}.json」，请先改名或删除它再恢复`)
  if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
  fs.renameSync(file, target)
  appendOrder(name)
  const idx = refreshIndexFile()
  sendJson(res, 200, {
    ok: true,
    name,
    restored: path.relative(root, target).split(path.sep).join('/'),
    indexRefreshed: idx.refreshed,
    ...(idx.warning ? { indexWarning: idx.warning } : {})
  })
}

/** DELETE /api/trash?name=X → 彻底删除一个 */
function apiTrashDelete (res, url) {
  const { name, file } = trashFile(url.searchParams.get('name'))
  fs.unlinkSync(file)
  sendJson(res, 200, { ok: true, name, deleted: true })
}

/** DELETE /api/trash → 清空回收站 */
function apiTrashEmpty (res) {
  const items = listTrash()
  const removed = []
  for (const item of items) {
    try {
      fs.unlinkSync(path.join(trashDir, `${item.name}.json`))
      removed.push(item.name)
    } catch { /* 单个删不掉不影响其它 */ }
  }
  sendJson(res, 200, { ok: true, removed: removed.length, names: removed })
}

async function apiReorder (req, res) {
  const body = await readJsonBody(req)
  if (!Array.isArray(body?.order)) throw err(400, '缺少 order 数组')
  const names = body.order.map(x => String(x).trim())
  for (const n of names) safeName(n)
  const existing = new Set(listCharacterNames())
  const seen = new Set()
  const next = []
  for (const n of names) {
    if (seen.has(n) || !existing.has(n)) continue
    seen.add(n)
    next.push(n)
  }
  // 没提到的角色按原顺序/拼音补在后面，避免「排序」把角色从清单里挤掉
  for (const n of orderList([...existing], readOrder())) if (!seen.has(n)) next.push(n)
  writeOrder(next)
  sendJson(res, 200, { ok: true, order: next })
}

/* ------------------------------------------------------------- 名称库用量 */

/**
 * GET /api/name-usage
 *
 * 名称库浏览面板要显示「哪些名字在用、用了多少处、谁在用、哪些完全没用」。
 * 逐个名字调 collectRefHits 会是几百次全量扫描，所以这里只扫一遍 data/gi/*.json，
 * 按 ref 名汇总。ref 与 name 不一致时以 ref 为准（ref 才是图标/跳转的依据），
 * 但同时把 name 记进同一个桶，避免「名字在数据里却显示未使用」。
 * @returns {{weapons: Array, artifacts: Array, characters: Array, indexTotal: object, scanned: number, totalRefs: number}}
 */
function collectNameUsage () {
  const buckets = { weapon: new Map(), artifact: new Map(), character: new Map() }
  const add = (type, name, character) => {
    const n = String(name ?? '').trim()
    if (!n || n.length > 24) return
    const map = buckets[type]
    if (!map) return
    let rec = map.get(n)
    if (!rec) { rec = { name: n, total: 0, byCharacter: new Map() }; map.set(n, rec) }
    rec.total++
    rec.byCharacter.set(character, (rec.byCharacter.get(character) ?? 0) + 1)
  }
  let scanned = 0
  let totalRefs = 0
  for (const character of listCharacterNames()) {
    let data
    try {
      data = readJson(characterFile(character))
    } catch {
      continue
    }
    scanned++
    const v2 = data?.v2 ?? {}
    const handle = (type, entry) => {
      if (!entry) return
      const ref = hasText(entry.ref) ? String(entry.ref).trim() : ''
      const parsed = ref ? parseRef(ref) : { type: '', name: '' }
      const type2 = parsed.type || type
      if (parsed.name) add(type2, parsed.name, character)
      const nm = typeof entry === 'string' ? entry.trim() : String(entry.name ?? '').trim()
      if (nm && nm !== parsed.name) add(type2 || type, nm, character)
      totalRefs++
    }
    for (const row of asArray(v2.weapons)) for (const it of asArray(row?.items)) handle('weapon', it)
    for (const row of asArray(v2.artifacts)) for (const s of asArray(row?.sets)) handle('artifact', s)
    for (const row of asArray(v2.teams)) for (const m of asArray(row?.members)) handle('character', m)
  }
  const flatten = (map) => [...map.values()]
    .map(r => ({ name: r.name, total: r.total, characters: [...r.byCharacter.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const index = readIndex()
  return {
    weapons: flatten(buckets.weapon),
    artifacts: flatten(buckets.artifact),
    characters: flatten(buckets.character),
    indexTotal: { weapons: index.weapons.length, artifacts: index.artifacts.length, characters: index.characters.length },
    scanned,
    totalRefs
  }
}

/* ------------------------------------------------------------- 全局检索 */

const SEARCH_TYPES = ['weapon', 'artifact', 'character', 'talent', 'constellation', 'set']

/**
 * GET /api/search?q=&type=&scope=
 *
 * scope：
 *   · name  —— 只当名称查（在 v2 引用里找「谁用了这个名字」）
 *   · text  —— 只搜正文关键词（sections 文本行）
 *   · auto  —— 默认：两者都做，结果分别放在 names / text 两组
 *
 * 名称检索规则：
 *   · q 命中名称库里某类名字（全等或子串）→ 逐个名字列出「哪些角色/哪个段落/哪一行用到」
 *   · 名称只在 data/gi 里出现过（不在索引）也照样能查到，并给出 usedNames 提示
 *   · `set` 是 artifact 的别名（圣遗物套装），方便界面按「套装」叫法查
 */
function apiSearch (res, url) {
  const q = String(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim()
  const askedType = String(url.searchParams.get('type') ?? '').trim().toLowerCase()
  const scope = (String(url.searchParams.get('scope') ?? 'auto').trim().toLowerCase() || 'auto')
  if (!q) return sendJson(res, 200, { q: '', scope, types: [], names: [], text: [], totalHits: 0, totalText: 0 })
  if (scope !== 'name' && scope !== 'text' && scope !== 'auto') throw err(400, `scope 只能是 name / text / auto：${scope}`)

  const types = askedType === 'set'
    ? ['artifact']
    : (SEARCH_TYPES.includes(askedType) ? [askedType] : ['weapon', 'artifact', 'character', 'talent', 'constellation'])

  const index = readIndex()
  const lower = q.toLowerCase()
  const exact = []
  const fuzzy = []
  const nameGroups = []

  if (scope !== 'text') {
    const bucket = { weapon: index.weapons, artifact: index.artifacts, character: index.characters, talent: [], constellation: [] }
    for (const type of types) {
      for (const name of asArray(bucket[type])) {
        if (name === q) exact.push({ type, name })
        else if (name.toLowerCase().includes(lower)) fuzzy.push({ type, name })
      }
    }
    // 名称不在索引、但数据里确实在用（例如刚写进 json 还没进索引的名字）也允许查
    if (!exact.length && !fuzzy.length) {
      for (const type of types) {
        for (const h of collectRefHits(type, q)) {
          exact.push({ type: h.kind, name: q, fromData: true })
          break
        }
      }
    }
    const picked = exact.length ? exact : fuzzy
    for (const item of picked.slice(0, 8)) {
      const hits = collectRefHits(item.type, item.name)
      nameGroups.push({
        type: item.type,
        name: item.name,
        fromData: !!item.fromData,
        total: hits.length,
        characters: summarizeHits(hits),
        hits
      })
    }
  }

  // 正文关键词：在 v2 派生出来的 sections 文本行里找（这些就是 guide 里的一行行文字）
  const text = []
  if (scope !== 'name') {
    for (const name of listCharacterNames()) {
      let data
      try {
        data = readJson(characterFile(name))
      } catch {
        continue
      }
      const sections = asArray(data?.sections)
      sections.forEach((sec, si) => {
        asArray(sec?.lines).forEach((lineText, li) => {
          const s = String(lineText)
          if (s.toLowerCase().includes(lower)) {
            text.push({ name, title: String(sec?.title ?? ''), line: li + 1, text: s, hitId: `${name}.json#sections.${si}.lines.${li}` })
          }
        })
      })
      if (text.length > 500) break
    }
  }

  sendJson(res, 200, {
    q,
    scope,
    types,
    names: nameGroups,
    text,
    totalHits: nameGroups.reduce((n, g) => n + g.total, 0),
    totalText: text.length,
    fuzzy: !exact.length && fuzzy.length > 0
  })
}

/* ------------------------------------------------------------- 批量替换 */

/** POST /api/batch-replace { type, from, to, dry? } */
async function apiBatchReplace (req, res) {
  const body = await readJsonBody(req)
  const type = String(body?.type ?? '').trim().toLowerCase()
  if (!['weapon', 'artifact', 'character', 'talent', 'constellation'].includes(type)) {
    throw err(400, `type 只能是 weapon / artifact / character / talent / constellation：${body?.type ?? ''}`)
  }
  const from = String(body?.from ?? '').trim()
  const to = String(body?.to ?? '').trim()
  if (!from) throw err(400, '缺少 from（被替换的名称）')
  if (!to) throw err(400, '缺少 to（替换成的新名称）')
  if (from === to) {
    const hits = collectRefHits(type, from)
    return sendJson(res, 200, {
      ok: true, dry: true, noop: true, type, from, to,
      total: hits.length, files: new Set(hits.map(h => h.name)).size,
      perCharacter: summarizeHits(hits), hits,
      warnings: ['from 与 to 相同，不会产生任何改动']
    })
  }
  const index = readIndex()
  const warnings = []
  const kindFrom = nameKindInIndex(from, index)
  const kindTo = nameKindInIndex(to, index)
  if (!kindFrom) warnings.push(`⚠「${from}」不在 data/_index.json 的 ${type} 清单里（可能是错名或新名字，仍可强制替换）`)
  else if (kindFrom !== type) warnings.push(`⚠「${from}」在名称库里属于「${kindFrom}」，但本次按「${type}」替换`)
  if (!kindTo) warnings.push(`⚠ 新名称「${to}」不在 data/_index.json 里，替换后会留下「名称不在图鉴」的 ⚠ 提示`)
  else if (kindTo !== type && !(type === 'talent' || type === 'constellation')) warnings.push(`⚠ 新名称「${to}」在名称库里属于「${kindTo}」`)

  const dry = body?.dry === true
  if (dry) {
    const hits = collectRefHits(type, from)
    return sendJson(res, 200, {
      ok: true,
      dry: true,
      type,
      from,
      to,
      total: hits.length,
      files: new Set(hits.map(h => h.name)).size,
      perCharacter: summarizeHits(hits),
      hits,
      warnings
    })
  }
  const result = runBatchReplace({ type, from, to })
  const hits = collectRefHits(type, from)  // 替换后旧名字的剩余命中（正常为 0）
  sendJson(res, 200, {
    ok: true,
    dry: false,
    type,
    from,
    to,
    ...result,
    remaining: hits.length,
    warnings
  })
}

/** POST /api/batch-replace/undo { stamp } */
async function apiBatchUndo (req, res) {
  const body = await readJsonBody(req)
  if (!body?.stamp) throw err(400, '缺少 stamp（批量替换返回的备份时间戳）')
  sendJson(res, 200, { ok: true, ...undoBatchReplace(body.stamp) })
}

/* -------------------------------------------------------------- 发布文档 */

/**
 * 「保存即发布」：一次点击把改动铺到全链路
 *   ① 写角色 JSON（body.name 给了才写；没给就假定界面已经保存过）
 *   ② 重建 data/_index.json
 *   ③ build-docx.mjs 写回主文档（自动备份 + 两种模式都做 129/129 往返校验）
 *   ④ build-html.mjs 生成 guide.html
 *   ⑤ 生成提交摘要 → out/_commit-summary.md + 响应
 *
 * **默认不执行 git add / git commit**：摘要只落盘 + 回传，提交由人工执行。
 * 显式提交走 POST /api/commit（界面默认不触发）。
 *
 * @returns {Promise<void>}
 */
async function apiPublish (req, res) {
  const body = await readJsonBody(req).catch(() => ({}))
  const name = body?.name ? safeName(body.name) : null
  const steps = []
  const mark = (step, ok, detail) => {
    steps.push({ step, ok, ...(detail ? { detail } : {}) })
    if (!ok) throw Object.assign(new Error(detail || `${step} 失败`), { step })
  }

  // 变更前的快照：改名 / 改写角色 JSON 都靠它做前后对比
  const before = snapshotFiles()
  let wroteJson = false
  /** 写盘前的角色 JSON（提交摘要的对比基线） */
  let prevJson = null
  if (name) {
    const file = characterFile(name)
    let prev = {}
    if (fs.existsSync(file)) {
      try { prev = readJson(file) } catch (e) { throw Object.assign(new Error(`原文件不是合法 JSON：${name}.json —— ${e.message}`), { step: '写角色 JSON' }) }
    }
    prevJson = prev // 基线必须是写盘前读到的内容
    try {
      const data = buildCharacter(body?.character ?? body, name, prev)
      writeJsonFile(file, data)
      appendOrder(name)
      wroteJson = true
      mark('写角色 JSON', true, `data/gi/${name}.json`)
    } catch (e) {
      mark('写角色 JSON', false, String(e?.message ?? e))
    }
  } else {
    mark('写角色 JSON', true, '跳过（未指定 name，沿用界面已保存的 JSON）')
  }

  // ② 重建索引（失败不算致命：保存流程里也只是警告，但发布要如实报出来）
  try {
    const idx = refreshIndexFile()
    if (!idx.refreshed) mark('重建 data/_index.json', false, idx.warning)
    else mark('重建 data/_index.json', true, `武器 ${idx.weapons} / 角色 ${idx.characters} / 圣遗物 ${idx.artifacts}`)
  } catch (e) {
    mark('重建 data/_index.json', false, String(e?.message ?? e))
  }

  // ③ 写回主文档：build-docx 默认只写 out/ 试验产物，只有显式 --write-main 才动主文档
  //    （真实发布路径用 --write-main；它自己会备份 + 往返自检 + 幂等校验）
  let docx = { path: DEFAULT_DOC, backup: null, bytes: 0, log: '' }
  const docxHashBefore = snapshotMainDoc()
  let docxRoundTripRaw = ''
  try {
    const out = await runNodeScript(path.join(here, 'build-docx.mjs'), ['--write-main'])
    docxRoundTripRaw = out
    docx = { ...docx, ...parseBuildDocxLog(out), log: out.trim().split('\n').filter(Boolean).slice(-6) }
    if (!fs.existsSync(DEFAULT_DOC)) throw new Error('build-docx 没有产出主文档')
    docx.bytes = fs.statSync(DEFAULT_DOC).size
    mark('写回主文档', true, `备份 ${docx.backup || '（无）'}`)
  } catch (e) {
    docxRoundTripRaw = String(e?.stdout ?? '') + '\n' + String(e?.message ?? e)
    mark('写回主文档', false, `build-docx 失败：${String(e?.message ?? e)}`)
  }

  // ④ 生成 guide.html
  let html = { path: path.join(root, 'guide.html'), bytes: 0 }
  try {
    await runNodeScript(path.join(here, 'build-html.mjs'), [])
    if (!fs.existsSync(html.path)) throw new Error('build-html 没有产出 guide.html')
    html.bytes = fs.statSync(html.path).size
    html.hash = sha1File(html.path)
    html.builtWithinRun = true
    mark('生成 guide.html', true, `${html.bytes} 字节`)
  } catch (e) {
    mark('生成 guide.html', false, `build-html 失败：${String(e?.message ?? e)}`)
  }

  const after = snapshotFiles()
  const relJson = name ? path.posix.join('data', 'gi', `${name}.json`) : null
  const curJson = name ? readJsonSafe(path.join(root, relJson)) : null
  const perChar = name ? [diffCharacterFields(name, prevJson, curJson, relJson)] : []
  const baselineInfo = {
    name,
    json: prevJson,
    // 写盘前后文件被并发改写时，字段统计可能对不上，摘要里要如实提醒
    concurrent: name ? before.get(relJson) !== after.get(relJson) : false
  }
  const summary = buildCommitSummary({ before, after, name, docx, html, wroteJson, steps, perChar, baseline: baselineInfo })
  // 摘要里先写「会由本流程提交」（此时还没提交，拿不到 hash）；提交失败会重写这一段
  summary.commitNote = '> 本摘要由「保存并发布」生成；保存并发布会自动提交（**不含 push**，推送请人工执行）。'
  summary.markdown = renderSummaryMarkdown(summary)
  let summaryFiles = null
  try {
    summaryFiles = writeSummaryFiles(summary.markdown)
  } catch (e) {
    summary.summaryWarning = `摘要落盘失败：${String(e?.message ?? e)}`
  }
  const summaryFile = summaryFiles?.file ?? 'out/_commit-summary.md'

  // ④.5 三方一致性校验：数据库（diagnose）/ 文档（往返）+ 悬挂分隔符 / 网页版（本次生成）
  //      任一项不过就**不提交**；已生成的文档与网页保持可用，不回滚。
  const verify = await verifyThreeWay({
    docxRoundTripRaw,
    docxHashBefore,
    docxPath: DEFAULT_DOC,
    frozenGiDir: parseFrozenGiDir(docxRoundTripRaw),
    markedDocx: parseMarkedDocxLog(docxRoundTripRaw),
    html,
    name
  })
  if (!verify.ok) {
    summary.commitNote = `> ⚠ 三方一致性校验未通过，**已跳过自动提交**：${verify.detail}`
    summary.markdown = renderSummaryMarkdown(summary)
    if (summaryFiles) {
      try { summaryFiles = writeSummaryFiles(summary.markdown) } catch { /* 忽略 */ }
    }
    sendJson(res, 200, {
      ok: false,
      step: 'verify',
      detail: verify.detail,
      verify,
      steps,
      commit: null,
      commitExecuted: false,
      commitError: null,
      commitSkipped: null,
      pushed: false,
      summary,
      summaryFile,
      summaryStampFile: summaryFiles?.stampFile ?? null,
      summaryKept: summaryFiles?.kept ?? [],
      docx: { path: docx.path, backup: docx.backup, bytes: docx.bytes },
      markedDocx: parseMarkedDocxLog(docxRoundTripRaw),
      html: { path: path.relative(root, html.path).split(path.sep).join('/'), bytes: html.bytes }
    })
    return
  }

  // ⑤ 自动提交（**绝不 push**）：只提交本次发布真正动过的路径，不把仓库里别人的在途改动卷进来。
  //    失败不报错、不回滚 —— 保存与生成都已经成功了，提交失败只提示用户手动提交。
  const commitResult = await commitChanges({
    subject: summary.suggestedMessage,
    bullets: summary.bullets,
    paths: [...summary.changedFiles.map(c => c.path), summaryFile, summaryFiles?.stampFile].filter(Boolean),
    stageAll: body?.stageAll === true
  })
  summary.commit = {
    executed: commitResult.executed,
    hash: commitResult.hash ?? null,
    error: commitResult.error ?? null,
    skipped: commitResult.skipped ?? null,
    scope: commitResult.paths ?? null,
    pushed: false
  }
  summary.commitNote = commitResult.executed
    ? `> 已自动提交 \`${commitResult.hash}\`（**未 push**；推送请人工执行 \`git push\`）。`
    : (commitResult.error
        ? `> ⚠ 自动提交失败：${commitResult.error}　→ 请手动 \`git add && git commit\`（保存与生成已完成，未回滚）。`
        : `> ${commitResult.skipped || '无改动可提交'}　→ 无需提交。`)
  summary.markdown = renderSummaryMarkdown(summary)
  if (summaryFiles) {
    try { summaryFiles = writeSummaryFiles(summary.markdown) } catch { /* 摘要二次写入失败不影响主流程 */ }
  }

  sendJson(res, 200, {
    ok: true,
    steps,
    verify,
    commit: commitResult.hash,
    commitExecuted: commitResult.executed,
    commitError: commitResult.error ?? null,
    commitSkipped: commitResult.skipped ?? null,
    commitScope: commitResult.paths ?? null,
    pushed: false,
    summary,
    summaryFile,
    summaryStampFile: summaryFiles?.stampFile ?? null,
    summaryKept: summaryFiles?.kept ?? [],
    docx: { path: docx.path, backup: docx.backup, bytes: docx.bytes },
    markedDocx: parseMarkedDocxLog(docxRoundTripRaw),
    html: { path: path.relative(root, html.path).split(path.sep).join('/'), bytes: html.bytes }
  })
}

/** git 是否可用（用 `git rev-parse` 探测，不依赖 PATH 之外的任何东西） */
async function gitAvailable () {
  const r = await gitRun(['rev-parse', '--is-inside-work-tree'])
  return r.code === 0
}

/** git 输出是否表示「无改动可提交」 */
const isNothingToCommit = (out) => /nothing to commit|nothing added to commit|无文件要提交|没有要提交的|nothing added/i.test(out)

/**
 * 自动提交（只 add + commit，**永不 push**）
 *
 * @param {{subject?: string, bullets?: string[], paths?: string[], stageAll?: boolean}} opts
 * @returns {Promise<{executed: boolean, hash: string|null, error?: string, skipped?: string, paths?: string[]}>}
 */
async function commitChanges (opts = {}) {
  const subject = String(opts.subject ?? '').trim() || 'docs: 更新角色攻略数据与文档'
  if (!(await gitAvailable())) return { executed: false, hash: null, error: 'git 不可用，请手动提交' }

  // 提交范围：优先只提交本次发布动过的路径（仓库内的），避免把别人的在途改动一起提交
  const paths = []
  for (const raw of opts.paths ?? []) {
    if (!raw) continue
    const abs = path.isAbsolute(raw) ? raw : path.join(root, raw)
    const relCheck = path.relative(root, abs)
    if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue // 仓库外（主文档）不进 git
    const rel = relCheck.split(path.sep).join('/')
    // 被 .gitignore 忽略的（如 out/ 下的摘要）跳过：git add 会直接报错
    if ((await gitRun(['check-ignore', '--quiet', '--', rel])).code === 0) continue
    if (fs.existsSync(abs) || (await gitRun(['ls-files', '--error-unmatch', '--', rel])).code === 0) paths.push(rel)
  }
  // 本次发布动过的路径都被忽略时，退回整仓 add -A（此时工作区里只有别人的在途改动，提交信息仍用本次摘要）
  const unique = [...new Set(paths)]
  const addArgs = opts.stageAll || !unique.length ? ['add', '-A'] : ['add', '--', ...unique]
  const add = await gitRun(addArgs)
  if (add.code !== 0) return { executed: false, hash: null, error: `git add 失败：${(add.stderr || add.stdout).trim().slice(0, 300)}` }

  const staged = await gitRun(['diff', '--cached', '--name-only'])
  if (!staged.stdout.trim()) return { executed: false, hash: null, skipped: '无改动可提交（工作区已干净）' }

  const message = buildCommitMessage(subject, opts.bullets ?? [])
  const commit = await gitRun(['commit', '-m', message])
  const output = `${commit.stdout}\n${commit.stderr}`
  if (commit.code !== 0) {
    if (isNothingToCommit(output)) return { executed: false, hash: null, skipped: '无改动可提交（工作区已干净）' }
    return { executed: false, hash: null, error: `git commit 失败：${output.trim().slice(0, 300)}` }
  }
  const head = await gitRun(['rev-parse', '--short', 'HEAD'])
  const subj = await gitRun(['log', '-1', '--pretty=%s'])
  return {
    executed: true,
    hash: head.stdout.trim(),
    subject: subj.stdout.trim(),
    paths: unique,
    files: staged.stdout.trim().split('\n').filter(Boolean).length
  }
}

/** 提交信息：首行标题 + 正文要点（每行一条 `- `） */
function buildCommitMessage (subject, bullets) {
  const body = (bullets ?? [])
    .map(b => String(b).replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20)
  if (!body.length) return subject
  return `${subject}\n\n${body.map(b => `- ${b}`).join('\n')}`
}

/**
 * 显式提交（界面不触发；幂等：无改动时返回 commitExecuted:false 且不报错）
 * body: { message?, paths?, stageAll? }
 */
async function apiCommit (req, res) {
  const body = await readJsonBody(req).catch(() => ({}))
  const summaryPath = path.join(root, 'out', '_commit-summary.md')
  const summaryMd = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : ''
  const subject = typeof body?.message === 'string' && body.message.trim()
    ? body.message.trim()
    : (suggestedTitleFromSummary(summaryMd) || 'docs: 更新角色攻略数据与文档')
  const bullets = (summaryMd.match(/^## 建议提交信息\n+[^\n]*\n+([\s\S]*?)\n## /m)?.[1] ?? '')
    .split('\n').map(l => l.trim()).filter(l => l.startsWith('- '))
  const r = await commitChanges({
    subject,
    bullets,
    paths: Array.isArray(body?.paths) ? body.paths : [],
    stageAll: body?.stageAll === true
  })
  sendJson(res, 200, {
    ok: true,
    commit: r.hash,
    commitExecuted: r.executed,
    commitError: r.error ?? null,
    commitSkipped: r.skipped ?? null,
    pushed: false
  })
}

/** 跑一条 git 命令（不抛错，交回 code/stdout/stderr） */
function gitRun (args) {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', e => resolve({ code: -1, stdout, stderr: String(e?.message ?? e) }))
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

/** 从 build-docx 的 stdout 里取备份路径与统计（拿不到也不算失败） */
function parseBuildDocxLog (text) {
  const backup = text.match(/^备份：(.*)$/m)?.[1]?.trim() ?? null
  const lines = text.match(/^段落数：产物 (\d+)（模板 (\d+)）/m)
  const roundtrip = text.match(/^与生成时 JSON 深比较：(.*)$/m)?.[1]?.trim() ?? null
  return {
    backup: backup && backup !== '（目标不存在，未备份）' ? backup : null,
    paragraphs: lines ? Number(lines[1]) : null,
    roundtrip
  }
}

/** 从 build-docx 输出里取它用的冻结快照目录（三方校验的 diagnose 也用它，避免并发写干扰） */
function parseFrozenGiDir (text) {
  const dir = String(text ?? '').match(/^冻结快照目录：(.*)$/m)?.[1]?.trim()
  return dir && dir !== '（无）' && fs.existsSync(dir) ? dir : null
}

/** 从 build-docx 输出里取标记版文档的信息（路径 / sha / 往返 / 去标记是否一致） */
function parseMarkedDocxLog (text) {
  const t = String(text ?? '')
  const outPath = t.match(/^标记版输出：(.*)$/m)?.[1]?.trim() ?? null
  const shim = t.match(/^标记版拷贝：(.*?)（备份 (.*?)）$/m)
  const shippedPath = shim?.[1]?.trim() ?? 'D:\\文件\\游戏\\原神\\原神·角色攻略(标记版).docx'
  const backup = shim?.[2]?.trim() ?? null
  const roundTrip = t.match(/^标记版往返（parse-docx ↔ 生成时 JSON）：(.*)$/m)?.[1]?.trim() ?? null
  const mainSha = t.match(/^主文档 sha1：(.*)$/m)?.[1]?.trim() ?? null
  const markedShaLog = t.match(/^标记版 sha1：(.*)$/m)?.[1]?.trim() ?? null
  const markCounts = t.match(/^标记版标记数：w=(\d+) a=(\d+) c=(\d+) t=(\d+) k=(\d+)/m)
  const strips = t.match(/^两份文档去标记后逐字一致：(是|否)/m)?.[1]
  const sha = sha1File(shippedPath) ?? markedShaLog
  return {
    outPath,
    shippedPath,
    backup: backup && backup !== '无' ? backup : null,
    bytes: fs.existsSync(shippedPath) ? fs.statSync(shippedPath).size : 0,
    sha,
    mainSha,
    mainBytes: fs.existsSync(DEFAULT_DOC) ? fs.statSync(DEFAULT_DOC).size : 0,
    marks: markCounts
      ? { w: Number(markCounts[1]), a: Number(markCounts[2]), c: Number(markCounts[3]), t: Number(markCounts[4]), k: Number(markCounts[5]) }
      : null,
    roundTrip,
    roundTripOk: Boolean(roundTrip && /完全相等/.test(roundTrip)),
    sameAsMain: Boolean(mainSha && mainSha === sha),
    stripsEqual: strips === '是',
    fresh: Boolean(outPath && fs.existsSync(outPath) && fs.existsSync(shippedPath) && sha1File(outPath) === sha)
  }
}

/** 从摘要里取「建议提交信息」的第一行标题 */
function suggestedTitleFromSummary (markdown) {
  const m = markdown.match(/## 建议提交信息\s*\n+([^\n]+)/)
  return m ? m[1].trim() : ''
}

/* ---------------------------------------------------- 提交摘要（只读，不动 git 状态） */

/** 摘要保留份数（带时间戳的副本，超出删最旧） */
const KEEP_SUMMARIES = 5

/** `YYYYMMDD-HHmmss` 时间戳 */
function summaryStamp (d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 写提交摘要：`out/_commit-summary.md` 覆盖为最新，同时留一份
 * `out/_commit-summary-<时间戳>.md`，只保留最近 KEEP_SUMMARIES 份。
 * @returns {{file: string, stampFile: string, kept: string[], removed: string[]}}
 */
function writeSummaryFiles (markdown) {
  const dir = path.dirname(SUMMARY_FILE)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(SUMMARY_FILE, markdown, 'utf8')
  let stamp = summaryStamp()
  let stampFile = path.join(dir, `_commit-summary-${stamp}.md`)
  let n = 1
  while (fs.existsSync(stampFile)) stampFile = path.join(dir, `_commit-summary-${stamp}-${n++}.md`)
  fs.writeFileSync(stampFile, markdown, 'utf8')
  const list = fs.readdirSync(dir).filter(f => /^_commit-summary-\d{8}-\d{6}(-\d+)?\.md$/.test(f)).sort()
  const removed = list.slice(0, Math.max(0, list.length - KEEP_SUMMARIES))
  for (const f of removed) fs.rmSync(path.join(dir, f), { force: true })
  const kept = list.slice(-KEEP_SUMMARIES)
  return {
    file: path.relative(root, SUMMARY_FILE).split(path.sep).join('/'),
    stampFile: path.relative(root, stampFile).split(path.sep).join('/'),
    kept: kept.map(f => `out/${f}`),
    removed: removed.map(f => `out/${f}`)
  }
}

const V2_FIELDS = [
  ['weapons', '武器'], ['artifacts', '圣遗物'], ['talents', '天赋'],
  ['panels', '面板'], ['constellations', '命座'], ['teams', '配队']
]

/** 仓库内与发布相关的文件 → 内容指纹（用于算「新增/修改/删除」） */
function snapshotFiles () {
  const map = new Map()
  const record = (rel) => {
    const abs = path.join(root, rel)
    try {
      map.set(rel, crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'))
    } catch { /* 不存在就算了 */ }
  }
  for (const f of ['guide.html', 'guide.md',
    path.join('data', '_index.json'),
    path.join('data', 'gi', '_order.json')]) record(f)
  if (fs.existsSync(giDir)) {
    for (const f of fs.readdirSync(giDir)) if (f.endsWith('.json') && !f.startsWith('_')) record(path.join('data', 'gi', f))
  }
  if (fs.existsSync(DEFAULT_DOC)) record(path.relative(root, DEFAULT_DOC).split(path.sep).join('/'))
  return map
}

/** 行数（以 \n 计，末尾换行不算多一行） */
function countLines (buf) {
  const s = buf.toString('utf8')
  if (!s) return 0
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
}

/**
 * 生成「可直接拿去提交」的摘要：
 *   ① 变更文件清单（新增/修改/删除 + 行数）
 *   ② 按角色汇总的字段变化
 *   ③ 建议提交信息（单行标题 + 正文要点）
 *   ④ 未跟踪文件提醒
 * 全部基于仓库内文件快照 + git status（只读查询，不做任何写操作）
 */
function buildCommitSummary ({ before, after, name, docx, html, wroteJson, steps, perChar = [], baseline = {} }) {
  const changed = []
  const slash = (p) => p.split(path.sep).join('/')
  for (const [rawRel, hash] of after) {
    const old = before.get(rawRel)
    if (old === hash) continue
    const lines = countLines(fs.readFileSync(path.join(root, rawRel)))
    // 仓库外的文件（主文档）用绝对路径标注，免得出现 ../ 这种看不清的写法
    const rel = rawRel.startsWith('..') ? slash(DEFAULT_DOC) : slash(rawRel)
    changed.push({ path: rel, status: old === undefined ? '新增' : '修改', added: old === undefined ? lines : null, removed: old === undefined ? 0 : null })
  }
  for (const [rawRel] of before) {
    if (after.has(rawRel)) continue
    changed.push({ path: slash(rawRel), status: '删除', added: 0, removed: null })
  }
  changed.sort((a, b) => a.path.localeCompare(b.path))
  const tracked = changed.filter(c => c.status !== '新增')

  const title = buildTitle(name, perChar, changed)

  const out = []
  const bullets = summaryBullets({ name, perChar, changed, docx, html })
  out.push('## 建议提交信息')
  out.push(title)
  out.push('')
  for (const line of bullets) out.push(line)
  out.push('')
  out.push('## 变更文件')
  if (!changed.length) out.push('- （无）')
  for (const c of changed) {
    const delta = c.status === '新增' ? `+${c.added ?? 0}/-0` : (c.added === null ? '' : `+${c.added}/-${c.removed}`)
    out.push(`- ${c.path}  ${c.status}${delta ? ' ' + delta : ''}`)
  }
  out.push('')
  out.push('## 按角色变化')
  if (!perChar.length) out.push('- （本次发布未指定角色，或该角色字段无变化）')
  for (const p of perChar) out.push(`- ${p.name}：${formatFieldChanges(p.fields)}`)
  out.push('')
  out.push('## 未跟踪文件')
  const untracked = listUntracked()
  if (!untracked.length) out.push('- （无）')
  for (const u of untracked) out.push(`- ${u}`)
  out.push('')
  out.push(`> 生成时间：${new Date().toISOString()}　|　主文档备份：${docx.backup || '（无）'}`)
  out.push(`> 对比基线：写盘前 JSON（角色 ${baseline.name || '—'}：武器 ${baselineLabel(baseline)}）`)
  if (baseline.concurrent) out.push('> ⚠ 写盘前后有其它进程改过该文件，字段变化统计可能不完全准确。')

  const section = {
    title,
    suggestedMessage: title,
    bullets,
    markdown: '',
    changedFiles: changed,
    characterChanges: perChar,
    untracked,
    steps,
    docxBackup: docx.backup || null,
    summaryPath: 'out/_commit-summary.md',
    trackedChanged: tracked.length,
    commitNote: '> 本摘要由「保存并发布」生成。',
    _head: out.join('\n')
  }
  section.markdown = renderSummaryMarkdown(section)
  return section
}

/**
 * 生成摘要 markdown：正文段落（缓存在 `_head`）+ 结尾的提交说明（`commitNote`）
 * @param {object} s
 * @returns {string}
 */
function renderSummaryMarkdown (s) {
  const lines = [s._head ?? '']
  if (s.commitNote) lines.push(s.commitNote)
  return lines.filter(Boolean).join('\n') + '\n'
}

/** 读 JSON，读不了返回 null（摘要生成不能因为一个坏文件而失败） */
const readJsonSafe = (file) => { try { return readJson(file) } catch { return null } }

/** 摘要底部的「对比基线」描述 */
function baselineLabel (baseline) {
  if (!baseline || !baseline.name) return '无（本次未指定角色）'
  const bits = []
  for (const [key, label] of V2_FIELDS) {
    const n = asArray(baseline.json?.v2?.[key]).length
    if (n) bits.push(`${label} ${n}`)
  }
  return bits.length ? bits.join(' / ') : '各字段为空'
}

/** 单个角色的字段级前后对比（逐段文本行做增/删/改统计，够写提交摘要） */
function diffCharacterFields (name, prev, cur, rel) {
  const fields = []
  for (const [key, label] of V2_FIELDS) {
    const d = diffLineSets(beforeLines(prev, key), beforeLines(cur, key))
    fields.push({ key, label, ...d })
  }
  if (prev?.meta || cur?.meta) {
    let changed = 0
    for (const k of ['建议等级', '定位', '100级提升']) {
      if (String(prev?.meta?.[k] ?? '') !== String(cur?.meta?.[k] ?? '')) changed++
    }
    fields.push({ key: 'meta', label: '基本', added: 0, removed: 0, changed })
  }
  const total = fields.reduce((n, f) => n + f.added + f.removed + f.changed, 0)
  return { name, json: rel, fields, total }
}

/** 某字段的行集合（同一文本出现多次时按次数计数） */
function beforeLines (data, key) {
  const bag = new Map()
  for (const line of deriveSections(data ?? {}) ) {
    if (!line.title.endsWith(`. ${SECTION_LABEL[key]}`)) continue
    for (const l of line.lines) bag.set(l, (bag.get(l) ?? 0) + 1)
  }
  return bag
}

const SECTION_LABEL = {
  weapons: '武器推荐', artifacts: '圣遗物推荐', talents: '天赋加点',
  panels: '毕业面板参考', constellations: '命座推荐', teams: '配队推荐'
}

/** 两个「行 → 次数」集合的增/删/改统计 */
function diffLineSets (prev, cur) {
  let added = 0
  let removed = 0
  let changed = 0
  const keys = new Set([...prev.keys(), ...cur.keys()])
  for (const k of keys) {
    const a = prev.get(k) ?? 0
    const b = cur.get(k) ?? 0
    if (a === b) continue
    if (a === 0) { added += b; continue }
    if (b === 0) { removed += a; continue }
    changed += Math.min(a, b)
    added += Math.max(0, b - a)
    removed += Math.max(0, a - b)
  }
  return { added, removed, changed }
}

/** 字段变化 → 「武器 2 改 1 增 / 圣遗物 1 改 …」 */
function formatFieldChanges (fields) {
  const parts = []
  for (const f of fields ?? []) {
    const bits = []
    if (f.changed) bits.push(`${f.changed} 改`)
    if (f.added) bits.push(`${f.added} 增`)
    if (f.removed) bits.push(`${f.removed} 删`)
    if (bits.length) parts.push(`${f.label} ${bits.join(' ')}`)
  }
  return parts.length ? parts.join(' / ') : '无字段变化（可能只改了文字内容或格式）'
}

/** 单行标题 + 正文要点 */
function buildTitle (name, perChar, changed) {
  if (!name) {
    const chars = changed.filter(c => c.path.includes('data/gi/') && !c.path.endsWith('_order.json')).length
    return chars > 1 ? `docs: 批量更新 ${chars} 个角色` : 'docs: 更新角色攻略数据与文档'
  }
  const fields = perChar[0]?.fields ?? []
  const names = fields.filter(f => (f.added || f.removed || f.changed)).map(f => f.label)
  const suffix = names.length ? names.slice(0, 3).join('/') + (names.length > 3 ? ' 等' : '') : '内容'
  return `docs: 更新 ${name}（${suffix}）`
}

function summaryBullets ({ name, perChar, changed, docx, html }) {
  const bullets = []
  if (name) bullets.push(`- 角色：${name}`)
  for (const p of perChar) bullets.push(`- ${p.name} 字段：${formatFieldChanges(p.fields)}`)
  bullets.push(`- 数据文件变化：${changed.filter(c => c.path.includes('data/gi/')).length} 个`)
  bullets.push(`- 主文档：${docx.path.split(path.sep).pop()}（${docx.bytes} 字节，备份 ${docx.backup || '无'}）`)
  bullets.push(`- 网页版：${html.path.split(path.sep).pop()}（${html.bytes} 字节）`)
  return bullets
}

/** git status 里未跟踪的文件（只读查询；git 不在也不炸） */
function listUntracked () {
  try {
    const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
    if (r.status !== 0 || !r.stdout) return []
    return r.stdout.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3).trim()).filter(Boolean).slice(0, 40)
  } catch {
    return []
  }
}

/** 跑一个仓库内的 node 脚本，返回它的 stdout（失败抛错，错误里带上 stderr 便于定位） */
function runNodeScript (file, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let errOut = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { errOut += d })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(out)
        return
      }
      const tail = (errOut || out || `退出码 ${code}`).trim().split('\n').filter(Boolean).slice(-6).join(' ｜ ')
      const e = new Error(tail)
      e.stdout = out
      e.exitCode = code
      reject(e)
    })
  })
}

/* -------------------------------------------------------------- 实时预览 */

/**
 * POST /api/preview
 *
 * 「编辑器里看到的就是面板 / 网页最终效果」：把**编辑器当前表单内容**（未保存也行）交给
 * 与网页版 / 面板**同一份显示级归一**（scripts/lib/guide-display.mjs，经 build-html.mjs 的
 * characterSections），返回六个模块的渲染结果：
 *   · html —— 与 guide.html 卡片同一套渲染函数（含 推荐/可选/过渡、`｜`、`＞`、皇冠 SVG、暂无）
 *   · lines —— 逐行纯文本，便于与面板模型逐行比对
 *   · sections —— 归一后的渲染模型（调试 / 逐行比对用）
 *
 * **幂等且不改数据**：只读内存里的 body，不写任何文件、不重建索引。
 * body: { name?, game?, meta?, v2?, unparsed? }（与 PUT /api/character 同形状）
 */
async function apiPreview (req, res) {
  const body = await readJsonBody(req)
  const asked = String(body?.name ?? '').trim()
  const name = isValidName(asked) ? asked : '预览'
  let prev = {}
  if (isValidName(asked)) {
    const file = characterFile(asked)
    if (fs.existsSync(file)) {
      try {
        prev = readJson(file)
      } catch { prev = {} }
    }
  }
  // 与保存走同一套规范化：mergeV2 按位置合并 + normalizeV2 去空行 + tags/sections 回推
  const data = buildCharacter(body?.character ?? body, name, prev)
  const html = renderGuideSectionsHtml(data, { indent: 2 })
  const lines = renderGuideSectionsText(data)
  const sections = characterSections(data).map(s => ({
    badge: s.badge ?? '',
    title: s.displayTitle ?? s.title,
    kind: s.kind,
    empty: !!s.empty,
    rows: (s.rows ?? []).map(r => ({
      label: r.label ?? '',
      kind: r.kind ?? '',
      items: (r.items ?? []).map(it => ({ text: it.text, sepAfter: it.sepAfter || '', crown: it.crown === true, note: it.note || '' }))
    })),
    teams: (s.teams ?? []).map(t => ({ tag: t.tag ?? '', members: (t.members ?? []).map(m => ({ name: m.name, note: m.note || '' })), note: t.note || '' }))
  }))
  sendJson(res, 200, { ok: true, name, html, lines, sections, issues: validate(data, readIndex()) })
}

/* ------------------------------------------------------------- 静态资源服务 */

const serveIndexHtml = (res) => serveStatic(res, '/index.html')

/**
 * 把 scripts/lib/pinyin.mjs 当浏览器脚本发给界面，避免拼音表维护两份。
 * 该模块本身没有 import/export，只在结尾判断 `module`（浏览器里 `module` 未定义会抛错）——
 * 这里**只摘掉那一行**（不动文件头的注释），其余原样发送；
 * 它自带 `root.Pinyin = Pinyin`，浏览器里就是 window.Pinyin。
 */
function servePinyin (res) {
  const file = path.join(here, 'lib', 'pinyin.mjs')
  if (!fs.existsSync(file)) return sendError(res, 404, '拼音表还没生成：scripts/lib/pinyin.mjs')
  const src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    .replace(/\n[ \t]*if \(typeof module !== 'undefined' && module\.exports\)[^\n]*\n/, '\n')
  const body = Buffer.from(src, 'utf8')
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(body)
}

function serveStatic (res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '')
  const target = path.resolve(editorDir, rel)
  const relCheck = path.relative(editorDir, target)
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return sendError(res, 403, '拒绝访问')
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return sendError(res, 404, `找不到资源：${urlPath}`)
  }
  if (!stat.isFile()) return sendError(res, 404, `找不到资源：${urlPath}`)
  const body = fs.readFileSync(target)
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/* ------------------------------------------------------------------- 服务器 */

async function route (req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const { pathname } = url
  const method = req.method ?? 'GET'

  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/index' && method === 'GET') return apiIndex(res)
    if (pathname === '/api/characters' && method === 'GET') return apiCharacters(res)
    if (pathname === '/api/character') {
      if (method === 'GET') return apiGetCharacter(res, url)
      if (method === 'PUT') return await apiPutCharacter(req, res, url)
      if (method === 'POST') return await apiCreateCharacter(req, res)
      if (method === 'DELETE') return apiDeleteCharacter(res, url)
      return sendError(res, 405, `不支持的请求方法：${method}`)
    }
    if (pathname === '/api/rename' && method === 'POST') return await apiRename(req, res)
    if (pathname === '/api/reorder' && method === 'POST') return await apiReorder(req, res)
    if (pathname === '/api/trash') {
      if (method === 'GET') return apiTrashList(res)
      if (method === 'DELETE') return url.searchParams.get('name') ? apiTrashDelete(res, url) : apiTrashEmpty(res)
      return sendError(res, 405, `不支持的请求方法：${method}`)
    }
    if (pathname === '/api/trash/restore' && method === 'POST') return await apiTrashRestore(req, res)
    if (pathname === '/api/search' && method === 'GET') return apiSearch(res, url)
    if (pathname === '/api/name-usage' && method === 'GET') return sendJson(res, 200, collectNameUsage())
    if (pathname === '/api/batch-replace/undo' && method === 'POST') return await apiBatchUndo(req, res)
    if (pathname === '/api/batch-replace' && method === 'POST') return await apiBatchReplace(req, res)
    if (pathname === '/api/publish' && method === 'POST') return await apiPublish(req, res)
    if (pathname === '/api/preview' && method === 'POST') return await apiPreview(req, res)
    // 心跳 / 关闭信号：只在开了 --exit-on-idle 时才有实际作用（否则仅回 200，纯 no-op）
    if (pathname === '/api/heartbeat') {
      if (idleWatcher) idleWatcher.heartbeat()
      return sendJson(res, 200, { ok: true, exitOnIdle: !!idleWatcher, idleSeconds: idleSeconds || null, at: new Date().toISOString() })
    }
    if (pathname === '/api/close') {
      // navigator.sendBeacon 会带 text/plain，不能按 JSON 解析；不读 body，直接响应
      if (idleWatcher) idleWatcher.requestClose()
      return sendJson(res, 200, { ok: true, exitOnIdle: !!idleWatcher, graceMs: idleWatcher ? CLOSE_GRACE_MS : null })
    }
    if (pathname === '/api/commit' && method === 'POST') return await apiCommit(req, res)
    return sendError(res, 404, `未知接口：${pathname}`)
  }

  if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, `不支持的请求方法：${method}`)
  if (pathname === '/' || pathname === '/index.html') return serveIndexHtml(res)
  if (pathname === '/pinyin.js') return servePinyin(res)
  return serveStatic(res, pathname)
}

/** 创建 http 服务（未监听） */
export function createServer () {
  return http.createServer((req, res) => {
    Promise.resolve()
      .then(() => route(req, res))
      .catch(e => {
        const status = Number.isInteger(e?.status) ? e.status : 500
        if (status >= 500) console.error(e)
        if (!res.headersSent) sendError(res, status, String(e?.message ?? e))
        else res.end()
      })
  })
}

/** 端口被占用时 +1 重试 */
function listenWithRetry (server, port, tries = MAX_PORT_TRIES) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryPort = (p) => {
      const onError = (e) => {
        if (e.code === 'EADDRINUSE' && attempt < tries - 1) {
          attempt++
          console.warn(`端口 ${p} 被占用，改试 ${p + 1} …`)
          setTimeout(() => tryPort(p + 1), 20)
        } else {
          reject(e)
        }
      }
      server.once('error', onError)
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve(server.address().port)
      })
    }
    tryPort(port)
  })
}

/** 尽力打开系统默认浏览器（失败只提示，不影响服务） */
function openBrowser (url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

function parseArgs (argv) {
  const out = { port: DEFAULT_PORT, open: true, exitOnIdle: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-open') out.open = false
    else if (a === '--open') out.open = true
    else if (a === '--exit-on-idle') {
      // `--exit-on-idle` 单独写 = 默认 20 秒；也可以 `--exit-on-idle 30`
      const next = argv[i + 1]
      if (next !== undefined && /^\d+$/.test(next)) { out.exitOnIdle = Number(next); i++ } else out.exitOnIdle = 20
    } else if (a.startsWith('--exit-on-idle=')) {
      const v = Number(a.slice('--exit-on-idle='.length))
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`--exit-on-idle 的秒数不合法：${a}`)
        process.exit(1)
      }
      out.exitOnIdle = v
    } else if (a === '--port' || a === '-p') {
      const v = Number(argv[++i])
      if (!Number.isInteger(v) || v < 0 || v > 65535) {
        console.error(`端口不合法：${argv[i]}`)
        process.exit(1)
      }
      out.port = v
    } else if (a.startsWith('--port=')) {
      const v = Number(a.slice('--port='.length))
      if (!Number.isInteger(v) || v < 0 || v > 65535) {
        console.error(`端口不合法：${a}`)
        process.exit(1)
      }
      out.port = v
    }
  }
  return out
}

export async function main (argv = process.argv.slice(2)) {
  const { port, open, exitOnIdle } = parseArgs(argv)
  if (!fs.existsSync(editorDir)) {
    console.error(`找不到界面资源目录：${editorDir}`)
    process.exit(1)
  }
  if (!fs.existsSync(giDir)) fs.mkdirSync(giDir, { recursive: true })
  const server = createServer()
  const actual = await listenWithRetry(server, port)
  const url = `http://127.0.0.1:${actual}`
  console.log('角色攻略编辑器已启动')
  console.log(`访问地址：${url}`)
  console.log(`数据目录：${path.relative(root, giDir)}`)

  // 空闲自动退出：只在显式打开时启用；命令行用户的默认行为完全不变
  if (exitOnIdle > 0) {
    idleSeconds = exitOnIdle
    idleWatcher = createIdleWatcher(exitOnIdle, () => {
      console.log('[idle] 正在关闭服务…')
      try { idleWatcher?.stop() } catch { /* 忽略 */ }
      try {
        server.close(() => process.exit(0))
      } catch {
        process.exit(0)
      }
      // server.close 会等现有连接结束；给个兜底，免得挂住
      setTimeout(() => process.exit(0), 1000).unref?.()
    })
    console.log(`空闲自动退出：${exitOnIdle}s 无心跳就退出（页面关闭后约 ${exitOnIdle}s 自动结束）`)
  }

  if (!fs.existsSync(indexPath)) console.log('提示：还没有 data/_index.json，先跑 node scripts/build-index.mjs 才能做名称校验')
  if (open) openBrowser(url)
  return { server, port: actual, url, idleWatcher, closeIdleWatcher: () => { try { idleWatcher?.stop() } catch { /* 忽略 */ } idleWatcher = null } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(`启动失败：${e?.message ?? e}`)
    process.exit(1)
  })
}
