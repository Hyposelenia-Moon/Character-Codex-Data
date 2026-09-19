/**
 * 字体获取：把 `guide.html` 用的 **汉仪文黑-85W**（原神内置 hk4e 字体）同步到仓库根目录。
 *
 * 为什么是「同步」而不是入库：
 *   - 该字体是**商业字体**（版权归汉仪字库；上游那份是从原神客户端提取的 hk4e 字体，
 *     版权同样不属于本仓库），不能随仓库分发，所以 `.gitignore` 里忽略 `*.ttf` / `*.otf`；
 *   - 但本机/CI 上想看图鉴网页版的真实排版，就需要这个文件 —— 从上游图鉴仓库取回同一份，
 *     `guide.html` 按相对路径 `./汉仪文黑-85W.ttf` 引用即可。
 *
 * 来源优先级（先本地、后网络，避免无谓下载）：
 *   1. 本地上游图鉴仓库里的同名字体（等价文件，字节相同）：
 *        <Atlas-Plugin>\resources\common\font\hk4e_zh-cn.ttf
 *   2. 上游公开仓库的 raw 地址（GitHub）
 * 复制/下载后校验字节数（>1MB）并打印 SHA256，方便与别人核对是不是同一份。
 *
 * 用法：
 *   node scripts/fetch-font.mjs [--force] [--from <路径或URL>]
 *   默认目标：仓库根 `汉仪文黑-85W.ttf`
 *
 * 退出码：0 = 字体就绪（原本就在 / 已同步）；1 = 拿不到（此时网页版会回退到系统免费字体）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const TARGET = path.join(root, '汉仪文黑-85W.ttf')
const MIN_BYTES = 1024 * 1024

/** 候选来源：本地优先，网络兜底 */
const LOCAL_SOURCES = [
  'D:\\文件\\游戏\\原神\\Atlas-Plugin\\resources\\common\\font\\hk4e_zh-cn.ttf',
  'D:\\文件\\游戏\\原神\\Atlas-Plugin\\resources\\common\\font\\汉仪文黑-85W.ttf'
]
const REMOTE_SOURCES = [
  'https://raw.githubusercontent.com/AxiuCN/Atlas-Plugin/master/resources/common/font/hk4e_zh-cn.ttf',
  'https://raw.githubusercontent.com/Hyposelenia-Moon/Atlas-Plugin/master/resources/common/font/hk4e_zh-cn.ttf'
]

const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const fmtSize = n => `${n} 字节（${(n / 1048576).toFixed(2)} MB）`

/** 文件是不是一个像样的字体（存在 + 够大） */
function looksLikeFont (file) {
  try {
    const st = fs.statSync(file)
    return st.isFile() && st.size >= MIN_BYTES
  } catch { return false }
}

async function download (url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < MIN_BYTES) throw new Error(`内容过小：${fmtSize(buf.length)}（可能不是字体）`)
  fs.writeFileSync(dest, buf)
  return buf.length
}

async function main () {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const fromIdx = argv.indexOf('--from')
  const custom = fromIdx >= 0 ? argv[fromIdx + 1] : null

  console.log(`目标：${TARGET}`)
  if (looksLikeFont(TARGET) && !force) {
    const buf = fs.readFileSync(TARGET)
    console.log(`字体已存在，无需同步：${fmtSize(buf.length)}`)
    console.log(`SHA256：${sha(buf)}`)
    return
  }

  const sources = custom ? [custom] : [...LOCAL_SOURCES, ...REMOTE_SOURCES]
  const tried = []
  for (const src of sources) {
    const isUrl = /^https?:\/\//i.test(src)
    process.stdout.write(`${isUrl ? '下载' : '复制'}：${src} … `)
    try {
      let bytes
      if (isUrl) {
        bytes = await download(src, TARGET)
      } else {
        if (!looksLikeFont(src)) throw new Error('本地不存在或不是字体文件')
        fs.copyFileSync(src, TARGET)
        bytes = fs.statSync(TARGET).size
      }
      const buf = fs.readFileSync(TARGET)
      console.log(`OK（${fmtSize(bytes)}）`)
      console.log(`SHA256：${sha(buf)}`)
      console.log(`来源：${isUrl ? '上游 raw 地址' : '本地上游图鉴仓库'}`)
      console.log('说明：该字体是商业字体，仅供本机看图鉴网页版使用，**不入库**（.gitignore 已忽略 *.ttf）。')
      return
    } catch (e) {
      console.log(`失败（${e.message ?? e}）`)
      tried.push(`${src} → ${e.message ?? e}`)
    }
  }

  console.error('\n❌ 所有来源都拿不到字体。')
  for (const t of tried) console.error(`  · ${t}`)
  console.error('可选做法：')
  console.error('  1. 手动把字体放到仓库根目录、命名为「汉仪文黑-85W.ttf」；')
  console.error('  2. 或指定来源：node scripts/fetch-font.mjs --from <路径或URL> --force；')
  console.error('  3. 不提供字体也能用：guide.html 会回退到 MiSans / Noto Sans SC / 思源黑体等免费字体，')
  console.error('     观感接近（详见 README「字体」一节）。')
  process.exitCode = 1
}

main().catch(e => { console.error(String(e?.stack ?? e)); process.exitCode = 1 })
