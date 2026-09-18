<template>
  <section v-if="trace" class="search-evidence" aria-label="检索记录">
    <div class="evidence-heading">
      <strong>联网核对</strong>
      <span>{{ status }} · 搜索 {{ trace.searches }} 次 · 阅读 {{ trace.pages }} 页</span>
    </div>
    <p v-if="trace.messages.length" class="evidence-message">{{ trace.messages[trace.messages.length - 1] }}</p>
    <details v-if="trace.sources.length || trace.messages.length > 1">
      <summary>查看 {{ trace.sources.length }} 条参考来源与检索记录</summary>
      <p>包含本题各模型检索过的资料；检索记录不代表每条资料都支持最终答案。</p>
      <p v-if="sourcesWithoutText">{{ sourcesWithoutText }} 条来源未回传摘要或正文。内置搜索内容由供应商在模型侧处理，这里仅展示客户端收到的来源信息；仅有链接的记录不会作为正文证据传给后续模型。</p>
      <ol v-if="trace.sources.length">
        <li v-for="source in trace.sources" :key="source.url">
          <a :href="source.url" target="_blank" rel="noopener noreferrer">{{ sourceLabel(source) }}</a>
          <span v-if="source.cited" class="citation-label">已被引用</span>
          <small>{{ readableUrl(source.url) }}</small>
          <p v-if="source.snippet">{{ source.snippet.slice(0, 350) }}</p>
          <small v-else>仅来源链接 · 客户端未收到摘要</small>
        </li>
      </ol>
      <ul class="search-events"><li v-for="(message, i) in trace.messages" :key="i">{{ message }}</li></ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SearchSource, SearchTrace } from '../services/search'
const props = defineProps<{ trace?: SearchTrace }>()
const sourcesWithoutText = computed(() => props.trace?.sources.filter(s => !s.snippet?.trim()).length || 0)
const readableUrl = (url: string) => { try { return decodeURI(url) } catch { return url } }
const sourceLabel = (source: SearchSource) => {
  if (source.title && !/^https?:\/\//i.test(source.title)) return source.title
  try { return new URL(source.url).hostname + ' · 来源页面' } catch { return '来源页面' }
}
const status = computed(() => ({ idle: '本题尚未检索', searching: '正在检索', complete: '已获得资料，仍需核对', failed: '检索未完成', unavailable: '当前配置未接通搜索' }[props.trace?.state || 'idle']))
</script>

<style scoped>
.search-evidence { margin: 12px 0; padding: 16px; border: 1px solid var(--border-color, #85858540); border-radius: 12px; background: var(--bg-secondary, #88888808); font-size: 13px; line-height: 1.6; }
.evidence-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.evidence-heading span, .evidence-message, small { opacity: .75; }
summary { cursor: pointer; padding: 8px 0; }
li { margin: 8px 0; }
a { color: var(--primary-color, #357de8); overflow-wrap: anywhere; }
small { display: block; overflow-wrap: anywhere; }
p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.search-events { font-size: 12px; opacity: .8; }
.citation-label { margin-left: 8px; font-size: 12px; opacity: .75; }
</style>
