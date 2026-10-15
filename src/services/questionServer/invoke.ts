import type { AIModel } from '../model/config'
import { buildPresetProcessModelJsCode, resolveExecutableModelJsCode, resolveRuntimeModelId } from '../model/protocol'
import { useSettings } from '../app/settings'
import { SearchSession } from '../search'
import { runModel } from '../modelRuntime'
import { isVisionEnabled } from '../modelCapabilities'
import { findQuestionImageMatches } from '../../utils/question/questionImage'
import { buildMultimodalContent, prepareVisionRequestContent } from './visionImage'
import { answerDeadlines, requestLogs, searchSessions, requestQuestionContexts } from './runtime'
import { applyOcsQuestionText, restoreOcsAnswerContent } from './ocsContext'
import { buildAnswerChatMessages } from '../../utils/answer/answerFewShot'
import { modelApi, settingsApi } from './deps'
import {
  createCancelledRequestError,
  formatModelCallError,
  isAbortLikeError,
} from './errors'
import {
  isRequestCancelled,
  registerAbortController,
  unregisterAbortController,
  updateStreamingReasoning,
  updateStreamingResponse,
  updateRequestDetailsWithModelReasoning,
} from './runtime'
import { getRequestAnswerContext, sendModelProgressToBackend } from './backend'

const { settings } = settingsApi
const { platforms } = modelApi

export const getModelRetryCount = () => {
  const n = Number(settings.modelRetryCount)
  if (!Number.isFinite(n) || n < 0) return 2
  return Math.min(10, Math.floor(n))
}

export const shouldSkipModelRetry = (_error: unknown, requestId: string) => {
  return isRequestCancelled(requestId)
}

export const withModelRetry = async <T>(
  requestId: string,
  label: string,
  enabled: boolean,
  fn: (attempt: number, maxAttempts: number) => Promise<T>,
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void
): Promise<T> => {
  const maxAttempts = enabled ? getModelRetryCount() + 1 : 1
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isRequestCancelled(requestId)) throw createCancelledRequestError()
    try {
      return await fn(attempt, maxAttempts)
    } catch (error) {
      lastError = error
      if (shouldSkipModelRetry(error, requestId) || attempt >= maxAttempts || Date.now() >= (answerDeadlines.get(requestId) || Infinity)) throw error
      console.warn(`[模型重试 ${attempt}/${maxAttempts}] ${label}:`, formatModelCallError(error))
      onRetry?.(attempt, maxAttempts, error)
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 400 * attempt)))
    }
  }
  throw lastError
}

export const stripMarkdownCodeBlock = (content: string): string => {
  return content.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')
}

/** 拼装多模型输出：成功内容或真实报错原文，不使用统一失败文案 */
export const formatModelOutputs = (
  entries: Array<{ model: { displayName: string }; response: string }>
): string => {
  const usable = entries.filter(e => (e.response || '').trim())
  if (usable.length === 0) return ''
  if (usable.length === 1) return usable[0].response
  return usable.map(e => `[${e.model.displayName}]\n${e.response}`).join('\n\n')
}

