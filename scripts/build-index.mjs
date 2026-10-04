/**
 * 生成图鉴索引 data/_index.json（武器名 / 角色名 / 圣遗物套装名）
 *
 * 数据来源：
 *   - 图鉴后端 nanoka-atlas-backend
 *     · 武器名、角色名：<backend>/data/map.json
 *         games.gi.locales.zh.pages.weapon.records[].name
 *         games.gi.locales.zh.pages.character.records[].name
 *       （records 在真实数据里是「id → 记录」的对象，这里按值遍历，数组/对象两种形态都兼容）
 *     · 圣遗物套装名：<backend>/data/items/简体中文/原神/圣遗物/&#42;&#42;/*.json
 *         content.list.set 的每个值里取 name.zh
 *   - data/gi/*.json 自身（并入，避免文档里实际在用的名字被误判成「不在图鉴」）
 *     · 文件名（去掉 .json）→ characters：旅行者·火 / 奇偶·男性 这类文档专用名，也覆盖将来新增的角色
 *     · 数据里出现过的 ref 名（只收「单个实体名」，带 +、/、=、空格等组合/说明的不收）→ 对应清单
 *
 * 输出：data/_index.json（UTF-8 无 BOM、2 空格缩进、末尾换行）
 *   {
 *     "generatedAt": "ISO",
 *     "weapons": [...], "characters": [...], "artifacts": [...],   // 合并清单（权威 + 来自数据的本地候选）
 *     "authoritative": { "weapons": [], "characters": [], "artifacts": [] },  // 只为图鉴后端 + data/gi 角色文件名
 *     "localOnly":     { "weapons": [], "characters": [], "artifacts": [] }   // 合并清单 − 权威清单
 *   }
 * 编辑器（scripts/editor.mjs）用它做名称候选与校验；scripts/parse-docx.mjs 也会读它。
 *
 * ⚠ 三个旧数组（weapons / characters / artifacts）**语义与内容都不变**（编辑器 datalist、名称库、
 *   批量替换的「在不在清单里」提示、类型判定都在用），仍含「图鉴里没有、只有 data/gi 在用」的名字；
 *   **校验（schema.mjs 的 validate）只读 authoritative** —— 否则把错名写进 data 再保存，
 *   错名会被并进白名单，该角色的 issue 从 1 变 0（自我合法化，审核 #8）。
 *   两者之差即 localOnly，由 scripts/audit-dup-items.mjs 当门禁（非空即失败）。
 *
 * 用法：
 *   node scripts/build-index.mjs [后端目录]
 *   默认后端目录：D:\文件\游戏\原神\Atlas-Plugin\tool\nanoka-atlas-backend\nanoka-atlas-backend
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const giDir = path.join(dataDir, 'gi')
const outFile = path.join(dataDir, '_index.json')

const DEFAULT_BACKEND = 'D:\\文件\\游戏\\原神\\Atlas-Plugin\\tool\\nanoka-atlas-backend\\nanoka-atlas-backend'

/** 后端根目录 → data/map.json */
const mapFile = (backend) => path.join(backend, 'data', 'map.json')
/** 后端根目录 → data/items/简体中文/原神/圣遗物 */
const artifactDir = (backend) => path.join(backend, 'data', 'items', '简体中文', '原神', '圣遗物')

