/**
 * 非破坏性对比：把主文档「解析出来的结果」与当前 data/gi/*.json 全量比对，**不写 data/gi**。
 *
 * 做法：把当前数据快照到 .tmp/docmerge/real，再把解析器克隆到 .tmp/docmerge/shadow 并在那边解析文档，
 * 然后逐角色逐字段比较两份 JSON，并把差异分类：
 *   - noteRow      ：并发任务正在做的「括注 → {kind:"note",text}」改造（数据库已有、文档没有）
 *   - docExtra     ：文档里有、数据库里没有的内容（**用户新填入的数据**，最关心）
 *   - jsonExtra    ：数据库里有、文档里没有的内容（可能被覆盖/漏写）
 *   - fieldDiff    ：其它字段级差异
 *
 * 用法：node scripts/compare-doc-json.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childRun } from './mark-docx.mjs'
import { ARTIFACT_KIND_LABEL } from './lib/guide-display.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const work = path.join(root, '.tmp', 'docmerge')
const shadow = path.join(work, 'shadow')
const docx = process.argv.find(a => !a.startsWith('--')) ?? 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'
/** 已有稳定快照时直接用它（主文档可能正被别的任务反复重写） */
const snapshotArg = (() => {
  const i = process.argv.indexOf('--snapshot')
  return i >= 0 ? process.argv[i + 1] : null
})()

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const SECTIONS = ['weapons', 'artifacts', 'talents', 'panels', 'constellations', 'teams']
const SECTION_CN = { weapons: '武器推荐', artifacts: '圣遗物推荐', talents: '天赋加点', panels: '毕业面板参考', constellations: '命座推荐', teams: '配队推荐' }

/** 在克隆目录里解析文档（不改动 data/gi）；文档可能正被别的任务原子替换，失败就先重试 */
function parseShadow () {
  fs.rmSync(shadow, { recursive: true, force: true })
  fs.mkdirSync(path.join(shadow, 'scripts', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(shadow, 'data'), { recursive: true })
  fs.copyFileSync(path.join(here, 'parse-docx.mjs'), path.join(shadow, 'scripts', 'parse-docx.mjs'))
  for (const f of ['docx.mjs', 'schema.mjs']) fs.copyFileSync(path.join(here, 'lib', f), path.join(shadow, 'scripts', 'lib', f))
  fs.copyFileSync(path.join(root, 'data', '_index.json'), path.join(shadow, 'data', '_index.json'))
  // 用当前 data/gi 作为「上一版」（parse-docx 会读它来继承 highlight/source）
  const srcGi = path.join(shadow, 'data', 'gi')
  fs.mkdirSync(srcGi, { recursive: true })
  for (const f of fs.readdirSync(giDir)) fs.copyFileSync(path.join(giDir, f), path.join(srcGi, f))
  let r = null
  // 子进程参数里的非 ASCII 路径可能被系统代码页搞坏，所以先复制成 .tmp 下的 ASCII 文件名再解析
  const asciiCopy = path.join(work, 'main.docx')
  // 复制必须「稳定读」：文档可能正被别的任务写入，读到半截会得到无效 zip
  const stableCopy = () => {
    for (let i = 0; i < 40; i++) {
      let before, buf, after, buf2
      try {
        before = fs.statSync(docx)
        buf = fs.readFileSync(docx)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800)
        after = fs.statSync(docx)
        buf2 = fs.readFileSync(docx)
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)
        continue
      }
      const valid = buf.length > 0 && buf.slice(-200).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
      if (valid && before.size === after.size && before.mtimeMs === after.mtimeMs && buf.equals(buf2)) {
        fs.writeFileSync(asciiCopy, buf)
        console.log(`已取得稳定副本：${buf.length} 字节（第 ${i + 1} 次尝试）`)
        return { bytes: buf.length, tries: i + 1 }
      }
      console.log(`  文档仍在变化（第 ${i + 1} 次尝试：${buf?.length} → ${buf2?.length} 字节，mtime ${before?.mtimeMs} → ${after?.mtimeMs}）`)
    }
    throw new Error('文档持续变化，无法取得稳定副本')
  }
  if (snapshotArg) {
    const snap = fs.readFileSync(snapshotArg)
    fs.writeFileSync(asciiCopy, snap)
    console.log(`使用调用方给的稳定快照：${snapshotArg}（${snap.length} 字节）`)
  } else {
    stableCopy()
  }
  for (let i = 1; i <= 5; i++) {
    r = childRun(path.join(shadow, 'scripts', 'parse-docx.mjs'), [asciiCopy], shadow, path.join(work, 'parse-stdout.txt'))
    if (r.status === 0) break
    console.log(`shadow parse-docx 第 ${i} 次失败，1.5s 后重试…`)
    fs.writeFileSync(path.join(work, `parse-fail-${i}.txt`), r.stderr)
    if (!snapshotArg) stableCopy()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  }
  if (r.status !== 0) throw new Error(`shadow parse-docx 失败（${r.status}）：${r.stderr.slice(0, 400)}`)
  const names = readJson(path.join(srcGi, '_order.json'))
  const map = new Map()
  for (const n of names) map.set(n, readJson(path.join(srcGi, `${n}.json`)))
  return { map, stdout: r.stdout }
}

