/**
 * 网页版结构体检：确认 guide.html 里 129 张卡片
 *   - 六模块（1武器 / 2圣遗物 / 3天赋 / 4面板 / 5命座 / 6配队，顺序沿用文档的
 *     `1..6` 编号，即「毕业面板参考」在「命座推荐」之前）齐全且顺序固定
 *   - 空模块用「暂无」占位（不是整块消失）
 *   - 没有旧写法残留（第一档 / 首选： / 皇冠： / 中文序命座标签 / 半角 `/` 档位分隔符）
 *
 * 用法：node scripts/audit-guide-html.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(path.resolve(here, '..'), 'guide.html')
const html = fs.readFileSync(file, 'utf8')

const cards = [...html.matchAll(/<div class="guide-card" data-name="([^"]+)">([\s\S]*?)(?=<div class="guide-card"|<\/body>)/g)]
/**
 * 模块顺序 = **文档里 `1..6` 的编号顺序（保持现状）**：
 *   武器 → 圣遗物 → 天赋 → 毕业面板 → 命座 → 配队（面板在命座**之前**）
 */
const EXPECT = '1武器,2圣遗物,3天赋,4面板,5命座,6配队'
const problems = []
let emptyTotal = 0
const leftover = { 档位词: 0, 皇冠行: 0, 首选标签: 0, 中文序命座: 0, 半角斜杠分隔符: 0 }

for (const [, name, body] of cards) {
  const titles = [...body.matchAll(/<span class="section-badge">(\d)<\/span>([^<]*)</g)].map(m => m[1] + m[2].trim())
  if (titles.join(',') !== EXPECT) problems.push(`${name}：模块 ${titles.join(',') || '（无）'}`)
  const empty = (body.match(/class="section-empty-text"/g) || []).length
  emptyTotal += empty
  if (empty > 6) problems.push(`${name}：暂无占位 ${empty} > 6`)

  const count = (re) => (body.match(re) || []).length
  leftover.档位词 += count(/<span class="row-label[^"]*">第[一二三四五六]档</g)
  leftover.皇冠行 += count(/<span class="row-label[^"]*">皇冠</g)
  leftover.首选标签 += count(/<span class="row-label[^"]*">(?:首选|其他|次选)</g)
  leftover.中文序命座 += count(/<span class="row-label[^"]*">[一二三四五六]命</g)
  // 半角 `/` 只检查**该用 ＞ 的地方**（副词条行）；
  // 命座说明里的「提升攻击力 / 精通」是正文内容，不是档位分隔符，不算残留
  for (const m of body.matchAll(/<div class="row[^"]*"><span class="row-label[^"]*">副词条<\/span>([\s\S]*?)<\/div>/g)) {
    leftover.半角斜杠分隔符 += (m[1].match(/<span class="sep">\/<\/span>/g) || []).length
  }
}
const leftTotal = Object.values(leftover).reduce((a, b) => a + b, 0)

console.log(`guide.html：${cards.length} 张卡片，暂无占位 ${emptyTotal} 个`)
console.log(`残留旧写法：${JSON.stringify(leftover)}（合计 ${leftTotal}）`)
console.log(`文件大小 ${fs.statSync(file).size} 字节`)
if (problems.length) {
  console.log(`\n问题 ${problems.length} 条：`)
  for (const p of problems.slice(0, 20)) console.log('  · ' + p)
  process.exitCode = 1
} else if (leftTotal) {
  console.log('\n存在旧写法残留')
  process.exitCode = 1
} else {
  console.log('\n体检通过：六模块齐全、暂无占位正常、无旧写法残留')
}
