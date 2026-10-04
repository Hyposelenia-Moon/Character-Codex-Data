/**
 * 全库扫描：派生文本（`sections`）里的悬挂 / 重复分隔符，以及**副词条同级对**的口径
 *
 * 检查每一行：
 *   - ` / / `、` /  / `、` > > `、` ≥ ≥ ` 这类连续分隔符（中间只剩空白 = 空条目）
 *   - 行首悬挂（`：/ `、`：> `、`：+ `）与行尾悬挂（` / `、` > `、` + ` 结尾）
 *   - **副词条里 `/` 只允许出现在「暴击率 / 暴击伤害」之间**（用户定稿：
 *     只有暴击和爆伤是等价的，其他都是大于）—— 非暴击对用 `/` 会被显示层当成「同级」渲染成 `=`，
 *     所以这里当错误拦下来。
 *   - 主词条行还在用 `note` / `noteSlot` 字段的**当错误拦下来**：那种形状写进 docx 读不回来，
 *     `build-docx` 往返校验不过、「保存并发布」会失败（编辑器保存时已经折进值里了）。
 *   - 同级条数超过上限的（**只提醒**）：武器行最多 4 把、圣遗物档位行最多 3 种带法
 *     （用户定稿 2026-09-30；编辑器里点「＋」已经直接挡下，这里把老数据扫出来）。
 *
 * 用法：node scripts/scan-separators.mjs [--json]
 *   退出码：有悬挂分隔符 / 非法同级对 / 主词条字段写法 → 1，没有 → 0
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const giDir = path.join(root, 'data', 'gi')
const { twoPieceName, isPieceShorthandName } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'schema.mjs')).href)

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
/** 名字里含反斜杠（`A\B\C`）的条目 —— 用户定稿 2026-10-04：`\` 与 `=` 等价，表示**同一档里的
 *  等价候选**，合法写法（渲染层会显示成 `A = B = C`，校验也按部件逐个核对图鉴）。
 *  这里只统计并列出，提醒作者"这是并列候选、不是优先级"，**不影响退出码**。 */
const slashNameHits = []
/**
 * 主词条 / 副词条里**括注没写在值末尾**（`防御力（华馆）x` 这种）。
 * 用户定稿：括注统一写在值里、且只跟在**那个值的末尾**（`防御力（特殊）`）；
 * 出现在中间会被部位/档位分隔符逻辑切开，文档与数据就会漂移。**只警告，不影响退出码**。
 */
const parenHits = []
/**
 * 主词条行还在用 `note` / `noteSlot` 字段的（**硬错误**）。
 *
 * 文档层只有「括注写在值里」这一种形状（`parse-docx` 按用户定稿 2026-09-20 不剥字段），
 * 所以这种写法写进 docx 就再也读不回字段 → `build-docx` 往返校验不过 →「保存并发布」直接失败
 * （用户 2026-09-26 报过）。编辑器保存时已经会折进值里（见 `foldMainNoteIntoStats`），
 * 这里把漏网的老数据扫出来。
 */
const legacyNoteHits = []
/**
 * 同级条数超过上限的（**只提醒，不影响退出码**）。
 *
 * 用户定稿 2026-09-30：武器行同级最多 **4 把**（行头那行「可加入 N 把」是按实际宽度算的软提示，
 * 这里是硬上限）、圣遗物档位行同级最多 **3 种带法**。编辑器点「＋」时已经直接挡下，
 * 这个扫描负责把**老数据**里已经超标的行列出来。
 */
const capHits = []
const WEAPON_ROW_CAP = 4
const ARTIFACT_BUILD_CAP = 3
/**
 * 2+2（`+` 连接的**恰好两条**）里还在写全名的（**只提醒，不影响退出码**）。
 *
 * 用户定稿 2026-09-30：「今后添加 2+2 后自动改为简写，不再写全称」。
 * `parse-docx` / 编辑器保存都会自动改写，所以这里报出来的只剩两种情况：
 *   · 表里没有这个套装的 2 件套写法（`scripts/lib/schema.mjs` 的 `TWO_PIECE_ABBR` 要补一行）；
 *   · 老数据没走过解析 / 保存（编辑器打开保存一次就好）。
 */
const twoPieceHits = []
/** `2X` / `4X` = 圣遗物件数简写（与显示层 `isPieceShorthand` 同口径） */
const pieceShort = (n) => /^[24][^\d\s]/.test(String(n ?? '').trim())
/**
 * 圣遗物档位行的「带法」数 —— 与显示层 `resolveSetItems` 同一口径：
 * `/` 断开两种带法，`+` 只有**两侧都是件数简写**才算同一种带法的 2+2 组合
 * （全套装名之间的 `+` 是同级选项，显示成 `/`，用户 2026-09-20 定稿）。
 * @param {object} row 圣遗物档位行
 * @returns {number}
 */
