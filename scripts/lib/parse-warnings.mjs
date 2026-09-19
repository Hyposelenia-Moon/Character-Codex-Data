/**
 * 解析期告警收集（防呆）：凡「无法保留 / 无法归位」的括注与标记都要显式报出，不静默。
 *
 * 用法（parse-docx.mjs）：
 *   import { warn, drainWarnings, resetWarnings, setWarnContext } from './lib/parse-warnings.mjs'
 *   resetWarnings()                 // main() 开头
 *   setWarnContext(角色名)           // 每个角色块开头
 *   warn('主词条片段「…」无法归位')   // 触发点
 *   report.warnings = drainWarnings() // 汇总进 data/_parse-report.json
 */
const warnings = []
let context = ''
let printed = 0
const MAX_PRINT = 60

/** 设置当前告警上下文（通常是角色名），会作为前缀 */
export function setWarnContext (name) {
  context = name ? `${name}：` : ''
}

/** 记一条告警：stderr 打印（最多 MAX_PRINT 条）+ 汇总 */
export function warn (message) {
  const text = `${context}${String(message ?? '').trim()}`
  if (!text) return text
  warnings.push(text)
  if (printed < MAX_PRINT) {
    printed++
    try { console.warn(`⚠ 解析告警：${text}`) } catch { /* 忽略 */ }
  } else if (printed === MAX_PRINT) {
    printed++
    try { console.warn('⚠ 解析告警：…（更多见 data/_parse-report.json 的 warnings）') } catch { /* 忽略 */ }
  }
  return text
}

/** 取走当前累计的告警（不清空，便于多次读取） */
export function getWarnings () { return [...warnings] }

/** 清空（main 开头调用，避免多次运行叠加） */
export function resetWarnings () {
  warnings.length = 0
  printed = 0
  context = ''
}
