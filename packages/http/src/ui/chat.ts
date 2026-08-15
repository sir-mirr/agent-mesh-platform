/**
 * Server-rendered chat pages.
 *
 * Each function returns a complete HTML document. The browser-side script
 * lives inside these template literals rather than as separate assets — the
 * server has no build step, and inlining is what lets it stay that way.
 */

import { IS_DEV, THEME } from './theme'

export function renderPendingApprovalPage(user: { github_login: string; role: string }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Mesh - Pending Approval</title>
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
    max-width: 480px;
  }
  .avatar {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    border: 3px solid #0f3460;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 600;
    margin-bottom: 12px;
    color: #e94560;
  }
  .login-name {
    font-size: 1.1rem;
    color: #888;
    margin-bottom: 24px;
  }
  .status-msg {
    font-size: 1rem;
    color: #ccc;
    line-height: 1.6;
    margin-bottom: 32px;
  }
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid #555;
    border-top-color: #e94560;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    vertical-align: middle;
    margin-right: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .poll-status {
    font-size: 0.85rem;
    color: #555;
    margin-top: 8px;
  }
  .logout-btn {
    display: inline-block;
    padding: 8px 20px;
    background: #16213e;
    color: #888;
    border: 1px solid #0f3460;
    border-radius: 6px;
    text-decoration: none;
    font-size: 0.9rem;
    cursor: pointer;
    margin-top: 16px;
  }
  .logout-btn:hover { color: #e94560; border-color: #e94560; }
</style>
</head>
<body>
  <div class="container">
    <img class="avatar" src="https://github.com/${user.github_login}.png?size=160" alt="">
    <h1>승인 대기 중</h1>
    <div class="login-name">${user.github_login}</div>
    <div class="status-msg">
      접근 승인을 요청했습니다.<br>
      관리자의 승인을 기다려주세요.
    </div>
    <div>
      <span class="spinner"></span>
      <span class="poll-status" id="pollStatus">승인 여부 확인 중...</span>
    </div>
    <button class="logout-btn" onclick="document.cookie='mesh_token=; path=/; max-age=0'; location.href='/';">Logout</button>
  </div>
<script>
const TOKEN = document.cookie.split('; ').find(c => c.startsWith('mesh_token='))?.split('=').slice(1).join('=') || '';
async function checkApproval() {
  try {
    const res = await fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const data = await res.json();
    if (data.approved) {
      location.reload();
    }
  } catch(e) {}
}
setInterval(checkApproval, 5000);
</script>
</body>
</html>`
}

export function renderAgentNotFoundPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Mesh - Not Found</title>
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
    max-width: 480px;
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 600;
    margin-bottom: 16px;
    color: ${THEME.accent};
  }
  .message {
    font-size: 1rem;
    color: #888;
    margin-bottom: 32px;
  }
  .home-btn {
    display: inline-block;
    padding: 12px 28px;
    background: ${THEME.sidebar};
    color: #e0e0e0;
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    font-size: 1rem;
    text-decoration: none;
    transition: all 0.2s;
  }
  .home-btn:hover {
    background: ${THEME.border};
    border-color: ${THEME.accent};
  }
</style>
</head>
<body>
  <div class="container">
    <h1>Agent Not Found</h1>
    <p class="message">등록된 에이전트가 없습니다</p>
    <a href="/chat" class="home-btn">홈으로</a>
  </div>
</body>
</html>`
}

