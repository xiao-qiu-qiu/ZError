import { expect, test } from 'bun:test'
import type { AIModel } from '../src/services/modelConfig'
import { isVisionEnabled, selectVisionModel } from '../src/services/modelCapabilities'

const model = (category: AIModel['category'], enableVision?: boolean): AIModel => ({
  id: category, name: category, displayName: category, platformId: 'fixture',
  category, enableVision, enabled: true, maxTokens: 1024, temperature: 0.7, topP: 1,
})

test('旧配置保留视觉分类的默认能力，显式开关优先于分类', () => {
  expect(isVisionEnabled(model('vision'))).toBe(true)
  expect(isVisionEnabled(model('text'))).toBe(false)
  expect(isVisionEnabled(model('summary'))).toBe(false)
  expect(isVisionEnabled(model('vision', false))).toBe(false)
  expect(isVisionEnabled(model('text', true))).toBe(true)
  expect(isVisionEnabled(model('summary', true))).toBe(true)
  expect(isVisionEnabled(null)).toBe(false)
})

test('含图题优先独立视觉模型，并回退到开启视觉的文本模型', () => {
  const vision = model('vision')
  const text = model('text', true)
  expect(selectVisionModel(vision, [text])).toBe(vision)
  expect(selectVisionModel(null, [text])).toBe(text)
  expect(selectVisionModel(model('vision', false), [text])).toBe(text)
  expect(selectVisionModel({ ...vision, enabled: false }, [text])).toBe(text)
  expect(selectVisionModel(null, [model('text'), { ...text, enabled: false }])).toBeNull()
})