/** 读取 JSON（容忍 UTF-8 BOM） */
function readJson (file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

/**
 * records 既可能是数组，也可能是「id → 记录」的对象；统一取值数组
 * @param {unknown} records
 * @returns {object[]}
 */
function recordValues (records) {
  if (!records) return []
  if (Array.isArray(records)) return records
  if (typeof records === 'object') return Object.values(records)
  return []
}

/**
 * 去重、去空白、按中文拼音排序
 * @param {Iterable<unknown>} values
 * @returns {string[]}
 */
export function normalizeNames (values) {
  const set = new Set()
  for (const v of values ?? []) {
    if (v == null) continue
    const name = String(v).trim()
    if (name) set.add(name)
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** map.json → { weapons, characters } */
function readMapNames (backend) {
  const file = mapFile(backend)
  if (!fs.existsSync(file)) {
    throw new Error(`找不到图鉴总表：${file}\n（后端目录应为 nanoka-atlas-backend，可用第一个参数覆盖）`)
  }
  let doc
  try {
    doc = readJson(file)
  } catch (err) {
    throw new Error(`解析失败：${file}\n${err.message}`)
  }
  const pages = doc?.games?.gi?.locales?.zh?.pages
  if (!pages || typeof pages !== 'object') {
    throw new Error(`${file} 里没有 games.gi.locales.zh.pages，后端结构可能变了`)
  }
  const pick = (key) => recordValues(pages?.[key]?.records).map(r => r?.name)
  return { weapons: normalizeNames(pick('weapon')), characters: normalizeNames(pick('character')) }
}

/** 图鉴后端记录里的角色条目（同名多形态只留第一条） */
function readMapCharacters (backend) {
  const file = mapFile(backend)
  if (!fs.existsSync(file)) {
    throw new Error(`找不到图鉴总表：${file}`)
  }
  const pages = readJson(file)?.games?.gi?.locales?.zh?.pages
  if (!pages || typeof pages !== 'object') {
    throw new Error(`${file} 里没有 games.gi.locales.zh.pages，后端结构可能变了`)
  }
  const byName = new Map()
  for (const r of recordValues(pages?.character?.records)) {
    const name = String(r?.name ?? '').trim()
    if (!name || byName.has(name)) continue
    byName.set(name, {
      name,
      rarity: String(r?.rarity ?? '').trim(),
      id: String(r?.id ?? '').trim(),
      path: String(r?.path ?? '').trim()
    })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/**
 * 图鉴（nanoka.cc 抓下来的 map.json）里的角色清单 —— 供编辑器「从图鉴添加新角色」用。
 *
 * 比 `readMapNames()` 多带**星级**（添加对话框里给用户看的参考信息）。
 * @param {string} [backend] 图鉴后端目录（默认 DEFAULT_BACKEND）
 * @returns {Array<{name: string, rarity: string, id: string, path: string}>}
 */
export function readAtlasCharacters (backend = DEFAULT_BACKEND) {
  const dir = path.resolve(backend)
  if (!fs.existsSync(dir)) throw new Error(`找不到图鉴后端目录：${dir}`)
  return readMapCharacters(dir)
}

/** 图鉴后端目录（编辑器等复用；可用参数或默认值覆盖） */
export function atlasBackendDir (backend) {
  return path.resolve(backend ?? DEFAULT_BACKEND)
}

/** 递归收集某目录下所有 .json（同步、深度优先） */
function walkJson (dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJson(full, out)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(full)
  }
  return out
}

/**
 * 圣遗物目录 → 套装名数组
 * 每个文件的 content.list.set 是「部位 id → { name: {zh,...} }」 (也兼容数组)
 * @returns {{ names: string[], files: number, badFiles: string[] }}
 */
function readArtifactNames (backend) {
  const dir = artifactDir(backend)
  const files = walkJson(dir)
  if (!files.length) {
    throw new Error(`找不到圣遗物数据目录或目录为空：${dir}`)
  }
  const names = []
  const badFiles = []
  for (const file of files) {
    let doc
    try {
      doc = readJson(file)
    } catch {
      badFiles.push(file)
      continue
    }
    const sets = doc?.content?.list?.set
    for (const value of recordValues(sets)) {
      const zh = value?.name?.zh ?? (typeof value?.name === 'string' ? value.name : '')
      if (zh) names.push(zh)
    }
  }
  return { names: normalizeNames(names), files: files.length, badFiles }
}

/** data/gi 下的角色文件名（去 .json，跳过 `_` 开头） */
function readCharacterFiles () {
  let entries = []
  try {
    entries = fs.readdirSync(giDir)
  } catch {
    return []
  }
  return entries
    .filter(f => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
    .map(f => f.slice(0, -'.json'.length))
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 数据里的 ref 名要不要并进索引 —— 索引是「标准名白名单」，只收单个实体名。
 *
 * 口语写法与整句说明一律不收，否则它们会因为「命中索引」而不再被 `validate` 标 ⚠，
 * 等于把该改的错名藏起来。以下都算「不是实体名」：
 *   - 组合/并列写法：含 + ＋ / ／ = ＝ > ＞ < ＜ ＆ & 、 ， , ； ; ： : （）() 等，或含空格
 *   - 口语/规格说明：数字开头（2充能、88爆伤），或含 任意 / 其他 / 主C / 武器 / 套装 /
 *     散搭 / 白值 / 辅助 等词（任意674白值武器、其他辅助武器、任意攻击主C、角斗士的终幕礼两件套）
 *   - 明显是短句：≥ 8 字
 *
 * ⚠ 黑名单式过滤天然会漏（想到哪个符号才挡哪个），这里至少把已知的复合名分隔符挡掉：
 *   `\`（`若水\阿莫斯`：7 字、汉字开头，加反斜杠前能整条混进白名单）、`\u3000` 全角空格。
 *   （`\u3000` 其实已被正则里的 `\s` 覆盖、也会被 trim 掉，这里显式列出只为把「全角空格也算分隔符」写明。）
 *   真要彻底解决，得改成白名单式判据（只收「图鉴里出现过」），那属于审核 #8 之后的另一件事。
 * @param {string} name
 */
const NON_ENTITY_WORDS = /任意|其他|主[cCＣ]|武器|套装|散搭|白值|辅助/

function isSingleName (name) {
  const s = String(name ?? '').trim()
  if (!s) return false
  if (s.length >= 8) return false                                   // 短句
  if (!/^[\u4e00-\u9fa5]/.test(s)) return false                     // 数字/字母开头 = 口语写法
  if (/[+＋/／=＝>＞<＜＆&、，,；;：:（）()\[\]「」【】\s·\\\u3000]/.test(s)) return false // 组合/并列（含 \ 与全角空格）
  if (NON_ENTITY_WORDS.test(s)) return false                        // 泛称/说明
  return true
}

/**
 * 常用「两件套」简写（编辑器预设，用户 2026-09-30 定稿）：`2攻击` / `2生命` / `2精通` / `2充能`。
 *
 * 它们**不是套装名**，而是"带这个 2 件套效果的那两套"的写法，图鉴后端里没有 —— 这里显式列出来、
 * 破例编进索引白名单，于是：
 *   - 编辑器「圣遗物套装」候选（名称库 `▾` / 输入框 datalist）把这四个**固定排在最前**，点一下就填；
 *   - `validate()` 以索引为白名单，所以编辑器不再挂「圣遗物名不在图鉴」的 ⚠，
 *     `parse-docx` 的 `_parse-report.json` 也不再记这几条。
 * ⚠ 只放行这一份清单：其余数字开头的口语写法（`88爆伤` 之类）照旧被 `isSingleName` 拒掉、照旧挂 ⚠ ——
 *   别把「不报错」扩大成「什么名字都收」。
 */
export const ARTIFACT_PIECE_PRESETS = ['2攻击', '2生命', '2精通', '2充能']

/** 递归收集一份角色 JSON 里所有 ref 的名字（按类型分组） */
function collectRefNames (value, into) {
  if (!value) return
  if (Array.isArray(value)) {
    for (const v of value) collectRefNames(v, into)
    return
  }
  if (typeof value !== 'object') return
  if (typeof value.ref === 'string') {
    const i = value.ref.indexOf(':')
    if (i > 0) {
      const type = value.ref.slice(0, i).trim()
      const name = value.ref.slice(i + 1).trim()
      if (into[type] && isSingleName(name)) into[type].push(name)
    }
  }
  for (const v of Object.values(value)) collectRefNames(v, into)
}

/** data/gi/*.json → { weapon:[], artifact:[], character:[] }（只收单个实体名） */
function readRefNamesFromData () {
  const into = { weapon: [], artifact: [], character: [] }
  let files = []
  try {
    files = fs.readdirSync(giDir).filter(f => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
  } catch {
    return into
  }
  for (const f of files) {
    try {
      collectRefNames(readJson(path.join(giDir, f)), into)
    } catch {
      // 单个坏文件不影响整体
    }
  }
  return into
}

/**
 * 构建索引对象并（可选）落盘 —— 供 scripts/editor.mjs 保存角色后自动重建复用。
 *
 * @param {object} [opts]
 * @param {string} [opts.backend] 图鉴后端目录（默认 DEFAULT_BACKEND）
 * @param {string} [opts.outFile] 输出文件（默认 data/_index.json；传 null 只返回不写盘）
 * @returns {{index: object, outFile: string|null, weapons: number, characters: number, artifacts: number,
 *            authoritative: {weapons: number, characters: number, artifacts: number},
 *            localOnly: {weapons: number, characters: number, artifacts: number},
 *            localOnlyNames: {weapons: string[], characters: string[], artifacts: string[]},
 *            artifactFiles: number, badFiles: string[], added: object, fromFiles: number, wrote: boolean}}
 */
export function buildIndex (opts = {}) {
  const backend = path.resolve(opts.backend ?? DEFAULT_BACKEND)
  const out = opts.outFile === undefined ? outFile : opts.outFile
  if (!fs.existsSync(backend) || !fs.statSync(backend).isDirectory()) {
    throw new Error(`找不到图鉴后端目录：${backend}`)
  }

  const map = readMapNames(backend)
  const art = readArtifactNames(backend)
  const fromFiles = readCharacterFiles()

  // ① 权威清单：武器/圣遗物**只来自图鉴后端**；角色除 map.json 外还必须含 data/gi 的文件名
  //    （编辑器「从图鉴添加新角色」刚建出来的文件要立刻通过校验 —— validate 读的就是这一份）。
  const authoritative = {
    weapons: normalizeNames(map.weapons),
    characters: normalizeNames([...map.characters, ...fromFiles]),
    artifacts: normalizeNames(art.names)
  }
  const authSets = {
    weapons: new Set(authoritative.weapons),
    characters: new Set(authoritative.characters),
    artifacts: new Set(authoritative.artifacts)
  }

  // ② 合并清单（旧字段）：权威 + data/gi 里实际在用的名字（文件名 + 数据里的 ref 名）。
  const fromData = readRefNamesFromData()
  const before = {
    weapons: authoritative.weapons.length,
    characters: authoritative.characters.length,
    artifacts: authoritative.artifacts.length
  }
  const weapons = normalizeNames([...authoritative.weapons, ...fromData.weapon])
  const characters = normalizeNames([...authoritative.characters, ...fromData.character])
  let artifacts = normalizeNames([...authoritative.artifacts, ...fromData.artifact])
  const added = {
    weapons: weapons.length - before.weapons,
    characters: characters.length - before.characters,
    artifacts: artifacts.length - before.artifacts
  }

  // 常用 2 件套预设固定排在候选最前（编辑器 ▾ 选择器 / datalist / 名称库都吃这个顺序）：
  // 归一那一步按拼音排序，所以要排完再插到前面。
  artifacts = [...ARTIFACT_PIECE_PRESETS, ...artifacts.filter(n => !ARTIFACT_PIECE_PRESETS.includes(n))]

  // ③ localOnly = 合并清单 − 权威清单 = 「图鉴后端里没有、只有 data/gi 在用」的名字。
  //    它们在合并清单里（UI 候选照旧能看到），但**不在权威清单里** —— 于是 validate 不会再替错名背书。
  //    顺序沿用合并清单的顺序（圣遗物这边会带上排在最前的 2 件套预设，见 audit-dup-items 的豁免说明）。
  const localOnly = {
    weapons: weapons.filter(n => !authSets.weapons.has(n)),
    characters: characters.filter(n => !authSets.characters.has(n)),
    artifacts: artifacts.filter(n => !authSets.artifacts.has(n))
  }

  const index = {
    generatedAt: new Date().toISOString(),
    weapons,
    characters,
    artifacts,
    authoritative,
    localOnly
  }
  let wrote = false
  if (out) {
    if (!fs.existsSync(path.dirname(out))) fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(index, null, 2) + '\n', 'utf8')
    wrote = true
  }
  return {
    index,
    outFile: out,
    backend,
    weapons: weapons.length,
    characters: characters.length,
    artifacts: artifacts.length,
    authoritative: {
      weapons: authoritative.weapons.length,
      characters: authoritative.characters.length,
      artifacts: authoritative.artifacts.length
    },
    localOnly: {
      weapons: localOnly.weapons.length,
      characters: localOnly.characters.length,
      artifacts: localOnly.artifacts.length
    },
    localOnlyNames: localOnly,
    artifactFiles: art.files,
    badFiles: art.badFiles,
    added,
    fromFiles: fromFiles.length,
    wrote
  }
}

function main () {
  const backend = path.resolve(process.argv[2] ?? DEFAULT_BACKEND)
  if (!fs.existsSync(backend) || !fs.statSync(backend).isDirectory()) {
    console.error(`找不到图鉴后端目录：${backend}`)
    console.error('用法：node scripts/build-index.mjs [后端目录]')
    console.error(`默认：${DEFAULT_BACKEND}`)
    process.exit(1)
  }
  console.log(`图鉴后端：${backend}`)

  let info
  try {
    info = buildIndex({ backend })
  } catch (err) {
    console.error(String(err?.message ?? err))
    process.exit(1)
  }

  if (!info.weapons) console.warn('警告：武器清单为空（map.json 里没读到 games.gi.locales.zh.pages.weapon.records[].name）')
  if (!info.characters) console.warn('警告：角色清单为空（map.json 里没读到 games.gi.locales.zh.pages.character.records[].name）')
  if (!info.artifacts) console.warn('警告：圣遗物套装清单为空（content.list.set[].name.zh 一个都没读到）')
  if (info.badFiles.length) console.warn(`警告：${info.badFiles.length} 个圣遗物文件无法解析，已跳过（例：${info.badFiles[0]}）`)

  console.log(`武器 ${info.weapons} 条 / 角色 ${info.characters} 条 / 圣遗物套装 ${info.artifacts} 条（来自 ${info.artifactFiles} 个文件）`)
  console.log(`其中来自 data/gi 的补充：武器 +${info.added.weapons} / 角色 +${info.added.characters}（含 ${info.fromFiles} 个文件名）/ 圣遗物 +${info.added.artifacts}`)

  // 「图鉴后端里没有、只有 data/gi 在用」的名字必须暴露在日志里 —— 它们是审核 #8 的病根，
  // 以前会被并进白名单、让该角色的 issue 从 1 变 0；现在 validate 只认 authoritative，它们不再被背书。
  const A = info.authoritative
  const L = info.localOnly
  const lo = info.localOnlyNames
  console.log(`权威：武器 ${A.weapons} / 角色 ${A.characters} / 圣遗物 ${A.artifacts}；来自数据的本地候选：武器 ${L.weapons} / 角色 ${L.characters} / 圣遗物 ${L.artifacts}`)
  const list = (arr) => arr.slice(0, 20).join('、') + (arr.length > 20 ? ` …（共 ${arr.length} 个，只列前 20）` : '')
  const loLines = []
  if (lo.weapons.length) loLines.push(`  · 武器（${lo.weapons.length}）：${list(lo.weapons)}`)
  if (lo.characters.length) loLines.push(`  · 角色（${lo.characters.length}）：${list(lo.characters)}`)
  if (lo.artifacts.length) loLines.push(`  · 圣遗物（${lo.artifacts.length}）：${list(lo.artifacts)}`)
  if (loLines.length) {
    console.log('本地候选清单（在合并清单里、但不在权威清单里 —— 图鉴后端没有这些名字）：')
    for (const line of loLines) console.log(line)
    const presetHit = lo.artifacts.filter(n => ARTIFACT_PIECE_PRESETS.includes(n))
    if (presetHit.length) console.log(`  注：其中 ${presetHit.join(' / ')} 是编辑器「2 件套」预设（ARTIFACT_PIECE_PRESETS），不是 data/gi 里出现的名字`)
  } else {
    console.log('本地候选清单：空（data/gi 里没有图鉴后端不认识的名字）')
  }
  console.log(`已写入 ${path.relative(root, outFile)}`)
}

// 仅在直接执行时跑主流程（被 import 时不跑）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
