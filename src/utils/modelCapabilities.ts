import type { AIModel } from '../services/model/config'

/** 显式视觉开关优先，其次使用能力字段，最后兼容旧视觉分类。 */
export function isVisionEnabled(model?: Pick<AIModel, 'category' | 'enableVision' | 'hasVision'> | null): boolean {
  return model?.enableVision ?? model?.hasVision ?? model?.category === 'vision'
}

/** 优先使用独立视觉模型，其次使用开启视觉的已选文本模型。 */
export function selectVisionModel(visionModel: AIModel | null, textModels: AIModel[]): AIModel | null {
  return [visionModel, ...textModels].find(
    (model): model is AIModel => !!model && model.enabled !== false && isVisionEnabled(model)
  ) ?? null
}
