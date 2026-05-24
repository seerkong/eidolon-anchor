import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import path from 'path'

const backendProxyTarget = process.env.VITE_BACKEND_PROXY_TARGET || 'http://localhost:4000'

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => tag === 'wc-mdit'
        }
      }
    }), 
    vueJsx()
  ],
  root: '.',
  publicDir: './public',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../../../shared/src/modules/AiArchitect'),

      // el-lowcode 相关包的别名
      'el-lowcode': path.resolve(__dirname, './packages/el-lowcode'),
      'el-form-render': path.resolve(__dirname, './packages/el-form-render'),
      '@el-lowcode/utils': path.resolve(__dirname, './packages/utils'),
      '@el-lowcode/render': path.resolve(__dirname, './packages/render'),
      
      // TipTap 相关包的别名
      '@tiptap-capsule': path.resolve(__dirname, './packages/tiptap-capsule/src'),
      '@tiptap-ext-table': path.resolve(__dirname, './packages/tiptap-ext-table/src'),
      '@tiptap-ext-vue-text-btn-demo': path.resolve(__dirname, './packages/tiptap-ext-vue-text-btn-demo/src'),
      '@tiptap-ext-code-block-enhanced': path.resolve(__dirname, './packages/tiptap-ext-code-block-enhanced/src'),

      // Visual Graph 包别名
      '@visual-graph': path.resolve(__dirname, '../visual-graph/src'),

      'alien-signals': path.resolve(__dirname, 'node_modules/alien-signals'),
      xstream: path.resolve(__dirname, 'node_modules/xstream'),
    }
  },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    fs: {
      // Allow serving files from the monorepo root node_modules
      allow: [
        '..',
        '../../..',
        '../../../node_modules'
      ]
    },
    proxy: {
      '/api': {
        target: backendProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      '/sse': {
        target: backendProxyTarget,
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: backendProxyTarget,
        changeOrigin: true,
        secure: false,
        ws: true, // 启用WebSocket代理
      }
    },
    allowedHosts: [
      "example.com"
    ]
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['monaco-editor', 'highlight.js', '@tiptap/extension-bubble-menu', '@tiptap/vue-3'],
    exclude: ['wc-mdit']
  }
})
