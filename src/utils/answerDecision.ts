/** The sole answer contract used for validation, comparison and arbitration. */
export interface AnswerContext { title: string; options?: string; type?: string }
export interface AnswerDecision { answer: string; key: string; needs_review: boolean; reason?: string }
export type AnswerKind = 'single' | 'multiple' | 'judgement' | 'completion' | 'general'

export function answerKind(type = ''): AnswerKind {
  if (/multiple|多选|多项选择/i.test(type)) return 'multiple'
  if (/single|单选|单项选择/i.test(type)) return 'single'
  if (/judg(e)?ment|判断/i.test(type)) return 'judgement'
  if (/completion|填空/i.test(type)) return 'completion'
  return 'general'
}

export function parseOptions(options = ''): Map<string, string> {
  const text = options.replace(/\r\n/g, '\n').trim()
  const map = new Map<string, string>()
  if (!text) return map
  const labels = [...text.matchAll(/(?:^|\s)([A-Za-z])[.、．)）]\s*/g)]
    .filter(m => !(m[0].includes('、') && /^[A-Za-z]、/.test(text.slice(m.index! + m[0].length))))
  if (labels.length) {
    labels.forEach((m, i) => {
      const value = text.slice(m.index! + m[0].length, labels[i + 1]?.index ?? text.length).trim()
      if (value) map.set(m[1].toUpperCase(), value)
    })
  } else {
    text.split('\n').map(v => v.trim()).filter(Boolean).forEach((v, i) => map.set(String.fromCharCode(65 + i), v))
  }
  return map
}

/** Scan JSON objects while respecting escaped quotes and braces inside strings. */
export function answerObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = []
  let start = -1, depth = 0, quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (start < 0) { if (ch === '{') { start = i; depth = 1 }; continue }
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        const value = JSON.parse(text.slice(start, i + 1))
        if (Object.prototype.hasOwnProperty.call(value, 'answer')) objects.push(value)
      } catch { /* invalid JSON is rejected by the caller */ }
      start = -1
    }
  }
  return objects
}

export const reviewDecision = (reason: string): AnswerDecision => ({ answer: '', key: '', needs_review: true, reason })

export function validateAnswer(content: string, context: AnswerContext): AnswerDecision {
  const objects = answerObjects(content)
  if (objects.length !== 1) return reviewDecision('需要唯一、有效的答案 JSON')
  const obj = objects[0]
  if (obj.needs_review === true) return reviewDecision(typeof obj.reason === 'string' ? obj.reason : '模型建议复核')
  if (obj.needs_review !== undefined && typeof obj.needs_review !== 'boolean') return reviewDecision('复核标记格式错误')
  if (typeof obj.answer !== 'string' || !obj.answer.trim()) return reviewDecision('答案为空或格式错误')
  let answer = obj.answer.trim()
  const kind = answerKind(context.type)
  let parts = answer.split('###').map(p => p.trim())
  if (parts.some(p => !p)) return reviewDecision('答案含有空项')
  if (kind === 'single' || kind === 'multiple') {
    const options = parseOptions(context.options)
    if (!options.size) return reviewDecision('选择题缺少完整选项')
    const values = [...options.values()]
    parts = parts.flatMap(p => {
      if (values.includes(p)) return [p]
      const labeled = p.match(/^([A-Za-z])[.、．)）]\s*(.+)$/)
      if (labeled && options.get(labeled[1].toUpperCase()) === labeled[2].trim()) return [labeled[2].trim()]
      const compact = p.replace(/[\s,，、]/g, '').toUpperCase()
      if (/^[A-Z]+$/.test(compact) && [...compact].every(l => options.has(l))) return [...compact].map(l => options.get(l)!)
      return [p]
    })
    if (parts.some(p => !values.includes(p))) return reviewDecision('答案未对应题目选项')
    if (new Set(parts).size !== parts.length) return reviewDecision('答案包含重复选项')
    if (kind === 'single' && parts.length !== 1) return reviewDecision('单选题需要且只能有一个答案')
    parts.sort((a, b) => values.indexOf(a) - values.indexOf(b))
    answer = parts.join('###')
  } else if (kind === 'judgement') {
    const yes = ['正确', '对', '是', 'true', '√']
    const no = ['错误', '错', '否', 'false', '×']
    if (yes.includes(answer.toLowerCase())) answer = '正确'
    else if (no.includes(answer.toLowerCase())) answer = '错误'
    else return reviewDecision('判断题需要明确的正确或错误')
  } else if (kind === 'completion') {
    const blanks = context.title.match(/_{2,}|（\s*）|\(\s*\)/g)?.length ?? 0
    if (blanks > 0 && blanks !== parts.length) return reviewDecision('填空答案数量与题目不符')
    answer = parts.join('###')
  }
  return { answer, key: answer, needs_review: false }
}

export function agreedAnswer(contents: string[], context: AnswerContext): AnswerDecision | null {
  const answers = contents.map(c => validateAnswer(c, context))
  if (!answers.length || answers.some(a => a.needs_review)) return null
  return answers.every(a => a.key === answers[0].key) ? answers[0] : null
}

export function serializeAnswer(decision: AnswerDecision): string {
  return JSON.stringify(decision.needs_review
    ? { answer: '', needs_review: true, reason: decision.reason }
    : { answer: decision.answer })
}
