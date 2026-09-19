/**
 * 一次性数据修正：把文档里的「冰主」改为完整名「旅行者·冰」
 *
 * 只重写 word/document.xml 这一个部件，其余部件逐字节复制（writeDocx 只拿 xml 替换）。
 * 附带：把原文档备份到 <doc>.bak-before-bingzhu，便于回滚。
 *
 * 用法：node scripts/fix-docx-names.mjs [docx路径] [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readDocx, writeDocx } from './lib/docx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const DEFAULT_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

/** 修正表：文档文本 → 标准名（old 必须是标准名白名单外的俗称） */
const RENAMES = [
  ['冰主', '旅行者·冰']
]

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const doc = args.find(a => !a.startsWith('--')) ?? DEFAULT_DOC

const src = readDocx(doc)
console.log(`文档：${doc}`)
console.log(`部件：${src.entries.size} 个，段落 ${src.paragraphs.length} 行`)

const xml = src.xml
const counts = {}
let next = xml
for (const [from, to] of RENAMES) {
  const n = next.split(from).length - 1
  counts[`${from} → ${to}`] = n
  if (!n) continue
  // 逐处计数（按出现位置列出所在段落文本，供人工核对）
  const paras = src.paragraphs.map((p, i) => [i, p]).filter(([, p]) => p.includes(from))
  console.log(`  · ${from} → ${to}：${n} 处，涉及 ${paras.length} 行`)
  for (const [i, p] of paras) console.log(`      段落 #${i}：${p}`)
  next = next.split(from).join(to)
}

if (JSON.stringify(counts) === '{}' || Object.values(counts).every(n => n === 0)) {
  console.log('没有需要修正的内容（0 处）')
  process.exit(0)
}
if (dry) {
  console.log('--dry：未写文件。统计：', JSON.stringify(counts, null, 2))
  process.exit(0)
}

const bak = doc + '.bak-before-rename'
if (!fs.existsSync(bak)) {
  fs.copyFileSync(doc, bak)
  console.log(`已备份原文档 → ${bak}`)
} else {
  console.log(`备份已存在，未覆盖：${bak}`)
}

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const entries = new Map()
for (const [name, buf] of src.entries) {
  entries.set(name, name === 'word/document.xml' ? Buffer.from(next, 'utf8') : buf)
}
const w = writeDocx(entries, doc)

// 复验：除 document.xml 外逐字节一致；解析出的段落文本应已更新
const rt = readDocx(doc)
const changed = []
for (const [name, buf] of src.entries) {
  if (name === 'word/document.xml') continue
  if (sha(buf) !== sha(rt.entries.get(name))) changed.push(name)
}
const left = rt.paragraphs.filter(p => RENAMES.some(([from]) => p.includes(from)))
console.log(`已写回 ${doc}（${w.count} 个部件，${w.bytes} 字节）`)
console.log(`其它部件：${changed.length ? '有改动！' + changed.join(',') : '与源逐字节一致'}`)
console.log(`段落数：${rt.paragraphs.length}（源 ${src.paragraphs.length}）`)
console.log(`残留旧名行：${left.length}${left.length ? '：' + left.join(' ｜ ') : ''}`)
