import type { AIModel } from './modelConfig'

/** 兼容旧配置：视觉模型默认开启，其余模型默认关闭。 */
export function isVisionEnabled(model?: Pick<AIModel, 'category' | 'enableVision'> | null): boolean {
  return model?.enableVision ?? model?.category === 'vision'
}

/** 优先使用独立视觉模型，其次使用开启视觉的已选文本模型。 */
export function selectVisionModel(visionModel: AIModel | null, textModels: AIModel[]): AIModel | null {
  return [visionModel, ...textModels].find(
    (model): model is AIModel => !!model && model.enabled && isVisionEnabled(model)
  ) ?? null
}
