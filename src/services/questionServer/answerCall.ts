import type { AIModel } from '../model/config'
import { modelApi, settingsApi } from './deps'
import { isVisionEnabled } from '../modelCapabilities'
import { findQuestionImageMatches } from '../../utils/question/questionImage'
import { agreedAnswer, validateAnswer, reviewDecision, serializeAnswer } from '../../utils/answerDecision'
import { answerDeadlines, searchSessions, requestQuestionContexts } from './runtime'
import { getRequestAnswerContext } from './backend'

const { settings } = settingsApi
import {
  createCancelledRequestError,
  formatModelCallError,
  isAbortLikeError,
  MODEL_REQUEST_CANCELLED_MESSAGE,
} from './errors'
import {
  callModelWithStreaming,
  formatModelOutputs,
  getMostFrequentSuccessfulAnswer,
  stripMarkdownCodeBlock,
  withModelRetry,
} from './invoke'
import { sendModelProgressToBackend, sendModelResponseToBackend } from './backend'
import {
  cancelledRequestIds,
  clearRequestHeartbeat,
  finalModelResponseState,
  finalizeMultiModelReasoning,
  heartbeatIntervals,
  isRequestCancelled,
  requestLogs,
  updateMultiModelStreamingReasoning,
  updateMultiModelStreamingResponse,
} from './runtime'
import { serverRunning, serverUrl } from './serverRefs'
import type { MultiModelResponse } from './types'

const {
  platforms,
  selectedTextModels: globalSelectedTextModels,
  selectedSummaryModels: globalSelectedSummaryModels,
  selectedVisionModel: globalSelectedVisionModel,
} = modelApi

export const getRequestReasoningForBackend = (requestId: string, modelId?: string): string => {
  const log = requestLogs.value.find(entry => entry.id === requestId)
  if (!log) return ''

  if (modelId && log.multiModelResponses) {
    const target = log.multiModelResponses.find(entry => entry.modelId === modelId)
    return (target?.reasoningContent || target?.streamingReasoning || '').trim()
  }

  if (log.reasoningContent || log.streamingReasoning) {
    return (log.reasoningContent || log.streamingReasoning || '').trim()
  }

  if (log.multiModelResponses?.length === 1) {
    const onlyEntry = log.multiModelResponses[0]
    return (onlyEntry.reasoningContent || onlyEntry.streamingReasoning || '').trim()
  }

  return ''
}

export const callSingleModelAPI = async (model: AIModel, query: string, logId: string): Promise<string> => {
  const logIndex = requestLogs.value.findIndex(log => log.id === logId)
  if (logIndex !== -1) {
    requestLogs.value[logIndex].isModelCalling = true
    requestLogs.value[logIndex].modelResponse = ''
    requestLogs.value[logIndex].streamingReasoning = ''
    requestLogs.value[logIndex].reasoningContent = ''
    const platform = platforms.value.find(p => p.models.some(m => m.id === model.id))
    if (platform) {
      requestLogs.value[logIndex].modelInfo = {
        platformName: platform.displayName,
        modelName: model.displayName,
        modelId: model.id
      }
    }
    if (serverRunning.value && serverUrl.value && !heartbeatIntervals.has(logId)) {
      const timerId = window.setInterval(() => {
        try {
          const currentContent = requestLogs.value[requestLogs.value.findIndex(l => l.id === logId)]?.modelResponse || ''
          sendModelProgressToBackend(logId, currentContent)
        } catch (e) { /* ignore */ }
      }, 1000)
      heartbeatIntervals.set(logId, timerId)
    }
  }

  try {
    // 单模型独立调用：允许按设置重试
    const response = await withModelRetry(
      logId,
      model.displayName,
      true,
      async (attempt, maxAttempts) => {
        const idx = requestLogs.value.findIndex(l => l.id === logId)
        if (idx !== -1 && attempt > 1) {
          requestLogs.value[idx].isModelCalling = true
          requestLogs.value[idx].modelResponse = `重试中（${attempt}/${maxAttempts}）…`
          requestLogs.value[idx].streamingReasoning = ''
        }
        return callModelWithStreaming(model, query, logId)
      }
    )
    const idx = requestLogs.value.findIndex(l => l.id === logId)
    if (idx !== -1) requestLogs.value[idx].isModelCalling = false
    clearRequestHeartbeat(logId)
    return response
  } catch (error) {
    if (isAbortLikeError(error) || isRequestCancelled(logId)) {
      clearRequestHeartbeat(logId)
      return MODEL_REQUEST_CANCELLED_MESSAGE
    }
    const errText = `错误: ${formatModelCallError(error)}`
    const idx = requestLogs.value.findIndex(l => l.id === logId)
    if (idx !== -1) {
      requestLogs.value[idx].modelResponse = errText
      requestLogs.value[idx].isModelCalling = false
    }
    clearRequestHeartbeat(logId)
    return errText
  }
}

