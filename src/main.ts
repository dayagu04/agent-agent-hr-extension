// 油猴脚本入口 —— 注入 Vue 悬浮面板到招聘平台页面
import { createApp } from 'vue'
import App from './App.vue'
import TestPanel from './TestPanel.vue'
import { startRemoteLoop } from './remote'

function mount() {
  // 创建挂载容器，直接挂在 body（样式用 .aah- 前缀避免与宿主冲突）
  const host = document.createElement('div')
  host.id = 'aah-plugin-root'
  document.body.appendChild(host)
  createApp(App).mount(host)

  // 独立测试面板：左下角「测」入口，与业务面板互不影响，可整体关闭
  const testHost = document.createElement('div')
  testHost.id = 'aah-test-host'
  document.body.appendChild(testHost)
  createApp(TestPanel).mount(testHost)
}

// 等页面加载完成再挂载（SPA 平台可能延迟渲染）
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => {
    mount()
    // 网页端远程管理：心跳 + 命令轮询（与悬浮面板独立）
    startRemoteLoop()
  }, 1000)
} else {
  window.addEventListener('load', () => {
    setTimeout(() => {
      mount()
      startRemoteLoop()
    }, 1000)
  })
}
