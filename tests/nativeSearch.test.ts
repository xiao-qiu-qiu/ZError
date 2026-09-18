import { describe, expect, test } from 'bun:test'
import { runModel } from '../src/services/modelRuntime'
import { SearchSession, type SearchSource } from '../src/services/search'
import type { SearchSettings } from '../src/services/settings'

const baseSettings: SearchSettings = {
  mode: 'always',
  provider: 'native',
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
const fixtureFetch = (async () => Response.json({})) as typeof fetch

const source = (url: string, title = '', snippet = ''): SearchSource => ({ url, title, snippet })

const nativeEvent = (id: string, sources: SearchSource[], status = 'completed') => ({
  id,
  type: 'web_search_call',
  status,
  action: { type: 'search', sources },
})

const runNative = (session: SearchSession, process: (input: any) => Promise<any>, config: any = { model: 'fixture' }) => runModel({
  input: { messages: [{ role: 'user', content: 'What is the fixture answer?' }] },
  config,
  signal: signal(),
  search: session,
  nativeSearch: true,
  fetcher: fixtureFetch,
  process,
})

describe('native search evidence', () => {
  test('merges duplicate URLs without degrading title or snippet', () => {
    const session = new SearchSession(settings(), fixtureFetch)
    const url = 'https://example.org/reference'

    session.addSources([source(url, url)])
    session.addSources([source(url, 'Referenced title', 'A useful evidence snippet')])
    expect(session.trace.sources).toEqual([{ url, title: 'Referenced title', snippet: 'A useful evidence snippet' }])

    session.addSources([source(url, url, '')])
    expect(session.trace.sources[0]).toEqual({ url, title: 'Referenced title', snippet: 'A useful evidence snippet' })
  })

  test('updates an existing URL even when the source list is already full', () => {
    const session = new SearchSession(settings(), fixtureFetch)
    const firstUrl = 'https://example.org/first'
    session.addSources([source(firstUrl, firstUrl)])
    session.addSources(Array.from({ length: 99 }, (_, index) => source(`https://example.org/source-${index + 1}`, `Source ${index + 1}`, 'summary')))
    expect(session.trace.sources).toHaveLength(100)

    session.addSources([source(firstUrl, 'Recovered title', 'Recovered summary')])
    expect(session.trace.sources).toHaveLength(100)
    expect(session.trace.sources[0]).toEqual({ url: firstUrl, title: 'Recovered title', snippet: 'Recovered summary' })
  })

  test('repeated native events preserve the richer source record', () => {
    const session = new SearchSession(settings(), fixtureFetch)
    const url = 'https://example.org/repeated'

    session.nativeEvent(nativeEvent('search-1', [source(url, 'Detailed title', 'Detailed snippet')]))
    session.nativeEvent(nativeEvent('search-1', [source(url, url, '')]))

    expect(session.trace.searches).toBe(1)
    expect(session.trace.sources).toEqual([{ url, title: 'Detailed title', snippet: 'Detailed snippet' }])
  })

  test('late citation titles survive replay of URL-only search events', () => {
    const session = new SearchSession(settings(), fixtureFetch)
    const url = 'https://example.org/citation'
    const event = nativeEvent('citation-search', [source(url)])
    session.nativeEvent(event)
    session.annotations([{ type: 'url_citation', url, title: 'Actual page title' }])
    session.nativeEvent(event)
    expect(session.trace.sources).toEqual([{ url, title: 'Actual page title', snippet: '', cited: true }])
  })

  test('accepts a current native search event whose source has only a URL', async () => {
    const session = new SearchSession(settings(), fixtureFetch)
    let calls = 0

    const answer = await runNative(session, async input => {
      calls++
      expect(input.tools).toEqual([{ type: 'web_search' }])
      expect(input.tool_choice).toBe('required')
      return { content: 'The fixture answer', search_items: [nativeEvent('current-search', [source('https://example.org/url-only')])] }
    })

    expect(answer).toBe('The fixture answer')
    expect(calls).toBe(1)
    expect(session.trace.sources).toEqual([{ url: 'https://example.org/url-only', title: 'https://example.org/url-only', snippet: '' }])
    expect(session.trace.messages.at(-1)).toMatch(/供应商侧内置搜索/)
  })

  test('does not run a later always-mode model when only a bare URL remains after budget exhaustion', async () => {
    const session = new SearchSession(settings({ maxSearches: 1 }), fixtureFetch)
    session.nativeEvent(nativeEvent('previous-search', [source('https://example.org/bare')]))
    let calls = 0

    await expect(runNative(session, async () => {
      calls++
      return { content: 'should not be returned' }
    })).rejects.toThrow(/正文|摘要/)
    expect(calls).toBe(0)
  })

  test('a later model must search for itself when budget remains but only URLs were shared', async () => {
    const session = new SearchSession(settings(), fixtureFetch)
    session.nativeEvent(nativeEvent('first-model', [source('https://example.org/previous')]))
    await runNative(session, async input => {
      expect(input.tool_choice).toBe('required')
      expect(JSON.stringify(input.messages)).not.toContain('https://example.org/previous')
      return { content: 'Verified independently', search_items: [nativeEvent('second-model', [source('https://example.org/current')])] }
    })
    expect(session.trace.searches).toBe(2)
  })

  test('shares only non-empty snippets with the next model and labels provider search separately', async () => {
    const session = new SearchSession(settings({ maxSearches: 3 }), fixtureFetch)
    const bareUrl = 'https://example.org/bare'
    const citedUrl = 'https://example.org/cited'
    session.nativeEvent(nativeEvent('bare-search', [source(bareUrl)]))
    session.nativeEvent(nativeEvent('cited-search', [source(citedUrl, 'Cited title', 'Cited evidence')]))
    let calls = 0

    const answer = await runNative(session, async input => {
      calls++
      const shared = input.messages.find((message: any) => message.role === 'user' && String(message.content).includes('前序模型'))
      expect(shared).toBeDefined()
      expect(String(shared.content)).toContain(citedUrl)
      expect(String(shared.content)).toContain('Cited evidence')
      expect(String(shared.content)).not.toContain(bareUrl)
      expect(input.tool_choice).toBe('auto')
      return { content: 'Shared answer' }
    })

    expect(answer).toBe('Shared answer')
    expect(calls).toBe(1)
    const completion = session.trace.messages.at(-1) || ''
    expect(completion).toMatch(/摘要/)
    expect(completion).not.toMatch(/供应商侧内置搜索/)
  })
})
