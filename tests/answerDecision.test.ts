import { describe, expect, test } from 'bun:test'

import { agreedAnswer, validateAnswer } from '../src/utils/answerDecision'

const multipleChoiceContext = {
  title: '下列哪些属于示例选项？',
  type: '多选题',
  options: 'A. 第一项\nB. 第二项\nC. 第三项'
}

describe('answer decision validation', () => {
  test('同一道多选题的选项顺序不同仍能达成一致', () => {
    const decision = agreedAnswer(
      [
        JSON.stringify({ answer: 'B###A' }),
        JSON.stringify({ answer: 'A###B' })
      ],
      multipleChoiceContext
    )

    expect(decision).toEqual({
      answer: '第一项###第二项',
      key: '第一项###第二项',
      needs_review: false
    })
  })

  test('单选题出现多个答案时要求复核', () => {
    const decision = validateAnswer(
      JSON.stringify({ answer: 'A###B' }),
      { ...multipleChoiceContext, type: '单选题' }
    )

    expect(decision.needs_review).toBe(true)
    expect(decision.reason).toContain('单选题')
  })

  test('答案包含题目中不存在的选项时要求复核', () => {
    const decision = validateAnswer(
      JSON.stringify({ answer: 'D' }),
      multipleChoiceContext
    )

    expect(decision.needs_review).toBe(true)
    expect(decision.reason).toContain('未对应')
  })

  test('字符串内容中的大括号不会被误判为额外 JSON', () => {
    const answer = '结果包含 {大括号}，但仍是一条完整答案'
    const decision = validateAnswer(
      JSON.stringify({ answer }),
      { title: '说明题', type: '简答题' }
    )

    expect(decision).toEqual({
      answer,
      key: answer,
      needs_review: false
    })
  })

  test('多个 answer 对象时要求复核', () => {
    const decision = validateAnswer(
      '{"answer":"第一项"}\n{"answer":"第二项"}',
      { title: '说明题', type: '简答题' }
    )

    expect(decision.needs_review).toBe(true)
    expect(decision.reason).toContain('唯一')
  })

  test('模型显式标记 needs_review 时保留复核原因', () => {
    const decision = validateAnswer(
      JSON.stringify({ answer: '', needs_review: true, reason: '资料不足' }),
      { title: '说明题', type: '简答题' }
    )

    expect(decision).toEqual({
      answer: '',
      key: '',
      needs_review: true,
      reason: '资料不足'
    })
  })

  test('填空题中的 C 字母保持原样，不按选择题选项转换', () => {
    const decision = validateAnswer(
      JSON.stringify({ answer: 'C' }),
      { title: '请填写字母：____', type: '填空题' }
    )

    expect(decision).toEqual({ answer: 'C', key: 'C', needs_review: false })
  })

  test('支持同一行的带标签选项', () => {
    const decision = validateAnswer(
      JSON.stringify({ answer: 'C' }),
      { title: '选择正确答案', type: '单选题', options: 'A. 第一项 B. 第二项 C. 第三项' }
    )

    expect(decision).toEqual({ answer: '第三项', key: '第三项', needs_review: false })
  })

  test('支持没有标签的换行选项', () => {
    const decision = validateAnswer(
      JSON.stringify({ answer: 'B' }),
      { title: '选择正确答案', type: '单选题', options: '第一项\n第二项\n第三项' }
    )

    expect(decision).toEqual({ answer: '第二项', key: '第二项', needs_review: false })
  })

  test('填空答案数量与题目空位数量不一致时要求复核', () => {
    const decision = validateAnswer(
      JSON.stringify({ answer: '甲' }),
      { title: '第一空____，第二空____', type: '填空题' }
    )

    expect(decision.needs_review).toBe(true)
    expect(decision.reason).toContain('数量')
  })
})
