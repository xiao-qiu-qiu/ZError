import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DOMParser } from '@xmldom/xmldom'
import { runModel } from '../src/services/modelRuntime'
import { isBingSourceRelevant, parseBingRss } from '../src/services/bingSearch'
import { SearchSession, type SearchSource } from '../src/services/search'
import type { SearchSettings } from '../src/services/settings'

const globalScope = globalThis as Record<string, unknown>
const originalDOMParser = globalScope.DOMParser

beforeAll(() => { globalScope.DOMParser = DOMParser })
afterAll(() => {
  if (originalDOMParser === undefined) delete globalScope.DOMParser
  else globalScope.DOMParser = originalDOMParser
})

const baseSettings: SearchSettings = {
  mode: 'always',
  provider: 'bing',
  apiKey: '',
  baseUrl: '',
  maxSearches: 2,
  maxPages: 3,
  timeoutSeconds: 120,
  requestTimeoutSeconds: 20,
  cacheTtlMinutes: 0,
}

const settings = (overrides: Partial<SearchSettings> = {}): SearchSettings => ({ ...baseSettings, ...overrides })
const signal = () => new AbortController().signal

const escapeXml = (value: string) => value.replace(/[<>&'\"]/g, char => ({
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
}[char] || char))

const source = (title: string, url: string, snippet: string): SearchSource => ({ title, url, snippet })

