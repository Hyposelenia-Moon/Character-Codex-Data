/**
 * 全库扫描：派生文本（`sections`）里的悬挂 / 重复分隔符
 *
 * 检查每一行：
 *   - ` / / `、` /  / `、` > > `、` ≥ ≥ ` 这类连续分隔符（中间只剩空白 = 空条目）
 *   - 行首悬挂（`：/ `、`：> `、`：+ `）与行尾悬挂（` / `、` > `、` + ` 结尾）
 *
 * 用法：node scripts/scan-separators.mjs [--json]
 *   退出码：有悬挂分隔符 → 1，没有 → 0
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
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ characters: files.length, lines, hits }, null, 2))
} else {
  console.log(`扫描 ${files.length} 个角色 / ${lines} 行派生文本（sections）`)
  if (!hits.length) {
    console.log('悬挂 / 重复分隔符：0 处 ✅')
  } else {
    console.log(`悬挂 / 重复分隔符：${hits.length} 处`)
    for (const h of hits.slice(0, 40)) console.log(`  · ${h.character} ${h.section} [${h.kinds.join('+')}] ${h.line}`)
  }
}
process.exit(hits.length ? 1 : 0)
