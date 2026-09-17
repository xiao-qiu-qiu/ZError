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
      <ol v-if="trace.sources.length">
        <li v-for="source in trace.sources" :key="source.url">
          <a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }}</a>
          <small>{{ source.url }}</small>
          <p v-if="source.snippet">{{ source.snippet.slice(0, 350) }}</p>
        </li>
      </ol>
      <ul class="search-events"><li v-for="(message, i) in trace.messages" :key="i">{{ message }}</li></ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SearchTrace } from '../services/search'
const props = defineProps<{ trace?: SearchTrace }>()
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
</style>
