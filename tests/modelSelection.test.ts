import { expect, test } from 'bun:test'
import { nextTick } from 'vue'

test('视觉能力模型可跨分类选中、保存恢复，关闭与删除会清理视觉选择', async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  })
  try {
    const { modelConfigManager: manager } = await import('../src/services/modelConfig')
    const makeModel = (id: string, category = 'text', enableVision = true) => ({
      id, name: id, displayName: id, platformId: 'custom_fixture', category,
      enableVision, enabled: true, maxTokens: 1024, temperature: 0.7, topP: 1,
    })
    manager.import(JSON.stringify({
      selectedTextModels: ['text'], selectedVisionModel: 'text',
      platforms: [{ id: 'custom_fixture', name: 'fixture', displayName: 'fixture', enabled: true,
        apiKey: '', baseUrl: '', models: [makeModel('text'), makeModel('summary', 'summary'), makeModel('disabled', 'vision', false)] }],
      globalSettings: { timeout: 30000, retryCount: 0, enableLogging: false },
    }))
    expect(manager.getSelectedVisionModel()?.id).toBe('text')
    expect(manager.getSelectedTextModel()?.id).toBe('text')
    await nextTick()
    manager.import(storage.get('model_settings')!)
    expect(manager.getSelectedVisionModel()?.id).toBe('text')
    manager.setSelectedVisionModel('disabled')
    expect(manager.getSelectedVisionModel()?.id).toBe('text')
    manager.updateModel('text', { enableVision: false })
    expect(JSON.parse(manager.export()).selectedVisionModel).toBeNull()
    expect(manager.getSelectedTextModel()?.id).toBe('text')
    manager.updateModel('text', { enableVision: true })
    manager.toggleSelectedVisionModel('text')
    expect(manager.getSelectedVisionModel()?.id).toBe('text')
    manager.removeModel('text')
    expect(manager.getSelectedVisionModel()?.id).toBe('summary')
    manager.removeModel('summary')
    expect(JSON.parse(manager.export()).selectedVisionModel).toBeNull()
  } finally {
    await nextTick()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
