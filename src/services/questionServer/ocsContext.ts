import { answerObjects, parseOptions } from '../../utils/answerDecision'
import type { RequestLog } from './types'

export interface OcsQuestionContext {
  title: string
  options?: string | null
  type?: string | null
  images: string[]
  suggestion_title?: string | null
  suggestion_options?: string | null
}

export const upsertStartedQuestionLog = (logs: RequestLog[], incoming: RequestLog): RequestLog => {
  const existing = logs.find(log => log.id === incoming.id)
  if (!existing) { logs.unshift(incoming); return incoming }
  const completion = existing.stage === 'completed' ? {
    stage: existing.stage, status: existing.status,
    responseBody: existing.responseBody, responseTime: existing.responseTime,
  } : {}
  Object.assign(existing, incoming, completion)
  return existing
}

export const readOcsQuestionContext = (value: unknown): OcsQuestionContext | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const data = value as OcsQuestionContext
  if (typeof data.title !== 'string') return undefined
  if (data.images !== undefined && (!Array.isArray(data.images) || data.images.some(image => typeof image !== 'string'))) {
    throw new Error('OCS images 必须是图片字符串数组')
  }
  const suggestion = (value: unknown, field: string) => typeof value === 'string' && value.trim() !== '${' + field + '}' ? value : ''
  return {
    title: data.title,
    options: typeof data.options === 'string' ? data.options : '',
    type: typeof data.type === 'string' ? data.type : '',
    images: data.images || [],
    suggestion_title: suggestion(data.suggestion_title, 'suggestion_title'),
    suggestion_options: suggestion(data.suggestion_options, 'suggestion_options'),
  }
}

export const getOcsQuestionText = (context: OcsQuestionContext) => ({
  title: context.images.length ? context.suggestion_title || context.title : context.title,
  options: context.images.length ? context.suggestion_options || context.options || '' : context.options || '',
})

export const applyOcsQuestionText = (text: string, context?: OcsQuestionContext): string => {
  if (!context?.images.length) return text
  const replacements = [
    [context.title, context.suggestion_title],
    [context.options, context.suggestion_options],
  ].filter((pair): pair is [string, string] => !!pair[0] && !!pair[1])
    .sort((a, b) => b[0].length - a[0].length)
  if (!replacements.length) return text
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(replacements.map(([from]) => escape(from)).join('|'), 'g')
  return text.replace(pattern, match => replacements.find(([from]) => from === match)![1])
}

/** OCS 的 PNG 标签有时包着 JPEG 等原始字节，按签名纠正 MIME。 */
export const normalizeOcsImageDataUrl = (value: string): string => {
  const match = value.match(/^data:[^,]*;base64,([\s\S]+)$/i)
  if (!match) throw new Error('OCS 图片需要 Base64 Data URL')
  const base64 = match[1].replace(/\s/g, '')
  let bytes: string
  try { bytes = atob(base64) } catch { throw new Error('OCS 图片 Base64 无效') }
  const sig = (...values: number[]) => values.every((v, i) => bytes.charCodeAt(i) === v)
  let mime = ''
  if (sig(137, 80, 78, 71, 13, 10, 26, 10)) mime = 'image/png'
  else if (sig(255, 216, 255)) mime = 'image/jpeg'
  else if (/^GIF8[79]a/.test(bytes)) mime = 'image/gif'
  else if (bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP') mime = 'image/webp'
  else if (bytes.startsWith('BM')) mime = 'image/bmp'
  else if (bytes.slice(4, 8) === 'ftyp' && /avif|avis/.test(bytes.slice(8, 32))) mime = 'image/avif'
  else if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(bytes)) mime = 'image/svg+xml'
  if (!mime) throw new Error('OCS 图片字节不是支持的图片格式')
  return `data:${mime};base64,${base64}`
}

export const buildOcsImageParts = (context?: OcsQuestionContext): any[] => {
  if (!context?.images.length) return []
  for (const ref of ((context.suggestion_title || '') + '\n' + (context.suggestion_options || '')).matchAll(/\[图片(\d+)\]/g)) {
    if (Number(ref[1]) < 1 || Number(ref[1]) > context.images.length) throw new Error(`OCS ${ref[0]} 超出图片数组范围`)
  }
  return context.images.flatMap((image, index) => [
    { type: 'text', text: `\n[图片${index + 1}]：\n` },
    { type: 'image_url', image_url: { url: normalizeOcsImageDataUrl(image), detail: 'high' } },
  ])
}

const compact = (text: string) => text.replace(/\s/g, '')
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const restoreOcsImageAnswer = (answer: string, context?: OcsQuestionContext): string => {
  if (!context?.images.length || !/\[图片\d+\]/.test(answer)) return answer
  for (const ref of answer.matchAll(/\[图片(\d+)\]/g)) {
    if (Number(ref[1]) < 1 || Number(ref[1]) > context.images.length) throw new Error(`OCS ${ref[0]} 缺少原始图片对应关系`)
  }
  const urls = new Map<string, string>()
  for (const [raw, suggestion] of [[context.title, context.suggestion_title], [context.options, context.suggestion_options]]) {
    if (!raw || !suggestion) continue
    const text = compact(suggestion)
    const refs = [...text.matchAll(/\[图片(\d+)\]/g)]
    if (!refs.length) continue
    let offset = 0
    let pattern = '^'
    for (const ref of refs) {
      pattern += escapeRegex(text.slice(offset, ref.index)) + '((?:https?://|data:image/).*?)'
      offset = ref.index! + ref[0].length
    }
    const match = compact(raw).match(new RegExp(pattern + escapeRegex(text.slice(offset)) + '$'))
    if (!match) continue
    refs.forEach((ref, i) => {
      const old = urls.get(ref[0])
      if (old && old !== match[i + 1]) throw new Error('OCS 图片编号对应多个原始地址')
      if (Number(ref[1]) <= context.images.length) urls.set(ref[0], match[i + 1])
    })
  }
  const rawOptions = parseOptions(context.options || '')
  const suggestions = parseOptions(context.suggestion_options || '')
  return answer.split('###').map(part => {
    if (!/\[图片\d+\]/.test(part)) return part
    const keys = [...suggestions].filter(([, value]) => compact(value) === compact(part)).map(([key]) => key)
    if (keys.length === 1 && rawOptions.size === suggestions.size && rawOptions.has(keys[0])) return rawOptions.get(keys[0])!
    return part.replace(/\[图片\d+\]/g, ref => {
      const url = urls.get(ref)
      if (!url) throw new Error(`OCS ${ref} 缺少原始图片对应关系`)
      return url
    }).trim()
  }).join('###')
}

export const restoreOcsAnswerContent = (content: string, context?: OcsQuestionContext): string => {
  if (!context?.images.length || !content.includes('[图片')) return content
  const objects = answerObjects(content)
  if (objects.length !== 1 || typeof objects[0].answer !== 'string') return content
  return JSON.stringify({ ...objects[0], answer: restoreOcsImageAnswer(objects[0].answer, context) })
}
