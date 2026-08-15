/**
 * Shared look for the server-rendered pages.
 *
 * The dev palette is deliberately different from production: these pages are
 * an operator surface, and mistaking one environment for the other is the
 * expensive kind of mistake.
 */

export const IS_DEV = process.env.NODE_ENV === 'development'

/** Changes on every process start, which is what busts the service worker cache. */
export const BUILD_VERSION = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

export const THEME = {
  bg: IS_DEV ? '#1e2a3a' : '#1a1a2e',
  sidebar: IS_DEV ? '#1a3050' : '#16213e',
  border: IS_DEV ? '#1a4070' : '#0f3460',
  accent: IS_DEV ? '#3498db' : '#e94560',
  envLabel: IS_DEV
    ? '<span style="font-size:0.7rem;background:#3498db;color:#fff;padding:2px 6px;border-radius:4px;margin-left:8px;">DEV</span>'
    : '',
}
