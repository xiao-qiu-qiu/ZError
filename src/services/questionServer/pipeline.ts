import { callModelAPI } from './answerCall'
import { handleSameQuestionCheckRequest } from './sameQuestion'
import { handleUrlQuestionRequest } from './urlQuestion'
import { settingsApi } from './deps'
import { answerDeadlines, searchSessions, rememberRequestQuestionContext } from './runtime'
import { readOcsQuestionContext } from './ocsContext'

const { settings } = settingsApi

export { getRequestReasoningForBackend, callSingleModelAPI, callModelAPI } from './answerCall'
export {
  buildSameQuestionCheckPrompt,
  parseSameQuestionCheckResult,
  handleSameQuestionCheckRequest,
} from './sameQuestion'
export {
  currentUrlWindowId,
  handleUrlQuestionRequest,
  getExistingQuestions,
  saveQuestionsToStorage,
  checkAndShowUrlDialog,
  analyzeUrlQuestion,
} from './urlQuestion'

export const inflightModelCallKeys = new Set<string>()

export const modelCallPhase = (query: string) => {
  if (query.startsWith('__URL_QUESTION__:')) return 'url'
  if (query.startsWith('__SAME_QUESTION_CHECK__:')) return 'same'
  return 'answer'
}

/** SSE / Tauri 双通道入口 */
export const dispatchModelCallRequest = (requestId: string, query: string, questionContext?: unknown) => {
  if (!requestId || typeof query !== 'string') return
  const phase = modelCallPhase(query)
  const context = readOcsQuestionContext(questionContext)
  if (context && phase !== 'same') rememberRequestQuestionContext(requestId, context)
  const key = `${requestId}:${phase}`
  console.log('模型调用请求数据:', { requestId, phase, query: query.slice(0, 120) })

  if (inflightModelCallKeys.has(key)) {
    console.warn('忽略重复的模型调用请求:', key)
    return
  }
  inflightModelCallKeys.add(key)
  if (!answerDeadlines.has(requestId)) {
    const budget = settings.search.mode === 'off' ? settings.modelResponseTimeout * (1 + settings.modelRetryCount) + 60 : settings.search.timeoutSeconds
    const deadline = Date.now() + budget * 1000
    answerDeadlines.set(requestId, deadline)
    setTimeout(() => { if (answerDeadlines.get(requestId) === deadline) { answerDeadlines.delete(requestId); searchSessions.delete(requestId) } }, (budget + 30) * 1000)
  }

  const done = () => { inflightModelCallKeys.delete(key) }

  if (phase === 'url') {
    void handleUrlQuestionRequest(requestId, query.slice('__URL_QUESTION__:'.length)).finally(done)
    return
  }

  if (phase === 'same') {
    void handleSameQuestionCheckRequest(requestId, query.slice('__SAME_QUESTION_CHECK__:'.length)).finally(done)
    return
  }

  void callModelAPI(requestId, query).finally(done)
}