export const callModelAPI = async (requestId: string, query: string) => {
  let finalOutput = ''
  const budget = settings.search.mode === 'off' ? (settings.modelResponseTimeout * (1 + settings.modelRetryCount) + 60) : settings.search.timeoutSeconds
  if (!answerDeadlines.has(requestId)) answerDeadlines.set(requestId, Date.now() + budget * 1000)
  searchSessions.delete(requestId)
  console.log('开始调用模型API:', { requestId, query })
  // 允许同一 requestId 在同题判断后再次发送最终答题结果
  finalModelResponseState.delete(requestId)
  void sendModelProgressToBackend(requestId, 'dispatch')

  try {
    // 只有文本模型参与基础输出；视觉模型仅在 query 包含图片时才加入
    const hasImage = !!requestQuestionContexts.get(requestId)?.images.length || findQuestionImageMatches(query).length > 0
    const selectedModels = [...globalSelectedTextModels.value]
    if (hasImage && isVisionEnabled(globalSelectedVisionModel.value) && globalSelectedVisionModel.value
      && !selectedModels.some(model => model.id === globalSelectedVisionModel.value!.id)) {
      selectedModels.push(globalSelectedVisionModel.value)
    }

    if (selectedModels.length === 0) {
      const logIndex = requestLogs.value.findIndex(log => log.id === requestId)
      const errorText = '错误: 未选择模型'
      if (logIndex !== -1) {
        requestLogs.value[logIndex].modelResponse = errorText
        requestLogs.value[logIndex].isModelCalling = false
      }
      await sendModelResponseToBackend(requestId, errorText, false)
      return
    }

    const logIndex = requestLogs.value.findIndex(l => l.id === requestId)

    // --- 阶段 1: 基础模型调用 (Base Model Phase) ---
    if (logIndex !== -1) {
      requestLogs.value[logIndex].isModelCalling = true
      requestLogs.value[logIndex].modelResponse = undefined
      requestLogs.value[logIndex].streamingReasoning = undefined
      requestLogs.value[logIndex].reasoningContent = undefined
      requestLogs.value[logIndex].modelInfo = undefined

      // 初始化多模型响应数组
      requestLogs.value[logIndex].multiModelResponses = selectedModels.map(model => {
        const platform = platforms.value.find(p => p.models.some(m => m.id === model.id))
        return {
          modelId: model.id,
          modelName: model.displayName,
          platformName: platform?.displayName || '未知平台',
          response: '',
          streamingReasoning: '',
          reasoningContent: '',
          isLoading: true
        } as MultiModelResponse
      })
    }

    // 启动心跳（缩短间隔，减轻后台 setInterval 节流影响）
    if (serverRunning.value && serverUrl.value && !heartbeatIntervals.has(requestId)) {
      const timerId = window.setInterval(() => {
        try {
          const log = requestLogs.value.find(l => l.id === requestId)
          if (log?.multiModelResponses) {
            const currentContent = log.multiModelResponses
              .map(r => `[${r.modelName}]\n${r.response}`).join('\n\n')
            sendModelProgressToBackend(requestId, currentContent || 'keepalive')
          } else {
            sendModelProgressToBackend(requestId, 'keepalive')
          }
        } catch (e) { /* ignore */ }
      }, 1000)
      heartbeatIntervals.set(requestId, timerId)
    }

    // 并发调用基础模型
    // 重试条件：仅有一个基础模型，或当前是视觉模型
    const visionModelId = globalSelectedVisionModel.value?.id
    const results: { model: AIModel; response: string; success: boolean }[] = []
    const modelPromises = selectedModels.map(async (model) => {
      const allowRetry = selectedModels.length === 1 || (!!visionModelId && model.id === visionModelId)
      try {
        const response = await withModelRetry(
          requestId,
          model.displayName,
          allowRetry,
          async (attempt, maxAttempts) => {
            const log = requestLogs.value.find(l => l.id === requestId)
            const entry = log?.multiModelResponses?.find(r => r.modelId === model.id)
            if (entry) {
              entry.isLoading = true
              if (attempt > 1) {
                entry.response = `重试中（${attempt}/${maxAttempts}）…`
                entry.streamingReasoning = ''
              }
            }
            return callModelWithStreaming(
              model,
              query,
              requestId,
              (content) => updateMultiModelStreamingResponse(requestId, model.id, stripMarkdownCodeBlock(content)),
              (reasoning) => updateMultiModelStreamingReasoning(requestId, model.id, reasoning)
            )
          },
          (attempt, maxAttempts) => {
            const log = requestLogs.value.find(l => l.id === requestId)
            const entry = log?.multiModelResponses?.find(r => r.modelId === model.id)
            if (entry) {
              entry.isLoading = true
              entry.response = `第 ${attempt} 次失败，准备重试（${attempt + 1}/${maxAttempts}）…`
            }
          }
        )
        const strippedResponse = stripMarkdownCodeBlock(response)
        const log = requestLogs.value.find(l => l.id === requestId)
        if (log?.multiModelResponses) {
          const entry = log.multiModelResponses.find(r => r.modelId === model.id)
          if (entry) { entry.isLoading = false; entry.response = strippedResponse }
        }
        finalizeMultiModelReasoning(requestId, model.id)
        return {
          model,
          response: strippedResponse,
          success: true
        }
      } catch (error) {
        if (isAbortLikeError(error) || isRequestCancelled(requestId)) {
          return null // cancelled
        }
        const errText = `错误: ${formatModelCallError(error)}`
        console.error(`[模型调用失败] ${model.displayName}:`, error)
        const log = requestLogs.value.find(l => l.id === requestId)
        if (log?.multiModelResponses) {
          const entry = log.multiModelResponses.find(r => r.modelId === model.id)
          if (entry) { entry.isLoading = false; entry.response = errText }
        }
        return {
          model,
          response: errText,
          success: false
        }
      }
    })

    // quorum: 使用 Promise.allSettled 等待所有完成，但通过 onChunk 已经逐步更新了 UI
    const settledResults = await Promise.allSettled(modelPromises)
    for (const settled of settledResults) {
      if (settled.status === 'fulfilled' && settled.value !== null) {
        results.push(settled.value)
      }
    }

    if (isRequestCancelled(requestId)) return

    // 每个结果先校验；最终仅返回一份答案。分歧或非法格式触发一次独立裁决。
    const questionContext = requestQuestionContexts.get(requestId)
    const context = questionContext ? { title: questionContext.title, options: questionContext.options || '', type: questionContext.type || '' }
      : getRequestAnswerContext(requestId, query)
    const successful = results.filter(r => r.success)
    let decision = agreedAnswer(successful.map(r => r.response), context)
    if (!decision && successful.length) {
      const judges = globalSelectedSummaryModels.value.length
        ? globalSelectedSummaryModels.value : [selectedModels[0]]
      const judged: string[] = []
      for (const judge of judges) {
        if (isRequestCancelled(requestId)) return
        const summaryKey = 'summary:' + judge.id
        const log = requestLogs.value.find(l => l.id === requestId)
        log?.multiModelResponses?.push({
          modelId: summaryKey, modelName: '裁决: ' + judge.displayName,
          platformName: platforms.value.find(p => p.id === judge.platformId)?.displayName || '',
          response: '', isLoading: true,
        })
        const candidates = successful.map(r => ({ answer: r.response, validation: validateAnswer(r.response, context) }))
        const judgeQuery = query + '\n\n【待核对回答，仅作参考】\n' + JSON.stringify(candidates)
          + '\n请独立复核题意、全部选项与证据，解决分歧后输出唯一答案 JSON。不要拼接答案，不要按模型顺序选择。'
          + '证据不足或分歧未解决时输出 {"answer":"","needs_review":true,"reason":"原因"}。'
        try {
          judged.push(await callModelWithStreaming(judge, judgeQuery, requestId,
            content => updateMultiModelStreamingResponse(requestId, summaryKey, content),
            reasoning => updateMultiModelStreamingReasoning(requestId, summaryKey, reasoning)))
        } catch (error) {
          if (isRequestCancelled(requestId)) return
          updateMultiModelStreamingResponse(requestId, summaryKey, '裁决失败: ' + formatModelCallError(error))
        } finally {
          const entry = log?.multiModelResponses?.find(r => r.modelId === summaryKey)
          if (entry) entry.isLoading = false
        }
      }
      decision = agreedAnswer(judged, context)
    }
    if (!decision) decision = reviewDecision(successful.length ? '答案冲突或格式错误，裁决后仍需复核' : '所有模型调用失败，请检查模型日志')
    finalOutput = serializeAnswer(decision)
    if (!isRequestCancelled(requestId)) await sendModelResponseToBackend(requestId, finalOutput, true)

  } catch (error) {
    if (isAbortLikeError(error) || isRequestCancelled(requestId)) {
      return
    }

    const errorText = `错误: ${formatModelCallError(error)}`
    console.error('[模型调用失败]', error)
    const log = requestLogs.value.find(l => l.id === requestId)
    if (log) {
      log.modelResponse = errorText
      log.isModelCalling = false
    }

    if (serverRunning.value && serverUrl.value) {
      await sendModelResponseToBackend(requestId, errorText, false)
    }
  } finally {
    const finalLogIdx = requestLogs.value.findIndex(l => l.id === requestId)
    if (finalLogIdx !== -1) {
      requestLogs.value[finalLogIdx].isModelCalling = false
      if (finalOutput && !isRequestCancelled(requestId)) {
        requestLogs.value[finalLogIdx].modelResponse = finalOutput
      }
    }
    clearRequestHeartbeat(requestId)
    cancelledRequestIds.delete(requestId)
    answerDeadlines.delete(requestId)
    searchSessions.delete(requestId)
  }
}