/** 值 → 一行可读文本（用于「文档有 / 库有」的粗粒度比较） */
function rowsOf (doc, key) {
  const v2 = doc?.v2 ?? {}
  if (key === 'weapons') return (v2.weapons ?? []).map(r => `${r.label ?? (r.tier ? '第' + r.tier + '档' : '')}：${(r.items ?? []).map(i => i.name + (i.note ? `（${i.note}）` : '')).join(' ' + (r.sep ?? '>').trim() + ' ')}`)
  if (key === 'artifacts') {
    const out = []
    for (const r of v2.artifacts ?? []) {
      if (r.kind === 'main') out.push(`主词条：${Object.entries(r.stats ?? {}).map(([k, v]) => `${k}：${(v ?? []).join(' / ')}`).join(' / ')}`)
      else if (r.kind === 'sub') out.push(`副词条：${(r.stats ?? []).join(' / ')}`)
      else if (r.kind === 'text') out.push(`${r.label ? r.label + '：' : ''}${r.text ?? ''}`)
      else out.push(`${r.label ? r.label + '：' : (ARTIFACT_KIND_LABEL[r.kind] ?? r.kind) + '：'}${(r.sets ?? []).map(s => s.name + (s.pieces ? `（${s.pieces}）` : '') + (s.note ? `〔注:${s.note}〕` : '')).join(' / ')}`)
    }
    return out
  }
  if (key === 'talents') return (v2.talents ?? []).map(r => r.kind === 'priority' ? `优先级：${(r.order ?? []).map(o => o.name).join(' > ')}` : r.kind === 'crown' ? `皇冠：${(r.items ?? []).map(i => i.name + (i.level ? `（${i.level}）` : '')).join('')}` : `（${r.kind}）${r.text ?? ''}`)
  if (key === 'panels') return (v2.panels ?? []).map(r => `${r.label ? r.label + '：' : ''}${r.k === undefined || r.k === null ? (r.text ?? '') : `${r.k}：${r.v ?? ''}`}`)
  if (key === 'constellations') return (v2.constellations ?? []).map(r => `${r.name}${r.text ? '——' + r.text : ''}`)
  if (key === 'teams') return (v2.teams ?? []).map(r => r.kind === 'note' ? `（注）${r.text ?? ''}` : `${r.label ? r.label + '：' : ''}${(r.members ?? []).map(m => m.name + (m.note ? `（${m.note}）` : '')).join(' + ')}${r.text ? (r.members?.length ? ' / ' : '') + r.text : ''}`)
  return []
}

const shadowData = parseShadow()
const results = []
let stable = true
for (const [name, docDoc] of shadowData.map) {
  const realFile = path.join(giDir, `${name}.json`)
  if (!fs.existsSync(realFile)) { results.push({ name, kind: 'jsonOnly' }); continue }
  const real = readJson(realFile)
  const item = { name, docExtra: [], jsonExtra: [], fieldDiff: [], noteConv: [] }
  for (const key of SECTIONS) {
    if (eq(docDoc.v2?.[key] ?? null, real.v2?.[key] ?? null)) continue
    const a = rowsOf(docDoc, key).map(s => s.trim())
    const b = rowsOf(real, key).map(s => s.trim())
    const setA = new Set(a); const setB = new Set(b)
    const onlyDoc = a.filter(x => !setB.has(x))
    const onlyReal = b.filter(x => !setA.has(x))
    // 把「note 行」单独挑出来（并发任务的改造）
    const onlyRealNote = onlyReal.filter(x => x.startsWith('（注）'))
    const onlyRealOther = onlyReal.filter(x => !x.startsWith('（注）'))
    const onlyDocOther = onlyDoc.filter(x => !x.startsWith('（注）'))
    if (onlyDocOther.length) item.docExtra.push({ section: key, lines: onlyDocOther })
    if (onlyRealOther.length) item.jsonExtra.push({ section: key, lines: onlyRealOther })
    if (onlyRealNote.length) item.noteConv.push({ section: key, lines: onlyRealNote })
    // 同一行两边都有但内部字段不同（如 note 差异）
    if (!onlyDocOther.length && !onlyRealOther.length && !onlyRealNote.length) item.fieldDiff.push({ section: key, doc: a, real: b })
  }
  if (item.docExtra.length || item.jsonExtra.length || item.fieldDiff.length || item.noteConv.length) results.push(item)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ results, stdout: shadowData.stdout }, null, 2))
} else {
  console.log(`对比完成：文档 ${shadowData.map.size} 个角色 vs 库 ${fs.readdirSync(giDir).filter(f => f.endsWith('.json') && !f.startsWith('_')).length} 个`)
  console.log(`有差异的角色：${results.length} 个`)
  for (const r of results) {
    console.log(`\n=== ${r.name} ===`)
    if (r.kind === 'jsonOnly') { console.log('  （只在数据库里，文档没有这个角色块）'); continue }
    for (const x of r.docExtra) { console.log(`  [文档有·库没有] ${SECTION_CN[x.section]}`); for (const l of x.lines) console.log(`      ${l}`) }
    for (const x of r.jsonExtra) { console.log(`  [库有·文档没有] ${SECTION_CN[x.section]}`); for (const l of x.lines) console.log(`      ${l}`) }
    for (const x of r.noteConv) { console.log(`  [并发改造·note 行] ${SECTION_CN[x.section]}：${x.lines.join(' ')}`) }
    for (const x of r.fieldDiff) { console.log(`  [字段级差异] ${SECTION_CN[x.section]}`); console.log(`      文档：${JSON.stringify(x.doc)}`); console.log(`      库　：${JSON.stringify(x.real)}`) }
  }
}