const artifactBuildCount = (row) => {
  const sets = (row?.sets ?? []).map(s => String(s?.name ?? '').trim()).filter(Boolean)
  if (!sets.length) return 0
  const raw = String(row?.sep ?? '').trim()
  const toks = raw ? raw.split(/\s+/).filter(Boolean) : []
  const at = (i) => toks[i] || toks[toks.length - 1] || '>'
  let n = 1
  for (let i = 1; i < sets.length; i++) {
    const plus = ['+', '＋', '&', '＆'].includes(at(i - 1))
    if (!(plus && pieceShort(sets[i - 1]) && pieceShort(sets[i]))) n++
  }
  return n
}
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
    const named = (w?.items ?? []).filter(it => String(it?.name ?? '').trim())
    if (named.length > WEAPON_ROW_CAP) {
      capHits.push(`${name} 武器第 ${w?.tier ?? '?'} 档：${named.length} 把（上限 ${WEAPON_ROW_CAP}）—— ` +
        named.map(it => String(it.name).trim()).join(' > '))
    }
    for (const it of (w.items ?? [])) {
      const nm = String(it?.name ?? '')
      if (/[/／｜]/.test(nm)) nameHits.push(`${name} 武器「${nm}」`)
      if (nm.includes('\\')) slashNameHits.push(`${name} 武器「${nm}」`)
    }
  }
  for (const a of (d.v2?.artifacts ?? [])) {
    if (['preferred', 'optional', 'transition'].includes(a?.kind)) {
      const builds = artifactBuildCount(a)
      if (builds > ARTIFACT_BUILD_CAP) {
        capHits.push(`${name} 圣遗物 ${a.label || a.kind}：${builds} 种带法（上限 ${ARTIFACT_BUILD_CAP}）—— ` +
          (a.sets ?? []).map(s => String(s?.name ?? '').trim()).filter(Boolean).join(' / '))
      }
      // 2+2 理应写成简写：只看**恰好两条**的 `+` 组合（三条的第三套是 4 件套选项，见 shortenTwoPiece）
      const sets = (a.sets ?? []).map(s => String(s?.name ?? '').trim()).filter(Boolean)
      const raw = String(a.sep ?? '').trim()
      const toks = raw ? raw.split(/\s+/).filter(Boolean) : []
      const at = (i) => String(toks[i] || toks[toks.length - 1] || '>').trim()
      const isPlus = (t) => t === '+' || t === '＋'
      for (let i = 0; i < sets.length; i++) {
        let j = i
        while (j < sets.length - 1 && isPlus(at(j))) j++
        const group = sets.slice(i, j + 1)
        if (group.length === 2 && !group.every(isPieceShorthandName)) {
          const unknown = group.filter(n => !isPieceShorthandName(n) && !twoPieceName(n))
          twoPieceHits.push(unknown.length
            ? `${name} ${a.label || a.kind}：2+2 里有表里没有的套装 ${unknown.map(n => `「${n}」`).join('、')}（补 schema.mjs 的 TWO_PIECE_ABBR）`
            : `${name} ${a.label || a.kind}：2+2 还是全名 ${group.join(' + ')}（打开编辑器保存一次就会变简写）`)
        }
        i = j
      }
    }
    if (a?.kind === 'main' && (a.note !== undefined || a.noteSlot !== undefined)) {
      legacyNoteHits.push(`${name} 主词条 note=${JSON.stringify(a.note)} noteSlot=${JSON.stringify(a.noteSlot)}`)
    }
    for (const st of (a.sets ?? [])) {
      const nm = String(st?.name ?? '')
      if (/[/／｜]/.test(nm)) nameHits.push(`${name} 套装「${nm}」`)
      if (nm.includes('\\')) slashNameHits.push(`${name} 套装「${nm}」`)
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
  if (slashNameHits.length) {
    console.log(`[i] 含反斜杠等价候选的条目：${slashNameHits.length} 处（` +
      '`\\` 与 `=` 等价，表示同一档里的等价候选 —— 渲染层显示为 `A = B = C`，校验按部件逐个核对；' +
      '要改成优先级请用 `/` 或 `>`）')
    for (const h of slashNameHits.slice(0, 10)) console.log(`  · ${h}`)
  }
  if (!parenHits.length) {
    console.log('主词条 / 副词条括注位置（只许在值末尾）：0 处问题 ✅')
  } else {
    console.log(`[!] 括注没写在值末尾的：${parenHits.length} 处（会被分隔符逻辑切开 → 文档与数据漂移）`)
    for (const h of parenHits.slice(0, 20)) console.log(`  · ${h}`)
  }
  if (!legacyNoteHits.length) {
    console.log('主词条 note / noteSlot 字段（应折进值里）：0 处 ✅')
  } else {
    console.log(`主词条还在用 note / noteSlot 字段：${legacyNoteHits.length} 处（写回文档后读不回字段 → 往返失败、「保存并发布」会被挡下）`)
    for (const h of legacyNoteHits.slice(0, 20)) console.log(`  · ${h}`)
  }
  if (!capHits.length) {
    console.log(`同级条数上限（武器 ${WEAPON_ROW_CAP} 把 / 圣遗物 ${ARTIFACT_BUILD_CAP} 种带法）：0 处 ✅`)
  } else {
    console.log(`[!] 同级条数超上限：${capHits.length} 处（编辑器点「＋」会直接挡下，这些是已有的行）`)
    for (const h of capHits.slice(0, 20)) console.log(`  · ${h}`)
  }
  if (!twoPieceHits.length) {
    console.log('2+2 写法（应是 `2X + 2Y` 简写）：0 处 ✅')
  } else {
    console.log(`[!] 2+2 还在写全名：${twoPieceHits.length} 处`)
    for (const h of twoPieceHits.slice(0, 20)) console.log(`  · ${h}`)
  }
}
process.exit(hits.length || critHits.length || legacyNoteHits.length ? 1 : 0)
