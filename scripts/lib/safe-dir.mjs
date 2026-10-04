/**
 * 破坏性输出的路径护栏
 *
 * 背景（2026-10-04 审核 P1）：全仓只有 `build-doc.mjs --docx-dir` 会把**用户传入的目录**
 * 递归删掉，而它对目标没有任何校验 —— 传 `.` 就是删仓库根，传一个放着笔记的目录就把笔记清空。
 * 其它 `rmSync` 都只作用于脚本自己派生的 `.tmp/*`，不需要这层护栏。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根（scripts/lib → ../..） */
export const REPO_ROOT = path.resolve(here, '..', '..')

/**
 * child 是否等于 parent 或位于 parent 之下（纯字符串判断，路径不必存在）
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside (parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 校验「可写输出目录」是否安全：盘根 / 仓库目录及其祖先 / 用户主目录一律拒绝。
 * 目录不存在是允许的（调用方随后 mkdir）；存在但不是目录则拒绝。
 * @param {string} dir
 * @param {{label?: string}} [opts]
 * @returns {string} 解析后的绝对路径
 */
export function assertSafeOutputDir (dir, opts = {}) {
  const label = opts.label ?? '输出目录'
  const abs = path.resolve(dir)
  if (abs === path.parse(abs).root) throw new Error(`${label}不能是盘根：${abs}`)
  if (isInside(abs, REPO_ROOT)) throw new Error(`${label}不能是仓库目录或其祖先：${abs}（仓库：${REPO_ROOT}）`)
  const home = os.homedir()
  if (home && path.resolve(home) === abs) throw new Error(`${label}不能是用户主目录：${abs}`)
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) throw new Error(`${label}已存在且不是目录：${abs}`)
  return abs
}

/**
 * 写盘前的兜底断言：目标必须落在输出目录内（防止拼接出错写到别处）
 * @param {string} dir 输出目录（已通过 assertSafeOutputDir）
 * @param {string} target 待写文件
 */
export function assertTargetInside (dir, target) {
  if (!isInside(dir, target)) throw new Error(`拒绝写入：${target} 不在输出目录 ${dir} 内`)
  return path.resolve(target)
}
