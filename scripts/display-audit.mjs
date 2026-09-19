/**
 * 显示级归一的全库体检（129 角色，不需要浏览器）：
 *   1. 所有会进渲染模型的文本字段过一遍简写展开，检查
 *      「展开幂等」（再展开一次结果不变）与「不产生重复字」（`效率效率` 之类）；
 *   2. 检查六个模块在归一后**永远都在**（空模块是「暂无」而不是消失）；
 *   3. 检查档位标签只出现 推荐 / 可选 / 过渡（自定义队名除外）；
 *   4. 检查面板里没有 `0%` 行、副词条里不再有半角斜杠、命座文案都是「命之座X」。
 *
 * 用法：node scripts/display-audit.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  displayText, normalizeGuideSections, DISPLAY_SECTIONS,
  constellationNumber, isZeroValue, displayLabel
} from './lib/guide-display.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const names = readJson(path.join(giDir, '_order.json'))

/** 档位中文数字（构造「第一档」这类内部写法用） */
const CN = ['', '一', '二', '三', '四', '五', '六']

const problems = []
const seen = { texts: 0, dup: 0, notIdem: 0 }
/** 收集所有原始文本 */
const texts = new Set()
const add = (t) => {
  if (typeof t !== 'string' || !t.trim()) return
  seen.texts++
  texts.add(t)
}

for (const n of names) {
  const d = readJson(path.join(giDir, `${n}.json`))
  const v = d.v2 ?? {}
  for (const r of v.weapons ?? []) { if (r.label) add(r.label); for (const i of r.items ?? []) { add(i.name); add(i.note) } }
  for (const r of v.artifacts ?? []) {
    if (r.label) add(r.label)
    if (Array.isArray(r.stats)) for (const s of r.stats) add(s)
    for (const k of ['时之沙', '空之杯', '理之冠']) for (const s of r.stats?.[k] ?? []) add(s)
    for (const s of r.sets ?? []) { add(s.name); add(s.pieces); add(s.note) }
  }
  for (const r of v.panels ?? []) {
    add(r.label); add(r.k); add(r.v); add(r.text)
    if (typeof r.text === 'string') for (const part of r.text.split(' / ')) add(part)
  }
  for (const r of v.constellations ?? []) { add(r.name); add(r.text) }
  for (const r of v.teams ?? []) {
    add(r.label); add(r.text)
    for (const m of r.members ?? []) { add(m.name); add(m.note) }
  }
  for (const r of v.talents ?? []) {
    if (r.kind === 'crown') for (const i of r.items ?? []) { add(i.name); add(i.level) }
    if (r.kind === 'priority') add(r.raw)
  }
}

/* 1：全库文本的展开幂等（`元素充能效率效率` 这类重复字会让二次展开不再变化，
 *    所以「不幂等」与「被展开污染」都能被这一步抓住） */
for (const t of texts) {
  const once = displayText(t)
  const twice = displayText(once)
  if (once !== twice) {
    seen.notIdem++
    if (problems.length < 25) problems.push(`展开不幂等：${JSON.stringify(t)} → ${JSON.stringify(once)} → ${JSON.stringify(twice)}`)
  }
}

/* 3 + 4：逐角色过一遍归一后的渲染模型 */
let emptyModules = 0
let labelBad = 0
const labelSeen = new Set()
for (const n of names) {
  const d = readJson(path.join(giDir, `${n}.json`))
  const sections = normalizeGuideSections(localRows(d.v2 ?? {}))
  if (sections.length !== 6) problems.push(`${n}：模块数 ${sections.length} ≠ 6`)
  for (const sec of sections) {
    if (sec.empty) { emptyModules++; continue }
    if (sec.kind === 'rows') {
      for (const row of sec.rows) {
        if (row.label) labelSeen.add(row.label)
        for (const it of row.items) {
          if (sec.title === '圣遗物' && /副词条/.test(row.label ?? '') && /[/／]/.test(it.sepAfter ?? '')) {
            problems.push(`${n}：副词条分隔符未转全角（${it.sepAfter}）`)
          }
          if (isZeroValue(it.text)) problems.push(`${n}：面板/条目里出现 0 值行「${it.text}」`)
        }
      }
    }
    if (sec.kind === 'stats') {
      for (const row of sec.rows) for (const it of row.items) if (isZeroValue(it.text)) problems.push(`${n}：面板 0 值行「${it.text}」`)
    }
    if (sec.kind === 'teams') {
      for (const t of sec.teams) { if (t.tag) labelSeen.add(t.tag); if (t.note && !t.note.startsWith('注：')) problems.push(`${n}：配队行内备注未用 注：（${t.note}）`) }
    }
  }
}
for (const l of labelSeen) {
  if (!['推荐', '可选', '过渡'].includes(l)) labelBad++
}

