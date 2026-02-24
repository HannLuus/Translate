import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Burmese–English Interpreter',
        short_name: 'Interpreter',
        description: 'Real-time Burmese to English interpreter with Tab Audio, Mic, and Rooted Android support',
        start_url: '/',
        display: 'standalone',
        background_color: '#242424',
        theme_color: '#4f46e5',
        icons: [
          { src: '/vite.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/functions/v1': {
        target: 'https://hbeixuedkdugfrpwpdph.supabase.co',
        changeOrigin: true,
      },
    },
  },
})
