import { describe, expect, test } from 'bun:test'
import { runModel } from '../src/services/modelRuntime'
import { SearchSession } from '../src/services/search'
import type { SearchSettings } from '../src/services/settings'

const SOURCE_URL = 'https://source.example.org/fixture'
const SEARCH_URL = 'https://search.example.org'

const baseSettings: SearchSettings = {
  mode: 'auto',
  provider: 'searxng',
  apiKey: '',
  baseUrl: SEARCH_URL,
  maxSearches: 2,
  maxPages: 2,
  timeoutSeconds: 120,
  requestTimeoutSeconds: 20,
  cacheTtlMinutes: 0,
}

const settings = (overrides: Partial<SearchSettings> = {}): SearchSettings => ({ ...baseSettings, ...overrides })
const signal = () => new AbortController().signal

const fixtureFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.startsWith(`${SEARCH_URL}/search?`)) {
    return Response.json({
      results: [{ url: SOURCE_URL, title: 'Fixture source', content: 'A factual fixture summary for the search workflow.' }],
    })
  }
  throw new Error(`unexpected fixture URL: ${url}`)
}) as typeof fetch

const toolNames = (input: any): string[] => (input.tools || []).map((tool: any) => tool.function?.name || tool.type)

const runWithFinalAnswer = (session: SearchSession, seen: any[]) => runModel({
  input: { messages: [{ role: 'user', content: '核对 fixture 事实' }] },
  config: { model: 'fixture' },
  signal: signal(),
  search: session,
  fetcher: fixtureFetch,
  process: async input => {
    seen.push(structuredClone(input))
    return { content: 'fixture answer' }
  },
})

describe('search workflow budget', () => {
  test('搜索预算用完后只把 read_page 交给下一轮，并在 web_search 输出中报告预算', async () => {
    const session = new SearchSession(settings({ maxSearches: 1, maxPages: 1 }), fixtureFetch)
    const first = JSON.parse(await session.execute('web_search', JSON.stringify({ query: 'fixture fact' }), signal()))

    expect(first.budget).toEqual({ searchesRemaining: 0, pagesRemaining: 1 })

    const seen: any[] = []
    await expect(runWithFinalAnswer(session, seen)).resolves.toBe('fixture answer')
    expect(seen).toHaveLength(1)
    expect(toolNames(seen[0])).toEqual(['read_page'])
    expect(toolNames(seen[0])).not.toContain('web_search')

    const exhausted = JSON.parse(await session.execute('web_search', JSON.stringify({ query: 'another fact' }), signal()))
    expect(exhausted.budget).toEqual({ searchesRemaining: 0, pagesRemaining: 1 })
  })

  test('网页读取预算用完后移除 read_page，但保留仍有次数的 web_search', async () => {
    const session = new SearchSession(settings({ maxSearches: 2, maxPages: 1 }), fixtureFetch)
    await session.execute('web_search', JSON.stringify({ query: 'fixture fact' }), signal())
    session.trace.pages = 1

    const seen: any[] = []
    await expect(runWithFinalAnswer(session, seen)).resolves.toBe('fixture answer')
    expect(seen).toHaveLength(1)
    expect(toolNames(seen[0])).toEqual(['web_search'])
    expect(session.budget).toEqual({ searchesRemaining: 1, pagesRemaining: 0 })
  })
})
