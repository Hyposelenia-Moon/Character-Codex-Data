/**
 * 由 JSON 数据生成文档版攻略文本
 *
 * - 默认写出仓库根目录的 guide.md（纯文本，可直接贴进 Word / 飞书）
 * - 加 --docx-dir <目录> 时额外写出 OOXML 片段，供打包成 .docx：
 *     node scripts/build-doc.mjs --docx-dir .tmp-docx
 *     powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; `
 *       [IO.Compression.ZipFile]::CreateFromDirectory('.tmp-docx','攻略.docx')"
 *
 * 数据来源：data/<gameId>/*.json（顺序按 _order.json，未列的排在后面）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data', 'gi')
const outMd = path.join(root, 'guide.md')

/** 空档角色保留的栏位骨架（与原 Word 模板一致） */
const SLOTS = {
  '武器推荐': ['第一档：', '第二档：', '第三档：'],
  '圣遗物推荐': ['首选：', '过渡：', '主词条：时之沙：', '空之杯：', '理之冠：', '副词条：'],
  '天赋加点': ['优先级：', '皇冠：'],
  '毕业面板参考': [],
  '命座推荐': ['二命——', '六命——'],
  '配队推荐': ['首选：', '其他：']
}

const SECTION_TITLES = ['1. 武器推荐', '2. 圣遗物推荐', '3. 天赋加点', '4. 毕业面板参考', '5. 命座推荐', '6. 配队推荐']

/** 行内标记还原成纯文本（**必须** → 必须） */
function plain (text) {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .trim()
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/** 按 _order.json 顺序列出角色，未列出的按名字排在后面 */
function listCharacters () {
  const order = readJson(path.join(dataDir, '_order.json'))
  const byName = new Map()
  for (const file of fs.readdirSync(dataDir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const data = readJson(path.join(dataDir, file))
    byName.set(data.name || path.basename(file, '.json'), data)
  }
  const listed = order.filter(name => byName.has(name))
  const rest = [...byName.keys()].filter(name => !listed.includes(name)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  return [...listed, ...rest].map(name => byName.get(name))
}

/** 空档角色：只有六个栏位标题，没有任何内容 */
function isEmptyCharacter (data) {
  const hasTags = Array.isArray(data.tags) && data.tags.length > 0
  const hasHighlight = Boolean(data.highlight)
  const hasLines = (data.sections || []).some(s => Array.isArray(s.lines) && s.lines.length > 0)
  return !hasTags && !hasHighlight && !hasLines
}

/** 角色 → 文本行数组 */
function renderCharacter (data) {
  const lines = []
  const tags = (data.tags || []).map(t => (typeof t === 'string' ? t : t.text))
  const level = tags.find(t => t.startsWith('建议等级')) || '建议等级：___级'
  const role = tags.find(t => t.startsWith('定位')) || '定位：___'
  const empty = isEmptyCharacter(data)

  lines.push(`${data.name} —— ${level}`)
  lines.push(role)
  lines.push(data.highlight ? plain(data.highlight) : '100级提升：___%')
  lines.push('')

  for (const title of SECTION_TITLES) {
    const section = (data.sections || []).find(s => String(s.title).replace(/^\d+\s*[.、]\s*/, '') === title.replace(/^\d+\s*[.、]\s*/, ''))
    lines.push(title)
    if (section && Array.isArray(section.lines) && section.lines.length) {
      for (const line of section.lines) lines.push(plain(line))
    } else if (empty) {
      for (const slot of SLOTS[title.replace(/^\d+\s*[.、]\s*/, '')] || []) lines.push(slot)
    } else {
      lines.push('（暂无数据）')
    }
    lines.push('')
  }
  return lines
}

/** 生成完整文档文本 */
function buildText () {
  const characters = listCharacters()
  const empty = characters.filter(isEmptyCharacter)
  const filled = characters.length - empty.length

  const out = []
  out.push('赋光之人 · 队伍攻略')
  out.push('')
  out.push(`共 ${characters.length} 名角色：${filled} 名已有内容，${empty.length} 名仅保留栏位待补充。`)
  out.push(`待补充：${empty.map(c => c.name).join('、') || '（无）'}`)
  out.push('')
  out.push('说明：一行一条，`>` / `≥` 表示档位或优先级顺序，`/` 表示并列选项；「必须 / 建议」为皇冠投入建议（只有「可选 / 无需」的不再列出）。')
  out.push('')
  for (const data of characters) {
    out.push('─'.repeat(32))
    out.push(...renderCharacter(data))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/* ---------- OOXML（可选，供打包 .docx） ---------- */
const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function buildDocumentXml (text) {
  const paragraphs = text.split('\n').map(line => {
    const size = line.startsWith('赋光之人') ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''
    const text2 = line === '' ? '' : `<w:r>${size}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
    return `    <w:p>${text2}</w:p>`
  })
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${paragraphs.join('\n')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>
`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`

/* ---------- 执行 ---------- */
const text = buildText()
fs.writeFileSync(outMd, text, 'utf8')
console.log(`已生成 ${path.relative(root, outMd)}（${text.split('\n').length} 行）`)

const docxDirFlag = process.argv.indexOf('--docx-dir')
if (docxDirFlag > -1 && process.argv[docxDirFlag + 1]) {
  const dir = path.resolve(process.argv[docxDirFlag + 1])
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, '_rels'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'word'), { recursive: true })
  fs.writeFileSync(path.join(dir, '[Content_Types].xml'), CONTENT_TYPES, 'utf8')
  fs.writeFileSync(path.join(dir, '_rels', '.rels'), RELS, 'utf8')
  fs.writeFileSync(path.join(dir, 'word', 'document.xml'), buildDocumentXml(text), 'utf8')
  console.log(`已生成 OOXML 片段 → ${dir}（打包命令见脚本头部注释）`)
}
