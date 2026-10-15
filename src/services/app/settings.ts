import { reactive, watch } from 'vue'
import { environmentDetector } from './environmentDetector'

// 设置接口定义
export interface AppSettings {
  // 常规设置
  theme: 'light' | 'dark' | 'auto'
  language: 'zh-CN' | 'en-US'
  autoSave: boolean
  
  // 题库设置
  autoAddToQuestionBank: boolean
  // 文本模型最长响应时间（秒）
  modelResponseTimeout: number
  // 模型失败自动重试次数（仅单模型 / 总结模型 / 视觉模型）；0 表示不重试
  modelRetryCount: number

  // 联网搜索设置
  search: SearchSettings

  
  // 题目显示设置
  defaultDifficulty: 'easy' | 'medium' | 'hard'
  itemsPerPage: number
  showExplanation: boolean
  
  // 网络设置
  network: {
    serverPort: number
    enableLanAccess: boolean
    bindAddress: string
  }
  
  // 应用设置
  windowSize: {
    width: number
    height: number
  }
  windowPosition: {
    x: number
    y: number
  }
  autoUpdate: boolean
  enableNotifications: boolean
  suppressNoModelWarning: boolean
  questionSaveDir: string
  questionSaveFolderId: number | null
  algorithms: AlgorithmConfig[]
  adminToken: string
  multiUser: {
    enabled: boolean
    users: UserConfig[]
  }
}

export interface UserConfig {
  id: string
  name: string
  token: string
  createdAt: string
}

export interface AlgorithmConfig {
  id: string
  name: string
  applicableType: string
  code: string
}

export type SearchMode = 'off' | 'auto' | 'always'
export type SearchProvider = 'native' | 'bing' | 'tavily' | 'searxng'

export interface SearchSettings {
  mode: SearchMode
  provider: SearchProvider
  apiKey: string
  baseUrl: string
  maxSearches: number
  maxPages: number
  timeoutSeconds: number
  requestTimeoutSeconds: number
  cacheTtlMinutes: number
}

const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  mode: 'auto',
  provider: 'bing',
  apiKey: '',
  baseUrl: '',
  maxSearches: 2,
  maxPages: 3,
  timeoutSeconds: 120,
  requestTimeoutSeconds: 20,
  cacheTtlMinutes: 30
}

type SettingsRecord = Record<string, unknown>

const isSettingsRecord = (value: unknown): value is SettingsRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const withoutUndefined = (value: SettingsRecord): SettingsRecord => {
  const result: SettingsRecord = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry
  }
  return result
}

const mergeDefined = <T extends SettingsRecord>(base: T, value: unknown): T => ({
  ...base,
  ...(isSettingsRecord(value) ? withoutUndefined(value) : {})
}) as T

const normalizeInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const numericValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN

  if (!Number.isFinite(numericValue)) return fallback
  return Math.round(Math.min(max, Math.max(min, numericValue)))
}

const normalizeSearchSettings = (value: unknown, fallback: SearchSettings = DEFAULT_SEARCH_SETTINGS): SearchSettings => {
  const source = isSettingsRecord(value) ? value : {}
  const mode = source.mode
  const provider = source.provider

  return {
    mode: mode === 'off' || mode === 'auto' || mode === 'always' ? mode : fallback.mode,
    provider: provider === 'native' || provider === 'bing' || provider === 'tavily' || provider === 'searxng' ? provider : fallback.provider,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : fallback.apiKey,
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : fallback.baseUrl,
    maxSearches: normalizeInteger(source.maxSearches, fallback.maxSearches, 1, 5),
    maxPages: normalizeInteger(source.maxPages, fallback.maxPages, 1, 8),
    timeoutSeconds: normalizeInteger(source.timeoutSeconds, fallback.timeoutSeconds, 30, 600),
    requestTimeoutSeconds: normalizeInteger(source.requestTimeoutSeconds, fallback.requestTimeoutSeconds, 5, 60),
    cacheTtlMinutes: normalizeInteger(source.cacheTtlMinutes, fallback.cacheTtlMinutes, 0, 1440)
  }
}

