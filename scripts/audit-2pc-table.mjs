/**
 * 检测所有圣遗物套装的「2 件套效果」，并按用户定稿的规则分类：
 *   2 件套效果 = 攻击力 18% / 生命值 20% / 元素精通 80 / 元素充能效率 20% → 用四条常用预设
 *   （`2攻击` / `2生命` / `2精通` / `2充能`）；其余才用套装简称。
 *
 * 用法：node scripts/audit-2pc-table.mjs
 *   输出 ① 每个套装的 2 件套描述与判定；② 与 scripts/lib/schema.mjs 的表比对；
 *   ③ 表里没有、也没有简称的套装（要补简称）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const BACKEND = process.env.DSH_ATLAS_BACKEND ??
  'D:\\文件\\游戏\\原神\\Atlas-Plugin\\tool\\nanoka-atlas-backend\\nanoka-atlas-backend'
const artDir = path.join(BACKEND, 'data', 'items', '简体中文', '原神', '圣遗物')

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

/** 套装名 → 2 件套描述（同名的第一条记录） */
const twoPieceDesc = new Map()
for (const file of walk(artDir)) {
  let doc
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
  const sets = doc?.content?.list?.set
  if (!sets || typeof sets !== 'object') continue
  for (const [id, v] of Object.entries(sets)) {
    const zh = v?.name?.zh
    if (!zh) continue
    const rec = { id: Number(id), desc: String(v?.desc?.zh ?? '').trim() }
    const cur = twoPieceDesc.get(zh)
    if (!cur || rec.id < cur.id) twoPieceDesc.set(zh, rec)
  }
}

/** 四条通用预设的判据（按用户定稿的数值，不按"含某个词"——避免把「生命值上限提升1000点」也算进来） */
const PRESET_RULES = [
  ['2攻击', /攻击力(?:提高|提升)18%/],
  ['2生命', /生命值(?:上限)?(?:提高|提升)20%/],
  ['2精通', /元素精通(?:提高|提升)80/],
  ['2充能', /元素充能效率(?:提高|提升)20%/]
]
const detect = (desc) => {
  const first = String(desc).split(/[。；;]/)[0]
  for (const [word, re] of PRESET_RULES) if (re.test(first)) return word
  return ''
}

const { ARTIFACT_2PC } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'schema.mjs')).href)
const PRESET_WORDS = new Set(['2攻击', '2生命', '2精通', '2充能'])

/* `--abbr`：只打「套装简称」核对表（不含四条常用预设），供人过一遍 */
if (process.argv.includes('--abbr')) {
  const rows = [...twoPieceDesc.keys()]
    .map(name => ({ name, word: ARTIFACT_2PC[name] ?? '', desc: String(twoPieceDesc.get(name).desc).split(/[。；;]/)[0] }))
    .filter(r => r.word && !PRESET_WORDS.has(r.word))
    .sort((a, b) => a.word.localeCompare(b.word, 'zh-Hans-CN'))
  console.log(`| 写法 | 套装 | 2 件套效果 |`)
  console.log(`|---|---|---|`)
  for (const r of rows) console.log(`| ${r.word} | ${r.name} | ${r.desc} |`)
  const missing = [...twoPieceDesc.keys()].filter(n => !ARTIFACT_2PC[n])
  console.log(`\n共 ${rows.length} 条简称；映射到四条常用预设的套装 ${[...twoPieceDesc.keys()].filter(n => PRESET_WORDS.has(ARTIFACT_2PC[n])).length} 个（不列）。`)
  console.log(`既没有简称、也没判到预设的 ${missing.length} 个：${missing.join('、')}`)
  process.exit(0)
}

const detected = new Map()
const unmapped = []
console.log('套装名 ｜ 2 件套效果 ｜ 判定 ｜ 表里的写法')
for (const [name, rec] of [...twoPieceDesc].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))) {
  const word = detect(rec.desc)
  const inTable = ARTIFACT_2PC[name] ?? ''
  detected.set(name, word)
  if (!word && !inTable) unmapped.push(name)
  const flag = (word && inTable && inTable !== word) ? `  ⚠ 表里写的是 ${inTable}`
    : (word ? '  （预设）' : (inTable ? `  简称 ${inTable}` : '  ← 要补简称'))
  console.log(`${name} ｜ ${rec.desc.split(/[。；;]/)[0]} ｜ ${word || inTable || '（无）'}${flag}`)
}

const presetGroups = {}
for (const [name, word] of detected) if (word) (presetGroups[word] = presetGroups[word] || []).push(name)
console.log('\n--- 检测出的四条预设（可直接替换 schema.mjs 里的 TWO_PIECE_PRESET）---')
for (const [word, list] of Object.entries(presetGroups)) {
  console.log(`  '${word}': [${list.map(n => `'${n}'`).join(', ')}],`)
}

const mismatch = [...detected].filter(([n, w]) => w && ARTIFACT_2PC[n] && ARTIFACT_2PC[n] !== w)
console.log(`\n判定与表不一致：${mismatch.length} 条` + (mismatch.length ? `\n  ` + mismatch.map(([n, w]) => `${n}：应 ${w}，表里 ${ARTIFACT_2PC[n]}`).join('\n  ') : ''))
console.log(`没有判定、也没有简称的套装：${unmapped.length} 个` + (unmapped.length ? `\n  ${unmapped.join('、')}` : ''))

/* 覆盖情况：图鉴（data/_index.json 的 artifacts，去掉四条预设）里每个套装都要有写法 */
const atlasNames = (() => {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(root, 'data', '_index.json'), 'utf8'))
    return (idx.artifacts ?? []).filter(n => !/^[24][^\d\s]/.test(String(n)))
  } catch { return [] }
})()
const notCovered = atlasNames.filter(n => !ARTIFACT_2PC[n])
const notInAtlas = Object.keys(ARTIFACT_2PC).filter(n => !atlasNames.includes(n))
console.log(`\n覆盖检查：图鉴套装 ${atlasNames.length} 个 ｜ 有写法 ${atlasNames.length - notCovered.length} 个 ｜ 没有写法 ${notCovered.length} 个`)
if (notCovered.length) console.log(`  没有写法的：${notCovered.join('、')}`)
console.log(`表里有、图鉴里没有的：${notInAtlas.length} 个` + (notInAtlas.length ? `（${notInAtlas.join('、')}）` : ' ✅'))
if (unmapped.length !== notCovered.length) {
  const only = unmapped.filter(n => !notCovered.includes(n))
  if (only.length) console.log(`  注意：检测有描述但没进图的鉴套装 ${only.length} 个：${only.join('、')}`)
}