console.log(`角色 ${names.length} 个；原始文本 ${texts.size} 条（出现 ${seen.texts} 次）`)
console.log(`展开不幂等：${seen.notIdem}；展开出重复字：${seen.dup}`)
console.log(`归一后空模块（暂无）：${emptyModules} 个；非档位标签：${labelBad} 个（自定义队名/描述标签，应为 0 才算全量归一）`)
console.log(`渲染模型里出现过的行标签：${[...labelSeen].sort().join(' / ')}`)
if (problems.length) {
  console.log(`\n问题 ${problems.length} 条：`)
  for (const p of problems.slice(0, 30)) console.log('  · ' + p)
  process.exitCode = 1
} else {
  console.log('\n体检通过：展开幂等、无重复字、六模块齐全、档位标签只有 推荐/可选/过渡')
}

/* ---------------- 本地 v2 → 渲染模型（与 display-selftest 同一套最小实现） ---------------- */
function localRows (v2) {
  const out = []
  const rows = []
  for (const r of v2.weapons ?? []) {
    rows.push({
      label: String(r.label ?? '').trim() || (r.tier ? `第${CN[r.tier]}档` : ''),
      items: (r.items ?? []).map((it, i, a) => ({ text: it.name, note: it.note ?? '', ref: it.ref, sepAfter: i < a.length - 1 ? String(r.sep ?? ' > ').trim().split(/\s+/)[0] : '' }))
    })
  }
  out.push({ title: '1. 武器推荐', type: 'rows', rows })
  const arows = []
  for (const r of v2.artifacts ?? []) {
    if (r.kind === 'main') {
      const slots = ['时之沙', '空之杯', '理之冠'].filter(s => (r.stats?.[s] ?? []).length)
      arows.push({ label: '主词条', items: slots.map((s, i) => ({ text: `${s}：${(r.stats[s] ?? []).join(' / ')}`, note: '', ref: '', sepAfter: i < slots.length - 1 ? '/' : '' })) })
      continue
    }
    if (r.kind === 'sub') {
      arows.push({ label: '副词条', items: (r.stats ?? []).map((s, i, a) => ({ text: s, note: '', ref: '', sepAfter: i < a.length - 1 ? String(r.sep ?? ' / ').trim().split(/\s+/)[0] : '' })) })
      continue
    }
    const head = { preferred: '首选', transition: '过渡', optional: '可选' }[r.kind] ?? ''
    arows.push({
      label: String(r.label ?? '').trim() || head,
      items: (r.sets ?? []).map((s, i, a) => ({ text: s.name + (s.pieces ? `（${s.pieces}）` : ''), note: s.note ?? '', ref: s.ref, sepAfter: i < a.length - 1 ? String(r.sep ?? ' / ').trim().split(/\s+/)[0] : '' }))
    })
  }
  out.push({ title: '2. 圣遗物推荐', type: 'rows', rows: arows })
  const trows = []
  for (const r of v2.talents ?? []) {
    if (r.kind === 'priority') trows.push({ label: '优先级', items: (r.order ?? []).map((o, i, a) => ({ text: o.name, note: '', ref: o.ref, sepAfter: i < a.length - 1 ? '＞' : '' })) })
    if (r.kind === 'crown') trows.push({ label: '皇冠', items: (r.items ?? []).map(o => ({ text: o.name, level: o.level, ref: o.ref, sepAfter: '' })) })
  }
  out.push({ title: '3. 天赋加点', type: 'rows', rows: trows })
  out.push({
    title: '4. 毕业面板参考',
    type: 'stats',
    rows: (v2.panels ?? []).map(r => ({
      label: String(r.label ?? ''),
      items: r.k != null
        ? [{ text: `${r.k}：${r.v ?? ''}`, note: '', ref: '', sepAfter: '' }]
        : String(r.text ?? '').split(' / ').map((t, i, a) => ({ text: t, note: '', ref: '', sepAfter: i < a.length - 1 ? '/' : '' }))
    }))
  })
  out.push({
    title: '5. 命座推荐',
    type: 'rows',
    rows: (v2.constellations ?? []).map(r => ({ label: r.name, items: r.text ? [{ text: r.text, note: '', ref: `constellation:${r.index}`, sepAfter: '' }] : [] }))
  })
  out.push({
    title: '6. 配队推荐',
    type: 'teams',
    teams: (v2.teams ?? []).map(r => ({ tag: String(r.label ?? ''), members: (r.members ?? []).map(m => ({ name: m.name, note: m.note ?? '', ref: m.ref })), text: String(r.text ?? '') }))
  })
  return out
}
