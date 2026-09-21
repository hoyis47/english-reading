import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite' // 1) 이 줄 추가

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(), // 2) 이 줄 추가
  ],  
  server: {
    proxy: {
      // /r2-api 로 시작하는 요청을 Cloudflare R2 엔드포인트로 안전하게 전달
      '/r2-api': {
        target: 'https://45fe633fedec13f69b6599fc5b564c78.r2.cloudflarestorage.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/r2-api/, ''),
      },
    },
  },
})

