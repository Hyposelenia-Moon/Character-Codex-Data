/**
 * 一次性数据迁移：把**已从文档里删掉的括注**按「备注走廊」的新规则恢复回来。
 *
 * 背景：上一轮把 `（二命）`（配队成员 / 主词条数值）与 `（高金）` 直接从正文里删掉了。
 * 现在改为：正文行保持干净的标准名，括注转移到**所属段落末尾的一行 `注：`**
 * （`v2.*` 数组里的一条 `{kind:'note', text:'…'}`）。
 *
 * 本脚本用**文档历史备份**里的原文作为唯一事实来源，逐条把备注写进 `data/gi/*.json`：
 *   - 主词条行的括注 → `kind:'main'` 的 `note` 字段（它指回具体那个杯/沙/冠，
 *     渲染成 `空之杯：水元素伤害加成（二命）`）；
 *   - 其余段落 → 在段落数组末尾补 `{kind:'note', text}`（渲染成段末 `注：…` 行）。
 *
 * 文档不由本脚本改：JSON 改完后由 `build-docx.mjs --write-main` 重建
 * （它自带 129/129 往返自检 + 幂等自检，比在这里手改 XML 可靠）。
 *
 * 只认**命座 / 成本类**括注：`（二命）`（2命）`（高金）`。`（精五）`（叠满）`（满命）`
 * `（建议/必须/可选）` `（特殊）` `（华馆）` 等一律**不动**（用户明确要求保持现状）。
 *
 * 幂等：目标备注已经在 JSON 里时跳过；跑第二遍输出「恢复 0 条」。
 *
 * 用法：
 *   node scripts/restore-notes.mjs [--backup <docx>] [--dry]
 *   默认 backup：D:\文件\游戏\原神\原神·角色攻略.docx.bak-before-rename
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDocx, SEPARATOR } from './lib/docx.mjs'
import { isCostNoteText, unpolishNoteText, isNoteRow } from './lib/schema.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const DEFAULT_BACKUP = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx.bak-before-rename'

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8')

/** 六个小节的标题行 */
const SECTION_HEAD_RE = /^\d+\.\s*(武器推荐|圣遗物推荐|天赋加点|毕业面板参考|命座推荐|配队推荐)\s*$/
/** 小节标题 → v2 字段名 */
const SECTION_KEY = {
  武器推荐: 'weapons', 圣遗物推荐: 'artifacts', 天赋加点: 'talents',
  毕业面板参考: 'panels', 命座推荐: 'constellations', 配队推荐: 'teams'
}

/** 按分隔段切块（与 parse-docx 一致） */
function splitBlocks (paragraphs) {
  const blocks = []
  let cur = []
  for (const p of paragraphs) {
    if (p === SEPARATOR) { blocks.push(cur); cur = [] } else if (p !== '') cur.push(p)
  }
  if (cur.length) blocks.push(cur)
  return blocks.filter(b => b.length)
}

/**
 * 备份文档里所有「命座 / 成本类括注」，**按行**记录（一行可能有多处）。
 * @returns {Map<string, Array<{section:string, raw:string, line:string}>>} 角色名 → 命中
 */
function scanBackup (paragraphs) {
  const out = new Map()
  for (const block of splitBlocks(paragraphs)) {
    const title = block[0] ?? ''
    const name = title.split('——')[0].trim()
    if (!name || name.startsWith('原神 ·') || name.includes('共 ')) continue
    let section = ''
    for (const text of block) {
      const sec = text.trim().match(SECTION_HEAD_RE)
      if (sec) { section = sec[1]; continue }
      if (!section) continue
      const raws = [...text.matchAll(/[（(]([^（()）]+)[）)]/g)].map(m => m[1]).filter(isCostNoteText)
      if (!raws.length) continue
      const list = out.get(name) ?? []
      // 同一行里的多处括注合并成一条（渲染时也用 `；` 合并成一行）
      list.push({ section, raw: raws.join('；'), line: text })
      out.set(name, list)
    }
  }
  return out
}

/**
 * 备份的主词条行 + 当前 JSON 的主词条行 → 补回「带括注的那个值」与该值属于哪个部位。
 *
 * 上一轮删括注时把整个词条值一起删了（`水元素伤害加成（二命）` → 值从 空之杯 消失），
 * 所以这里要按备份把值补回**它原本所在的部位**（按 `时之沙：… / 空之杯：… / 理之冠：…` 的段落归属）。
 * @returns {{slot: string, value: string} | null}
 */
function mainNoteTarget (line, raw) {
  const seg = line.split(/\s*[/／]\s*/).find(s => s.includes(`（${raw}）`))
  if (!seg) return null
  const before = seg.slice(0, seg.indexOf(`（${raw}）`))
  const value = before.replace(/^.*?[:：]\s*/, '').trim()
  if (!value) return null
  // 这一份属于哪个部位：取它前面最近的那个「时之沙/空之杯/理之冠：」
  const upto = line.slice(0, line.indexOf(seg) + before.length)
  let slot = null
  for (const m of upto.matchAll(/(时之沙|空之杯|理之冠)[:：]/g)) slot = m[1]
  return slot ? { slot, value } : null
}

