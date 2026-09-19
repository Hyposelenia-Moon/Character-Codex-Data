/**
 * 一次性生成 LICENSE（PolyForm Noncommercial 1.0.0 官方英文正文 + 中文适用范围头）
 *
 * 英文正文从官方纯文本拉取后**逐字**写入（用于校验与将来重跑）：
 *   https://polyformproject.org/licenses/noncommercial/1.0.0.txt
 *
 * 用法：node scripts/write-license-code.mjs [--check]
 *   --check 只对比现有 LICENSE 的英文正文与官方文本是否逐字一致，不写文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outFile = path.join(root, 'LICENSE')
const OFFICIAL = 'https://polyformproject.org/licenses/noncommercial/1.0.0.txt'

/** 中文适用范围头（与 LICENSE 现有头部逐字一致；末尾是唯一的 ===== 分隔行） */
const HEAD = `Character-Codex-Data — 代码部分许可（非商用）
Code License (Noncommercial)

本仓库的「代码部分」——scripts/ 目录下的全部 Node 脚本（Word→JSON 转换、索引 / 网页 / 文档生成、
图形化编辑器等）、resources/ 目录下的编辑器静态资源（如 resources/editor/*），
以及其它由本仓库维护者编写的程序代码——采用
**PolyForm Noncommercial License 1.0.0**（PolyForm 非商业许可 1.0.0）授权。

官方文本与说明：https://polyformproject.org/licenses/noncommercial/1.0.0

通俗说明（仅供参考，不构成法律文本，一切以本文件下方的官方英文正文为准）：
  - 允许：任何**非商业目的**的使用、修改、分享与再分发。包括个人学习、研究、实验、
    业余爱好项目，以及慈善机构、教育机构、公共研究机构、公共安全 / 卫生机构、
    环保组织、政府机构的使用（详见官方正文 Noncommercial Purposes / Personal Uses /
    Noncommercial Organizations 等节）。
  - 不允许：**商业用途**。以商业应用为目的的使用不在授权范围内，需另行取得授权。
  - 义务：分发时（无论是否修改）必须随附本许可条款或官方 URL，
    并保留下方以 \`Required Notice:\` 开头的版权行。
  - 无担保：软件按「现状」提供，不附带任何明示或默示担保。

Required Notice: Copyright (c) 2026 Hyposelenia-Moon

注意：
  1. 本文件正文为 PolyForm Project 官方发布的 PolyForm Noncommercial License 1.0.0
     英文文本，逐字未改动。官方纯文本：https://polyformproject.org/licenses/noncommercial/1.0.0.txt
     官方页面：https://polyformproject.org/licenses/noncommercial/1.0.0/
     若本文件与官方文本存在任何出入，一律以官方文本为准。
  2. 本仓库的数据与文档部分（data/、templates/、guide.html、guide.md）采用
     CC BY-NC-SA 4.0（署名—非商业性使用—相同方式共享 4.0 国际），见 LICENSE-DATA 文件。
  3. 本仓库根目录的 汉仪文黑-85W.ttf 为商业字体，版权归汉仪字库（北京汉仪创新科技股份有限公司）所有，
     不属于本许可授权的范围，也**不随仓库分发**（已从版本控制移除）。详见 README.md「许可」一节。
  4. 《原神》及其相关名称、图标、游戏内文本与数据，版权归 米哈游 / HoYoverse 所有。
     本仓库为非官方整理，与米哈游 / HoYoverse 无隶属或合作关系；详见 README.md「许可」一节。
  5. 本许可不允许再许可（sublicense）；如需商业授权，请联系仓库维护者。

以下为 PolyForm Noncommercial License 1.0.0 官方英文文本全文（逐字未改动）
The following is the verbatim official text of PolyForm Noncommercial 1.0.0
=======================================================================

`
const checkOnly = process.argv.includes('--check')

/** 从现有文件里取出官方英文正文（第一条 === 分隔线**之后**的全部内容） */
function englishBody (text) {
  const m = String(text).match(/^=+\s*$/m)
  if (!m) return ''
  return text.slice(m.index + m[0].length)
}

async function fetchOfficial () {
  const res = await fetch(OFFICIAL)
  if (!res.ok) throw new Error(`拉取官方文本失败：HTTP ${res.status}`)
  return await res.text()
}

const official = await fetchOfficial()
// 官方正文**原样**写入（不 trimEnd：官方 legalcode.txt 末尾自带一个空行，
// 保留它才能做到「重跑结果与现有文件逐字节相同」）
const content = HEAD + official

if (checkOnly) {
  const cur = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  // 正文比较按行来（忽略行尾空白差异），这样「逐字一致」的判定不受末尾换行影响
  const lines = (s) => String(s).replace(/\r\n/g, '\n').split('\n').map(x => x.replace(/\s+$/, ''))
  const a = lines(englishBody(cur).trim())
  const b = lines(official.trim())
  let diffAt = -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { diffAt = i; break }
  const same = diffAt === -1
  console.log(`官方英文正文：${Buffer.byteLength(official, 'utf8')} 字节，sha1=${crypto.createHash('sha1').update(official).digest('hex').slice(0, 12)}`)
  console.log(`现有 ${path.relative(root, outFile)} 英文正文逐字一致：${same ? '是' : `否（第 ${diffAt + 1} 行起不同）`}`)
  if (!same) {
    console.log(`  现有：${JSON.stringify(a[diffAt] ?? '(缺行)').slice(0, 120)}`)
    console.log(`  官方：${JSON.stringify(b[diffAt] ?? '(多行)').slice(0, 120)}`)
    console.log(`  行数：现有 ${a.length} / 官方 ${b.length}`)
  }
  process.exit(same ? 0 : 1)
}

fs.writeFileSync(outFile, content, 'utf8')
console.log(`已写入 ${path.relative(root, outFile)}（${Buffer.byteLength(content, 'utf8')} 字节）`)
console.log(`官方英文正文：${Buffer.byteLength(official, 'utf8')} 字节，sha1=${crypto.createHash('sha1').update(official).digest('hex').slice(0, 12)}`)
