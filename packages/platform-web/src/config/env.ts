/**
 * Environment configuration loader.
 * In development, Vite proxy handles /api and /auth so API_BASE_URL defaults to "" (same-origin).
 */
export const ENV = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL ?? "",
  IS_PRODUCTION: import.meta.env.PROD,
  IS_DEVELOPMENT: import.meta.env.DEV,
} as const;
