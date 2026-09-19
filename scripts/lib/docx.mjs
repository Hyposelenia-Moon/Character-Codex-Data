/**
 * 最小 docx 读取器（无第三方依赖）
 *  - 只做「读」：取出 word/document.xml 的段落文本
 *  - zip 解析用中央目录，deflate 用 node:zlib
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

/**
 * 读取 zip 内所有条目
 * @param {string} file
 * @returns {Map<string, Buffer>}
 */
export function readZip (file) {
  const buf = fs.readFileSync(file)
  // 找 EOCD（从尾部往前扫，最多 64KB 注释）
  let eocd = -1
  const from = Math.max(0, buf.length - 65558)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx：找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  const cenOff = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  let p = cenOff
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    // 本地头：数据起点 = localOff + 30 + 名称长度 + 扩展长度
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** XML 文本反转义 */
export function unescapeXml (s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

/**
 * 读取 docx 的段落文本（自动跳过空段、自闭合段）
 * @param {string} file
 * @returns {{paragraphs: string[], xml: string, entries: Map<string, Buffer>}}
 */
export function readDocx (file) {
  const entries = readZip(file)
  const doc = entries.get('word/document.xml')
  if (!doc) throw new Error('docx 缺少 word/document.xml')
  const xml = doc.toString('utf8')
  const paragraphs = []
  const re = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const chunk = m[0]
    if (chunk.endsWith('/>')) { paragraphs.push(''); continue }
    let text = ''
    const tre = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
    let t
    while ((t = tre.exec(chunk)) !== null) text += t[1]
    paragraphs.push(unescapeXml(text).trim())
  }
  return { paragraphs, xml, entries }
}

/** 分隔段（32 个 U+2500） */
export const SEPARATOR = '─'.repeat(32)

/* ------------------------------------------------------------------ *
 * 以下为「写」能力（新增导出，不影响上面的读取函数）
 * ------------------------------------------------------------------ */

/** XML 文本转义（与 unescapeXml 互逆） */
export function escapeXml (s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** CRC32 查表（zip 需要） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** 计算 Buffer 的 CRC32 */
export function crc32 (buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/**
 * 写出一个 docx（zip）：手写本地头 / 中央目录 / EOCD，deflate 用 node:zlib
 *  - 条目顺序保持传入 Map 的顺序（即原文档顺序）
 *  - 条目名本身可用 UTF-8 位标记，Word 可以正常打开
 * @param {Map<string, Buffer>} entries 部件名 → 内容
 * @param {string} outFile 输出路径
 * @param {{date?: Date, level?: number, minDeflate?: number}} [opts]
 * @returns {{file: string, count: number, bytes: number, stored: string[], deflated: string[]}}
 */
export function writeDocx (entries, outFile, opts = {}) {
  if (!(entries instanceof Map)) throw new TypeError('writeDocx(entries) 需要 Map<string, Buffer>')
  const date = opts.date instanceof Date ? opts.date : new Date()
  const level = opts.level ?? 9
  const minDeflate = opts.minDeflate ?? 1
  // DOS 时间（本地时区，与 Word 一致）
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF
  // 文件头：末条记录必须记录「中央目录起始位置」以便回填
  const head = []
  const central = []
  const stored = []
  const deflated = []
  let offset = 0
  for (const [name, rawBuf] of entries) {
    const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf)
    const nb = Buffer.from(name, 'utf8')
    const crc = crc32(raw)
    let method = 0
    let data = raw
    if (raw.length >= minDeflate) {
      const z = zlib.deflateRawSync(raw, { level })
      if (z.length < raw.length) { method = 8; data = z }
    }
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)          // version needed
    lh.writeUInt16LE(0x0800, 6)      // UTF-8 名称
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(dosTime, 10)
    lh.writeUInt16LE(dosDate, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nb.length, 26)
    lh.writeUInt16LE(0, 28)
    head.push(lh, nb, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(0x031E, 4)      // version made by（unix + 3.0）
    ch.writeUInt16LE(20, 6)          // version needed
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(dosTime, 12)
    ch.writeUInt16LE(dosDate, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nb.length, 28)
    ch.writeUInt16LE(0, 30)          // extra
    ch.writeUInt16LE(0, 32)          // comment
    ch.writeUInt16LE(0, 34)          // disk
    ch.writeUInt16LE(0, 36)          // internal attrs
    ch.writeUInt32LE(0, 38)          // external attrs
    ch.writeUInt32LE(offset, 42)     // local header offset
    central.push(ch, nb)
    if (method === 8) deflated.push(name); else stored.push(name)
    offset += 30 + nb.length + data.length
  }
  const cenBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.size, 8)
  eocd.writeUInt16LE(entries.size, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  const out = Buffer.concat([...head, cenBuf, eocd])
  fs.writeFileSync(outFile, out)
  return { file: outFile, count: entries.size, bytes: out.length, stored, deflated }
}
