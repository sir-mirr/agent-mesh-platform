/**
 * The sign-in page.
 *
 * Takes the error code straight from the query string rather than a message,
 * so the copy stays here with the rest of the markup instead of being built at
 * the route.
 */

import { IS_DEV, THEME } from './theme'

export function renderLandingPage(error: string | undefined): string {
    const errorHtml = error === 'invalid'
    ? `<div style="color:${THEME.accent}; font-size:0.85rem; margin-top:8px;">Invalid username or password</div>`
    : error === 'missing'
      ? `<div style="color:${THEME.accent}; font-size:0.85rem; margin-top:8px;">Username and password are required</div>`
      : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>L's Agent Mesh</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .container {
    text-align: center;
    padding: 40px;
  }
  h1 {
    font-size: 3rem;
    font-weight: 700;
    margin-bottom: 8px;
    background: linear-gradient(135deg, ${THEME.accent}, ${THEME.border});
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .subtitle {
    color: #aaa;
    font-size: 1.1rem;
    margin-bottom: 48px;
  }
  .login-btn {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    padding: 14px 32px;
    background: ${THEME.sidebar};
    color: #e0e0e0;
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    font-size: 1.1rem;
    text-decoration: none;
    transition: all 0.2s;
    cursor: pointer;
  }
  .login-btn:hover {
    background: ${THEME.border};
    border-color: ${THEME.accent};
    transform: translateY(-1px);
  }
  .login-btn.primary {
    background: linear-gradient(135deg, ${THEME.accent}, ${IS_DEV ? '#2980b9' : '#c73652'});
    border: none;
    color: #fff;
    font-weight: 600;
  }
  .login-btn.primary:hover {
    filter: brightness(1.1);
    transform: translateY(-1px);
  }
  .login-btn svg {
    width: 24px;
    height: 24px;
    fill: currentColor;
  }
</style>
</head>
<body>
  <div class="container">
    <h1>L's Agent Mesh${IS_DEV ? ' <span style="font-size:1rem;vertical-align:middle;background:#3498db;color:#fff;padding:4px 10px;border-radius:6px;">DEV</span>' : ''}</h1>
    <p class="subtitle">Multi-agent communication hub</p>
    <a href="/auth/github" class="login-btn primary">
      <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Login with GitHub
    </a>
    <div style="margin-top:32px; color:#555; font-size:0.9rem;">&mdash; or &mdash;</div>
    <form action="/auth/local" method="POST" style="margin-top:24px; display:flex; flex-direction:column; align-items:center; gap:12px; width:100%;">
      <input name="username" type="text" placeholder="Username" required style="width:280px; padding:14px 16px; background:${THEME.sidebar}; border:1px solid ${THEME.border}; border-radius:8px; color:#e0e0e0; font-size:1rem; outline:none;">
      <input name="password" type="password" placeholder="Password" required style="width:280px; padding:14px 16px; background:${THEME.sidebar}; border:1px solid ${THEME.border}; border-radius:8px; color:#e0e0e0; font-size:1rem; outline:none;">
      <button type="submit" class="login-btn" style="width:280px; justify-content:center;">Login</button>
    </form>
    ${errorHtml}
    <div style="margin-top:48px;color:#555;font-size:0.8rem;">Agent Mesh v2</div>
  </div>
</body>
</html>`
}
