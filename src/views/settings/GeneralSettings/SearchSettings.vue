<template>
  <section class="network-group search-settings" aria-labelledby="search-settings-title">
    <div id="search-settings-title" class="group-title">联网搜索</div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">检索模式</h3>
        <p class="setting-description">选择关闭、自动检索，或每道题都执行一次检索。</p>
      </div>
      <div class="setting-control">
        <div class="segmented-control" role="group" aria-label="检索模式">
          <button
            v-for="option in modeOptions"
            :key="option.value"
            type="button"
            class="segment-button"
            :class="{ active: searchSettings.mode === option.value }"
            :aria-pressed="searchSettings.mode === option.value"
            @click="updateSearch('mode', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">搜索供应商</h3>
        <p v-if="searchSettings.provider === 'native'" class="setting-description">使用当前模型的 Responses 接口执行原生搜索，需供应商支持；联网是否成功以实际搜索事件和来源为准。</p>
        <p v-else class="setting-description">模型可自行搜索并读取资料。公开搜索无需密钥；通用 API 和自建服务使用下方配置。</p>
      </div>
      <div class="setting-control setting-control-wide">
        <select
          class="form-select"
          :value="searchSettings.provider"
          aria-label="搜索供应商"
          @change="updateSearch('provider', ($event.target as HTMLSelectElement).value)"
        >
          <option value="native">内置搜索</option>
          <option value="bing">公开搜索（Bing，无需密钥）</option>
          <option value="tavily">通用搜索(Tavily)</option>
          <option value="searxng">自建搜索(SearXNG)</option>
        </select>
      </div>
    </div>

    <div v-if="searchSettings.provider === 'tavily'" class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">访问密钥</h3>
        <p class="setting-description">Tavily API 密钥仅保存在本地设置中。</p>
      </div>
      <div class="setting-control setting-control-wide">
        <input
          type="password"
          class="form-input"
          :value="searchSettings.apiKey"
          autocomplete="new-password"
          placeholder="输入 Tavily API 密钥"
          aria-label="Tavily API 密钥"
          @change="updateSearch('apiKey', ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <div v-if="requiresBaseUrl" class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">服务地址</h3>
        <p v-if="searchSettings.provider === 'searxng'" class="setting-description">SearXNG 服务地址为必填项，请填写实例的 API 地址。</p>
        <p v-else class="setting-description">Tavily 服务地址可留空，留空时使用默认地址。</p>
      </div>
      <div class="setting-control setting-control-wide">
        <input
          type="url"
          class="form-input"
          :value="searchSettings.baseUrl"
          :placeholder="searchSettings.provider === 'searxng' ? 'https://你的-SearXNG-实例' : '留空使用默认地址'"
          :required="searchSettings.provider === 'searxng'"
          aria-label="搜索服务地址"
          @change="updateSearch('baseUrl', ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">最多检索次数</h3>
        <p class="setting-description">每道题允许发起的搜索次数。</p>
      </div>
      <div class="setting-control number-control">
        <input
          type="number"
          class="number-input"
          :value="searchSettings.maxSearches"
          min="1"
          max="5"
          step="1"
          inputmode="numeric"
          aria-label="最多检索次数"
          @change="updateNumber('maxSearches', $event)"
        />
        <span class="input-unit">次</span>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">最多读取页面</h3>
        <p class="setting-description">每道题允许读取的搜索结果页面数。</p>
      </div>
      <div class="setting-control number-control">
        <input
          type="number"
          class="number-input"
          :value="searchSettings.maxPages"
          min="1"
          max="8"
          step="1"
          inputmode="numeric"
          aria-label="最多读取页面"
          @change="updateNumber('maxPages', $event)"
        />
        <span class="input-unit">页</span>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">整题答题预算</h3>
        <p class="setting-description">开启联网时的整题预算，包含模型作答、搜索、重试和裁决。OCS 等待时间需略大于此值（默认建议 150 秒）。</p>
      </div>
      <div class="setting-control number-control">
        <input
          type="number"
          class="number-input number-input-wide"
          :value="searchSettings.timeoutSeconds"
          min="30"
          max="600"
          step="1"
          inputmode="numeric"
          aria-label="整题答题预算"
          @change="updateNumber('timeoutSeconds', $event)"
        />
        <span class="input-unit">秒</span>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">单次请求超时</h3>
        <p class="setting-description">单次搜索或页面请求的最长等待时间。</p>
      </div>
      <div class="setting-control number-control">
        <input
          type="number"
          class="number-input"
          :value="searchSettings.requestTimeoutSeconds"
          min="5"
          max="60"
          step="1"
          inputmode="numeric"
          aria-label="单次请求超时"
          @change="updateNumber('requestTimeoutSeconds', $event)"
        />
        <span class="input-unit">秒</span>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">结果缓存时间</h3>
        <p class="setting-description">相同检索结果的本地缓存时间，设为 0 表示不缓存。</p>
      </div>
      <div class="setting-control number-control">
        <input
          type="number"
          class="number-input number-input-wide"
          :value="searchSettings.cacheTtlMinutes"
          min="0"
          max="1440"
          step="1"
          inputmode="numeric"
          aria-label="结果缓存时间"
          @change="updateNumber('cacheTtlMinutes', $event)"
        />
        <span class="input-unit">分钟</span>
      </div>
    </div>

    <p class="search-provider-note">Bing 资料请先核对；也可改用 Tavily 或自建搜索。</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { useSettingsManager } from '../../../composables/useSettingsManager'
