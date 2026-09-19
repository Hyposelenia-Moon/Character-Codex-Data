/**
 * 输出「主文档解析结果 vs data/gi」的逐字段深层差异（含 JSON 结构级 firstDiff）
 * 用法：node scripts/deep-diff-doc-json.mjs [--snapshot <docx>] [角色名...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childRun } from './mark-docx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const work = path.join(root, '.tmp', 'deepdiff')
const shadow = path.join(work, 'shadow')
const snapArg = (() => { const i = process.argv.indexOf('--snapshot'); return i >= 0 ? process.argv[i + 1] : null })()
const only = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== snapArg)
const docx = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function firstDiffs (a, b, pathStr = '', out = [], max = 6) {
  if (out.length >= max || eq(a, b)) return out
  const isObj = (x) => x && typeof x === 'object'
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n && out.length < max; i++) {
      if (i >= a.length) out.push(`${pathStr}[${i}] 文档缺（库有 ${JSON.stringify(b[i]).slice(0, 70)}）`)
      else if (i >= b.length) out.push(`${pathStr}[${i}] 库缺（文档有 ${JSON.stringify(a[i]).slice(0, 70)}）`)
      else firstDiffs(a[i], b[i], `${pathStr}[${i}]`, out, max)
    }
    return out
  }
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      if (out.length >= max) break
      if (!(k in a)) out.push(`${pathStr}.${k} 文档缺（库: ${JSON.stringify(b[k]).slice(0, 70)}）`)
      else if (!(k in b)) out.push(`${pathStr}.${k} 库缺（文档: ${JSON.stringify(a[k]).slice(0, 70)}）`)
      else firstDiffs(a[k], b[k], `${pathStr}.${k}`, out, max)
    }
    return out
  }
  out.push(`${pathStr}: 文档=${JSON.stringify(a)?.slice(0, 80)} ≠ 库=${JSON.stringify(b)?.slice(0, 80)}`)
  return out
}

// 影子解析（不写 data/gi）
fs.rmSync(shadow, { recursive: true, force: true })
fs.mkdirSync(path.join(shadow, 'scripts', 'lib'), { recursive: true })
fs.mkdirSync(path.join(shadow, 'data'), { recursive: true })
fs.copyFileSync(path.join(here, 'parse-docx.mjs'), path.join(shadow, 'scripts', 'parse-docx.mjs'))
for (const f of ['docx.mjs', 'schema.mjs']) fs.copyFileSync(path.join(here, 'lib', f), path.join(shadow, 'scripts', 'lib', f))
fs.copyFileSync(path.join(root, 'data', '_index.json'), path.join(shadow, 'data', '_index.json'))
const srcGi = path.join(shadow, 'data', 'gi')
fs.mkdirSync(srcGi, { recursive: true })
for (const f of fs.readdirSync(giDir)) fs.copyFileSync(path.join(giDir, f), path.join(srcGi, f))
const ascii = path.join(work, 'main.docx')
fs.mkdirSync(work, { recursive: true })
if (snapArg) fs.writeFileSync(ascii, fs.readFileSync(snapArg))
else fs.copyFileSync(docx, ascii)
const r = childRun(path.join(shadow, 'scripts', 'parse-docx.mjs'), [ascii], shadow, path.join(work, 'out.txt'))
if (r.status !== 0) { console.error(r.stderr.slice(0, 600)); process.exit(1) }

const names = readJson(path.join(srcGi, '_order.json'))
let n = 0
for (const name of names) {
  if (only.length && !only.includes(name)) continue
  const doc = readJson(path.join(srcGi, `${name}.json`))
  const realFile = path.join(giDir, `${name}.json`)
  if (!fs.existsSync(realFile)) { console.log(`=== ${name} === 只在文档`); n++; continue }
  const real = readJson(realFile)
  const d = firstDiffs(doc, real, '', [], 8)
  if (!d.length) continue
  n++
  console.log(`=== ${name} ===`)
  for (const x of d) console.log('   ' + x)
}
console.log(`\n有深层差异的角色：${n} / ${names.length}`)
