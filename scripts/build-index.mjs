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
 *   { "generatedAt": "ISO", "weapons": [...], "characters": [...], "artifacts": [...] }
 * 编辑器（scripts/editor.mjs）用它做名称候选与校验；scripts/parse-docx.mjs 也会读它。
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
 * @param {string} name
 */
const NON_ENTITY_WORDS = /任意|其他|主[cCＣ]|武器|套装|散搭|白值|辅助/

function isSingleName (name) {
  const s = String(name ?? '').trim()
  if (!s) return false
  if (s.length >= 8) return false                                   // 短句
  if (!/^[\u4e00-\u9fa5]/.test(s)) return false                     // 数字/字母开头 = 口语写法
  if (/[+＋/／=＝>＞<＜＆&、，,；;：:（）()\[\]「」【】\s·]/.test(s)) return false   // 组合/并列
  if (NON_ENTITY_WORDS.test(s)) return false                        // 泛称/说明
  return true
}

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

function main () {
  const backend = path.resolve(process.argv[2] ?? DEFAULT_BACKEND)

  if (!fs.existsSync(backend) || !fs.statSync(backend).isDirectory()) {
    console.error(`找不到图鉴后端目录：${backend}`)
    console.error('用法：node scripts/build-index.mjs [后端目录]')
    console.error(`默认：${DEFAULT_BACKEND}`)
    process.exit(1)
  }
  console.log(`图鉴后端：${backend}`)

  let weapons = []
  let characters = []
  let artifacts = []
  let artifactFiles = 0

  try {
    const map = readMapNames(backend)
    weapons = map.weapons
    characters = map.characters
    const art = readArtifactNames(backend)
    artifacts = art.names
    artifactFiles = art.files
    if (art.badFiles.length) console.warn(`警告：${art.badFiles.length} 个圣遗物文件无法解析，已跳过（例：${art.badFiles[0]}）`)
  } catch (err) {
    console.error(String(err?.message ?? err))
    process.exit(1)
  }

  // 并入 data/gi 里实际在用的名字：文件名 + 数据里的 ref 名
  const fromData = readRefNamesFromData()
  const fromFiles = readCharacterFiles()
  const before = { weapons: weapons.length, characters: characters.length, artifacts: artifacts.length }
  weapons = normalizeNames([...weapons, ...fromData.weapon])
  artifacts = normalizeNames([...artifacts, ...fromData.artifact])
  characters = normalizeNames([...characters, ...fromData.character, ...fromFiles])
  const added = {
    weapons: weapons.length - before.weapons,
    characters: characters.length - before.characters,
    artifacts: artifacts.length - before.artifacts
  }

  if (!weapons.length) console.warn('警告：武器清单为空（map.json 里没读到 games.gi.locales.zh.pages.weapon.records[].name）')
  if (!characters.length) console.warn('警告：角色清单为空（map.json 里没读到 games.gi.locales.zh.pages.character.records[].name）')
  if (!artifacts.length) console.warn('警告：圣遗物套装清单为空（content.list.set[].name.zh 一个都没读到）')

  const index = {
    generatedAt: new Date().toISOString(),
    weapons,
    characters,
    artifacts
  }

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(index, null, 2) + '\n', 'utf8')

  console.log(`武器 ${weapons.length} 条 / 角色 ${characters.length} 条 / 圣遗物套装 ${artifacts.length} 条（来自 ${artifactFiles} 个文件）`)
  console.log(`其中来自 data/gi 的补充：武器 +${added.weapons} / 角色 +${added.characters}（含 ${fromFiles.length} 个文件名）/ 圣遗物 +${added.artifacts}`)
  console.log(`已写入 ${path.relative(root, outFile)}`)
}

// 仅在直接执行时跑主流程（被 import 时不跑）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
