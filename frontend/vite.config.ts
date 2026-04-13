import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..')
  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      host: '0.0.0.0',
      port: 5175,
      strictPort: true,
      proxy: {
        '/api/': {
          target: env.VITE_API_TARGET || 'http://localhost:8100',
          changeOrigin: true,
        },
      },
      watch: {
        usePolling: true,
        interval: 1000,
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  }
})
