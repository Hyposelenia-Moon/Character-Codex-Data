/**
 * 诊断：主文档 D:\...\原神·角色攻略.docx 与 data/gi/*.json 逐角色深比较，列出所有不一致及具体字段
 *
 * 用法：node scripts/diagnose-docx-json.mjs [docx路径]
 *   只读，不写任何文件。退出码：有差异 → 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseToJson, parseDry } from './mark-docx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = process.env.DSH_GI_DIR ? path.resolve(process.env.DSH_GI_DIR) : path.join(root, 'data', 'gi')
const docx = process.argv[2] ?? 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'
const tmp = path.join(root, '.tmp', 'diagnose')

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 找出两个值的第一处不同路径 */
function firstDiff (a, b, pathStr = '') {
  if (eq(a, b)) return null
  const isObj = (x) => x && typeof x === 'object'
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (i >= a.length) return `${pathStr}[${i}] 多出 ${JSON.stringify(b[i]).slice(0, 60)}`
      if (i >= b.length) return `${pathStr}[${i}] 缺失（JSON 有 ${JSON.stringify(a[i]).slice(0, 60)}）`
      const d = firstDiff(a[i], b[i], `${pathStr}[${i}]`)
      if (d) return d
    }
    return `${pathStr} 长度不同 ${a.length} vs ${b.length}`
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    for (const k of keys) {
      if (!(k in a)) return `${pathStr}.${k} 文档多出 ${JSON.stringify(b[k]).slice(0, 60)}`
      if (!(k in b)) return `${pathStr}.${k} 文档缺失（JSON: ${JSON.stringify(a[k]).slice(0, 60)}）`
      const d = firstDiff(a[k], b[k], `${pathStr}.${k}`)
      if (d) return d
    }
    return `${pathStr} 对象键不同`
  }
  return `${pathStr}: 文档=${JSON.stringify(a).slice(0, 80)} ≠ JSON=${JSON.stringify(b).slice(0, 80)}`
}

console.log(`主文档：${docx}`)
console.log(`数据：${giDir}${process.env.DSH_GI_DIR ? '（冻结快照）' : ''}`)
fs.mkdirSync(tmp, { recursive: true })
const dry = parseDry(docx, tmp, process.env.DSH_GI_DIR ? { giDir: giDir } : {})
console.log('文档回读统计：', JSON.stringify(dry.stats))

const parsed = parseToJson(docx, path.join(tmp, 'out'), process.env.DSH_GI_DIR ? { giDir: giDir } : {})
const files = fs.readdirSync(giDir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()
const jsonNames = readJson(path.join(giDir, '_order.json'))
const bundle = jsonNames.map(n => ({ name: n, doc: readJson(path.join(giDir, `${n}.json`)) }))

console.log(`角色数：文档 ${parsed.names.length} / JSON ${bundle.length}`)
const onlyDoc = parsed.names.filter(n => !jsonNames.includes(n))
const onlyJson = jsonNames.filter(n => !parsed.names.includes(n))
if (onlyDoc.length) console.log('只在文档里的角色：', onlyDoc.join('、'))
if (onlyJson.length) console.log('只在 JSON 里的角色：', onlyJson.join('、'))

const issues = []
for (let i = 0; i < Math.min(parsed.names.length, bundle.length); i++) {
  const got = parsed.objs[i]
  const want = bundle[i].doc
  if (parsed.names[i] !== bundle[i].name) {
    issues.push({ name: `${bundle[i].name} / ${parsed.names[i]}`, fields: ['顺序不一致'] })
    continue
  }
  const fields = []
  for (const k of ['schema', 'name', 'game', 'meta', 'v2', 'unparsed']) {
    if (!eq(got[k] ?? null, want[k] ?? null)) {
      fields.push(`${k}：${firstDiff(want[k] ?? null, got[k] ?? null, k)}`)
    }
  }
  if (fields.length) issues.push({ name: bundle[i].name, fields })
}

console.log(`\n=== 不一致角色：${issues.length} 个 ===`)
for (const it of issues) {
  console.log(`· ${it.name}`)
  for (const f of it.fields) console.log(`    ${f}`)
}

console.log(`\n文件总数：${files.length}`)
process.exit(issues.length || onlyDoc.length || onlyJson.length ? 1 : 0)
