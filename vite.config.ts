import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import monkey, { cdn } from 'vite-plugin-monkey'
import pkg from './package.json'

// 平台 URL 匹配规则（插件仅在这些页面注入）
const matchUrls = [
  // 智联招聘
  'https://sou.zhaopin.com/*',
  'https://www.zhaopin.com/*',
  // BOSS 直聘（整域名：首页/列表页/聊天页都可注入，智能编排可从首页启动）
  'https://www.zhipin.com/*',

  // 51前程无忧、猎聘选择器未在真实页面验证，暂不启用真实投递
  // 'https://we.51job.com/pc/search*',
  // 'https://search.51job.com/*',
  // 'https://www.liepin.com/zhaopin/*',
  // 'https://m.liepin.com/*',
]

export default defineConfig({
  // Preserve the two extension directories and any locally loaded artifacts.
  build: { emptyOutDir: false },
  plugins: [
    vue(),
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: '智能求职助手 - 社招自动投递',
        namespace: 'agent-agent-hr',
        // 从 package.json 读，避免与 src/version.ts、App.vue 显示值漂移
        version: pkg.version,
        // 打 tag 后 CI 把产物挂到 GitHub Release，Tampermonkey 按 @version 自动更新
        updateURL: 'https://github.com/dayagu04/agent-agent-hr-extension/releases/latest/download/agent-agent-hr-tampermonkey.user.js',
        downloadURL: 'https://github.com/dayagu04/agent-agent-hr-extension/releases/latest/download/agent-agent-hr-tampermonkey.user.js',
        description: '社招平台自动投递 + 会话托管油猴插件（BOSS 直聘主支持）',
        author: 'agent-agent-hr',
        match: matchUrls,
        // @connect 只接受域名/IP，不能带端口号（写 'localhost:8010' 会被忽略）
        connect: ['gudaya.chat', 'localhost', '127.0.0.1'],
        grant: [
          'GM_xmlhttpRequest',
          'GM_setValue',
          'GM_getValue',
          'GM_deleteValue',
          'GM_listValues',
          'GM_notification',
        ],
      },
      build: {
        fileName: 'agent-agent-hr-tampermonkey.user.js',
        // Vue 走 CDN，减小脚本体积
        externalGlobals: {
          vue: cdn.jsdelivr('Vue', 'dist/vue.global.prod.js'),
        },
      },
    }),
  ],
})
