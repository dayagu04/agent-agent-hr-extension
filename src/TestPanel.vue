<script setup lang="ts">
// 独立测试面板 —— 与业务面板完全分离的一个窗口。
//
// 用途：把 tools.ts 里的标准工具逐个手动跑一遍（筛选点击这类页面动作尤其需要）。
// 入口是左下角「测」悬浮按钮；面板可一键关闭，不影响业务面板。
import { computed, ref } from 'vue'
import { callTool, toolSpecs } from './tools'
import { VERSION } from './version'

interface Spec {
  name: string
  description: string
  irreversible: boolean
  exampleArgs: Record<string, unknown>
}

const specs = ref<Spec[]>(toolSpecs())
const open = ref(false)
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

function closePanel(): void {
  open.value = false
  activeName.value = ''
  resultText.value = ''
  armed.value = false
}

/** 不可撤回的工具要点两次：第一次上膛，第二次执行 */
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数须为 JSON 对象')
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
  <div class="aah-test-root">
    <button class="aah-test-fab" :class="{ open }" title="测试工具（独立面板）" @click="open = !open">
      测
    </button>

    <div v-if="open" class="aah-test-window">
      <div class="aah-test-window-header">
        <span class="aah-test-window-title">测试工具 · v{{ VERSION }}</span>
        <button class="aah-test-close" title="关闭测试面板" @click="closePanel">关闭</button>
      </div>

      <div class="aah-test-window-body">
        <div class="aah-test-list">
          <button
            v-for="s in specs"
            :key="s.name"
            class="aah-test-item"
            :class="{ active: s.name === activeName, danger: s.irreversible }"
            @click="selectTool(s)"
          >
            <span class="aah-test-item-name">{{ s.name }}</span>
            <span v-if="s.irreversible" class="aah-test-badge">不可撤回</span>
            <span class="aah-test-item-desc">{{ s.description }}</span>
          </button>
        </div>

        <div class="aah-test-run">
          <template v-if="active">
            <div class="aah-test-run-title">{{ active.name }}</div>
            <textarea v-model="argsText" class="aah-test-args" spellcheck="false" rows="8" />
            <button
              class="aah-test-run-btn"
              :class="{ danger: active.irreversible }"
              :disabled="running"
              @click="runTool"
            >
              {{ running ? '执行中…' : active.irreversible ? (armed ? '确认执行（不可撤回）' : '执行（需二次确认）') : '执行' }}
            </button>
            <pre v-if="resultText" class="aah-test-result">{{ resultText }}</pre>
          </template>
          <p v-else class="aah-test-hint">左侧选一个工具。参数是 JSON，按需修改后执行；结果同时写入插件日志。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.aah-test-root { position: fixed; z-index: 999998; left: 16px; bottom: 16px; font-size: 13px; font-family: -apple-system, sans-serif; }
.aah-test-fab { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #a855f7; background: #fff; color: #7e22ce; font-weight: 700; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.18); }
.aah-test-fab.open { background: #7e22ce; color: #fff; }
.aah-test-window { position: absolute; left: 0; bottom: 56px; width: 760px; max-width: calc(100vw - 32px); height: 460px; max-height: 70vh; background: #fff; border: 1px solid #e9d5ff; border-radius: 12px; box-shadow: 0 12px 36px rgba(0,0,0,.22); display: flex; flex-direction: column; overflow: hidden; }
.aah-test-window-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #7e22ce; color: #fff; }
.aah-test-window-title { font-weight: 600; }
.aah-test-close { background: rgba(255,255,255,.18); border: none; color: #fff; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.aah-test-window-body { flex: 1; min-height: 0; display: flex; }
.aah-test-list { width: 260px; flex: 0 0 260px; overflow-y: auto; border-right: 1px solid #f3e8ff; background: #faf5ff; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.aah-test-item { text-align: left; background: #fff; border: 1px solid #ede9fe; border-radius: 8px; padding: 7px 9px; cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
.aah-test-item:hover { border-color: #a855f7; }
.aah-test-item.active { border-color: #7e22ce; box-shadow: inset 0 0 0 1px #7e22ce; }
.aah-test-item-name { font-weight: 600; font-size: 12px; color: #4c1d95; }
.aah-test-badge { font-size: 10px; color: #b91c1c; background: #fee2e2; border-radius: 4px; padding: 0 4px; }
.aah-test-item-desc { width: 100%; font-size: 11px; color: #6b7280; line-height: 1.4; }
.aah-test-run { flex: 1; min-width: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.aah-test-run-title { font-weight: 600; color: #4c1d95; }
.aah-test-args { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 12px; padding: 8px; border: 1px solid #e5e7eb; border-radius: 8px; resize: vertical; }
.aah-test-run-btn { padding: 8px 12px; border-radius: 8px; border: 1px solid #c4b5fd; background: #f5f3ff; color: #5b21b6; font-weight: 600; cursor: pointer; }
.aah-test-run-btn.danger { border-color: #fca5a5; background: #fef2f2; color: #991b1b; }
.aah-test-result { margin: 0; padding: 8px; background: #0f172a; color: #cbd5e1; border-radius: 8px; font-size: 11px; line-height: 1.5; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.aah-test-hint { color: #6b7280; font-size: 12px; line-height: 1.6; }
</style>
