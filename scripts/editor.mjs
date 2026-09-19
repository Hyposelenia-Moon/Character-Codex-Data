/**
 * 图形化角色 JSON 编辑器 —— 后端 HTTP 服务（零依赖，仅用 node: 内置模块）
 *
 * 用法：
 *   node scripts/editor.mjs [--port 8787] [--no-open]
 *   默认端口 8787，端口被占用时自动 +1 重试（最多 10 次）
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
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deriveSections, deriveTags, validate } from './lib/schema.mjs'
import { buildIndex } from './build-index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const giDir = path.join(dataDir, 'gi')
const trashDir = path.join(dataDir, '_trash')
const indexPath = path.join(dataDir, '_index.json')
const orderPath = path.join(giDir, '_order.json')
const editorDir = path.join(root, 'resources', 'editor')

const DEFAULT_PORT = 8787
const MAX_PORT_TRIES = 10
const MAX_BODY = 8 * 1024 * 1024

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

/** 值算不算「编辑器的有效输入」 */
function isProvided (v) {
  if (v === undefined || v === null) return false
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
      const kind = ['preferred', 'transition', 'optional', 'main', 'sub', 'text'].includes(row.kind) ? row.kind : 'text'
      const label = hasText(row.label) ? row.label.trim() : null
      if (kind === 'main') {
        const st = row.stats && typeof row.stats === 'object' ? row.stats : {}
        // 主词条行不写 sep（渲染器只用它拼多值），三个部位键始终齐全
        return {
          kind,
          stats: {
            时之沙: asArray(st['时之沙']).map(x => String(x).trim()).filter(Boolean),
            空之杯: asArray(st['空之杯']).map(x => String(x).trim()).filter(Boolean),
            理之冠: asArray(st['理之冠']).map(x => String(x).trim()).filter(Boolean)
          }
        }
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
      const label = hasText(row.label) ? row.label.trim() : null
      if (hasText(row.k)) return { label, k: row.k.trim(), v: hasText(row.v) ? row.v.trim() : '' }
      if (hasText(row.text)) return { label, text: row.text.trim() }
      return null
    })
    .filter(Boolean)

  out.constellations = asArray(src.constellations)
    .filter(r => r && typeof r === 'object')
    .map(row => {
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
function constellationIndex (name) {
  const s = String(name ?? '')
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
  data.source = prev.source && typeof prev.source === 'object' ? prev.source : { guide: '赋光之人 · 队伍攻略' }

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
    source: { guide: '赋光之人 · 队伍攻略' }
  }
  data.tags = deriveTags(data)
  data.sections = deriveSections(data)
  return data
}

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

/* ------------------------------------------------------------- 静态资源服务 */

const serveIndexHtml = (res) => serveStatic(res, '/index.html')

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
    return sendError(res, 404, `未知接口：${pathname}`)
  }

  if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, `不支持的请求方法：${method}`)
  if (pathname === '/' || pathname === '/index.html') return serveIndexHtml(res)
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
  const out = { port: DEFAULT_PORT, open: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-open') out.open = false
    else if (a === '--open') out.open = true
    else if (a === '--port' || a === '-p') {
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
  const { port, open } = parseArgs(argv)
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
  if (!fs.existsSync(indexPath)) console.log('提示：还没有 data/_index.json，先跑 node scripts/build-index.mjs 才能做名称校验')
  if (open) openBrowser(url)
  return { server, port: actual, url }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(`启动失败：${e?.message ?? e}`)
    process.exit(1)
  })
}
