import type { SearchSource } from './search'

export const BING_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function bingSearchUrl(query: string): string {
  return 'https://www.bing.com/search?' + new URLSearchParams({ q: query, format: 'rss' })
}

export function parseBingRss(xml: string): SearchSource[] {
  if (!xml.trim()) throw new Error('搜索服务返回了空响应')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('channel').length) {
    throw new Error('搜索服务返回了非 RSS 数据')
  }
  return Array.from(doc.getElementsByTagName('item')).map(item => {
    const text = (tag: string) => (item.getElementsByTagName(tag)[0]?.textContent || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return { url: text('link'), title: text('title'), snippet: text('description') }
  })
}

const englishStopWords = new Set('a an the is are was were be of in on at to for and or with which what who when where how why do does did about explain list please find search answer question best correct incorrect true false'.split(' '))
const chineseStopWords = new Set('下列 以下 上述 哪个 哪些 什么 为何 为什么 是否 正确 错误 不正 不确 不错 选项 选择 判断 问题 答案 关于 主要 内容 原因 说法 认为 可以 应该 一个 一种 其中 属于 的是 的有 的不 是什 么是'.split(' '))

/** A coarse off-topic guard, not proof that a result supports the answer.
 * Compare only result text, never the channel title or URL (which can echo q).
 * Han bigrams work without spaces and tolerate punctuation such as “八七”会议.
 */
export function isBingSourceRelevant(query: string, source: SearchSource): boolean {
  if (/^(?:30[1278]\s|40[034]\s|50[0234]\s|access denied|forbidden|just a moment)/i.test(source.title.trim())) return false
  const normalized = query.normalize('NFKC').toLowerCase().replace(/\b(?:site|filetype):\S+/g, '')
  const content = (source.title + ' ' + source.snippet).normalize('NFKC').toLowerCase()
  const words = (normalized.match(/[a-z][a-z0-9+#.-]*/g) || []).filter(w => w.length > 1 && !englishStopWords.has(w))
  const resultWords = new Set(content.match(/[a-z][a-z0-9+#.-]*/g) || [])
  const terms = new Set<string>()
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    const chars = Array.from(run)
    for (let i = 0; i < chars.length - 1; i++) {
      const term = chars[i] + chars[i + 1]
      if (!chineseStopWords.has(term)) terms.add(term)
    }
  }
  const hanContent = content.replace(/[^\p{Script=Han}]/gu, '')
  const matches = [...terms].filter(t => hanContent.includes(t)).length
  // For mixed queries, an acronym alone (e.g. TCP Software for TCP 三次握手)
  // does not establish a match to the Chinese subject or condition.
  // Queries without lexical terms (e.g. a mathematical expression) are left
  // to the model; never blacklist a topic such as pizza or Paris itself.
  return terms.size ? matches >= Math.min(2, terms.size) : words.length === 0 || words.some(w => resultWords.has(w))
}

export async function directBingSearch(query: string, timeoutSeconds: number): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string>('search_bing_direct', { query, timeoutSeconds })
}
