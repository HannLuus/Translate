/** Build identity injected at Vite build time (see vite.config.ts). */
export function getAppVersionLabel(): string {
  const pkg = import.meta.env.VITE_APP_VERSION || '0.0.0'
  const sha = import.meta.env.VITE_APP_GIT_SHA || 'dev'
  return `v${pkg} · ${sha}`
}

export function getAppBuildTime(): string | null {
  const t = import.meta.env.VITE_APP_BUILD_TIME
  return t && t.length > 0 ? t : null
}

/** Dispatched from main.tsx when a newer PWA build is waiting. */
export const APP_UPDATE_EVENT = 'interpreter-update-available'
