/**
 * 主文档路径的**单一入口**
 *
 * 背景（2026-10-04 审核）：以前有 5 处各自硬编码
 * `D:\文件\游戏\原神\原神·角色攻略.docx`（build-docx / mark-docx / diagnose-docx-json /
 * publish-verify / editor / daily-docx-sync），而唯一的环境变量入口 `CODEX_DOCX` 只覆盖了
 * daily-docx-sync 的一处、还只用来比 mtime —— 于是会出现「查 A 文件的时间、诊断 B 文件、
 * 回写第三处」这种日志上完全看不出来的错位。
 *
 * 现在所有脚本都从这里取主文档路径：`CODEX_DOCX` 一改，诊断 / 构建 / 备份 / 标记版输出
 * 一起改，不会再各走各的。
 */
import path from 'node:path'

/** 默认主文档（与 data/gi/*.json 的 `source.guide` 对应） */
export const DEFAULT_MAIN_DOC = 'D:\\文件\\游戏\\原神\\原神·角色攻略.docx'

/**
 * 实际使用的主文档：`CODEX_DOCX` 优先（相对路径按当前工作目录解析）
 * 各脚本用它当参数默认值；子进程按环境变量继承，天然一致。
 */
export const MAIN_DOC = process.env.CODEX_DOCX ? path.resolve(process.env.CODEX_DOCX) : DEFAULT_MAIN_DOC

/** 交付用「标记版」的后缀（与主文档同目录、同扩展名） */
export const MARKED_SUFFIX = '(标记版)'

/**
 * 由主文档路径派生标记版路径（`--write-main` 时的交付副本）
 * @param {string} [mainDoc]
 * @returns {string}
 */
export function markedDocOf (mainDoc = MAIN_DOC) {
  const dir = path.dirname(mainDoc)
  const ext = path.extname(mainDoc)
  const base = path.basename(mainDoc, ext)
  return path.join(dir, `${base}${MARKED_SUFFIX}${ext}`)
}

/** 交付用标记版路径 */
export const MARKED_DOC = markedDocOf(MAIN_DOC)
