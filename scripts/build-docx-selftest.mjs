/**
 * build-docx 的文档重建自检（审核 #11：DOCX 重建丢失正文末尾的节属性）
 *
 * 只测纯函数 `rebuildDocumentXml(xml, lines)`：**不需要真实 docx 文件**，
 * 全部用内存里的 document.xml 字符串造 fixture（避免往仓库里塞二进制样本）。
 *
 * 覆盖：
 *   ① 写法 A（Word 常规：`<w:sectPr>` 挂在 body 末尾）→ 产物的
 *      pgSz / pgMar / cols / docGrid **逐字保留**，且数量与模板相等、且 > 0；
 *   ② 写法 B（`<w:sectPr>` 嵌在最后一段的 `<w:pPr>` 里）+ `lines.length < 模板段数`
 *      → 被截断的 shell 里的节属性仍作为正文级 sectPr 保留；
 *   ③ 两种极端：`lines.length > 模板段数`、`lines.length === 模板段数` 都正常；
 *   ④ 连续重建两次 → document.xml 逐字节相同（幂等）；
 *   ⑤ 模板本来没有 sectPr → 产物也没有、且不报错；
 *   ⑥ 缺 `</w:body>` / 模板没有段落 → 抛人话错误，不静默产出坏 XML。
 *
 * ⚠ 断言里**必须**有一条要求节属性数量 > 0：
 *   当前主文档的 sectPr 数量是 0（历史上真的丢过一次），只比「相等」会得到「0 == 0」的假通过。
 *
 * 跑法：node scripts/build-docx-selftest.mjs
 * 退出码：全通过 0，有失败 1。
 */
import { rebuildDocumentXml } from './build-docx.mjs'

/* ------------------------------------------------------------------ *
 * fixture 工具：内存里拼最小可用的 document.xml
 * ------------------------------------------------------------------ */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** 一套节属性：页面尺寸 / 页边距 / 分栏 / 文档网格（Word 正文级 sectPr 的常见内容） */
const SAMPLE_SECTPR = [
  '<w:sectPr>',
  '<w:pgSz w:w="11906" w:h="16838"/>',
  '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>',
  '<w:cols w:num="1" w:space="425"/>',
  '<w:docGrid w:type="lines" w:linePitch="312"/>',
  '</w:sectPr>'
].join('')

/**
 * 造一段正文
 * @param {string} text 段落文本
 * @param {string} [pPrInner] 塞进 `<w:pPr>` 里的内容（写法 B 用它放 sectPr）
 * @returns {string}
 */
const para = (text, pPrInner) =>
  pPrInner === undefined
    ? `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
    : `<w:p><w:pPr>${pPrInner}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

/**
 * 造一份 document.xml（含 xml 声明，与真实模板形状一致）
 * @param {string[]} paras 段落 XML 块
 * @param {{bodySectPr?: string, closeBody?: boolean}} [opts]
 *   bodySectPr：写法 A 的正文级节属性（挂在 body 末尾）；closeBody=false 模拟缺 `</w:body>`
 * @returns {string}
 */
function mkDoc (paras, { bodySectPr = '', closeBody = true } = {}) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + `<w:document ${W_NS}><w:body>`
    + paras.join('')
    + bodySectPr
    + (closeBody ? '</w:body>' : '')
    + '</w:document>'
}

