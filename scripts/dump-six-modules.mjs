/** 打印某个角色在网页版 / 面板模型里的六个模块顺序与文本（验收用） */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK = path.resolve(HERE, '..')
const PLUGIN = process.env.DSH_PLUGIN_DIR ?? 'D:\\文件\\游戏\\原神\\Atlas-Plugin'
const gi = path.join(WORK, 'data', 'gi')

const names = process.argv.slice(2)
const { parseGuideJson } = await import(pathToFileURL(path.join(PLUGIN, 'model/codexIndex/parse.js')).href)
const strip = s => String(s ?? '').replace(/<[^>]*>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()

const web = fs.readFileSync(path.join(WORK, 'guide.html'), 'utf8')
for (const name of names) {
  console.log(`\n================ ${name} ================`)
  // ---- 网页版 ----
  const start = web.indexOf(`<!-- ================= ${name} `)
  const cardAt = web.indexOf('<div class="guide-card"', start)
  const end = web.indexOf('<div class="guide-card"', cardAt + 10)
  const chunk = web.slice(cardAt, end > 0 ? end : cardAt + 20000)
  console.log('--- 网页版 guide.html ---')
  const sections = [...chunk.matchAll(/<div class="section(?: section-empty)?">([\s\S]*?)(?=<div class="section |\n    <\/div>\n<\/div>|$)/g)]
  for (const m of sections) {
    const badge = (m[1].match(/section-badge">(\d)</) || [])[1] ?? ''
    const title = strip((m[1].match(/<\/span>\s*([^<]*)<\/div>/) || [])[1])
    if (!title) continue
    const empty = /section-empty-text/.test(m[1]) ? '暂无' : ''
    const lines = []
    const rows = m[1].split('<div class="row').slice(1)
    for (const row of rows) {
      const label = strip((row.match(/row-label[^"]*">([^<]*)</) || [])[1])
      const items = [...row.matchAll(/<span class="rank-item">([\s\S]*?)<\/span>(?:<span class="sep">([\s\S]*?)<\/span>)?/g)].map(x => strip(x[1]) + (x[2] ? ` ${strip(x[2])} ` : ''))
      const plain = strip((row.match(/<span class="row-value">([\s\S]*?)<\/span>/) || [])[1])
      const note = strip((row.match(/<span class="row-note">([\s\S]*?)<\/span>/) || [])[1])
      const members = [...row.matchAll(/<span class="team-member">([\s\S]*?)<\/span>/g)].map(x => strip(x[1]))
      const body = items.length ? items.join('').replace(/\s+/g, ' ').trim() : (members.length ? members.join(' + ') : plain)
      lines.push(`${label ? (body || note ? label + '：' : label) : ''}${body}${note ? ` ${note}` : ''}`)
    }
    console.log(`[${badge}] ${title}${empty ? '：' + empty : '：' + lines.join(' ｜ ')}`)
  }
  // ---- 面板模型 ----
  const raw = JSON.parse(fs.readFileSync(path.join(gi, `${name}.json`), 'utf8'))
  const card = parseGuideJson(raw, { fileDir: gi, fileName: name })
  console.log('--- 面板模型 Atlas-Plugin ---')
  for (const s of card.sections) {
    if (s.empty) { console.log(`[${s.badge}] ${s.title}：暂无`); continue }
    if (s.type === 'teams') {
      console.log(`[${s.badge}] ${s.title}：` + s.teams.map(t => `${t.tag ? t.tag + '：' : ''}${t.members.map(m => strip(m.name)).join(' + ')}${t.note ? ` ${strip(t.note)}` : ''}`).join(' ｜ '))
      continue
    }
    console.log(`[${s.badge}] ${s.title}：` + s.rows.map(row => {
      const raw = (row.items || []).map(it => strip(it.text) + (it.sepAfter ? ` ${strip(it.sepAfter)} ` : '')).join('').replace(/\s+/g, ' ').trim()
      const body = raw || strip((row.items || []).map(it => it.text || '').join(''))
      const label = strip(row.label)
      if (!body) return label
      return `${label ? label + '：' : ''}${body}`
    }).join(' ｜ '))
  }
}