import type { SearchMode, SearchSettings } from '../../../services/settings'

const { settings, setSetting, saveSettings } = useSettingsManager()

const searchSettings = computed(() => settings.value.search)
const requiresBaseUrl = computed(() => searchSettings.value.provider === 'tavily' || searchSettings.value.provider === 'searxng')

const modeOptions: Array<{ value: SearchMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'auto', label: '自动' },
  { value: 'always', label: '每题检索' }
]

const persistSearchSettings = async (key: keyof SearchSettings, value: unknown) => {
  const nextSettings = {
    ...searchSettings.value,
    [key]: value
  } as SearchSettings

  setSetting('search', nextSettings)
  try {
    await saveSettings()
  } catch (error) {
    console.error('保存搜索设置失败:', error)
  }
}

const updateSearch = (key: keyof SearchSettings, value: unknown) => {
  void persistSearchSettings(key, value)
}

const updateNumber = (key: keyof SearchSettings, event: Event) => {
  const input = event.target as HTMLInputElement
  void persistSearchSettings(key, Number(input.value))
}
</script>

<style scoped>
.search-settings {
  background: var(--network-group-bg);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 0 14px;
  margin: 12px 0;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .05);
}

.group-title {
  padding: 10px 0 2px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .03em;
}

.setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 0;
  border-bottom: 1px solid var(--border-color);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info {
  flex: 1;
  min-width: 0;
}

.setting-title {
  margin: 0 0 6px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
}

.setting-description {
  max-width: 620px;
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.search-provider-note {
  margin: 0;
  padding: 0 0 12px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.setting-control {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
}

.setting-control-wide {
  width: min(340px, 42%);
}

.segmented-control {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  background: var(--form-input-bg, var(--network-group-bg));
}

.segment-button {
  min-height: 34px;
  padding: 6px 12px;
  border: 0;
  border-right: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color .2s ease, color .2s ease;
}

.segment-button:last-child {
  border-right: 0;
}

.segment-button:hover {
  background: var(--form-input-hover-bg, var(--hover-bg));
  color: var(--text-primary);
}

.segment-button.active {
  background: color-mix(in srgb, var(--color-primary) 14%, var(--network-group-bg));
  color: var(--color-primary);
  font-weight: 600;
}

.segment-button:focus-visible,
.form-select:focus-visible,
.form-input:focus-visible,
.number-input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-primary) 55%, transparent);
  outline-offset: 1px;
}

.form-select,
.form-input,
.number-input {
  box-sizing: border-box;
  min-height: 34px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--form-input-bg, var(--network-group-bg));
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  transition: border-color .2s ease, background-color .2s ease;
}

.form-select,
.form-input {
  width: 100%;
  padding: 7px 9px;
}

.form-select:hover,
.form-input:hover,
.number-input:hover {
  border-color: var(--form-input-hover-border, var(--color-primary));
}

.form-select:focus,
.form-input:focus,
.number-input:focus {
  border-color: var(--form-input-focus-border, var(--color-primary));
  outline: none;
}

.number-control {
  gap: 6px;
}

.number-input {
  width: 74px;
  padding: 6px 8px;
  text-align: center;
  -moz-appearance: textfield;
}

.number-input-wide {
  width: 86px;
}

.number-input::-webkit-inner-spin-button,
.number-input::-webkit-outer-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.input-unit {
  min-width: 28px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

@media (max-width: 700px) {
  .setting-item {
    flex-direction: column;
    gap: 10px;
  }

  .setting-control,
  .setting-control-wide {
    width: 100%;
  }

  .segmented-control {
    width: 100%;
  }

  .segment-button {
    flex: 1;
  }
}
</style>