/** 抠出某个自闭合标签的**逐字**写法（用于 pgSz / pgMar / cols / docGrid 的严格比较） */
const tagsOf = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}\\b[^>]*?/>`, 'g'))].map(m => m[0])
/** 某个标签出现次数 */
const countOf = (xml, tag) => tagsOf(xml, tag).length
/** sectPr 出现次数（容器标签，不能用自闭合匹配） */
const sectCount = xml => (String(xml).match(/<w:sectPr\b/g) || []).length
/** 段落块个数 */
const paraCount = xml => (String(xml).match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || []).length
/** 去掉全部段落后的 body 内部内容（用来看「正文级」非段落内容还在不在） */
const bodyOnly = xml => {
  const s = String(xml)
  const from = s.indexOf('<w:body>') + '<w:body>'.length
  const to = s.lastIndexOf('</w:body>')
  return s.slice(from, to < 0 ? undefined : to).replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, '')
}

/** 期望抛错的调用：返回错误信息，没抛错则返回 null */
function catchError (fn) {
  try {
    fn()
    return null
  } catch (e) {
    return String(e?.message ?? e)
  }
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

const checks = []
const push = (what, got, want) => checks.push({ what, got, want, ok: JSON.stringify(got) === JSON.stringify(want) })
/** 四类节属性标签（页面尺寸 / 页边距 / 分栏 / 文档网格） */
const SECT_TAGS = ['w:pgSz', 'w:pgMar', 'w:cols', 'w:docGrid']

/* ① 写法 A：正文级 sectPr 挂在 body 末尾（最后一个段落之后），lines 少于模板段数 */
{
  const tpl = mkDoc([para('甲'), para('乙'), para('丙')], { bodySectPr: SAMPLE_SECTPR })
  const lines = ['新一', '新二']
  const r = rebuildDocumentXml(tpl, lines)
  const out = r.xml

  SECT_TAGS.forEach(tag => {
    push(`写法A：${tag} 逐字保留（数量=模板）`, tagsOf(out, tag), tagsOf(tpl, tag))
  })
  // ⚠ 主文档当前 sectPr 数 = 0，所以必须显式要求「数量 > 0」，否则「0 == 0」会假通过
  push('写法A：四类节属性数量均 > 0（防「0 == 0」假通过）',
    SECT_TAGS.map(t => countOf(out, t) > 0), [true, true, true, true])
  push('写法A：sectPr 恰好 1 个', sectCount(out), 1)
  push('写法A：正文级 sectPr 位于全部段落之后', bodyOnly(out).includes('<w:sectPr>'), true)
  push('写法A：段落数 == 文本行数', paraCount(out), lines.length)
  push('写法A：最后一行的文本仍在文末段落里', out.slice(0, out.lastIndexOf('</w:body>')).includes('>新二<'), true)
  push('写法A：文档头（xml 声明 + w:document）保留', out.startsWith('<?xml version="1.0"') && out.includes('<w:document '), true)
  push('写法A：body 闭合标签仍在', out.includes('</w:body></w:document>'), true)
  push('写法A：返回的 contentTail 就是正文末尾那一段', r.contentTail.includes('<w:pgMar'), true)
  push('写法A：没有再额外追加 pPr 里的 sectPr', r.appendedSectPr, '')

  // ④ 幂等：把产物当模板再重建一次 → 逐字节相同
  const again = rebuildDocumentXml(out, lines).xml
  push('写法A：连续重建两次逐字节相同（幂等）', again === out, true)

  // ③-b 极端：lines.length === 模板段数
  const eq = rebuildDocumentXml(tpl, ['一', '二', '三']).xml
  push('写法A（行数==模板段数）：段落数正确', paraCount(eq), 3)
  push('写法A（行数==模板段数）：节属性仍在', countOf(eq, 'w:pgSz'), 1)
  push('写法A（行数==模板段数）：sectPr 未重复', sectCount(eq), 1)

  // ③-a 极端：lines.length > 模板段数（多出的段落用第一段的 shell 补）
  const more = rebuildDocumentXml(tpl, ['一', '二', '三', '四', '五']).xml
  push('写法A（行数>模板段数）：段落数 == 文本行数', paraCount(more), 5)
  push('写法A（行数>模板段数）：节属性仍在', countOf(more, 'w:pgSz'), 1)
  push('写法A（行数>模板段数）：sectPr 未重复', sectCount(more), 1)
}

/* ② 写法 B：sectPr 嵌在最后一段的 w:pPr 里，且 lines.length < 模板段数（该 shell 用不到） */
{
  const tpl = mkDoc([para('甲'), para('乙'), para('丙', SAMPLE_SECTPR)])
  const lines = ['新一', '新二']
  const r = rebuildDocumentXml(tpl, lines)
  const out = r.xml

  SECT_TAGS.forEach(tag => {
    push(`写法B：${tag} 逐字保留（被截断的 shell 里的节属性）`, tagsOf(out, tag), tagsOf(tpl, tag))
  })
  push('写法B：四类节属性数量均 > 0（防「0 == 0」假通过）',
    SECT_TAGS.map(t => countOf(out, t) > 0), [true, true, true, true])
  push('写法B：sectPr 恰好 1 个（不因追加而重复）', sectCount(out), 1)
  push('写法B：提升为正文级 sectPr（在所有段落之后）', bodyOnly(out).includes('<w:sectPr>'), true)
  push('写法B：确实触发了 pPr 提取兜底', r.appendedSectPr.includes('<w:pgMar'), true)
  push('写法B：段落数 == 文本行数', paraCount(out), 2)

  const again = rebuildDocumentXml(out, lines).xml
  push('写法B：连续重建两次逐字节相同（幂等）', again === out, true)

  // 行数 >= 模板段数时：最后一段的 shell 被用到，sectPr 原地留在该段 pPr 里（不重复追加）
  const eq = rebuildDocumentXml(tpl, ['一', '二', '三']).xml
  push('写法B（行数==模板段数）：sectPr 仍恰好 1 个', sectCount(eq), 1)
  push('写法B（行数==模板段数）：sectPr 留在段落的 pPr 内（写作 B 原样）',
    /<w:pPr>[\s\S]*<w:sectPr>/.test(eq.slice(eq.lastIndexOf('<w:p>'))), true)
  const more = rebuildDocumentXml(tpl, ['一', '二', '三', '四']).xml
  push('写法B（行数>模板段数）：sectPr 仍恰好 1 个', sectCount(more), 1)
  push('写法B（行数>模板段数）：未额外追加正文级 sectPr', rebuildDocumentXml(tpl, ['一', '二', '三', '四']).appendedSectPr, '')
}

/* ⑤ 模板本来没有 sectPr → 产物也没有、且不报错 */
{
  const tpl = mkDoc([para('甲'), para('乙')])
  const lines = ['新一', '新二', '新三']
  const r = rebuildDocumentXml(tpl, lines)
  push('无 sectPr 模板：不报错且产出非空', typeof r.xml === 'string' && r.xml.length > 0, true)
  push('无 sectPr 模板：产物里 sectPr 数量为 0', sectCount(r.xml), 0)
  push('无 sectPr 模板：四类节属性也都不存在',
    SECT_TAGS.map(t => countOf(r.xml, t)), [0, 0, 0, 0])
  push('无 sectPr 模板：段落数 == 文本行数', paraCount(r.xml), 3)
  push('无 sectPr 模板：body 闭合标签仍在', r.xml.includes('</w:body></w:document>'), true)
}

/* ⑥ 边界：缺 </w:body> / 模板没有段落 → 抛人话错误 */
{
  const noBody = mkDoc([para('甲')], { closeBody: false })
  const e1 = catchError(() => rebuildDocumentXml(noBody, ['新一']))
  push('缺 </w:body>：抛错', e1 !== null, true)
  push('缺 </w:body>：错误信息提到 w:body', String(e1).includes('w:body'), true)

  const noPara = mkDoc([])
  const e2 = catchError(() => rebuildDocumentXml(noPara, ['新一']))
  push('模板没有段落：抛错', e2 !== null, true)
  push('模板没有段落：错误信息提到段落', String(e2).includes('段落'), true)

  const e3 = catchError(() => rebuildDocumentXml(mkDoc([para('甲')], { closeBody: false }), []))
  push('缺 </w:body> 且无文本行：同样抛错（不静默产出）', e3 !== null, true)
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
let failed = 0
for (const c of checks) {
  if (!c.ok) failed++
  console.log(`${c.ok ? '✓' : '✗'} ${c.what}：${JSON.stringify(c.got)}${c.ok ? '' : `（期望 ${JSON.stringify(c.want)}）`}`)
}
console.log(`\n文档重建自检（审核#11 sectPr）：${checks.length - failed}/${checks.length}${failed ? ' ← 有失败' : ' 全通过 ✅'}`)
process.exitCode = failed ? 1 : 0