// 默认设置
const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  language: 'zh-CN',
  autoSave: true,
  autoAddToQuestionBank: true,
  modelResponseTimeout: 40,
  modelRetryCount: 2,
  search: DEFAULT_SEARCH_SETTINGS,

  defaultDifficulty: 'medium',
  itemsPerPage: 20,
  showExplanation: true,
  network: {
    serverPort: 3000,
    enableLanAccess: false,
    bindAddress: '127.0.0.1'
  },
  windowSize: {
    width: 1000,
    height: 680
  },
  windowPosition: {
    x: 100,
    y: 100
  },
  autoUpdate: true,
  enableNotifications: true
  , suppressNoModelWarning: false
  , questionSaveDir: ''
  , questionSaveFolderId: null
  , algorithms: []
  , adminToken: ''
  , multiUser: {
    enabled: false
    , users: []
  }
}

// 设置存储键
const SETTINGS_STORAGE_KEY = 'app_settings'

/**
 * 设置管理器类
 * 提供设置的读取、保存、重置等功能
 */
class SettingsManager {
  private settings: AppSettings
  private listeners: Set<(settings: AppSettings) => void> = new Set()

  constructor() {
    this.settings = reactive(this.loadSettings())
    this.setupAutoSave()
    // 异步从文件加载设置并合并
    this.loadFromFile()
  }