/**
 * 在 JSON 里补备注。
 * 主词条行 → `kind:'main'` 的 `note` + `noteSlot`；其余段落 → 数组末尾补 `{kind:'note', text}`。
 * @returns {{restored:number, skipped:number}}
 */
function patchJson (hits, dry) {
  let restored = 0
  let skipped = 0
  for (const [name, list] of hits) {
    const file = path.join(giDir, `${name}.json`)
    if (!fs.existsSync(file)) { console.log(`  ⚠ 没有 JSON：${name}`); continue }
    const data = readJson(file)
    let dirty = false
    for (const h of list) {
      const key = SECTION_KEY[h.section]
      const rows = data.v2?.[key]
      if (!rows) continue
      // 原始括注先还原（`（2命）` 原样保留「2命」，不强行改成「二命」）
      const raws = h.raw.split('；').map(x => unpolishNoteText(x)).filter(Boolean)
      const mainArtifact = h.section === '圣遗物推荐' && /主词条/.test(h.line)
      if (mainArtifact) {
        const idx = rows.findIndex(r => r.kind === 'main')
        if (idx < 0) continue
        const main = rows[idx]
        if (main.note) { skipped++; continue }
        const target = mainNoteTarget(h.line, h.raw)
        const slot = target?.slot ?? null
        // 值也被删掉过（`水元素伤害加成（二命）`）→ 按备份补回原部位，且不再与已有值重复
        const stats = { ...main.stats }
        if (target && slot && !(stats[slot] ?? []).includes(target.value)) {
          stats[slot] = [...(stats[slot] ?? []), target.value]
        }
        // 字段顺序固定成 kind, note, [noteSlot], stats（与 parse-docx 落盘写法一致）
        rows[idx] = { kind: 'main', note: raws[0], ...(slot ? { noteSlot: slot } : {}), stats }
        dirty = true
        restored++
        continue
      }
      for (const raw of raws) {
        if (rows.some(r => isNoteRow(r) && String(r.text).trim() === raw)) { skipped++; continue }
        rows.push({ kind: 'note', text: raw })
        dirty = true
        restored++
      }
    }
    if (dirty && !dry) writeJson(file, data)
  }
  return { restored, skipped }
}

/**
 * 顺手清掉历史遗留的**测试数据**（用户要求文档与 JSON 里不再出现测试串）。
 * 目前只有 `旅行者·火` 的「第四档：测试武器」这一条是手工测试留下的假数据。
 * @returns {number} 清掉的条目数
 */
function dropTestRows (dry) {
  let n = 0
  for (const f of fs.readdirSync(giDir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    const file = path.join(giDir, f)
    const data = readJson(file)
    let dirty = false
    for (const key of ['weapons', 'artifacts', 'talents', 'panels', 'constellations', 'teams']) {
      const rows = data.v2?.[key]
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        for (const listKey of ['items', 'sets', 'members']) {
          if (!Array.isArray(row[listKey])) continue
          const kept = row[listKey].filter(it => !String(it?.name ?? '').includes('测试'))
          if (kept.length !== row[listKey].length) { n += row[listKey].length - kept.length; row[listKey] = kept; dirty = true }
        }
      }
      // 清空后整行没内容了（如「第四档：测试武器」）→ 连行一起删，别留空档
      const pruned = rows.filter(r => {
        if (r.kind === 'note' || r.kind === 'main' || r.kind === 'sub' || r.kind === 'text') return true
        if (Array.isArray(r.items)) return r.items.length > 0
        if (Array.isArray(r.sets)) return r.sets.length > 0
        if (Array.isArray(r.members)) return r.members.length > 0 || String(r.text ?? '').trim() !== ''
        return true
      })
      if (pruned.length !== rows.length) { dirty = true; data.v2[key] = pruned }
    }
    if (dirty && !dry) writeJson(file, data)
  }
  return n
}

function main () {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  const i = argv.indexOf('--backup')
  const backup = i >= 0 ? argv[i + 1] : DEFAULT_BACKUP
  if (!fs.existsSync(backup)) { console.error(`找不到备份文档：${backup}`); process.exitCode = 1; return }

  const dropped = dropTestRows(dry)
  if (dropped) console.log(`清理测试条目：${dropped} 条`)

  const hits = scanBackup(readDocx(backup).paragraphs)
  const total = [...hits.values()].reduce((n, l) => n + l.length, 0)
  const bySection = {}
  for (const l of hits.values()) for (const h of l) bySection[h.section] = (bySection[h.section] ?? 0) + 1
  console.log(`扫描备份：${backup}`)
  console.log(`带命座/成本括注的角色 ${hits.size} 个 / ${total} 行（${Object.entries(bySection).map(([s, n]) => `${s} ${n}`).join('，')}）`)
  for (const [name, list] of hits) console.log(`  · ${name}：${list.map(h => `${h.section} ${h.raw}`).join('；')}`)

  const { restored, skipped } = patchJson(hits, dry)
  console.log(`data/gi：恢复备注 ${restored} 条${skipped ? `，已有 ${skipped} 条（跳过）` : ''}${dry ? '（--dry 未写文件）' : ''}`)
  if (!dry) console.log('下一步：node scripts/parse-docx.mjs && node scripts/build-docx.mjs --write-main')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
