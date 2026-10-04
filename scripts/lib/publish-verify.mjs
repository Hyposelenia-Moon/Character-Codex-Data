/**
 * 「保存并发布」提交前的三方一致性校验（文档 / 数据库 / 网页版）
 *
 * 只在 publish 流程里用：**四项全过才允许 git commit**，任一项不过就跳过提交，
 * 已生成的文档与网页保持可用（不回滚）。
 *
 *   a. 数据 ↔ 文档：`scripts/diagnose-docx-json.mjs` 的结构化结论行必须 `ok=true`
 *      （内容不一致 / 只在文档 / 只在 JSON / 顺序不符都算不过）；拿不到结论行时回退中文正则并在 detail 里标注
 *   b. 文档往返：build-docx 的往返校验（parse-docx 读回 vs 生成时 JSON）必须 129/129
 *   c. 网页版新鲜度：guide.html 必须是本次 publish 里 build-html 刚生成的
 *   d. 悬挂/重复分隔符：`scripts/scan-separators.mjs` 必须 0 处
 *
 * 用法：
 *   import { verifyThreeWay, snapshotMainDoc } from './lib/publish-verify.mjs'
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// 主文档 / 标记版路径统一从 lib/main-doc.mjs 取（CODEX_DOCX 优先），不再本文件硬编码 D 盘路径
import { MAIN_DOC, markedDocOf } from './main-doc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const scriptsDir = path.join(root, 'scripts')

/** 主文档的 sha1（提交前用来确认文档确实被本次发布重写过） */
export function snapshotMainDoc (file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

export function sha1File (file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** 跑一个仓库内的 node 脚本，返回 {code, stdout, stderr}（不抛错） */
function runScript (file, args = [], extraEnv) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', e => resolve({ code: -1, stdout, stderr: String(e?.message ?? e) }))
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

/**
 * 解析诊断脚本的机器可读结论行（全角冒号 + 单行 JSON）：
 *   `诊断结论：{"ok":false,"fields":1,"onlyDoc":["X"],"onlyJson":[],"order":true}`
 * 拿不到（旧版诊断脚本 / 输出被截断 / JSON 坏了）返回 null —— 调用方回退中文正则，
 * 但必须在 detail 里写明是回退判定，不能静默。
 * @param {string} text
 * @returns {{ok: boolean, fields: number, onlyDoc: string[], onlyJson: string[], order: boolean}|null}
 */
function parseDiagConclusion (text) {
  const m = String(text ?? '').match(/^诊断结论：(\{.*\})$/m)
  if (!m) return null
  try {
    const r = JSON.parse(m[1])
    return r && typeof r === 'object' ? r : null
  } catch {
    return null
  }
}

/**
 * 三方一致性校验
 * @param {{docxRoundTripRaw?: string, docxHashBefore?: string|null, html?: {path?: string, bytes?: number, hash?: string, builtWithinRun?: boolean}, name?: string}} ctx
 * @returns {Promise<{ok: boolean, detail: string, checks: object[], failed: string[]}>}
 */
export async function verifyThreeWay (ctx = {}) {
  const checks = []
  // 主文档候选：调用方给的最优先，其次 main-doc 的 MAIN_DOC（两者现在同源，去重后通常只有一个）
  const docxCandidates = [...new Set([ctx.docxPath, MAIN_DOC].filter(Boolean))]

  // a. 数据 ↔ 文档（diagnose：不一致角色必须 0）
  const diagScript = path.join(scriptsDir, 'diagnose-docx-json.mjs')
  if (fs.existsSync(diagScript)) {
    // 有冻结快照就用它（并发写 data/gi 时结果稳定）；否则退回实时 data/gi
    const env = ctx.frozenGiDir ? { DSH_GI_DIR: ctx.frozenGiDir } : undefined
    // 必须把文档路径显式传下去：ctx.docxPath 以前只用来算 hash，诊断永远看的是另一份硬编码文件
    const r = await runScript(diagScript, [ctx.docxPath ?? MAIN_DOC], env)
    const text = `${r.stdout}\n${r.stderr}`
    // 优先吃结构化结论行；拿不到才回退中文正则
    const conclusion = parseDiagConclusion(text)
    const m = text.match(/不一致角色：(\d+)\s*个/)
    const count = conclusion ? Number(conclusion.fields) : (m ? Number(m[1]) : null)
    const names = [...text.matchAll(/^· (.+)$/gm)].map(x => x[1].trim()).slice(0, 8)
    const list = (arr) => (Array.isArray(arr) && arr.length ? arr.join('、') : '无')
    checks.push({
      key: 'docx-json',
      name: '数据 ↔ 文档（diagnose-docx-json）',
      ok: conclusion ? (r.code === 0 && conclusion.ok === true) : (r.code === 0 && count === 0),
      detail: conclusion
        ? `不一致角色 ${count} 个；只在文档：${list(conclusion.onlyDoc)}；只在 JSON：${list(conclusion.onlyJson)}；顺序${conclusion.order ? '一致' : '不一致'}${count > 0 && names.length ? `（${names.join('、')}）` : ''}`
        : (count === null
            ? `无法解析诊断输出（退出码 ${r.code}），也没有「诊断结论：{…}」结构化行`
            : `回退中文正则（无「诊断结论：{…}」结构化行）：不一致角色 ${count} 个：${names.join('、') || '（详见诊断输出）'}`)
    })
  } else {
    checks.push({ key: 'docx-json', name: '数据 ↔ 文档（diagnose-docx-json）', ok: false, detail: '找不到 scripts/diagnose-docx-json.mjs' })
  }

  // b. 文档往返（build-docx --write-main 的往返校验结果）
  const raw = String(ctx.docxRoundTripRaw ?? '')
  const cmp = raw.match(/与生成时 JSON 深比较：(.*)$/m)?.[1]?.trim() ?? ''
  const roundTripOk = /完全相等/.test(cmp)
  checks.push({
    key: 'roundtrip',
    name: '文档往返（parse-docx ↔ 生成时 JSON）',
    ok: roundTripOk,
    detail: cmp || '拿不到往返校验输出（build-docx 可能没跑到校验）'
  })

  // b2. 主文档确实被本次发布重写过（信息项，不阻断提交：数据没改到文档时 hash 相同是正常的）
  if (ctx.docxHashBefore !== undefined) {
    const docxNow = docxCandidates.map(snapshotMainDoc).find(h => h)
    const changed = Boolean(docxNow) && docxNow !== ctx.docxHashBefore
    checks.push({
      key: 'docx-rewritten',
      name: '主文档由本次发布重写',
      advisory: true,
      ok: changed,
      detail: docxNow
        ? (changed ? `sha1 ${String(docxNow).slice(0, 12)}（与发布前不同）` : `sha1 ${String(docxNow).slice(0, 12)} 与发布前相同（本次改动未影响文档内容）`)
        : '主文档不存在或读不到'
    })
  }

  // c. 网页版新鲜度（必须由本次 publish 的 build-html 生成）
  const htmlFile = ctx.html?.path ?? path.join(root, 'guide.html')
  const exists = fs.existsSync(htmlFile)
  const hashNow = exists ? sha1File(htmlFile) : null
  const sizeNow = exists ? fs.statSync(htmlFile).size : 0
  const fresh = Boolean(ctx.html?.builtWithinRun) && exists && (ctx.html?.hash ? ctx.html.hash === hashNow : hashNow !== null)
  checks.push({
    key: 'html-fresh',
    name: '网页版新鲜度（guide.html 由本次生成）',
    ok: fresh,
    detail: exists
      ? (fresh ? `本次生成，${sizeNow} 字节，sha1 ${String(hashNow).slice(0, 12)}` : `guide.html 不是本次生成的（sha1 ${String(hashNow).slice(0, 12)}）`)
      : 'guide.html 不存在'
  })

  // d. 悬挂 / 重复分隔符（sections 派生文本）
  const scanScript = path.join(scriptsDir, 'scan-separators.mjs')
  if (fs.existsSync(scanScript)) {
    const r = await runScript(scanScript)
    const text = `${r.stdout}\n${r.stderr}`
    const m = text.match(/悬挂 \/ 重复分隔符：(\d+)\s*处/)
    const count = m ? Number(m[1]) : null
    const samples = [...text.matchAll(/^\s+· (.+)$/gm)].map(x => x[1].trim()).slice(0, 5)
    checks.push({
      key: 'separators',
      name: '悬挂 / 重复分隔符（scan-separators）',
      ok: r.code === 0 && count === 0,
      detail: count === null
        ? `无法解析扫描输出（退出码 ${r.code}）`
        : (count === 0 ? '0 处' : `${count} 处：${samples.join('；') || '（详见扫描输出）'}`)
    })
  } else {
    checks.push({ key: 'separators', name: '悬挂 / 重复分隔符（scan-separators）', ok: false, detail: '找不到 scripts/scan-separators.mjs' })
  }

  // d2. 标记版文档：存在 + 由本次发布刷新 + 往返与 JSON 相等 + 与主文档去标记后逐字一致
  const markedShipped = ctx.markedDocx?.shippedPath ?? markedDocOf(MAIN_DOC)
  const markedExists = fs.existsSync(markedShipped)
  const markedHash = markedExists ? sha1File(markedShipped) : null
  const markedFresh = Boolean(ctx.markedDocx?.fresh) && markedExists
  checks.push({
    key: 'marked-docx',
    name: '标记版文档（out/ + 交付副本，本次刷新）',
    ok: markedFresh,
    detail: markedExists
      ? `${markedShipped}，${fs.statSync(markedShipped).size} 字节，sha1 ${String(markedHash).slice(0, 12)}${markedFresh ? '（本次刷新）' : '（不是本次刷新）'}`
      : `标记版不存在：${markedShipped}`
  })
  checks.push({
    key: 'marked-roundtrip',
    name: '标记版往返（parse-docx ↔ 生成时 JSON）',
    ok: ctx.markedDocx?.roundTripOk === true,
    detail: ctx.markedDocx?.roundTrip || '拿不到标记版往返结果'
  })
  checks.push({
    key: 'strips-equal',
    name: '主文档 ↔ 标记版（去标记后逐字一致）',
    ok: ctx.markedDocx?.stripsEqual === true || ctx.markedDocx?.sameAsMain === true,
    detail: ctx.markedDocx?.stripsEqual === true
      ? '两份文档去标记后逐字一致'
      : (ctx.markedDocx?.sameAsMain ? '两份文档字节级同源（去标记后必然一致）' : '两份文档去标记后不一致')
  })

  // d3. guide.html 与去标记后的文档内容等价：网页版由同一份 data/gi 生成
  //     ⚠ 以前这里判的是 `ctx.docxRoundTripOk !== false`，而**没有任何调用方传这个键**
  //     （undefined !== false 恒真）→ 这一项等于空校验。改用调用方真正会传的两样东西：
  //     本轮确实重建过 guide.html，且标记版往返校验的原始输出里写着「完全相等」。
  const guideFile = ctx.guidePath ?? path.join(root, 'guide.html')
  const guideRoundTripOk = /完全相等|往返[^\n]*ok|结论：通过/.test(String(ctx.docxRoundTripRaw ?? ''))
  checks.push({
    key: 'guide-equivalent',
    name: '网页版 ↔ 数据（guide.html 与去标记文档同源）',
    ok: fs.existsSync(guideFile) && ctx.html?.builtWithinRun === true && guideRoundTripOk,
    detail: fs.existsSync(guideFile)
      ? `guide.html 由本次 build-html 生成（${fs.statSync(guideFile).size} 字节），与文档/数据库同一份 data/gi；标记版往返：${guideRoundTripOk ? '通过' : '未通过'}`
      : 'guide.html 不存在'
  })

  const failed = checks.filter(c => !c.ok && !c.advisory)
  return {
    ok: failed.length === 0,
    checks,
    failed: failed.map(c => `${c.name}：${c.detail}`),
    detail: failed.length
      ? failed.map(c => `${c.name} → ${c.detail}`).join(' ｜ ')
      : `${checks.filter(c => !c.advisory).length} 项全过（数据 / 主文档往返 / 网页 / 分隔符 / 标记版 / 去标记等价）`
  }
}
