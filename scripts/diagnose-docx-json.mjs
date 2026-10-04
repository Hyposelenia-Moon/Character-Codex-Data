/**
 * 诊断：主文档（MAIN_DOC，可用 CODEX_DOCX 覆盖）与 data/gi/*.json 逐角色深比较，列出所有不一致及具体字段
 *
 * 用法：node scripts/diagnose-docx-json.mjs [docx路径]
 *   只读，不写任何文件（`DSH_GI_DIR` 指向的输入目录也一个字节都不会动）。退出码：有差异 → 1。
 *
 * 2026-10-04 审核 P1-3 / P2-9 修的三处：
 *  1. `DSH_GI_DIR` 以前既被当作"冻结输入快照"、又被当作子进程的**写入目录**，而期望值是在解析
 *     **之后**才从这个目录读的 —— 于是「数据 ↔ 文档」退化成"文档和自己比"，恒 0 个不一致。
 *     现在期望值先读进内存，解析只把种子复制进克隆体，解析完再比一次目录哈希证明输入没被动过。
 *  2. 「文档角色集合」改用解析报告（`report.characters`）：解析后的 `_order.json` 按设计保留空档模板
 *     （米提亚 / 瓦列里）与旧顺序残留，拿它当文档角色集合会把这些误报成「只在文档里的角色」。
 *  3. 集合差（只在文档 / 只在 JSON）以前不计入「不一致角色」数、只在退出码里体现，而下游只读那个数字；
 *     现在按名字对齐比较（不再按下标逐位比），集合差与顺序不一致各算一条，末尾追加一行机器可读的
 *     `诊断结论：{…}`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseToJson, parseDry } from './mark-docx.mjs'
import { isFilledCharacter } from './build-docx.mjs'
import { MAIN_DOC } from './lib/main-doc.mjs'
import { hashDir, hashDiff } from './lib/parse-isolation.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = process.env.DSH_GI_DIR ? path.resolve(process.env.DSH_GI_DIR) : path.join(root, 'data', 'gi')
const docx = process.argv[2] ?? MAIN_DOC
const tmp = path.join(root, '.tmp', 'diagnose')
/** 只有显式给了 `DSH_GI_DIR` 才把种子交给解析器；否则不传，行为与以前一致（解析器自己用仓库 data/gi） */
const seedOpt = process.env.DSH_GI_DIR ? { seedGiDir: giDir } : {}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 找出两个值的第一处不同路径。
 * ⚠ 调用方传的是 `firstDiff(want, got)`，其中 `want` = **数据 JSON**、`got` = **文档解析结果**
 * （见下面的 `firstDiff(want[k], got[k], k)`）—— 标签必须与实参方向一致，
 * 否则报错信息会把「该改文档」说成「该改数据」，正好把修复方向指反。
 */
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
  return `${pathStr}: 数据=${JSON.stringify(a).slice(0, 80)} ≠ 文档=${JSON.stringify(b).slice(0, 80)}`
}

console.log(`主文档：${docx}`)
console.log(`数据：${giDir}${process.env.DSH_GI_DIR ? '（冻结快照）' : ''}`)
fs.mkdirSync(tmp, { recursive: true })

/* ------------------------------------------------------------------ *
 * 1. 期望值**先**读进内存：解析期间输入目录必须只读
 * ------------------------------------------------------------------ */

