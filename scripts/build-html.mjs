/**
 * 由 JSON 数据生成网页版 guide.html
 *
 * 数据源：data/<gameId>/<角色名>.json（字段规范见 README）
 * 页面外壳：templates/guide.html（样式与页头，含 <!--{{CARDS}}--> 占位）
 * 输出：仓库根目录的 guide.html —— **该文件由本脚本生成，不要手改**
 *
 * 用法：node scripts/build-html.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, 'data')
const templateFile = path.join(root, 'templates/guide.html')
const outputFile = path.join(root, 'guide.html')

/** 值是否为空（空串、只有占位符 ___、或只剩标点）：网页版不渲染这类待补栏位 */
function isBlank (text) {
  const s = String(text ?? '').trim()
  if (!s) return true
  if (s.includes('___')) return true
  // 去掉「标签：」「标签——」前缀后还有没有实际内容（「第二档：」这类待补栏位算空）
  const rest = s.replace(/^[^：:—]{1,8}[：:—]+/, '').trim()
  if (!rest) return true
  return /^[_\-—·、/：:（）()]+$/.test(rest)
}

/** 行内文本转义（数据是纯文本，标签由本脚本生成） */
function escapeHtml (text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 行内强调：**文字** → span.must，==文字== → span.highlight
 * @param {string} text
 * @returns {string} 已转义的 HTML 片段
 */
function inline (text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<span class="must">$1</span>')
    .replace(/==([^=]+)==/g, '<span class="highlight">$1</span>')
}

/** 标签既接受字符串，也接受 {text, style} */
function tagOf (tag) {
  if (typeof tag === 'string') return { text: tag, style: '' }
  return { text: String(tag?.text ?? ''), style: String(tag?.style ?? '') }
}

/**
 * 读取 JSON（容忍编辑器写入的 UTF-8 BOM：Node 的 JSON.parse 不接受 BOM）
 * @param {string} file
 * @returns {object}
 */
function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/**
 * 读取某游戏的卡片顺序表（data/<gameId>/_order.json，缺省按角色名排序）
 * @param {string} dir
 * @returns {string[]}
 */
function readOrder (dir) {
  try {
    const data = readJson(path.join(dir, '_order.json'))
    const list = Array.isArray(data) ? data : (Array.isArray(data?.order) ? data.order : [])
    return list.map(name => String(name))
  } catch {
    return []
  }
}

/**
 * 是否为空档：只有六个栏位标题、没有任何内容（新增角色待补充时的占位）
 * @param {object} data
 * @returns {boolean}
 */
function isEmptyCharacter (data) {
  const hasTags = Array.isArray(data.tags) && data.tags.length > 0
  const hasHighlight = Boolean(data.highlight)
  const hasLines = (data.sections || []).some(s => Array.isArray(s.lines) && s.lines.some(line => !isBlank(line)))
  return !hasTags && !hasHighlight && !hasLines
}

/** 上次列出时跳过的空档角色（供命令行提示） */
export const skippedEmpty = []

/**
 * 列出 data/<gameId>/*.json（跳过 `_` 前缀的元数据文件与没有内容的空档角色）
 * @returns {Array<{game: string, name: string, data: object, dir: string}>}
 */
export function listCharacters () {
  const out = []
  skippedEmpty.length = 0
  let games = []
  try {
    games = fs.readdirSync(dataDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => e.name)
  } catch {
    return out
  }
  for (const game of games.sort((a, b) => a.localeCompare(b))) {
    const dir = path.join(dataDir, game)
    const order = readOrder(dir)
    const chars = []
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue
      const data = readJson(path.join(dir, file))
      const name = data.name || path.basename(file, '.json')
      // 空档角色（新增待补）不进网页版，避免出现整页空卡片
      if (isEmptyCharacter(data)) {
        skippedEmpty.push(name)
        continue
      }
      chars.push({ game, name, data, dir })
    }
    const rank = (char) => {
      const i = order.indexOf(char.name)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    chars.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    out.push(...chars)
  }
  return out
}

/**
 * 段落配图路径：数据里相对 JSON 文件，页面里相对仓库根目录
 * @param {string} dir - JSON 文件所在目录
 * @param {string} image
 * @returns {string} 仓库根目录下的相对路径（POSIX 分隔）
 */
function imageSrc (dir, image) {
  if (!image) return ''
  return path.relative(root, path.resolve(dir, image)).split(path.sep).join('/')
}

/**
 * 渲染段落正文：lines / items / fields 三选一，可附 image
 * @param {object} section
 * @param {number} indent - 行首缩进
 * @param {string} dir - JSON 文件所在目录
 * @returns {string} HTML
 */
function renderBody (section, indent, dir) {
  const pad = ' '.repeat(indent)
  const lines = []

  if (Array.isArray(section.lines)) {
    const body = section.lines.filter(line => !isBlank(line))
    if (body.length) {
      lines.push(`${pad}<div class="text-block">`)
      lines.push(body.map(line => `${pad}    ${inline(line)}`).join('<br>\n'))
      lines.push(`${pad}</div>`)
    }
  } else if (Array.isArray(section.items)) {
    lines.push(`${pad}<ul class="content-list">`)
    for (const item of section.items) {
      const desc = item.desc ? `<br>${inline(item.desc)}` : ''
      lines.push(`${pad}    <li>${inline(item.name)}${desc}</li>`)
    }
    lines.push(`${pad}</ul>`)
  } else if (Array.isArray(section.fields)) {
    for (const field of section.fields) {
      lines.push(`${pad}<div class="field-line"><span class="field-label">${inline(field.label)}</span>${inline(field.value)}</div>`)
    }
  }

  if (section.image) {
    lines.push(`${pad}<img class="codex-img" src="${escapeHtml(imageSrc(dir, section.image))}"/>`)
  }
  return lines.join('\n')
}

/**
 * 渲染单个角色卡片
 * @param {{name: string, data: object, dir: string}} character
 * @returns {string} HTML
 */
export function renderCard (character) {
  const { name, data, dir } = character
  const out = []
  out.push(`<!-- ================= ${name} ================= -->`)
  out.push(`<div class="guide-card" data-name="${escapeHtml(name)}">`)
  out.push('    <div class="char-header">')
  out.push(`        <div class="char-name">${escapeHtml(name)}</div>`)
  const tags = (data.tags || []).map(tagOf).filter(t => t.text && !isBlank(t.text) && !/：\s*$/.test(t.text))
  if (tags.length) {
    out.push('        <div class="char-tags">')
    for (const tag of tags) {
      out.push(`            <span class="tag${tag.style ? ` ${escapeHtml(tag.style)}` : ''}">${inline(tag.text)}</span>`)
    }
    out.push('        </div>')
  }
  out.push('    </div>')
  if (data.highlight && !isBlank(data.highlight)) {
    out.push('    <div class="text-block" style="margin-bottom:10px; color:#dd6b20;">')
    out.push(`        ${inline(data.highlight)}`)
    out.push('    </div>')
  }
  if (Array.isArray(data.sections) && data.sections.length) {
    out.push('    <div class="grid-2">')
    for (const section of data.sections) {
      out.push('        <div class="section">')
      out.push(`            <div class="section-title">${inline(section.title)}</div>`)
      out.push(renderBody(section, 12, dir))
      out.push('        </div>')
    }
    out.push('    </div>')
  }
  out.push('</div>')
  return out.join('\n')
}

/**
 * 生成完整网页
 * @returns {string} guide.html 内容
 */
export function buildHtml () {
  const template = fs.readFileSync(templateFile, 'utf8')
  const cards = listCharacters().map(renderCard).join('\n\n')
  return template.replace('<!--{{CARDS}}-->', cards)
}

// 直接执行时写入 guide.html
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const html = buildHtml()
  fs.writeFileSync(outputFile, html, 'utf8')
  const rendered = listCharacters().length
  const skipped = skippedEmpty.length
  console.log(`已生成 ${path.relative(root, outputFile)}（${rendered} 个角色${skipped ? `，跳过 ${skipped} 个空档` : ''}）`)
}
