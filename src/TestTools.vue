<script setup lang="ts">
// 内嵌在投递面板里的测试工具区（标题栏 🧪 打开）。
//
// 列 tools.ts 里的全部标准工具，选中后填 JSON 参数执行，结果显示在下方。
// 不可撤回的工具要点两次。整块可通过「关闭测试」收起，回到正常投递流程。
import { computed, ref } from 'vue'
import { callTool, toolSpecs } from './tools'

const emit = defineEmits<{ (e: 'close'): void }>()

interface Spec {
  name: string
  description: string
  irreversible: boolean
  exampleArgs: Record<string, unknown>
}

const specs = ref<Spec[]>(toolSpecs())
const activeName = ref('')
const argsText = ref('{}')
const resultText = ref('')
const running = ref(false)
const armed = ref(false)

const active = computed(() => specs.value.find((s) => s.name === activeName.value) || null)

function selectTool(spec: Spec): void {
  activeName.value = spec.name
  argsText.value = JSON.stringify(spec.exampleArgs, null, 2)
  resultText.value = ''
  armed.value = false
}

function close(): void {
  armed.value = false
  resultText.value = ''
  emit('close')
}

async function runTool(): Promise<void> {
  const spec = active.value
  if (!spec || running.value) return
  if (spec.irreversible && !armed.value) {
    armed.value = true
    return
  }
  armed.value = false
  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(argsText.value || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('参数须为 JSON 对象')
    }
    args = parsed as Record<string, unknown>
  } catch (e) {
    resultText.value = `参数解析失败：${(e as Error).message}`
    return
  }
  running.value = true
  resultText.value = '执行中…'
  try {
    const r = await callTool(spec.name, args)
    resultText.value = JSON.stringify(r, null, 2)
  } catch (e) {
    resultText.value = `执行异常：${(e as Error).message}`
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="aah-tt">
    <div class="aah-tt-head">
      <span class="aah-tt-title">🧪 测试工具</span>
      <button class="aah-tt-close" @click="close">关闭测试</button>
    </div>

    <div class="aah-tt-tools">
      <button
        v-for="s in specs"
        :key="s.name"
        class="aah-tt-tool"
        :class="{ active: s.name === activeName, danger: s.irreversible }"
        @click="selectTool(s)"
      >
        <span class="aah-tt-tool-name">{{ s.name }}</span>
        <span v-if="s.irreversible" class="aah-tt-badge">不可撤回</span>
        <span class="aah-tt-tool-desc">{{ s.description }}</span>
      </button>
    </div>

    <div v-if="active" class="aah-tt-run">
      <div class="aah-tt-run-title">{{ active.name }}</div>
      <textarea v-model="argsText" class="aah-tt-args" spellcheck="false" rows="6" />
      <button
        class="aah-tt-run-btn"
        :class="{ danger: active.irreversible }"
        :disabled="running"
        @click="runTool"
      >
        {{ running ? '执行中…' : active.irreversible ? (armed ? '确认执行（不可撤回）' : '执行（需二次确认）') : '执行' }}
      </button>
      <pre v-if="resultText" class="aah-tt-result">{{ resultText }}</pre>
    </div>
    <p v-else class="aah-tt-hint">选一个工具。参数是 JSON，按需修改后执行；结果同时写入插件日志。</p>
  </div>
</template>

<style>
.aah-tt { display: flex; flex-direction: column; gap: 10px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 10px; padding: 12px; }
.aah-tt-head { display: flex; align-items: center; justify-content: space-between; }
.aah-tt-title { font-weight: 700; color: #5b21b6; font-size: 14px; }
.aah-tt-close { background: #fff; border: 1px solid #ddd6fe; color: #6d28d9; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.aah-tt-close:hover { border-color: #7c3aed; }
.aah-tt-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 190px; overflow-y: auto; }
.aah-tt-tool { text-align: left; background: #fff; border: 1px solid #ede9fe; border-radius: 8px; padding: 6px 8px; cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
.aah-tt-tool:hover { border-color: #a855f7; }
.aah-tt-tool.active { border-color: #7e22ce; box-shadow: inset 0 0 0 1px #7e22ce; }
.aah-tt-tool.danger .aah-tt-tool-name { color: #b91c1c; }
.aah-tt-tool-name { font-weight: 600; font-size: 12px; color: #4c1d95; }
.aah-tt-badge { font-size: 10px; color: #b91c1c; background: #fee2e2; border-radius: 4px; padding: 0 4px; }
.aah-tt-tool-desc { width: 100%; font-size: 11px; color: #6b7280; line-height: 1.4; }
.aah-tt-run { display: flex; flex-direction: column; gap: 6px; }
.aah-tt-run-title { font-size: 12px; font-weight: 600; color: #4c1d95; }
.aah-tt-args { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 12px; padding: 8px; border: 1px solid #e5e7eb; border-radius: 8px; resize: vertical; }
.aah-tt-run-btn { padding: 8px; border-radius: 8px; border: 1px solid #c4b5fd; background: #f5f3ff; color: #5b21b6; font-weight: 600; cursor: pointer; }
.aah-tt-run-btn.danger { border-color: #fca5a5; background: #fef2f2; color: #991b1b; }
.aah-tt-run-btn:disabled { opacity: .6; cursor: wait; }
.aah-tt-result { margin: 0; padding: 8px; background: #0f172a; color: #cbd5e1; border-radius: 8px; font-size: 11px; line-height: 1.5; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.aah-tt-hint { margin: 0; color: #6b7280; font-size: 12px; line-height: 1.6; }
</style>