export const normalizeAnswerForComparison = (content: string): string => {
  return stripMarkdownCodeBlock(content || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const getMostFrequentSuccessfulAnswer = (responses: string[]): string => {
  const answerStats = new Map<string, { count: number; firstIndex: number; original: string }>()

  responses.forEach((response, index) => {
    const original = stripMarkdownCodeBlock(response).trim()
    const key = normalizeAnswerForComparison(original)
    if (!key) return

    const existing = answerStats.get(key)
    if (existing) {
      existing.count += 1
      return
    }

    answerStats.set(key, {
      count: 1,
      firstIndex: index,
      original,
    })
  })

  let selected: { count: number; firstIndex: number; original: string } | null = null
  for (const stat of answerStats.values()) {
    if (
      !selected ||
      stat.count > selected.count ||
      (stat.count === selected.count && stat.firstIndex < selected.firstIndex)
    ) {
      selected = stat
    }
  }

  return selected?.original || ''
}

export const getReasoningContentValue = (payload: any): string => {
  const candidates = [
    payload?.reasoning_content,
    payload?.reasoningContent,
    payload?.reasoning,
    payload?.delta?.reasoning_content,
    payload?.delta?.reasoningContent,
    payload?.delta?.reasoning,
    payload?.message?.reasoning_content,
    payload?.message?.reasoningContent,
    payload?.message?.reasoning,
    payload?.choices?.[0]?.delta?.reasoning_content,
    payload?.choices?.[0]?.delta?.reasoningContent,
    payload?.choices?.[0]?.delta?.reasoning,
    payload?.choices?.[0]?.message?.reasoning_content,
    payload?.choices?.[0]?.message?.reasoningContent,
    payload?.choices?.[0]?.message?.reasoning
  ]

  const reasoning = candidates.find(value => typeof value === 'string' && value.length > 0)
  return typeof reasoning === 'string' ? reasoning : ''
}


export const callModelWithStreaming = async (

  model: AIModel,
  query: string,
  requestId: string,
  onChunk?: (content: string) => void,
  onReasoning?: (text: string) => void,
  allowSearch = true
) => {
  if (isRequestCancelled(requestId)) {
    throw createCancelledRequestError()
  }

  const runtimeModelId = resolveRuntimeModelId(model)
  const platform = platforms.value.find(p => p.models.some(m => m.id === model.id))
  const useNativeSearch = allowSearch && answerDeadlines.has(requestId) && settings.search.mode !== 'off' && settings.search.provider === 'native'
  const executableCode = useNativeSearch
    ? buildPresetProcessModelJsCode({ ...model, protocol: 'openai-response', modelId: runtimeModelId })
    : resolveExecutableModelJsCode(model, platform)

  if (!platform) {
    console.error('未找到模型所属平台 - 详细信息:')
    console.error('- 模型ID:', model.id)
    console.error('- 模型平台ID:', model.platformId)
    console.error('- 所有平台:', platforms.value.map(p => ({
      id: p.id,
      name: p.displayName,
      modelIds: p.models.map(m => m.id)
    })))
    throw new Error('未找到模型所属平台')
  }

  const questionContext = allowSearch ? requestQuestionContexts.get(requestId) : undefined
  if (questionContext?.images.length && !isVisionEnabled(model)) {
    throw new Error('本题包含上传图片，请为此模型启用视觉')
  }
  // 普通答题保留例题对话，图片与文本分开传递。
  const testInput: any = {
    messages: buildAnswerChatMessages(applyOcsQuestionText(query, questionContext)),
    model: runtimeModelId,
    stream: true,
    tools: []
  }

  if (isVisionEnabled(model) && (questionContext?.images.length || findQuestionImageMatches(query).length > 0)) {
    const questionMessage = testInput.messages[testInput.messages.length - 1]
    questionMessage.content = await prepareVisionRequestContent(await buildMultimodalContent(query, questionContext))
  }

  // 构建配置对象
  const config = {
    ...model,
    protocol: useNativeSearch ? 'openai-response' : platform.apiProtocol,
    apiKey: platform.apiKey, customHeaders: platform.customHeaders,
    baseUrl: platform.baseUrl,
    model: runtimeModelId,
    modelId: runtimeModelId
  }

  // 读取超时配置（秒转毫秒）
  const { settings: appSettings } = useSettings()
  const searchEnabled = allowSearch && answerDeadlines.has(requestId) && appSettings.search.mode !== 'off'
  const remaining = (answerDeadlines.get(requestId) || Infinity) - Date.now()
  if (remaining <= 0) throw new Error('整题答题时间已用完，答案待复核')
  const timeoutMs = Math.min(remaining, searchEnabled ? appSettings.search.timeoutSeconds * 1000 : (appSettings.modelResponseTimeout ?? 40) * 1000)

  // AbortController 用于超时中断 fetch
  const abortController = new AbortController()
  registerAbortController(requestId, abortController)
  const timeoutHandle = setTimeout(() => {
    if (!isRequestCancelled(requestId)) {
      abortController.abort(new DOMException(`模型响应超时（${Math.round(timeoutMs / 1000)} 秒）`, 'TimeoutError'))
    } else {
      abortController.abort()
    }
  }, timeoutMs)

  const tauriHttp = await import('@tauri-apps/plugin-http')
  const { invoke } = await import('@tauri-apps/api/core')
  const tauriFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    try {
      return await tauriHttp.fetch(input as any, {
        ...init,
        credentials: init.credentials ?? 'include',
        signal: init.signal ?? abortController.signal
      } as any)
    } catch (error) {
      if (isAbortLikeError(error)) throw error
      throw new Error(formatModelCallError(error, '网络请求失败'))
    }
  }

  // 执行JavaScript配置代码
  if (executableCode) {
    // 创建一个安全的执行环境
    let processModel

    if (executableCode.startsWith('async function') || executableCode.startsWith('function')) {
      const safeEval = new Function('input', 'config', 'fetch', 'abortSignal', `
        ${executableCode}
        return processModel;
      `)
      processModel = safeEval(testInput, config, tauriFetch, abortController.signal)
    } else {
      const wrapperFunction = new Function('input', 'config', 'fetch', 'abortSignal', `
        return (async function processModel(input, config) {
          ${executableCode}
        });
      `)
      processModel = wrapperFunction(testInput, config, tauriFetch, abortController.signal)
    }

    let keepaliveTimer: ReturnType<typeof setInterval> | null = null
    try {
      void sendModelProgressToBackend(requestId, 'started')
      keepaliveTimer = setInterval(() => void sendModelProgressToBackend(requestId, 'keepalive'), 2000)
      let session: SearchSession | undefined
      if (searchEnabled) {
        session = searchSessions.get(requestId)
        if (!session) {
          session = new SearchSession({ ...appSettings.search }, tauriFetch as typeof fetch, trace => {
            const log = requestLogs.value.find(l => l.id === requestId)
            if (log) log.searchTrace = trace
          })
          searchSessions.set(requestId, session)
        }

      }
      const response = await runModel({
        input: testInput, config, signal: abortController.signal, process: processModel,
        fetcher: tauriFetch as typeof fetch, search: session,
        nativeSearch: session?.settings.provider === 'native',
        searchQuery: questionContext?.title || getRequestAnswerContext(requestId, query).title,
        onContent: text => { if (onChunk) onChunk(text); else updateStreamingResponse(requestId, text) },
        onReasoning: text => { if (onReasoning) onReasoning(text); else updateStreamingReasoning(requestId, text) },
      })
      return restoreOcsAnswerContent(response, questionContext)
    } catch (error) {
      if (isRequestCancelled(requestId)) {
        throw createCancelledRequestError()
      }
      if (isAbortLikeError(error)) {
        throw new Error(`模型响应超时（${Math.round(timeoutMs / 1000)} 秒）或连接被中断`)
      }
      throw new Error(formatModelCallError(error))
    } finally {
      clearTimeout(timeoutHandle)
      if (keepaliveTimer !== null) clearInterval(keepaliveTimer)
      unregisterAbortController(requestId, abortController)
    }
  } else {
    clearTimeout(timeoutHandle)
    unregisterAbortController(requestId, abortController)
    throw new Error('模型未配置可执行代码')
  }
}


export const callModel = async (model: AIModel, query: string) => {
  const runtimeModelId = resolveRuntimeModelId(model)
  // 获取模型所属的平台
  const platform = platforms.value.find(p => p.models.some(m => m.id === model.id))
  const executableCode = resolveExecutableModelJsCode(model, platform)
  if (!platform) {
    throw new Error('未找到模型所属平台')
  }

  // 构建测试输入数据
  const testInput = {
    messages: [
      {
        role: 'user',
        content: query
      }
    ],
    model: runtimeModelId,
    stream: true
  }

  // 构建配置对象
  const config = {
    ...model,
    protocol: platform.apiProtocol,
    apiKey: platform.apiKey, customHeaders: platform.customHeaders,
    baseUrl: platform.baseUrl,
    model: runtimeModelId,
    modelId: runtimeModelId
  }

  const tauriHttp = await import('@tauri-apps/plugin-http')
  const tauriFetch = (input: RequestInfo | URL, init: RequestInit = {}) =>
    tauriHttp.fetch(input as any, {
      ...init,
      credentials: init.credentials ?? 'include'
    } as any)

  // 执行JavaScript配置代码
  if (executableCode) {
    // 创建一个安全的执行环境
    let processModel

    if (executableCode.startsWith('async function') || executableCode.startsWith('function')) {
      // 如果是完整的函数声明，使用eval在安全环境中执行
      const safeEval = new Function('input', 'config', 'fetch', `
        ${executableCode}
        return processModel;
      `)
      processModel = safeEval(testInput, config, tauriFetch)
    } else {
      // 如果是函数体，包装为async函数
      const wrapperFunction = new Function('input', 'config', 'fetch', `
        return (async function processModel(input, config) {
          ${executableCode}
        });
      `)
      processModel = wrapperFunction(testInput, config, tauriFetch)
    }

    // 执行模型调用
    const result = await processModel(testInput, config, tauriFetch)

    if (result) {
      // 如果返回的是生成器或异步迭代器，收集结果
      if (result[Symbol.asyncIterator]) {
        let fullResponse = ''
        for await (const chunk of result) {
          if (chunk.content) {
            fullResponse += chunk.content
          }
        }
        return fullResponse
      } else {
        return result
      }
    } else {
      throw new Error('模型配置代码未返回有效结果')
    }
  } else {
    throw new Error('模型未配置可执行代码')
  }
}

