import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version: string }

function resolveGitSha(): string {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VITE_APP_GIT_SHA ||
    process.env.GITHUB_SHA
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: rootDir }).trim()
  } catch {
    return 'dev'
  }
}

const appGitSha = resolveGitSha()
const appBuildTime = new Date().toISOString()

// https://vite.dev/config/
export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    'import.meta.env.VITE_APP_GIT_SHA': JSON.stringify(appGitSha),
    'import.meta.env.VITE_APP_BUILD_TIME': JSON.stringify(appBuildTime),
  },
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
        target: 'https://translate.lucas-dev-server.tech',
        changeOrigin: true,
      },
    },
  },
})