const rss = (items: SearchSource[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Bing</title>${items.map(item => `<item><title>${escapeXml(item.title)}</title><link>${escapeXml(item.url)}</link><description>${escapeXml(item.snippet)}</description></item>`).join('')}</channel></rss>`

const response = (xml: string) => new Response(xml, {
  status: 200,
  headers: { 'content-type': 'application/rss+xml' },
})

describe('Bing RSS search evidence', () => {
  test('中文题意的跑题结果被过滤，内置兜底也无证据时不接受答案', async () => {
    const query = '中国古代四大发明有哪些'
    const unrelated = rss([
      source('Pizza in Paris', 'https://example.com/pizza', 'Pizza and Paris travel guide'),
      source('Paris travel guide', 'https://example.com/paris', 'Hotels, food and sightseeing in Paris'),
      source('301 Moved Permanently', 'https://example.com/redirect', 'The requested page moved permanently'),
    ])
    let fetchCalls = 0
    let fallbackCalls = 0
    const fetcher = (async () => { fetchCalls++; return response(unrelated) }) as typeof fetch
    const session = new SearchSession(settings(), fetcher, undefined, async () => {
      fallbackCalls++
      return unrelated
    })
    let processCalls = 0

    await expect(runModel({
      input: { messages: [{ role: 'user', content: query }] },
      config: {},
      signal: signal(),
      search: session,
      fetcher,
      searchQuery: query,
      process: async () => {
        processCalls++
        return { content: '{"answer":"不应作答"}' }
      },
    })).rejects.toThrow('内置搜索兜底未获得真实搜索事件和来源')

    expect(fetchCalls).toBe(2) // Bing request plus the Responses fallback.
    expect(fallbackCalls).toBe(1)
    expect(processCalls).toBe(0)
    expect(session.trace.sources).toHaveLength(0)
    expect(session.trace.state).toBe('failed')
  })

  test('初次结果无关时，fallback 返回相关中文 RSS 后 always 模式才成功', async () => {
    const query = '中国古代四大发明有哪些'
    const initial = rss([source('Pizza in Paris', 'https://example.com/pizza', 'Pizza and Paris travel guide')])
    const fallback = rss([source('中国古代四大发明', 'https://example.com/inventions', '造纸术、印刷术、火药和指南针是中国古代四大发明。')])
    let fetchCalls = 0
    let fallbackCalls = 0
    const fetcher = (async () => { fetchCalls++; return response(initial) }) as typeof fetch
    const session = new SearchSession(settings(), fetcher, undefined, async (fallbackQuery, timeoutSeconds) => {
      fallbackCalls++
      expect(fallbackQuery).toBe(query)
      expect(timeoutSeconds).toBe(20)
      return fallback
    })
    let processCalls = 0

    const answer = await runModel({
      input: { messages: [{ role: 'user', content: query }] },
      config: {},
      signal: signal(),
      search: session,
      fetcher,
      searchQuery: query,
      process: async input => {
        processCalls++
        expect(input.messages.some((message: any) => String(message.content || '').includes('造纸术'))).toBe(true)
        return { content: '{"answer":"造纸术"}' }
      },
    })

    expect(answer).toBe('{"answer":"造纸术"}')
    expect(fetchCalls).toBe(1)
    expect(fallbackCalls).toBe(1)
    expect(processCalls).toBe(1)
    expect(session.trace.sources.map(item => item.url)).toEqual(['https://example.com/inventions'])
  })

  test('前五条跑题时仍保留第六条相关结果', async () => {
    const query = '中国古代四大发明有哪些'
    const firstFive = Array.from({ length: 5 }, (_, index) => source(`Pizza result ${index + 1}`, `https://example.com/pizza-${index + 1}`, 'Pizza and Paris travel guide'))
    const relevant = source('中国古代四大发明', 'https://example.com/inventions', '造纸术、印刷术、火药和指南针')
    let fallbackCalls = 0
    const fetcher = (async () => response(rss([...firstFive, relevant]))) as typeof fetch
    const session = new SearchSession(settings(), fetcher, undefined, async () => {
      fallbackCalls++
      return rss([])
    })

    const result = JSON.parse(await session.execute('web_search', JSON.stringify({ query }), signal())) as { sources: SearchSource[] }
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].url).toBe(relevant.url)
    expect(session.trace.sources.map(item => item.url)).toEqual([relevant.url])
    expect(fallbackCalls).toBe(0)
  })

  test('合法的 pizza 查询仍可返回 pizza 来源', async () => {
    const query = 'pizza Paris'
    const pizza = source('Pizza in Paris', 'https://food.example.com/pizza-paris', 'Best pizza restaurants in Paris')
    let fallbackCalls = 0
    const fetcher = (async () => response(rss([pizza]))) as typeof fetch
    const session = new SearchSession(settings(), fetcher, undefined, async () => {
      fallbackCalls++
      return rss([])
    })

    const result = JSON.parse(await session.execute('web_search', JSON.stringify({ query }), signal())) as { sources: SearchSource[] }
    expect(result.sources).toEqual([pizza])
    expect(fallbackCalls).toBe(0)
  })

  test('中英文相关性均可识别，纯 XML 错误页面不视为 RSS', () => {
    expect(isBingSourceRelevant('中国古代四大发明', source('中国古代四大发明', 'https://example.com/zh', '造纸术和印刷术的历史'))).toBe(true)
    expect(isBingSourceRelevant('Paris travel guide', source('Paris travel guide', 'https://example.com/en', 'A guide to travel in Paris'))).toBe(true)
    expect(isBingSourceRelevant('中国古代四大发明', source('Pizza in Paris', 'https://example.com/off-topic', 'Pizza and Paris travel guide'))).toBe(false)
    expect(isBingSourceRelevant('Paris travel guide', source('301 Moved Permanently', 'https://example.com/301', 'Paris travel guide'))).toBe(false)
    expect(() => parseBingRss('<Error><Code>AccessDenied</Code></Error>')).toThrow('搜索服务返回了非 RSS 数据')
  })

  test('失败结果不污染缓存，相同 query 的新 session 会重新请求', async () => {
    const query = '缓存失败后重新检索中国古代四大发明'
    const cachedSettings = settings({ cacheTtlMinutes: 30 })
    const invalidXml = '<Error><Code>BadGateway</Code></Error>'
    let firstFetchCalls = 0
    let firstFallbackCalls = 0
    const firstFetcher = (async () => { firstFetchCalls++; return response(invalidXml) }) as typeof fetch
    const firstSession = new SearchSession(cachedSettings, firstFetcher, undefined, async () => {
      firstFallbackCalls++
      return invalidXml
    })
    const firstResult = JSON.parse(await firstSession.execute('web_search', JSON.stringify({ query }), signal())) as { error: string }
    expect(firstResult.error).toContain('搜索服务返回了非 RSS 数据')
    expect(firstSession.trace.sources).toHaveLength(0)

    const relevant = source('中国古代四大发明', 'https://example.com/inventions-cache', '造纸术、印刷术、火药和指南针')
    let secondFetchCalls = 0
    let secondFallbackCalls = 0
    const secondFetcher = (async () => { secondFetchCalls++; return response(rss([relevant])) }) as typeof fetch
    const secondSession = new SearchSession(cachedSettings, secondFetcher, undefined, async () => {
      secondFallbackCalls++
      return rss([])
    })
    const secondResult = JSON.parse(await secondSession.execute('web_search', JSON.stringify({ query }), signal())) as { sources: SearchSource[] }

    expect(firstFetchCalls).toBe(1)
    expect(firstFallbackCalls).toBe(1)
    expect(secondFetchCalls).toBe(1)
    expect(secondFallbackCalls).toBe(0)
    expect(secondResult.sources.map(item => item.url)).toEqual([relevant.url])
  })
})
