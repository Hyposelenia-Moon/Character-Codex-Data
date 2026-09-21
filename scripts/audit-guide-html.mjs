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
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const file = path.join(root, 'guide.html')
const html = fs.readFileSync(file, 'utf8')

// ① 卡片数**必须**等于 data/gi 里的角色数（以前只打印不判定：丢卡片也能「体检通过」）
const giDir = path.join(root, 'data', 'gi')
const expectCards = fs.readdirSync(giDir).filter(f => f.endsWith('.json') && !f.startsWith('_')).length

// ② 与**现算**的一份比对：上一次数据改动忘了重建 guide.html 时，这里必须报出来
//    （只查结构与旧写法的旧版审不出来，README 却拿它当 guide.html 的验收证据）
let fresh = null
try {
  const mod = await import(pathToFileURL(path.join(here, 'build-html.mjs')).href)
  fresh = typeof mod.buildHtml === 'function' ? mod.buildHtml() : null
} catch { /* 拿不到现算结果就跳过这一项 */ }

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
  // 中文序命座标签**只检查命座小节**：`一命` 也可能是圣遗物行的**自定义档位词**
  // （莉奈娅：`零命：晨星与月的晓歌` / `一命：华馆梦醒形骸记`，文档里就是这么写的，合法）
  const consSection = (body.match(/<span class="section-badge">5<\/span>[\s\S]*?(?=<span class="section-badge">6<\/span>|$)/) || [''])[0]
  leftover.中文序命座 += (consSection.match(/<span class="row-label[^"]*">[一二三四五六]命</g) || []).length
  // 半角 `/` 只检查**该用 ＞ 的地方**（副词条行）；
  // 命座说明里的「提升攻击力 / 精通」是正文内容，不是档位分隔符，不算残留
  for (const m of body.matchAll(/<div class="row[^"]*"><span class="row-label[^"]*">副词条<\/span>([\s\S]*?)<\/div>/g)) {
    leftover.半角斜杠分隔符 += (m[1].match(/<span class="sep">\/<\/span>/g) || []).length
  }
}
const leftTotal = Object.values(leftover).reduce((a, b) => a + b, 0)

// ③ 卡片数 = data/gi 的角色数
if (cards.length !== expectCards) {
  problems.push(`卡片数 ${cards.length} ≠ data/gi 角色数 ${expectCards}（有角色没进 guide.html？）`)
}

console.log(`guide.html：${cards.length} 张卡片（data/gi ${expectCards} 个），暂无占位 ${emptyTotal} 个`)
console.log(`残留旧写法：${JSON.stringify(leftover)}（合计 ${leftTotal}）`)
if (fresh) {
  const same = fresh === html
  console.log(`与现算结果逐字节一致：${same ? '是 ✅' : '否 ❌（guide.html 落后于数据，跑 node scripts/build-html.mjs）'}`)
  if (!same) problems.push('guide.html 与内存里现算的结果不一致（陈旧）')
} else {
  console.log('与现算结果比对：跳过（build-html 没有导出 buildHtml）')
}
console.log(`文件大小 ${fs.statSync(file).size} 字节`)
if (problems.length) {
  console.log(`\n问题 ${problems.length} 条：`)
  for (const p of problems.slice(0, 20)) console.log('  · ' + p)
  process.exitCode = 1
} else if (leftTotal) {
  console.log('\n存在旧写法残留')
  process.exitCode = 1
} else {
  console.log('\n体检通过：六模块齐全、暂无占位正常、无旧写法残留、与数据同步')
}
