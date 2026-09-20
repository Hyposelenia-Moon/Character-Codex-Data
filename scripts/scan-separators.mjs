/**
 * 全库扫描：派生文本（`sections`）里的悬挂 / 重复分隔符，以及**副词条同级对**的口径
 *
 * 检查每一行：
 *   - ` / / `、` /  / `、` > > `、` ≥ ≥ ` 这类连续分隔符（中间只剩空白 = 空条目）
 *   - 行首悬挂（`：/ `、`：> `、`：+ `）与行尾悬挂（` / `、` > `、` + ` 结尾）
 *   - **副词条里 `/` 只允许出现在「暴击率 / 暴击伤害」之间**（用户定稿：
 *     只有暴击和爆伤是等价的，其他都是大于）—— 非暴击对用 `/` 会被显示层当成「同级」渲染成 `=`，
 *     所以这里当错误拦下来。
 *
 * 用法：node scripts/scan-separators.mjs [--json]
 *   退出码：有悬挂分隔符或非法同级对 → 1，没有 → 0
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))

/** 连续分隔符：中间只有空白（空条目）。`=` / `+` 不参与 —— 它们可能是正文里的等号或「2200+」 */
const DOUBLED_RE = /(?:[>＞]|≥|\/)(?:\s*(?:[>＞]|≥|\/))/
/** 行首悬挂：冒号后直接跟分隔符 */
const LEADING_RE = /[:：]\s*(?:[>＞]|≥|\/)(?:\s|$)/
/** 行尾悬挂：以分隔符结尾（`+` 排除 —— 「攻击力：2200+」是合法写法） */
const TRAILING_RE = /(?:[>＞]|≥|\/)\s*$/

const hits = []
const critHits = []
/** 名字里含条目分隔符（`/`、`／`、`｜`）的条目 —— 这类名字写回文档后再解析会被切成两条 */
const nameHits = []
/**
 * 主词条 / 副词条里**括注没写在值末尾**（`防御力（华馆）x` 这种）。
 * 用户定稿：括注统一写在值里、且只跟在**那个值的末尾**（`防御力（特殊）`）；
 * 出现在中间会被部位/档位分隔符逻辑切开，文档与数据就会漂移。**只警告，不影响退出码**。
 */
const parenHits = []
/** 显示后仍是「暴击率 / 暴击伤害」这一对？ */
const isCritPair = (a, b) => {
  const x = String(a ?? '').trim()
  const y = String(b ?? '').trim()
  return (x === '暴击率' && y === '暴击伤害') || (x === '暴击伤害' && y === '暴击率')
}
/** 副词条行：把 `/` 两侧的词条取出来，非暴击对就是非法同级 */
const SUB_RE = /^副词条\s*[:：]\s*(.*)$/
const checkSubCritOnly = (line, name, section) => {
  const m = line.match(SUB_RE)
  if (!m) return
  // 按 `/` 切开；每个片段再按 `>`/`≥` 切，取**紧贴 `/` 的那一个词条**当左右两侧
  const pieces = m[1].split(/[/／]/)
  for (let i = 0; i < pieces.length - 1; i++) {
    const left = String(pieces[i]).split(/[>＞≥]/).pop()
    const right = String(pieces[i + 1]).split(/[>＞≥]/)[0]
    if (!isCritPair(left, right)) {
      critHits.push({ character: name, section, left: String(left).trim(), right: String(right).trim(), line })
    }
  }
}
const files = fs.readdirSync(giDir).filter(f => f.toLowerCase().endsWith('.json') && !f.startsWith('_')).sort()
let lines = 0
for (const f of files) {
  const name = f.slice(0, -'.json'.length)
  const d = readJson(path.join(giDir, f))
  for (const sec of d.sections ?? []) {
    for (const line of sec.lines ?? []) {
      lines++
      const kinds = []
      if (DOUBLED_RE.test(line)) kinds.push('连续分隔符')
      if (LEADING_RE.test(line)) kinds.push('行首悬挂')
      if (TRAILING_RE.test(line)) kinds.push('行尾悬挂')
      if (kinds.length) hits.push({ character: name, section: sec.title, line, kinds })
      checkSubCritOnly(line, name, sec.title)
    }
  }
  // 名字里含分隔符（武器条目 / 套装名）：写回文档会被切成两条 → 往返不一致
  for (const w of (d.v2?.weapons ?? [])) {
    for (const it of (w.items ?? [])) {
      const nm = String(it?.name ?? '')
      if (/[/／｜]/.test(nm)) nameHits.push(`${name} 武器「${nm}」`)
    }
  }
  for (const a of (d.v2?.artifacts ?? [])) {
    for (const st of (a.sets ?? [])) {
      const nm = String(st?.name ?? '')
      if (/[/／｜]/.test(nm)) nameHits.push(`${name} 套装「${nm}」`)
    }
    // 主词条 / 副词条：括注必须在**值末尾**（`防御力（特殊）`）
    const lists = a.kind === 'main' ? Object.values(a.stats ?? {})
      : (a.kind === 'sub' ? [a.stats ?? []] : [])
    for (const list of lists) {
      for (const v of list) {
        const s = String(v ?? '')
        if (!/[（(]/.test(s)) continue
        if (!/^(.*?)\s*[（(]([^（()）]+)[）)]\s*$/.test(s)) parenHits.push(`${name} ${a.kind} 「${s}」`)
      }
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ characters: files.length, lines, hits, critHits }, null, 2))
} else {
  console.log(`扫描 ${files.length} 个角色 / ${lines} 行派生文本（sections）`)
  if (!hits.length) {
    console.log('悬挂 / 重复分隔符：0 处 ✅')
  } else {
    console.log(`悬挂 / 重复分隔符：${hits.length} 处`)
    for (const h of hits.slice(0, 40)) console.log(`  · ${h.character} ${h.section} [${h.kinds.join('+')}] ${h.line}`)
  }
  if (!critHits.length) {
    console.log('副词条非法同级对（`/` 只许出现在 暴击率 / 暴击伤害 之间）：0 处 ✅')
  } else {
    console.log(`副词条非法同级对：${critHits.length} 处（应为 0）`)
    for (const h of critHits.slice(0, 20)) console.log(`  · ${h.character ?? ''} 「${h.left} / ${h.right}」 ${h.line}`)
  }
  // 名字里含分隔符：**只警告不影响退出码**（往返问题诊断脚本 diagnose-docx-json 会直接标出来）
  if (!nameHits.length) {
    console.log('名字里含条目分隔符（/ ／ ｜）的条目：0 处 ✅')
  } else {
    console.log(`[!] 名字里含条目分隔符的条目：${nameHits.length} 处（写回文档会被切成两条 → 往返不一致）`)
    for (const h of nameHits.slice(0, 20)) console.log(`  · ${h}`)
  }
  if (!parenHits.length) {
    console.log('主词条 / 副词条括注位置（只许在值末尾）：0 处问题 ✅')
  } else {
    console.log(`[!] 括注没写在值末尾的：${parenHits.length} 处（会被分隔符逻辑切开 → 文档与数据漂移）`)
    for (const h of parenHits.slice(0, 20)) console.log(`  · ${h}`)
  }
}
process.exit(hits.length || critHits.length ? 1 : 0)