// 顺序是关键：以前是先解析、再从这个目录读「期望值」，而这个目录正是子进程的写入目录，
// 于是比的是"文档刚写出来的数据本身"，永远 0 个不一致（发布校验用的就是这一项）。
const giBefore = hashDir(giDir)
const files = fs.readdirSync(giDir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()
const jsonNames = readJson(path.join(giDir, '_order.json'))
const allEntries = jsonNames.map(n => ({ name: n, doc: readJson(path.join(giDir, `${n}.json`)) }))
// 空档角色（「从图鉴添加」建的空模板）**不进主文档**，所以不参与比对 —— 与 build-docx 同一口径
const skipped = allEntries.filter(x => !isFilledCharacter(x.doc)).map(x => x.name)
const bundle = allEntries.filter(x => isFilledCharacter(x.doc))
const expected = new Map(bundle.map(x => [x.name, x.doc]))
const jsonSeq = bundle.map(x => x.name)

/* ------------------------------------------------------------------ *
 * 2. 解析（拿不到结果就给人话，不要把栈扔给用户）
 * ------------------------------------------------------------------ */

let dry, parsed
try {
  dry = parseDry(docx, tmp, seedOpt)
  parsed = parseToJson(docx, path.join(tmp, 'out'), seedOpt)
} catch (e) {
  // 文档含未识别行 / 找不到文档 / 依赖缺失等都会抛到这里；退出码 1 与"有差异"一致，但原因写清楚
  console.error(`× 诊断失败：${e?.message ?? e}`)
  process.exit(1)
}
console.log('文档回读统计：', JSON.stringify(dry.stats))

// 输入只读契约：解析器内部已断言过种子没被改写，这里再自查一次并留下可核对的结论
const giChanged = hashDiff(giBefore, hashDir(giDir))
console.log(`输入目录未被改写：${giChanged.length ? '否！' + giChanged.join('、') : `是（${giBefore.size} 个文件哈希一致）`}`)

/* ------------------------------------------------------------------ *
 * 3. 文档角色集合：优先用解析报告（文档里真实出现的角色）
 * ------------------------------------------------------------------ */

const reportNames = Array.isArray(parsed.report?.characters) ? parsed.report.characters.map(c => c.name) : null
if (!reportNames) {
  console.log('（拿不到解析报告 report.characters，角色集合回退为解析后的 _order.json —— 空档模板与旧顺序残留可能被误报成「只在文档」）')
}
const docSeq = reportNames ?? parsed.names
const docObjs = new Map(parsed.names.map((n, i) => [n, parsed.objs[i]]))

console.log(`角色数：文档 ${docSeq.length} / JSON ${bundle.length}${skipped.length ? `（另有 ${skipped.length} 个空档未进文档：${skipped.join('、')}）` : ''}`)

/* ------------------------------------------------------------------ *
 * 4. 按名字对齐比较（不再按下标 Math.min 逐位比）
 * ------------------------------------------------------------------ */

const docSet = new Set(docSeq)
const onlyDoc = docSeq.filter(n => !expected.has(n))
const onlyJson = jsonSeq.filter(n => !docSet.has(n))
// 顺序能力不能丢：两侧名字序列不同就记一条「顺序不一致」
const order = docSeq.length === jsonSeq.length && docSeq.every((n, i) => n === jsonSeq[i])
if (onlyDoc.length) console.log('只在文档里的角色：', onlyDoc.join('、'))
if (onlyJson.length) console.log('只在 JSON 里的角色：', onlyJson.join('、'))
if (!order) {
  // 只打「第一处不同」，否则两边前缀一样时看不出问题出在哪一位
  const i = docSeq.findIndex((n, k) => n !== jsonSeq[k])
  console.log(i < 0
    ? `顺序不一致：共有部分顺序相同，但长度不同（文档 ${docSeq.length} / JSON ${jsonSeq.length}）`
    : `顺序不一致：第 ${i + 1} 位起 文档「${docSeq[i] ?? '（无）'}」 vs JSON「${jsonSeq[i] ?? '（无）'}」`)
}

// 交集内逐字段比（按文档顺序遍历，与看到的文档顺序一致）
const content = []
for (const name of docSeq) {
  if (!expected.has(name)) continue
  const got = docObjs.get(name)
  const want = expected.get(name)
  if (!got) { content.push({ name, fields: ['文档解析结果里没有这个角色的对象'] }); continue }
  const fields = []
  for (const k of ['schema', 'name', 'game', 'meta', 'v2', 'unparsed']) {
    if (!eq(got[k] ?? null, want[k] ?? null)) {
      fields.push(`${k}：${firstDiff(want[k] ?? null, got[k] ?? null, k)}`)
    }
  }
  if (fields.length) content.push({ name, fields })
}

/* ------------------------------------------------------------------ *
 * 5. 输出：集合差与顺序也各算一条「不一致角色」
 * ------------------------------------------------------------------ */

const entries = [
  ...content,
  ...onlyDoc.map(name => ({ name, fields: ['只在文档（JSON 里没有这个已填角色）'] })),
  ...onlyJson.map(name => ({ name, fields: ['只在 JSON（文档里没有这个角色块）'] })),
  ...(order ? [] : [{ name: '（角色顺序）', fields: ['顺序不一致：文档与 JSON 的名字序列不同'] }])
]
console.log(`\n=== 不一致角色：${entries.length} 个 ===`)
for (const it of entries) {
  console.log(`· ${it.name}`)
  for (const f of it.fields) console.log(`    ${f}`)
}

console.log(`\n文件总数：${files.length}`)

// 机器可读结论：下游只读这一行（全角冒号 + 单行 JSON，字段顺序固定）
const conclusion = {
  ok: content.length === 0 && onlyDoc.length === 0 && onlyJson.length === 0 && order === true,
  fields: content.length,
  onlyDoc,
  onlyJson,
  order
}
console.log(`诊断结论：${JSON.stringify(conclusion)}`)
process.exit(conclusion.ok ? 0 : 1)