export function renderChatPage(user: { github_login: string; role: string }, initialAgent: string = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Agent Mesh - Chat</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    height: 100%;
    margin: 0;
  }
  body {
    display: flex;
    overflow: hidden;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }

  /* Sidebar */
  .sidebar {
    width: 260px;
    min-width: 260px;
    background: ${THEME.sidebar};
    border-right: 1px solid ${THEME.border};
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sidebar-header {
    padding: 16px;
    border-bottom: 1px solid #0f3460;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sidebar-header h2 {
    font-size: 1rem;
    color: ${THEME.accent};
    font-weight: 600;
  }
  .user-info {
    padding: 12px 16px;
    border-bottom: 1px solid ${THEME.border};
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.9rem;
  }
  .user-info img {
    width: 28px;
    height: 28px;
    border-radius: 50%;
  }
  .user-info .username {
    color: #ccc;
    flex: 1;
  }
  .logout-btn {
    color: #888;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 10px 12px;
    border-radius: 4px;
  }
  .logout-btn:hover { color: #e94560; background: #1a1a2e; }
  .agent-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .agent-item {
    padding: 12px 16px;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: all 0.15s;
    font-size: 0.9rem;
    min-height: 44px;
  }
  .agent-item:hover {
    background: #1a1a2e;
  }
  .agent-item.active {
    background: ${IS_DEV ? '#1a2a40' : '#1a1a2e'};
    border-left-color: ${THEME.accent};
    border-left-width: 3px;
  }
  .agent-item .agent-name {
    font-weight: 500;
    font-size: 0.95rem;
  }
  .agent-item .agent-desc {
    font-size: 0.78rem;
    color: #999;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Main chat area */
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  #chatArea {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .chat-header {
    padding: 14px 20px;
    border-bottom: 1px solid #0f3460;
    background: #16213e;
    font-weight: 600;
    font-size: 1rem;
  }
  .chat-messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chat-messages::before {
    content: '';
    flex: 1;
  }
  .msg {
    max-width: 70%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 0.9rem;
    line-height: 1.45;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .msg.sent {
    align-self: flex-end;
    background: ${IS_DEV ? '#1a3a5a' : '#0f3460'};
    border-bottom-right-radius: 4px;
  }
  .msg.received {
    align-self: flex-start;
    background: ${IS_DEV ? '#1a2a3a' : '#16213e'};
    border: 1px solid ${IS_DEV ? '#1a4070' : '#0f3460'};
    border-left: 3px solid ${IS_DEV ? '#2a6090' : '#1a4a70'};
    border-bottom-left-radius: 4px;
  }
  .msg .meta {
    font-size: 0.72rem;
    color: #999;
    margin-top: 4px;
  }
  .no-agent {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #555;
    font-size: 1.1rem;
  }

  /* Input area */
  .chat-input {
    padding: 12px 20px;
    border-top: 1px solid #0f3460;
    background: #16213e;
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-shrink: 0;   /* 보강: 키보드 열림 + 긴 목록 상황에서 컨테이너 축소 방지 */
  }
  .chat-input > #attachBtn,
  .chat-input > #sendBtn { flex-shrink: 0; }
  .input-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .file-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #0f3460;
    color: #e0e0e0;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 0.8rem;
    max-width: 220px;
  }
  .file-chip .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
  .file-chip .close {
    background: none;
    border: none;
    color: #bbb;
    cursor: pointer;
    padding: 0 2px;
    font-size: 0.9rem;
    line-height: 1;
    min-height: 0;
  }
  .file-chip .close:hover { color: #e94560; }
  .chat-input textarea {
    background: ${THEME.bg};
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    color: #e0e0e0;
    padding: 8px 12px;
    font-size: 16px;
    line-height: 1.45;
    font-family: inherit;
    resize: none;
    outline: none;
    min-height: 44px;
    max-height: 208px;
    overflow-y: hidden;
    touch-action: pan-y;
    width: 100%;
    box-sizing: border-box;
  }
  .chat-input textarea:focus {
    /* 포커스 halo: 브랜드 accent 35% opacity. 향후 에러 상태는 solid border로 분리 */
    border-color: ${THEME.border};
    box-shadow: 0 0 0 2px ${THEME.accent}59;
  }
  .chat-input button {
    padding: 12px 20px;
    background: ${IS_DEV ? '#2980b9' : 'linear-gradient(135deg, #3498db, #2980b9)'};
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.15s;
    white-space: nowrap;
    min-height: 44px;
  }
  .chat-input button:hover { background: ${IS_DEV ? '#2471a3' : '#2471a3'}; }
  .chat-input button:disabled { background: #555; cursor: not-allowed; opacity: 0.6; }
  /* Send 버튼: 44x44 아이콘 버튼 */
  .chat-input #sendBtn {
    padding: 0;
    width: 44px;
    min-width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .chat-input #sendBtn svg { width: 20px; height: 20px; }

  /* Search */
  .search-toggle-btn {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 6px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }
  .search-toggle-btn:hover { color: #e94560; background: #1a1a2e; }
  .search-panel {
    border-bottom: 1px solid #0f3460;
    padding: 8px 12px;
    background: #16213e;
  }
  .search-input-wrap {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .search-input-wrap input {
    flex: 1;
    background: #1a1a2e;
    border: 1px solid #0f3460;
    border-radius: 6px;
    color: #e0e0e0;
    padding: 7px 10px;
    font-size: 0.85rem;
    outline: none;
  }
  .search-input-wrap input:focus { border-color: #e94560; }
  .search-go-btn {
    background: #0f3460;
    color: #e0e0e0;
    border: none;
    border-radius: 6px;
    padding: 7px 12px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .search-go-btn:hover { background: #e94560; }
  .search-close-btn {
    background: none;
    border: none;
    color: #888;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 4px 6px;
  }
  .search-close-btn:hover { color: #e94560; }
  .search-results {
    max-height: 300px;
    overflow-y: auto;
    margin-top: 6px;
  }
  .search-result-item {
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.82rem;
    border-bottom: 1px solid #0f346033;
  }
  .search-result-item:hover { background: #1a1a2e; }
  .search-result-item .sr-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
  }
  .search-result-item .sr-agent { color: #e94560; font-weight: 500; }
  .search-result-item .sr-time { color: #555; font-size: 0.75rem; }
  .search-result-item .sr-content {
    color: #aaa;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .search-empty { color: #555; font-size: 0.82rem; padding: 12px 4px; text-align: center; }

  /* Unread badge */
  .unread-dot {
    background: #e94560;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-left: 8px;
    flex-shrink: 0;
  }
  .agent-item .agent-name-row {
    display: flex;
    align-items: center;
  }

  /* Date separator */
  .date-separator {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 12px 0 4px;
    font-size: 0.75rem;
    color: #777;
  }
  .date-separator::before,
  .date-separator::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #0f3460;
  }
  .date-separator span {
    white-space: nowrap;
  }

  /* Mobile */
  @media (max-width: 768px) {
    .sidebar { width: 200px; min-width: 200px; }
    .msg { max-width: 85%; }
  }
  @media (max-width: 520px) {
    body { flex-direction: column; }
    .sidebar {
      width: 100%;
      min-width: 100%;
      flex: 1;
      border-right: none;
      border-bottom: none;
      overflow-y: auto;
    }
    .sidebar.collapsed { display: none; }
    .main { flex: 1; min-height: 0; display: none; }
    .sidebar.collapsed + .main { display: flex; }
    .back-btn {
      display: inline-block;
      background: none;
      border: none;
      color: #e94560;
      font-size: 1.1rem;
      cursor: pointer;
      padding: 0 8px 0 0;
    }
    .chat-input {
      padding: 8px 12px;
      padding-bottom: max(8px, env(safe-area-inset-bottom));
    }
    .chat-input textarea { min-height: 44px; max-height: 208px; font-size: 16px; }
  }
  @media (display-mode: standalone) {
    .chat-input {
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
  }
  @media (min-width: 521px) {
    .back-btn { display: none; }
  }
  .typing-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    color: #bbb;
    font-size: 0.85rem;
  }
  .typing-indicator .dots {
    display: flex;
    gap: 4px;
  }
  .typing-indicator .dots span {
    width: 8px;
    height: 8px;
    background: ${THEME.accent};
    border-radius: 50%;
    animation: typing-bounce 1.4s infinite ease-in-out;
  }
  .typing-indicator .dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing-indicator .dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing-bounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }
</style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header">
      <h2>Agent Mesh${THEME.envLabel}</h2>
      <button class="search-toggle-btn" onclick="toggleSearch()" title="Search messages">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
    </div>
    <div class="search-panel" id="searchPanel" style="display:none;">
      <div class="search-input-wrap">
        <input type="text" id="searchInput" placeholder="Search messages..." onkeydown="if(event.key==='Enter')doSearch()" />
        <button class="search-go-btn" onclick="doSearch()">Go</button>
        <button class="search-close-btn" onclick="toggleSearch()">&times;</button>
      </div>
      <div class="search-results" id="searchResults"></div>
    </div>
    <div class="user-info">
      <img id="avatar" src="https://github.com/${user.github_login}.png?size=56" alt="" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div style=\\'width:28px;height:28px;border-radius:50%;background:${THEME.border};display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:600;color:#e0e0e0;\\'>${user.github_login.charAt(0).toUpperCase()}</div>')">
      <span class="username">${user.github_login}</span>
      ${user.role === 'admin' ? '<a href="/admin" style="color:#888;font-size:0.8rem;padding:10px 8px;text-decoration:none;">Admin</a>' : ''}
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="agent-list" id="agentList">
      <div style="padding: 16px; color: #555; font-size: 0.85rem;">Loading agents...</div>
    </div>
  </div>

  <div class="main">
    <div class="chat-header" id="chatHeader" style="display:none;"><button class="back-btn" onclick="showSidebar()">&#9664;</button><span id="chatTitle"></span></div>
    <div id="chatArea">
      <div class="no-agent"></div>
    </div>
  </div>

<script>
const MY_LOGIN = '${user.github_login}';
const INITIAL_AGENT = '${initialAgent}';
const TOKEN = document.cookie.split('; ').find(c => c.startsWith('mesh_token='))?.split('=').slice(1).join('=') || '';

// --- KST timestamp helpers (Asia/Seoul, browser-locale independent via Intl) ---
function kstParts(isoOrSqliteUtc) {
  const s = String(isoOrSqliteUtc).trim();
  const withT = s.includes('T') ? s : s.replace(' ', 'T');
  const withZ = /Z$|[+-]\\d\\d:?\\d\\d$/.test(withT) ? withT : withT + 'Z';
  const d = new Date(withZ);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24, // Intl may give "24" for midnight in some locales; normalize
    minute: Number(get('minute')),
    second: Number(get('second')),
    date: d,
  };
}
function toKST(isoOrSqliteUtc) {
  const p = kstParts(isoOrSqliteUtc);
  if (!p) return String(isoOrSqliteUtc);
  const pad = n => String(n).padStart(2, '0');
  return p.year + '-' + pad(p.month) + '-' + pad(p.day) + ' ' +
         pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second) + ' KST';
}

let currentAgent = null;
let agents = [];
let eventSource = null;
let lastMsgCount = 0;
let lastMsgKey = '';
let isFirstLoad = true;
let agentLatestTs = {}; // { agentId: isoTimestamp } — latest message per agent

const headers = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// --- Unread tracking (localStorage) ---
function getLastReadTs() {
  try { return JSON.parse(localStorage.getItem('mesh_lastRead') || '{}'); } catch { return {}; }
}
function setLastReadTs(agentId, ts) {
  const data = getLastReadTs();
  data[agentId] = ts;
  localStorage.setItem('mesh_lastRead', JSON.stringify(data));
}
function hasUnread(agentId) {
  const latest = agentLatestTs[agentId];
  if (!latest) return false;
  const lastRead = getLastReadTs()[agentId];
  if (!lastRead) return true;
  return latest > lastRead;
}

async function loadAgents() {
  try {
    const res = await fetch('/api/v1/agents', { headers });
    const data = await res.json();
    agents = (data.agents || []).filter(a => a.id !== MY_LOGIN);
    // Fetch latest message ts for each agent (for unread dots)
    await refreshUnreadState();
    renderAgents();
  } catch(e) {
    document.getElementById('agentList').innerHTML = '<div style="padding:16px;color:#e94560;">Failed to load agents</div>';
  }
}

async function refreshUnreadState() {
  const promises = agents.map(async (a) => {
    try {
      const res = await fetch('/api/v1/messages/' + encodeURIComponent(a.id) + '?limit=10', { headers });
      const data = await res.json();
      const msgs = (data.messages || []).filter(m =>
        (m.from === a.id && m.to === MY_LOGIN) || (m.from === MY_LOGIN && m.to === a.id)
      );
      if (msgs.length > 0) {
        // Find the latest message from the OTHER agent (incoming)
        const incoming = msgs.filter(m => m.from === a.id);
        if (incoming.length > 0) {
          agentLatestTs[a.id] = incoming[incoming.length - 1].ts;
        }
      }
    } catch {}
  });
  await Promise.all(promises);
}

function renderAgents() {
  const el = document.getElementById('agentList');
  if (agents.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:#555;font-size:0.85rem;">No agents registered</div>';
    return;
  }
  const mobile = window.innerWidth <= 520;
  el.innerHTML = agents.map(a => {
    const dot = hasUnread(a.id) ? '<span class="unread-dot"></span>' : '';
    const inner = '<div class="agent-name-row"><span class="agent-name">' + escHtml(a.name) + '</span>' + dot + '</div>' +
      (a.description ? '<div class="agent-desc">' + escHtml(a.description) + '</div>' : '');
    if (mobile) {
      return '<a href="/chat/' + encodeURIComponent(a.id) + '" class="agent-item' + (currentAgent === a.id ? ' active' : '') + '" style="display:block;text-decoration:none;color:inherit;">' + inner + '</a>';
    }
    return '<div class="agent-item' + (currentAgent === a.id ? ' active' : '') + '" onclick="selectAgent(\\'' + a.id.replace(/'/g, "\\\\'") + '\\')">' + inner + '</div>';
  }).join('');
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

var pollTimer = null;
function connectSSE(agentId) {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  eventSource = new EventSource('/api/v1/events/' + encodeURIComponent(agentId) + '?token=' + encodeURIComponent(TOKEN));
  eventSource.addEventListener('message', function(e) {
    lastMsgCount = 0;
    lastMsgKey = '';
    try {
      var msg = JSON.parse(e.data);
      if (msg.from === agentId) hideTyping();
    } catch(err) { hideTyping(); }
    loadMessages();
  });
  eventSource.addEventListener('delivered', function(e) {
    showTyping();
  });
  eventSource.addEventListener('connected', function(e) {
    console.log('SSE connected for', agentId);
  });
  eventSource.onerror = function() {
    setTimeout(function() {
      if (currentAgent === agentId) connectSSE(agentId);
    }, 5000);
  };
  // Polling fallback: check for new messages every 5s in case SSE push is missed
  pollTimer = setInterval(function() {
    if (currentAgent === agentId) loadMessages();
  }, 5000);
}

function selectAgent(id, skipPush) {
  currentAgent = id;
  if (!skipPush) history.pushState({ view: 'chat', agent: id }, '', '/chat/' + encodeURIComponent(id));
  isFirstLoad = true;
  lastMsgCount = 0;
  lastMsgKey = '';
  // Mark as read
  setLastReadTs(id, new Date().toISOString());
  const agent = agents.find(a => a.id === id);
  document.getElementById('chatHeader').style.display = '';
  document.getElementById('chatTitle').textContent = agent ? agent.name + ' (' + id + ')' : id;
  renderAgents();
  showChatUI();
  loadMessages();
  connectSSE(id);
  // Mobile: collapse sidebar
  if (window.innerWidth <= 520) {
    document.querySelector('.sidebar').classList.add('collapsed');
  }
}

function closeChatToSidebar() {
  currentAgent = null;
  if (eventSource) { eventSource.close(); eventSource = null; }
  document.querySelector('.sidebar').classList.remove('collapsed');
  const header = document.getElementById('chatHeader');
  if (header) header.style.display = 'none';
  const area = document.getElementById('chatArea');
  if (area) area.innerHTML = '<div class="no-agent"></div>';
  renderAgents();
}

function showSidebar() {
  // popstate 컨텍스트 외 직접 호출(닫기 버튼 등) — history 추가 후 SPA 전환
  if (currentAgent !== null) {
    history.pushState(null, '', '/chat');
  }
  closeChatToSidebar();
}

function showChatUI() {
  document.getElementById('chatArea').innerHTML =
    '<div class="chat-messages" id="messages"></div>' +
    '<div id="typingIndicator" class="typing-indicator" style="display:none;">' +
      '<div class="dots"><span></span><span></span><span></span></div>' +
      '<span id="typingText">응답 대기 중...</span>' +
    '</div>' +
    '<input type="file" id="fileUploadInput" style="display:none;" onchange="onFileSelected(this)">' +
    '<div class="chat-input">' +
    '<button id="attachBtn" onclick="triggerFileUpload()" title="Attach file" style="background:none;border:1px solid #0f3460;border-radius:8px;color:#888;cursor:pointer;padding:10px 12px;font-size:1.1rem;min-height:44px;transition:all 0.15s;">&#x1F4CE;</button>' +
    '<div class="input-wrapper">' +
    '<div class="file-chip-row" id="fileChipRow" style="display:none;">' +
    '<span class="file-chip" id="fileChip"><span class="name" id="fileChipName"></span><button class="close" type="button" onclick="clearFileUpload()" aria-label="Remove file">&#x2715;</button></span>' +
    '</div>' +
    '<textarea id="msgInput" rows="1" placeholder="Message" onkeydown="handleKey(event)" oninput="updateSendBtnState(); autoResizeInput(this);"></textarea>' +
    '</div>' +
    '<button id="sendBtn" onclick="sendMessage()" disabled aria-label="Send"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg></button>' +
    '</div>';
  if (window.innerWidth > 520) {
    document.getElementById('msgInput').focus();   // 데스크톱만 자동 focus
  }
  updateSendBtnState();
}

function updateSendBtnState() {
  const input = document.getElementById('msgInput');
  const btn = document.getElementById('sendBtn');
  if (!input || !btn) return;
  btn.disabled = input.value.trim().length === 0;
}

let pendingFilePath = null;

function triggerFileUpload() {
  document.getElementById('fileUploadInput').click();
}

function onFileSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const row = document.getElementById('fileChipRow');
  const btn = document.getElementById('attachBtn');
  document.getElementById('fileChipName').textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + 'KB)';
  row.style.display = 'flex';
  btn.style.borderColor = '#e94560';
  btn.style.color = '#e94560';
}

function clearFileUpload() {
  const row = document.getElementById('fileChipRow');
  const btn = document.getElementById('attachBtn');
  document.getElementById('fileUploadInput').value = '';
  document.getElementById('fileChipName').textContent = '';
  row.style.display = 'none';
  btn.style.borderColor = '#0f3460';
  btn.style.color = '#888';
  pendingFilePath = null;
}

function clearFilePath() {
  document.getElementById('filePathInput').value = '';
  toggleFileInput();
}

// --- FR-017: Relative time + Date grouping (KST) ---
function relativeTime(ts) {
  const now = Date.now();
  const d = new Date(ts);
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return diffMin + '분 전';
  if (diffHr < 24) return diffHr + '시간 전';
  if (diffDay < 7) return diffDay + '일 전';
  const p = kstParts(ts);
  if (!p) return String(ts);
  const pad = n => String(n).padStart(2, '0');
  return pad(p.month) + '/' + pad(p.day) + ' ' + pad(p.hour) + ':' + pad(p.minute);
}

function dateSeparatorHtml(prevTs, currentTs) {
  const prev = prevTs ? kstParts(prevTs) : null;
  const cur = kstParts(currentTs);
  if (!cur) return '';
  // Check if same calendar day in KST
  if (prev && prev.year === cur.year && prev.month === cur.month && prev.day === cur.day) {
    return '';
  }
  const nowP = kstParts(new Date().toISOString());
  let diffDays = Infinity;
  if (nowP) {
    // Compute day diff from KST calendar date using UTC-midnight arithmetic on components
    const todayUtc = Date.UTC(nowP.year, nowP.month - 1, nowP.day);
    const curUtc = Date.UTC(cur.year, cur.month - 1, cur.day);
    diffDays = Math.round((todayUtc - curUtc) / 86400000);
  }
  let label;
  if (diffDays === 0) label = '오늘';
  else if (diffDays === 1) label = '어제';
  else label = cur.month + '월 ' + cur.day + '일';
  return '<div class="date-separator"><span>' + label + '</span></div>';
}

var typingTimer = null;
function showTyping() {
  var el = document.getElementById('typingIndicator');
  if (el) {
    var label = document.getElementById('typingText');
    if (label && currentAgent) {
      var agent = agents.find(function(a) { return a.id === currentAgent; });
      label.textContent = (agent ? agent.name : currentAgent) + ' 응답 중...';
    }
    el.style.display = 'flex';
    var msgEl = document.getElementById('messages');
    if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
  }
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(function() { hideTyping(); }, 60000);
}
function hideTyping() {
  var el = document.getElementById('typingIndicator');
  if (el) el.style.display = 'none';
  if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
}

async function loadMessages() {
  if (!currentAgent) return;
  try {
    const res = await fetch('/api/v1/messages/' + encodeURIComponent(currentAgent) + '?limit=100', { headers });
    const data = await res.json();
    const msgs = data.messages || [];
    // Update if messages changed (compare last message ID)
    const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
    const prevLastId = lastMsgCount > 0 ? String(lastMsgCount) : '';
    const newKey = msgs.length + ':' + lastId;
    if (newKey !== lastMsgKey) {
      // Check if the new message is from the agent (not from me)
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      if (lastMsg && lastMsg.from === currentAgent) hideTyping();
      lastMsgKey = newKey;
      lastMsgCount = msgs.length;
      renderMessages(msgs);
    }
    // Update unread tracking: mark latest incoming message ts
    const incoming = msgs.filter(m => m.from === currentAgent && m.to === MY_LOGIN);
    if (incoming.length > 0) {
      agentLatestTs[currentAgent] = incoming[incoming.length - 1].ts;
      // Since user is viewing, update lastRead
      setLastReadTs(currentAgent, new Date().toISOString());
    }
  } catch(e) {}
}

function renderMessages(msgs) {
  const el = document.getElementById('messages');
  if (!el) return;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;

  // Filter messages relevant to this conversation (between user and agent)
  const relevant = msgs.filter(m =>
    (m.from === MY_LOGIN && m.to === currentAgent) ||
    (m.from === currentAgent && m.to === MY_LOGIN) ||
    (m.to === currentAgent && m.from === MY_LOGIN) ||
    (m.to === MY_LOGIN && m.from === currentAgent)
  );

  let html = '';
  let prevTs = null;
  for (let i = 0; i < relevant.length; i++) {
    const m = relevant[i];
    const isSent = m.from === MY_LOGIN;
    const timeStr = relativeTime(m.ts);
    const kp = kstParts(m.ts);
    const pad2 = n => String(n).padStart(2, '0');
    const absTime = kp ? (kp.month + '/' + kp.day + ' ' + pad2(kp.hour) + ':' + pad2(kp.minute) + ' KST') : String(m.ts);
    // Date separator
    const sep = dateSeparatorHtml(prevTs, m.ts);
    if (sep) html += sep;
    prevTs = m.ts;
    let fileHtml = '';
    if (m.file_path) {
      const fileName = m.file_path.split('/').pop() || m.file_path;
      fileHtml = '<div class="file-attachment" style="margin-top:6px;padding:6px 10px;background:rgba(15,52,96,0.5);border:1px solid #0f3460;border-radius:6px;font-size:0.82rem;">' +
        '<a href="#" onclick="event.preventDefault();window.open(\\'/api/v1/files?path=' + encodeURIComponent(m.file_path) + '\\',\\'_system\\');" style="color:#e94560;text-decoration:none;" title="' + escHtml(m.file_path) + '">&#x1F4CE; ' + escHtml(fileName) + '</a>' +
        '<span style="color:#555;margin-left:6px;font-family:monospace;font-size:0.75rem;">' + escHtml(m.file_path) + '</span>' +
        '</div>';
    }
    html += '<div class="msg ' + (isSent ? 'sent' : 'received') + '" data-msgid="' + escHtml(m.id) + '">' +
      escHtml(m.content) +
      fileHtml +
      '<div class="meta">' + (isSent ? 'You' : escHtml(m.from)) + ' &middot; ' + absTime + ' (' + timeStr + ')' + '</div>' +
      '</div>';
  }
  el.innerHTML = html;

  if (pendingScrollToMsg) {
    scrollToAndHighlight();
  } else if (isFirstLoad || wasAtBottom) {
    el.scrollTop = el.scrollHeight;
    isFirstLoad = false;
  }
}

async function sendMessage() {
  const input = document.getElementById('msgInput');
  const btn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('filePathInput');
  const text = input.value.trim();
  if (!text || !currentAgent) return;

  btn.disabled = true;
  input.value = '';
  input.style.height = '44px';

  const msgPayload = { to: currentAgent, text };

  try {
    // Upload file first if selected
    const fileEl = document.getElementById('fileUploadInput');
    if (fileEl && fileEl.files && fileEl.files[0]) {
      const formData = new FormData();
      formData.append('file', fileEl.files[0]);
      const uploadRes = await fetch('/api/v1/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN },
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (uploadRes.ok && uploadData.file_path) {
        msgPayload.file_path = uploadData.file_path;
      } else {
        alert(uploadData.error || 'Upload failed');
        btn.disabled = false;
        input.value = text;
        return;
      }
    }

    const res = await fetch('/api/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(msgPayload)
    });
    const data = await res.json();
    if (!res.ok && data.error) {
      alert(data.error);
      input.value = text;
    } else {
      clearFileUpload();
    }
    lastMsgCount = 0; // Force refresh
    lastMsgKey = '';
    isFirstLoad = true; // Force scroll to bottom
    await loadMessages();
  } catch(e) {
    input.value = text;
  }
  updateSendBtnState();
  input.focus();
}

const isMobile = window.innerWidth <= 520;

const MAX_INPUT_HEIGHT = 208; // 8줄 기준: 16px * 1.45 * 8 ≈ 185.6px + padding(16) + border(2) ≈ 204px → 208px

function autoResizeInput(el) {
  el.style.height = 'auto';                                // flex 제약 해제 트릭 — natural size 재계산 유도
  const newH = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT);
  el.style.height = newH + 'px';
  el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.isComposing) {
    if (isMobile) {
      // Mobile: Enter = newline, send only via button
      return;
    }
    // PC: Enter = send, Shift+Enter or Ctrl+Enter = newline
    if (!e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
  }
}

function logout() {
  document.cookie = 'mesh_token=; path=/; max-age=0';
  location.href = '/';
}

// --- Search ---
function toggleSearch() {
  const panel = document.getElementById('searchPanel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  if (!visible) {
    document.getElementById('searchInput').focus();
  } else {
    document.getElementById('searchResults').innerHTML = '';
    document.getElementById('searchInput').value = '';
  }
}

async function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  const resultsEl = document.getElementById('searchResults');
  if (!q) { resultsEl.innerHTML = ''; return; }

  resultsEl.innerHTML = '<div class="search-empty">Searching...</div>';
  try {
    const res = await fetch('/api/v1/messages/search?q=' + encodeURIComponent(q) + '&limit=50', { headers });
    const data = await res.json();
    const msgs = data.messages || [];
    if (msgs.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">No results found</div>';
      return;
    }
    const searchQuery = q;
    resultsEl.innerHTML = msgs.map(m => {
      const other = m.from === MY_LOGIN ? m.to : m.from;
      const time = (function(){ const kp = kstParts(m.ts); const pad2 = n => String(n).padStart(2, '0'); return kp ? (kp.month + '/' + kp.day + ' ' + pad2(kp.hour) + ':' + pad2(kp.minute) + ' KST') : String(m.ts); })();
      const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
      return '<div class="search-result-item" onclick="searchNav(\\'' + other.replace(/'/g, "\\\\'") + '\\',\\'' + m.id.replace(/'/g, "\\\\'") + '\\',\\'' + searchQuery.replace(/'/g, "\\\\'") + '\\')">' +
        '<div class="sr-header"><span class="sr-agent">' + escHtml(m.from === MY_LOGIN ? 'You -> ' + other : other) + '</span><span class="sr-time">' + time + '</span></div>' +
        '<div class="sr-content">' + escHtml(preview) + '</div></div>';
    }).join('');
  } catch(e) {
    resultsEl.innerHTML = '<div class="search-empty">Search failed</div>';
  }
}

let pendingScrollToMsg = null;
let pendingHighlight = null;

function searchNav(agentId, msgId, query) {
  // Close search panel and navigate to that agent's chat
  toggleSearch();
  pendingScrollToMsg = msgId;
  pendingHighlight = query;
  if (agents.find(a => a.id === agentId)) {
    selectAgent(agentId);
  }
}

function scrollToAndHighlight() {
  if (!pendingScrollToMsg) return;
  const msgId = pendingScrollToMsg;
  const query = pendingHighlight;
  pendingScrollToMsg = null;
  pendingHighlight = null;

  setTimeout(() => {
    const el = document.getElementById('messages');
    if (!el) return;
    // Find the message element by data-id
    const msgEl = el.querySelector('[data-msgid="' + msgId + '"]');
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      msgEl.style.outline = '2px solid ' + '${THEME.accent}';
      msgEl.style.outlineOffset = '4px';
      setTimeout(() => { msgEl.style.outline = ''; msgEl.style.outlineOffset = ''; }, 3000);
    }
    // Highlight search text
    if (query) {
      const allMsgs = el.querySelectorAll('.msg');
      allMsgs.forEach(m => {
        const textNodes = m.childNodes;
        textNodes.forEach(n => {
          if (n.nodeType === 3 && n.textContent.includes(query)) {
            const span = document.createElement('span');
            span.innerHTML = n.textContent.replace(new RegExp('(' + query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi'), '<mark style="background:${THEME.accent};color:#fff;padding:1px 3px;border-radius:3px;">$1</mark>');
            n.parentNode.replaceChild(span, n);
            setTimeout(() => {
              span.querySelectorAll('mark').forEach(mk => { mk.style.background = 'transparent'; mk.style.color = 'inherit'; });
            }, 3000);
          }
        });
      });
    }
  }, 500);
}

// Fix viewport height for PWA / mobile browsers
function fixViewportHeight() {
  document.body.style.height = window.innerHeight + 'px';
}
fixViewportHeight();
window.addEventListener('resize', fixViewportHeight);

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const m = location.pathname.match(/^\\/chat\\/(.+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (agents.find(a => a.id === id)) selectAgent(id, true);
  } else {
    // URL이 /chat (id 없음) — SPA 내 sidebar 복귀
    closeChatToSidebar();
  }
});

// Init
loadAgents().then(() => {
  if (INITIAL_AGENT && agents.find(a => a.id === INITIAL_AGENT)) {
    // SPA 뒤로가기 흐름 정렬: sidebar entry → chat entry 순으로 history 구성
    // 결과: 뒤로가기 1회 → URL /chat → popstate → closeChatToSidebar
    history.replaceState({ view: 'sidebar' }, '', '/chat');
    history.pushState({ view: 'chat', agent: INITIAL_AGENT }, '', '/chat/' + encodeURIComponent(INITIAL_AGENT));
    selectAgent(INITIAL_AGENT, true); // skipPush=true (already pushed above)
  }
});
// Global message polling — always refresh current chat every 3s
setInterval(() => {
  if (currentAgent) loadMessages();
}, 3000);
// Periodically refresh unread state for sidebar dots (every 15s)
setInterval(async () => {
  if (agents.length > 0) {
    await refreshUnreadState();
    renderAgents();
  }
}, 15000);

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      newSW.addEventListener('statechange', () => {
        if (newSW.state === 'activated') {
          location.reload();
        }
      });
    });
  });
  // Handle navigation requests from SW notificationclick (avoids Chrome Android URL notification)
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.url) {
      window.location.href = e.data.url;
    }
  });
}

// Request notification permission and subscribe to push
async function setupPushNotifications() {
  if (!('Notification' in window) || !('PushManager' in window)) return;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const reg = await navigator.serviceWorker.ready;

  // Get VAPID key
  const vapidRes = await fetch('/api/v1/push/vapid-key');
  const { publicKey } = await vapidRes.json();
  if (!publicKey) return;

  // Convert VAPID key
  const vapidKey = urlBase64ToUint8Array(publicKey);

  // Subscribe
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKey
    });
  }

  // Send subscription to server
  await fetch('/api/v1/push/subscribe', {
    method: 'POST',
    headers,
    body: JSON.stringify({ subscription: sub.toJSON() })
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Call after SW registration
setupPushNotifications();
</script>
</body>
</html>`
}

