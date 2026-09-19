
import fs from 'node:fs'
const [file, out] = process.argv.slice(2)
const src = fs.readFileSync("D:\\文件\\游戏\\原神\\Character-Codex-Data\\scripts\\editor.mjs", 'utf8')
const mod = await import("file:///D:/%E6%96%87%E4%BB%B6/%E6%B8%B8%E6%88%8F/%E5%8E%9F%E7%A5%9E/Character-Codex-Data/scripts/_rt-editor-mod.mjs")
const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
// 模拟编辑器真正提交的 body：只带表单认识的字段（与 resources/editor/app.js 的 buildBody 一致）
const v2 = data.v2 ?? {}
const body = {
  kindOf: null,
  weapons: (v2.weapons ?? []).map(r => r.kind === 'note'
    ? { kind: 'note', text: r.text }
    : { label: r.label, tier: r.tier, sep: r.sep, items: (r.items ?? []).map(it => ({ name: it.name, note: it.note, level: it.level, ref: it.ref })) }),
  artifacts: (v2.artifacts ?? []).map(r => {
    if (r.kind === 'note') return { kind: 'note', text: r.text }
    if (r.kind === 'main') return { kind: 'main', note: r.note, stats: r.stats }
    if (r.kind === 'sub') return { kind: 'sub', stats: r.stats, sep: r.sep }
    if (r.kind === 'text') return { kind: 'text', label: r.label, text: r.text }
    return { kind: r.kind, label: r.label, sep: r.sep, sets: (r.sets ?? []).map(s => ({ name: s.name, ref: s.ref, pieces: s.pieces })) }
  }),
  talents: (v2.talents ?? []).map(r => {
    if (r.kind === 'note') return { kind: 'note', text: r.text }
    if (r.kind === 'priority') return { kind: 'priority', order: (r.order ?? []).map(t => ({ name: t.name, ref: t.ref })) }
    return { kind: 'crown', items: (r.items ?? []).map(t => ({ name: t.name, level: t.level, ref: t.ref })) }
  }),
  panels: (v2.panels ?? []).map(r => r.kind === 'note' ? { kind: 'note', text: r.text } : { label: r.label, k: r.k, v: r.v, text: r.text }),
  constellations: (v2.constellations ?? []).map(r => r.kind === 'note' ? { kind: 'note', text: r.text } : { name: r.name, index: r.index, text: r.text }),
  teams: (v2.teams ?? []).map(r => r.kind === 'note'
    ? { kind: 'note', text: r.text }
    : { label: r.label, members: (r.members ?? []).map(m => ({ name: m.name, note: m.note, ref: m.ref })), text: r.text })
}
const norm = mod.normalizeV2(mod.mergeV2(body, data.v2))
const built = mod.buildCharacter({ meta: data.meta, v2: norm, unparsed: data.unparsed }, data.name, data)
fs.writeFileSync(out, JSON.stringify(built, null, 2) + '\n', 'utf8')
