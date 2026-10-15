import { expect, test } from 'bun:test'
import { buildOcsConfig } from '../src/utils/ocsConfig'
import {
  applyOcsQuestionText, buildOcsImageParts, getOcsQuestionText, normalizeOcsImageDataUrl,
  readOcsQuestionContext, restoreOcsAnswerContent, restoreOcsImageAnswer, upsertStartedQuestionLog,
} from '../src/services/questionServer/ocsContext'
import { buildMultimodalContent, buildRenderedHtml } from '../src/services/questionServer/visionImage'
import { validateAnswer } from '../src/utils/answerDecision'
import type { RequestLog } from '../src/services/questionServer/types'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII='
const resolveField = (field: { handler: string }, env: object) => new Function(field.handler)()(env)

test('导出 POST 真数组；只有题干图片时选项 handler 回退原始选项', () => {
  const config = buildOcsConfig(31000)[0]
  const env = { title: '计算 https://example.test/t.png', options: 'A. 1\nB. 2', images: [png], suggestion_title: '计算 [图片1]' }
  expect(config.method).toBe('post')
  expect(config.url).toBe('http://localhost:31000/query')
  expect(config.headers['Content-Type']).toBe('application/json')
  const body = JSON.parse(JSON.stringify({
    title: env.title, options: env.options,
    images: resolveField(config.data.images, env),
    suggestion_title: resolveField(config.data.suggestion_title, env),
    suggestion_options: resolveField(config.data.suggestion_options, env),
  }))
  expect(body.images).toEqual([png])
  expect(getOcsQuestionText(readOcsQuestionContext(body)!)).toEqual({ title: env.suggestion_title, options: env.options })
  expect(resolveField(config.data.images, {})).toEqual([])
  expect(resolveField(config.data.suggestion_title, {})).toBe('')
  expect(resolveField(config.data.suggestion_options, {})).toBe('')
})

test('历史未替换占位符与旧 GET 数据回退到原题', () => {
  const context = readOcsQuestionContext({ title: '原题', options: 'A. 1\nB. 2', images: [png], suggestion_title: '${suggestion_title}', suggestion_options: '${suggestion_options}' })!
  expect(getOcsQuestionText(context)).toEqual({ title: '原题', options: 'A. 1\nB. 2' })
  expect(readOcsQuestionContext({ title: '旧 GET', type: 'single' })?.images).toEqual([])
})

test('多模态与预览按全局图号使用上传图片，同内容图片不合并', async () => {
  const context = readOcsQuestionContext({
    title: '计算 https://example.test/t.png', options: 'A. https://example.test/a.png\nB. 2',
    suggestion_title: '计算 [图片1]', suggestion_options: 'A. [图片2]\nB. 2', images: [png, png],
  })!
  const parts = await buildMultimodalContent(context.title + '\n' + context.options, context)
  expect(parts.filter(part => part.type === 'image_url').map(part => part.image_url.url)).toEqual([png, png])
  const text = parts.filter(part => part.type === 'text').map(part => part.text).join('')
  expect(text).toContain('A. [图片2]')
  expect(text).not.toContain('base64')
  expect(text).not.toContain('https://')
  expect((await buildRenderedHtml(context.title, context.options!, context)).match(/<img /g)).toHaveLength(2)
  expect(context.title).toContain('https://')
  expect(applyOcsQuestionText('标题：' + context.title, context)).toBe('标题：计算 [图片1]')
})

test('MIME 按图片字节纠正，坏图片和缺失图号报错而不压缩编号', () => {
  expect(normalizeOcsImageDataUrl('data:image/png;base64,/9j/AA==')).toBe('data:image/jpeg;base64,/9j/AA==')
  expect(normalizeOcsImageDataUrl('data:application/octet-stream;base64,R0lGODlh')).toBe('data:image/gif;base64,R0lGODlh')
  expect(() => normalizeOcsImageDataUrl('data:image/png;base64,aGVsbG8=')).toThrow('图片格式')
  expect(() => buildOcsImageParts({ title: '题目', suggestion_title: '[图片3]', images: [png, png] })).toThrow('超出')
  expect(() => buildOcsImageParts({ title: '题目', images: [png, 'broken', png] })).toThrow()
})

test('图片选项和多选答案在复核前还原原始语义，保留填空图号对应', () => {
  const context = readOcsQuestionContext({
    title: '图 https://example.test/t.png', suggestion_title: '图 [图片1]', type: 'multiple',
    options: 'A. f(https://example.test/a.png)\nB. https://example.test/b.png',
    suggestion_options: 'A. f( [图片2] )\nB.  [图片3] ', images: [png, png, png],
  })!
  const restored = restoreOcsAnswerContent('{"answer":"[图片3]###f( [图片2] )"}', context)
  const decision = validateAnswer(restored, { title: context.title, options: context.options!, type: context.type! })
  expect(decision.needs_review).toBe(false)
  expect(decision.answer).toBe('f(https://example.test/a.png)###https://example.test/b.png')
  expect(restoreOcsImageAnswer('[图片1]', context)).toBe('https://example.test/t.png')
  expect(() => restoreOcsImageAnswer('[图片9]', context)).toThrow('对应关系')
})

test('模型事件先到时，迟到开始日志合并同条记录并保留视觉状态与完成结果', () => {
  const logs: RequestLog[] = []
  const early = upsertStartedQuestionLog(logs, { id: 'race', timestamp: 1, method: '', path: '/query', ip: '', userAgent: '', stage: 'started' })
  early.modelResponse = '视觉结果'
  early.stage = 'completed'
  early.status = 200
  const merged = upsertStartedQuestionLog(logs, { id: 'race', timestamp: 2, method: 'POST', path: '/query', ip: '', userAgent: '', stage: 'started', status: undefined, requestBody: '{"title":"原题"}' })
  expect(logs).toHaveLength(1)
  expect(merged).toBe(early)
  expect(merged.stage).toBe('completed')
  expect(merged.modelResponse).toBe('视觉结果')
  expect(merged.status).toBe(200)
  expect(merged.method).toBe('POST')
})
