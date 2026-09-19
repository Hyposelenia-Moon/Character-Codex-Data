/**
 * 一次性生成 LICENSE-DATA（CC BY-NC-SA 4.0 官方英文 legalcode 全文 + 中文适用范围头）
 *
 * 英文正文从官方纯文本拉取后**逐字**写入（用于校验与将来重跑）：
 *   https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt
 *
 * 用法：node scripts/write-license-data.mjs [--check]
 *   --check 只对比现有 LICENSE-DATA 的英文正文与官方文本是否逐字一致，不写文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outFile = path.join(root, 'LICENSE-DATA')
const OFFICIAL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt'

/** 中文适用范围头（与 LICENSE-DATA 现有头部逐字一致；末尾是唯一的 ===== 分隔行） */
const HEAD = `Character-Codex-Data — 数据与文档部分许可（非商用）
Data and Documentation License (Noncommercial)

本仓库的「数据与文档部分」——即 data/ 目录下的全部内容（含 data/<gameId>/*.json、
data/<gameId>/_order.json、data/_index.json、图片等）、templates/ 目录，以及由数据生成的
guide.html、guide.md——采用「知识共享 署名—非商业性使用—相同方式共享 4.0 国际」
（Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International，
简称 CC BY-NC-SA 4.0）许可协议授权。

版权声明（Copyright (c) 2026 Hyposelenia-Moon）：本许可仅覆盖本仓库整理者可以主张权利的
「整理、编排、结构化与表述」部分。游戏原始内容（名称、图标、文本、数值等）不在本许可范围内，
其权利仍归原权利人所有。

许可要素摘要（仅供参考，不构成法律文本）：
  - 署名（BY）：转载、改编时必须注明来源（本仓库名 + 仓库链接）与本许可协议。
  - 非商业性使用（NC）：不得用于以商业优势或金钱报酬为主要目的的场景。
  - 相同方式共享（SA）：基于本内容产生的改编作品，必须以相同许可（CC BY-NC-SA 4.0 或兼容许可）发布。

注意：
  1. 本文件正文为 Creative Commons 官方发布的 CC BY-NC-SA 4.0 英文法律文本，逐字未改动。
     官方纯文本：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt
     官方页面：  https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode
     简体中文参考译本：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-Hans
     若本文件与官方文本存在任何出入，一律以官方文本为准。
  2. 本仓库的代码部分（scripts/、resources/）采用 PolyForm Noncommercial License 1.0.0
     （PolyForm 非商业许可 1.0.0），见 LICENSE 文件。
  3. 本仓库根目录的 汉仪文黑-85W.ttf 为**商业字体**，版权归汉仪字库（北京汉仪创新科技股份有限公司）所有，
     不属于本许可授权的范围，也**不随仓库分发**（已从版本控制移除）。使用者需自行获取该字体并放到
     仓库根目录的同名文件，guide.html 才会使用它，否则回退到系统字体。详见 README.md「许可」一节。
  4. 《原神》及其相关名称、图标、游戏内文本与数据，版权归 米哈游 / HoYoverse 所有。
     本仓库为非官方整理，与米哈游 / HoYoverse 无隶属或合作关系；详见 README.md「许可」一节。

以下为 CC BY-NC-SA 4.0 官方英文法律文本全文（逐字未改动）
The following is the verbatim official legal code of CC BY-NC-SA 4.0
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
  console.log(`现有 LICENSE-DATA 英文正文逐字一致：${same ? '是' : `否（第 ${diffAt + 1} 行起不同）`}`)
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