  /**
   * 从本地存储加载设置（同步，作为初始值）
   */
  private loadSettings(): AppSettings {
    try {
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY)
      if (stored) {
        const parsedSettings = { ...(JSON.parse(stored) || {}) }
        delete parsedSettings.enableNonThinkingModelAnalysis
        return this.mergeSettings(parsedSettings)
      }


    } catch (error) {
      console.warn('加载设置失败，使用默认设置:', error)
    }
    return this.mergeSettings({})
  }

  /**
   * 从 exe 同级目录的 config.json 异步加载设置
   */
  private async loadFromFile(): Promise<void> {
    if (!environmentDetector.isTauriEnvironment(true)) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content = await invoke<string>('read_config')
      if (content) {
        const parsed = { ...(JSON.parse(content) || {}) }
        delete parsed.enableNonThinkingModelAnalysis
        Object.assign(this.settings, this.mergeSettings(parsed))
        console.log('已从配置文件加载设置')
      }

    } catch (error) {
      console.warn('从配置文件加载设置失败:', error)
    }
  }

  /**
   * 保存设置到本地存储及 exe 同级目录的 config.json
   */
  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.settings))
      this.notifyListeners()
    } catch (error) {
      console.error('保存设置失败:', error)
      throw new Error('设置保存失败')
    }
    // 异步写入配置文件
    if (environmentDetector.isTauriEnvironment(true)) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('write_config', { content: JSON.stringify(this.settings, null, 2) })
          .catch(e => console.warn('写入配置文件失败:', e))
      })
    }
  }

  /**
   * 设置自动保存
   */
  private setupAutoSave(): void {
    watch(
      () => this.settings,
      () => {
        if (this.settings.autoSave) {
          this.saveSettings()
        }
      },
      { deep: true }
    )
  }

  /**
   * 通知监听器设置已更改
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.settings)
      } catch (error) {
        console.error('设置监听器执行失败:', error)
      }
    })
  }

  /**
   * 获取当前设置
   */
  getSettings(): AppSettings {
    return this.settings
  }

  /**
   * 获取特定设置项
   */
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.settings[key]
  }

  /**
   * 设置特定设置项
   */
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    if (key === 'search') {
      this.settings.search = normalizeSearchSettings(value, this.settings.search)
      return
    }
    this.settings[key] = value
  }

  /**
   * 批量更新设置
   */
  update(newSettings: Partial<AppSettings>): void {
    Object.assign(this.settings, this.mergeSettings(newSettings, this.settings))
  }

  /**
   * 手动保存设置
   */
  save(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.saveSettings()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * 重置设置为默认值
   */
  reset(): void {
    Object.assign(this.settings, this.mergeSettings({}))
  }

  /**
   * 重置特定设置项
   */
  resetKey<K extends keyof AppSettings>(key: K): void {
    this.settings[key] = this.mergeSettings({})[key]
  }

  /**
   * 添加设置变更监听器
   */
  addListener(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    // 返回取消监听的函数
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 移除设置变更监听器
   */
  removeListener(listener: (settings: AppSettings) => void): void {
    this.listeners.delete(listener)
  }

  /**
   * 导出设置为JSON
   */
  export(): string {
    return JSON.stringify(this.settings, null, 2)
  }

  /**
   * 从JSON导入设置
   */
  import(jsonString: string): void {
    try {
      const importedSettings = JSON.parse(jsonString)
      // 验证导入的设置格式
      if (this.validateSettings(importedSettings)) {
        this.update(importedSettings)
      } else {
        throw new Error('导入的设置格式无效')
      }
    } catch (error) {
      console.error('导入设置失败:', error)
      throw new Error('设置导入失败')
    }
  }

  /**
   * 验证设置格式
   */
  private validateSettings(settings: any): boolean {
    if (!settings || typeof settings !== 'object') {
      return false
    }

    // 验证必要的设置项类型
    const validations = [
      () => !settings.theme || ['light', 'dark', 'auto'].includes(settings.theme),
      () => !settings.language || ['zh-CN', 'en-US'].includes(settings.language),
      () => !settings.autoSave || typeof settings.autoSave === 'boolean',
      () => !settings.autoAddToQuestionBank || typeof settings.autoAddToQuestionBank === 'boolean',
      () => !settings.algorithms || (

        Array.isArray(settings.algorithms) && settings.algorithms.every((a: any) => (
          a && typeof a === 'object' && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.applicableType === 'string' && typeof a.code === 'string'
        ))
      )
    ]

    return validations.every(validation => validation())
  }

  /**
   * 合并设置并规范化新增的搜索配置。
   * `base` 用于批量更新时保留未传入的当前值；读取持久化配置时使用默认值。
   */
  private mergeSettings(value: unknown, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
    const source = isSettingsRecord(value) ? withoutUndefined(value) : {}

    return {
      ...base,
      ...source,
      network: mergeDefined(base.network, source.network),
      windowSize: mergeDefined(base.windowSize, source.windowSize),
      windowPosition: mergeDefined(base.windowPosition, source.windowPosition),
      multiUser: mergeDefined(base.multiUser, source.multiUser),
      search: normalizeSearchSettings(source.search, base.search)
    }
  }

  /**
   * 获取设置的描述信息
   */
  getSettingsInfo(): Record<keyof AppSettings, string> {
    return {
      theme: '界面主题模式',
      language: '应用界面语言',
      autoSave: '自动保存设置',
      autoAddToQuestionBank: '自动将AI返回的题目添加到本地题库',
      modelResponseTimeout: '文本模型最长响应时间（秒）',
      modelRetryCount: '模型失败自动重试次数',
      search: '联网搜索设置',

      network: '网络配置设置',
      windowSize: '窗口大小',
      windowPosition: '窗口位置',
      autoUpdate: '自动更新应用',
      enableNotifications: '启用通知',
      suppressNoModelWarning: '未选择模型提醒',
      questionSaveDir: '题目保存目录',
      questionSaveFolderId: '题目默认保存文件夹 ID',
      algorithms: '算法配置列表',
      adminToken: '管理员令牌',
      multiUser: '多用户配置',
      defaultDifficulty: '默认题目难度',
      itemsPerPage: '每页显示题目数',
      showExplanation: '显示题目解析'
    }

  }
}

// 创建全局设置管理器实例
export const settingsManager = new SettingsManager()

// 导出设置管理器类型
export type { SettingsManager }

// 便捷的钩子函数
export function useSettings() {
  return {
    settings: settingsManager.getSettings(),
    get: settingsManager.get.bind(settingsManager),
    set: settingsManager.set.bind(settingsManager),
    update: settingsManager.update.bind(settingsManager),
    save: settingsManager.save.bind(settingsManager),
    reset: settingsManager.reset.bind(settingsManager),
    addListener: settingsManager.addListener.bind(settingsManager),
    removeListener: settingsManager.removeListener.bind(settingsManager)
  }
}
