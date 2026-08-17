/**
 * Environment configuration loader.
 * In development, empty VITE_API_BASE_URL can use Vite proxy,
 * or connect directly to VITE_API_BASE_URL.
 */
export const ENV = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL || "http://localhost:3000",
  HUB_WS_URL: import.meta.env.VITE_HUB_WS_URL || "ws://localhost:3100",
  IS_PRODUCTION: import.meta.env.PROD,
  IS_DEVELOPMENT: import.meta.env.DEV,
} as const;
