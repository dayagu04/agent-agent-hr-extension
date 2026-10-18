// 油猴脚本入口 —— 注入 Vue 悬浮面板到招聘平台页面
import { createApp } from 'vue'
import App from './App.vue'
import { startRemoteLoop } from './remote'
import { installTestTools } from './test-tools'

function mount() {
  // 创建挂载容器，直接挂在 body（样式用 .aah- 前缀避免与宿主冲突）
  const host = document.createElement('div')
  host.id = 'aah-plugin-root'
  document.body.appendChild(host)
  createApp(App).mount(host)
  // 浏览器控制台测试工具（window.aahTools）：手动验证会话原子操作可行性
  installTestTools()
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
