import { describe, expect, test } from 'bun:test'
import { runModel } from '../src/services/modelRuntime'
import { SearchSession } from '../src/services/search'
import type { SearchSettings } from '../src/services/settings'

const MODEL_BASE_URL = 'https://model.example.org/v1'
const RESPONSES_URL = `${MODEL_BASE_URL}/responses`
const MODEL_API_KEY = 'model-key'
const TAVILY_API_KEY = 'tavily-secret'
const SOURCE_URL = 'https://sources.example.org/fixture'
const IMAGE_URL = 'data:image/png;base64,ZmFrZS1pbWFnZQ=='

const baseSettings: SearchSettings = {
  mode: 'auto',
  provider: 'tavily',
  apiKey: TAVILY_API_KEY,
  baseUrl: 'https://api.tavily.com',
  maxSearches: 2,
  maxPages: 3,
  timeoutSeconds: 120,
  requestTimeoutSeconds: 5,
  cacheTtlMinutes: 0,
}

const settings = (overrides: Partial<SearchSettings> = {}): SearchSettings => ({ ...baseSettings, ...overrides })

const config = {
  baseUrl: MODEL_BASE_URL,
  apiKey: MODEL_API_KEY,
  model: 'fixture',
}

const signal = () => new AbortController().signal

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

const nativeResponse = (suffix: string, text = '{"answer":"native"}') => jsonResponse({
  id: `response-${suffix}`,
  output: [
    {
      type: 'web_search_call',
      id: `search-${suffix}`,
      status: 'completed',
      action: {
        type: 'search',
        sources: [{ url: SOURCE_URL, title: 'Native fixture source' }],
      },
    },
    {
      type: 'message',
      id: `message-${suffix}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    },
  ],
})

type FetchCall = { url: string; init?: RequestInit }

type FetchFixtureOptions = {
  provider: SearchSettings['provider']
  searchResponse?: Response | (() => Response | Promise<Response>)
  searchError?: Error
  nativeResponse?: Response | (() => Response | Promise<Response>)
  nativeError?: Error
}

const isProviderSearchUrl = (url: string, provider: SearchSettings['provider']) => {
  if (provider === 'tavily') return url.endsWith('/search')
  if (provider === 'searxng') return new URL(url).pathname === '/search'
  return url.includes('bing.com')
}

const makeFetchFixture = (options: FetchFixtureOptions) => {
  const calls: FetchCall[] = []
  const searchCalls: FetchCall[] = []
  const nativeCalls: FetchCall[] = []
  let nativeCount = 0

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const call = { url, init }
    calls.push(call)

    if (url === RESPONSES_URL) {
      nativeCalls.push(call)
      if (options.nativeError) throw options.nativeError
      const value = typeof options.nativeResponse === 'function'
        ? await options.nativeResponse()
        : options.nativeResponse || nativeResponse(String(nativeCount++))
      return value
    }

    if (isProviderSearchUrl(url, options.provider)) {
      searchCalls.push(call)
      if (options.searchError) throw options.searchError
      if (typeof options.searchResponse === 'function') return await options.searchResponse()
      if (options.searchResponse) return options.searchResponse
      return jsonResponse({ results: [] })
    }

    throw new Error(`unexpected fixture URL: ${url}`)
  }) as typeof fetch

  return { fetcher, calls, searchCalls, nativeCalls }
}

const toolCall = {
  id: 'provider-search-call',
  type: 'function',
  function: { name: 'web_search', arguments: JSON.stringify({ query: 'fixture query' }) },
}

const makeProviderProcess = (seen: any[], finalText = '{"answer":"tavily"}') => async (input: any) => {
  seen.push(structuredClone(input))
  if (seen.length === 1) return { content: '', tool_calls: [toolCall] }
  return { content: finalText }
}

const runWithProviderFailure = async (provider: SearchSettings['provider'], fetchOptions: Omit<FetchFixtureOptions, 'provider'> = {}, overrides: Partial<SearchSettings> = {}) => {
  const fixture = makeFetchFixture({ provider, ...fetchOptions })
  const session = new SearchSession(settings({ ...overrides, provider }), fixture.fetcher)
  const processCalls: any[] = []
  const answer = await runModel({
    input: { messages: [{ role: 'user', content: 'Find the fixture evidence' }], stream: false },
    config,
    signal: signal(),
    search: session,
    process: makeProviderProcess(processCalls),
    fetcher: fixture.fetcher,
  })
  return { answer, fixture, session, processCalls }
}

describe('通用搜索失败后的同平台 Responses 内置搜索兜底', () => {
  const failures: Array<[string, Omit<FetchFixtureOptions, 'provider'>]> = [
    ['HTTP 432', { searchResponse: jsonResponse({ error: 'fixture' }, 432) }],
    ['HTTP 429', { searchResponse: jsonResponse({ error: 'fixture' }, 429) }],
    ['HTTP 500', { searchResponse: jsonResponse({ error: 'fixture' }, 500) }],
    ['空 results', { searchResponse: jsonResponse({ results: [] }) }],
    ['网络异常', { searchError: new Error('network fixture') }],
    ['坏 JSON', { searchResponse: new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } }) }],
    ['缺少 Tavily key', { searchResponse: jsonResponse({ results: [{ url: SOURCE_URL, content: 'should not be used' }] }) }],
  ]

  for (const [label, failure] of failures) test(`Tavily ${label} 触发一次原生搜索兜底且隔离凭据`, async () => {
    const { answer, fixture, session } = await runWithProviderFailure('tavily', failure, {
      apiKey: label === '缺少 Tavily key' ? '' : TAVILY_API_KEY,
    })

    expect(answer).toBe('{"answer":"native"}')
    expect(fixture.searchCalls).toHaveLength(label === '缺少 Tavily key' ? 0 : 1)
    expect(fixture.nativeCalls).toHaveLength(1)
    expect(fixture.nativeCalls[0].url).toBe(RESPONSES_URL)
    expect(fixture.nativeCalls[0].url).not.toContain('/v1/v1')
    expect(new Headers(fixture.nativeCalls[0].init?.headers).get('authorization')).toBe(`Bearer ${MODEL_API_KEY}`)
    expect(JSON.stringify(fixture.nativeCalls[0].init)).not.toContain(TAVILY_API_KEY)
    if (fixture.searchCalls.length) {
      expect(new Headers(fixture.searchCalls[0].init?.headers).get('authorization')).toBe(`Bearer ${TAVILY_API_KEY}`)
      expect(JSON.stringify(fixture.searchCalls[0].init)).not.toContain(MODEL_API_KEY)
    }
    expect(session.trace.sources.map(source => source.url)).toEqual([SOURCE_URL])
  })

  test('SearXNG HTTP 500 使用相同的原生 Responses 兜底路径', async () => {
    const { answer, fixture, session } = await runWithProviderFailure('searxng', {
      searchResponse: jsonResponse({ error: 'fixture' }, 500),
    }, { baseUrl: 'https://search.example.org' })

    expect(answer).toBe('{"answer":"native"}')
    expect(fixture.searchCalls).toHaveLength(1)
    expect(fixture.searchCalls[0].url).toContain('https://search.example.org/search?')
    expect(fixture.nativeCalls).toHaveLength(1)
    expect(session.nativeFallback?.reason).toContain('HTTP 500')
  })

  test('Bing 首次 fetch 和构造器直连重试都失败时进入原生兜底', async () => {
    const fixture = makeFetchFixture({ provider: 'bing', searchError: new Error('bing fetch failed') })
    let fallbackCalls = 0
    const session = new SearchSession(settings({ provider: 'bing', baseUrl: '', apiKey: '' }), fixture.fetcher, undefined, async () => {
      fallbackCalls++
      throw new Error('bing failed')
    })
    const processCalls: any[] = []
    const answer = await runModel({
      input: { messages: [{ role: 'user', content: 'Find the fixture evidence' }], stream: false },
      config,
      signal: signal(),
      search: session,
      process: makeProviderProcess(processCalls),
      fetcher: fixture.fetcher,
    })

    expect(answer).toBe('{"answer":"native"}')
    expect(fixture.searchCalls).toHaveLength(1)
    expect(fallbackCalls).toBe(1)
    expect(fixture.nativeCalls).toHaveLength(1)
    expect(session.nativeFallback?.reason).toContain('bing failed')
  })

  test('HTTP 200 有可用 Tavily 来源时直接完成，不切换 Responses', async () => {
    const { answer, fixture, session } = await runWithProviderFailure('tavily', {
      searchResponse: jsonResponse({ results: [{ url: SOURCE_URL, title: 'Tavily fixture', content: 'Tavily evidence' }] }),
    })

    expect(answer).toBe('{"answer":"tavily"}')
    expect(fixture.searchCalls).toHaveLength(1)
    expect(fixture.nativeCalls).toHaveLength(0)
    expect(session.nativeFallback).toBeUndefined()
    expect(session.trace.searches).toBe(1)
  })

  test('取消中的问题不触发搜索请求，也不启动原生兜底', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled fixture'))
    const fixture = makeFetchFixture({ provider: 'tavily', searchError: new Error('should not fetch') })
    const session = new SearchSession(settings(), fixture.fetcher)

    await expect(runModel({
      input: { messages: [{ role: 'user', content: 'Find the fixture evidence' }], stream: false },
      config,
      signal: controller.signal,
      search: session,
      process: makeProviderProcess([]),
      fetcher: fixture.fetcher,
    })).rejects.toThrow('cancelled fixture')

    expect(fixture.searchCalls).toHaveLength(0)
    expect(fixture.nativeCalls).toHaveLength(0)
    expect(session.nativeFallback).toBeUndefined()
  })

  test('自动模式失败后以原始消息重启，保留图片且不携带未完成工具历史', async () => {
    const fixture = makeFetchFixture({ provider: 'tavily', searchError: new Error('network fixture') })
    const session = new SearchSession(settings(), fixture.fetcher)
    const originalMessages = [{
      role: 'system',
      content: 'system fixture',
    }, {
      role: 'user',
      content: [
        { type: 'text', text: '请识别图片中的 fixture' },
        { type: 'image_url', image_url: { url: IMAGE_URL, detail: 'high' } },
      ],
    }]
    const processCalls: any[] = []
    const answer = await runModel({
      input: { messages: structuredClone(originalMessages), stream: false },
      config,
      signal: signal(),
      search: session,
      process: makeProviderProcess(processCalls),
      fetcher: fixture.fetcher,
    })

    expect(answer).toBe('{"answer":"native"}')
    expect(processCalls).toHaveLength(1)
    const body = JSON.parse(String(fixture.nativeCalls[0].init?.body))
    expect(body.input).toEqual(expect.arrayContaining([
      { role: 'system', content: [{ type: 'input_text', text: 'system fixture' }] },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '请识别图片中的 fixture' },
          { type: 'input_image', image_url: IMAGE_URL, detail: 'high' },
        ],
      },
    ]))
    expect(body.input.some((item: any) => item.type === 'function_call' || item.type === 'function_call_output')).toBe(false)
    expect(JSON.stringify(body.input)).not.toContain('provider-search-call')
  })

  test('maxSearches=1 时失败通用搜索仍允许一次内置搜索，预算分别记录', async () => {
    const { fixture, session } = await runWithProviderFailure('tavily', {
      searchError: new Error('network fixture'),
    }, { maxSearches: 1 })

    expect(fixture.searchCalls).toHaveLength(1)
    expect(fixture.nativeCalls).toHaveLength(1)
    expect(session.trace.searches).toBe(2)
    expect(session.searchBudgetUsed).toBe(1)
  })

  test('同一 SearchSession 记住 provider 失败，后续问题直接使用 Responses', async () => {
    const fixture = makeFetchFixture({ provider: 'tavily', searchError: new Error('network fixture') })
    const session = new SearchSession(settings({ maxSearches: 3 }), fixture.fetcher)
    const firstProcess: any[] = []
    const secondProcess: any[] = []
    const makeOptions = (content: string, processCalls: any[]) => ({
      input: { messages: [{ role: 'user', content }], stream: false },
      config,
      signal: signal(),
      search: session,
      process: makeProviderProcess(processCalls),
      fetcher: fixture.fetcher,
    })

    await runModel(makeOptions('first fixture question', firstProcess))
    await runModel(makeOptions('second fixture question', secondProcess))

    expect(fixture.searchCalls).toHaveLength(1)
    expect(fixture.nativeCalls).toHaveLength(2)
    expect(firstProcess).toHaveLength(1)
    expect(secondProcess).toHaveLength(0)
    expect(session.nativeFallback).toBeDefined()
  })

  const nativeFailures: Array<[string, FetchFixtureOptions]> = [
    ['空 Responses 输出', { provider: 'tavily', searchError: new Error('network fixture'), nativeResponse: jsonResponse({ id: 'empty', output: [] }) }],
    ['Responses 不支持', { provider: 'tavily', searchError: new Error('network fixture'), nativeResponse: jsonResponse({ error: { message: 'unsupported' } }, 400) }],
  ]

  for (const [label, fetchOptions] of nativeFailures) test(`${label}失败后不循环请求`, async () => {
    const fixture = makeFetchFixture(fetchOptions)
    const session = new SearchSession(settings(), fixture.fetcher)
    await expect(runModel({
      input: { messages: [{ role: 'user', content: 'Find the fixture evidence' }], stream: false },
      config,
      signal: signal(),
      search: session,
      process: makeProviderProcess([]),
      fetcher: fixture.fetcher,
    })).rejects.toThrow()

    expect(fixture.searchCalls).toHaveLength(1)
    expect(fixture.nativeCalls).toHaveLength(1)
  })
})
