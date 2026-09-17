import { describe, expect, test } from 'bun:test'
import { runModel } from '../src/services/modelRuntime'
import { SearchSession } from '../src/services/search'
import { buildPresetProcessModelJsCode } from '../src/services/modelProtocol'

const settings = { mode: 'always' as const, provider: 'searxng' as const, apiKey: '', baseUrl: 'https://search.example.org', maxSearches: 2, maxPages: 3, timeoutSeconds: 120, requestTimeoutSeconds: 20, cacheTtlMinutes: 0 }
const signal = () => new AbortController().signal
const fixtureFetch = (async () => Response.json({ results: [{ url: 'https://example.org/fact', title: 'Fixture', content: 'Evidence 42' }] })) as typeof fetch

describe('tool loop and protocol replay', () => {
  for (const stream of [false, true]) test(`executes tools and returns only final answer (stream=${stream})`, async () => {
    let count = 0
    const session = new SearchSession(settings, fixtureFetch)
    const input = { messages: [{ role: 'user', content: 'Find the fixture' }], stream }
    const response = await runModel({ input, config: {}, signal: signal(), search: session, fetcher: fixtureFetch,
      process: async (i) => {
        count++
        if (count === 1) {
          const tc = { index: 0, id: 'call1', function: { name: 'web_search', arguments: '{"query":"fixture"}' } }
          if (!stream) return { content: 'I will search', tool_calls: [tc] }
          return (async function* () {
            yield { content: 'I will search', tool_calls: [{ ...tc, function: { name: 'web_search', arguments: '{"query":' } }] }
            yield { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] }
          })()
        }
        expect(i.messages.at(-1).role).toBe('tool')
        expect(i.messages.at(-1).content).toContain('Evidence 42')
        return { content: '{"answer":"42"}' }
      } })
    expect(response).toBe('{"answer":"42"}')
    expect(count).toBe(2)
    expect(session.trace.sources).toHaveLength(1)
  })

  test('required native search cannot succeed by claiming it searched', async () => {
    await expect(runModel({ input: { messages: [] }, config: {}, signal: signal(), fetcher: fixtureFetch, nativeSearch: true,
      search: new SearchSession(settings, fixtureFetch), process: async () => ({ content: '{"answer":"claimed"}' }) })).rejects.toThrow('真实搜索来源')
  })

  test('native evidence is deduplicated across completed events', async () => {
    const session = new SearchSession(settings, fixtureFetch)
    const item = { id: 'ws1', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://example.org/fact', title: 'Fact' }] } }
    session.nativeEvent(item); session.nativeEvent(item)
    expect(session.trace.searches).toBe(1)
    expect(session.trace.sources).toHaveLength(1)
  })

  test('auto native search with no sources does not claim verification', async () => {
    const session = new SearchSession({ ...settings, mode: 'auto' }, fixtureFetch)
    await expect(runModel({ input: { messages: [] }, config: {}, signal: signal(), search: session, nativeSearch: true, fetcher: fixtureFetch,
      process: async () => ({ content: '{"answer":"42"}', search_items: [{ id: 'empty', type: 'web_search_call', status: 'completed', action: { type: 'search' } }] })
    })).rejects.toThrow('缺少来源')
    expect(session.trace.state).toBe('unavailable')
  })

  test('cancelling one shared search consumer leaves another intact', async () => {
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetcher = (async (_url, init) => {
      calls++; await gate
      expect(init?.signal?.aborted).toBe(false)
      return Response.json({ results: [{ url: 'https://example.org/fact', title: 'Fact', content: '42' }] })
    }) as typeof fetch
    const session = new SearchSession(settings, fetcher)
    const first = new AbortController(), second = new AbortController()
    const a = session.execute('web_search', '{"query":"same"}', first.signal).catch(() => 'cancelled')
    const b = session.execute('web_search', '{"query":"same"}', second.signal)
    first.abort(); release()
    expect(await a).toBe('cancelled')
    expect(await b).toContain('42')
    expect(calls).toBe(1)
  })

  test('Anthropic SSE empty input plus JSON deltas yields valid arguments', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"fixture"}' } },
    ]
    const fetcher = (async () => new Response(events.map(e => 'data: ' + JSON.stringify(e)).join('\r\n\r\n') + '\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch
    const process = new Function(buildPresetProcessModelJsCode({ protocol: 'anthropic' }) + ';return processModel')()
    const stream = await process({ messages: [], stream: true }, { baseUrl: 'https://example.org' }, fetcher, signal())
    let args = ''
    for await (const chunk of stream) args += chunk.tool_calls?.[0]?.function?.arguments || ''
    expect(JSON.parse(args)).toEqual({ query: 'fixture' })
  })

  for (const protocol of ['openai-chat', 'openai-response', 'anthropic'] as const) test(`${protocol} replays tool IDs and handles base /v1 once`, async () => {
    let payload: any, endpoint = ''
    const fetcher = (async (url, init) => {
      endpoint = String(url); payload = JSON.parse(String(init?.body))
      return Response.json(protocol === 'anthropic' ? { content: [{ type: 'text', text: 'ok' }] } : protocol === 'openai-response' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } : { choices: [{ message: { content: 'ok' } }] })
    }) as typeof fetch
    const process = new Function(buildPresetProcessModelJsCode({ protocol, modelId: 'fixture' }) + ';return processModel')()
    await process({ stream: false, messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'web_search', arguments: '{"query":"q"}' } }] },
      { role: 'tool', tool_call_id: 'call1', content: 'result' },
    ] }, { baseUrl: 'https://example.org/v1/', apiKey: 'fixture' }, fetcher, signal())
    expect(endpoint).not.toContain('/v1/v1')
    if (protocol === 'openai-response') {
      expect(payload.input[0].type).toBe('function_call')
      expect(payload.input[1]).toEqual({ type: 'function_call_output', call_id: 'call1', output: 'result' })
    } else if (protocol === 'anthropic') {
      expect(payload.messages[0].content[0].type).toBe('tool_use')
      expect(payload.messages[1].content[0].tool_use_id).toBe('call1')
    } else expect(payload.messages[1].tool_call_id).toBe('call1')
  })
})
