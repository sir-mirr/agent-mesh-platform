/**
 * The admin console.
 *
 * Approval queue, the live chat-audit tail, and the AI usage panel, in one
 * server-rendered page whose browser script is inline for the same reason the
 * chat pages' is: there is no build step, and this keeps it that way.
 */

import { THEME } from './theme'

export function renderAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Mesh - Admin</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="${THEME.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
  /* --- AI Usage iter2 (task #79) --- design tokens */
  :root {
    --level-none:   #2ecc71;
    --level-info:   #3498db;
    --level-warn:   #facc15;
    --level-danger: #f97316;
    --level-stop:   #dc2626;
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 14px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${THEME.bg};
    color: #e0e0e0;
    min-height: 100vh;
    padding: 20px;
    max-width: 800px;
    margin: 0 auto;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }
  h1 { font-size: 1.4rem; color: ${THEME.accent}; }
  .back-link { color: #aaa; text-decoration: none; font-size: 0.9rem; }
  .back-link:hover { color: ${THEME.accent}; }
  .section { margin-bottom: 32px; }
  .section h2 { font-size: 1.1rem; margin-bottom: 12px; color: #ccc; }
  .card {
    background: #16213e;
    border: 1px solid #0f3460;
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .card .info { flex: 1; }
  .card .name { font-weight: 600; font-size: 0.95rem; }
  .card .meta { font-size: 0.8rem; color: #999; margin-top: 2px; }
  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
    min-height: 36px;
  }
  .btn-approve { background: #2ecc71; color: #fff; }
  .btn-approve:hover { background: #27ae60; }
  .btn-deny { background: #e74c3c; color: #fff; margin-left: 6px; }
  .btn-deny:hover { background: #c0392b; }
  .empty { color: #555; font-size: 0.9rem; padding: 20px; text-align: center; }
  .status { font-size: 0.85rem; padding: 4px 10px; border-radius: 4px; }
  .status-approved { background: #2ecc7133; color: #2ecc71; }
  .status-denied { background: #e74c3c33; color: #e74c3c; }
  .status-pending { background: #f39c1233; color: #f39c12; }
  /* --- Tabs --- */
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid ${THEME.border};
    margin-bottom: 20px;
  }
  .tab {
    padding: 10px 18px;
    background: transparent;
    color: #888;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 500;
    transition: color 0.15s, border-color 0.15s;
  }
  .tab:hover { color: #ccc; }
  .tab.active {
    color: ${THEME.accent};
    border-bottom-color: ${THEME.accent};
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  /* --- Chat Audits --- */
  .audit-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
    padding: 12px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: 8px;
  }
  .audit-filters select,
  .audit-filters input[type="text"] {
    padding: 8px 10px;
    background: ${THEME.bg};
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.9rem;
    outline: none;
  }
  .audit-filters input[type="text"] { flex: 1; min-width: 160px; }
  .audit-filters select { min-width: 130px; }
  .audit-filters button {
    padding: 8px 14px;
    background: ${THEME.accent};
    color: #fff;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
  }
  .audit-filters button:hover { filter: brightness(1.1); }
  .audit-status {
    font-size: 0.8rem;
    color: #888;
    padding: 8px 4px;
    text-align: center;
  }
  .audit-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 70vh;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    background: ${THEME.bg};
  }
  .audit-msg {
    padding: 10px 12px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    font-size: 0.88rem;
  }
  .audit-msg .hdr {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 6px;
    font-size: 0.78rem;
    color: #999;
    margin-bottom: 6px;
  }
  .audit-msg .route { color: ${THEME.accent}; font-weight: 500; }
  .audit-msg .route .arrow { color: #777; margin: 0 4px; }
  .audit-msg .content { color: #e0e0e0; white-space: pre-wrap; word-break: break-word; }
  .audit-msg .reply-to { font-size: 0.72rem; color: #777; margin-top: 4px; font-family: monospace; }
  .audit-msg .expand-btn {
    display: inline-block;
    margin-left: 4px;
    color: ${THEME.accent};
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
  }
  /* --- v2: Chat Audits live indicator, glow, floating pill --- */
  .audit-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .audit-header-row h2 { margin-bottom: 0; }
  .live-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #aaa;
    padding: 4px 10px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: 14px;
    font-variant-numeric: tabular-nums;
  }
  .live-dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: #666;
    box-shadow: 0 0 6px rgba(255,255,255,0.05);
  }
  .live-indicator[data-state="live"]  .live-dot { background: #2ecc71; box-shadow: 0 0 6px rgba(46,204,113,0.6); }
  .live-indicator[data-state="reconnecting"] .live-dot { background: #f39c12; box-shadow: 0 0 6px rgba(243,156,18,0.6); animation: live-pulse 1s ease-in-out infinite; }
  .live-indicator[data-state="offline"] .live-dot { background: #e74c3c; box-shadow: 0 0 6px rgba(231,76,60,0.6); }
  @keyframes live-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
  /* glow fade — accent-tinted halo that fades out */
  @keyframes glow-fade {
    0%   { box-shadow: 0 0 0 1px ${THEME.accent}66, 0 0 10px 2px ${THEME.accent}55; }
    100% { box-shadow: 0 0 0 1px transparent, 0 0 0 0 transparent; }
  }
  .audit-msg.glow { animation: glow-fade 600ms ease-out 1; }
  .audit-msg.recovered {
    background: ${THEME.bg};
    border-left: 3px solid #666;
    opacity: 0.85;
  }
  .audit-msg.recovered .route::before {
    content: '↺ ';
    color: #888;
  }
  /* floating pill (scenario B) */
  .audit-list-wrap {
    position: relative;
  }
  .audit-pill {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: 16px;
    background: ${THEME.accent};
    color: #fff;
    border: none;
    border-radius: 18px;
    padding: 8px 16px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    display: none;
    z-index: 5;
    min-height: 36px;
  }
  .audit-pill.show { display: inline-block; }
  .audit-pill:hover { filter: brightness(1.1); }
  /* clear-filter button */
  .audit-filters .clear-btn {
    padding: 8px 10px;
    background: transparent;
    color: #aaa;
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
    line-height: 1;
    min-width: 36px;
  }
  .audit-filters .clear-btn:hover { color: ${THEME.accent}; border-color: ${THEME.accent}; background: ${THEME.sidebar}; }
  /* counters line */
  .audit-counters {
    font-size: 0.78rem;
    color: #888;
    padding: 2px 4px 6px;
    font-variant-numeric: tabular-nums;
  }
  /* --- AI Usage iter2 (task #79) --- */
  .ai-usage-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .ai-usage-header-row h2 { margin-bottom: 0; }
  .ai-usage-meta {
    font-size: 0.82rem;
    color: #aaa;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: var(--radius-lg);
  }
  .ai-usage-meta.stale {
    color: var(--level-warn);
    border-color: var(--level-warn);
  }
  .ai-usage-meta .warn-icon { font-size: 0.9rem; }
  .ai-usage-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .ai-usage-card {
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: var(--radius-md);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: opacity 0.2s;
  }
  /* --- AI Usage iter2 (task #79) --- D-04: stale readability */
  .ai-usage-card.stale {
    opacity: 0.7;
    filter: saturate(0.5);
  }
  .ai-usage-card .account-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ai-usage-card .account-name {
    font-weight: 600;
    font-size: 0.95rem;
    color: #e0e0e0;
  }
  .ai-usage-card .provider-badge {
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: var(--radius-md);
    background: ${THEME.bg};
    color: #aaa;
    border: 1px solid ${THEME.border};
  }
  /* --- AI Usage iter5 (task #80) S-03: provider-badge --strong (탭 카드 강조) --- */
  .provider-badge.provider-badge--strong {
    font-size: 0.82rem;
    padding: 3px 12px;
    font-weight: 700;
    color: #e8e8e8;
    background: rgba(255,255,255,0.10);
    border: 1px solid rgba(255,255,255,0.22);
  }
  /* --- AI Usage iter2 (task #79) --- D-06: plan-badge neutral style */
  .ai-usage-card .plan-badge {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.08);
    color: #cfd3d9;
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-weight: 500;
  }
  .ai-usage-window {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ai-usage-window .window-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
    color: #bbb;
    gap: 8px;
  }
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 탭 카드 window-label 글자 단위 wrap 방지 --- */
  .ai-usage-window .window-label { font-weight: 500; white-space: nowrap; }
  /* --- AI Usage iter2 (task #79) --- U-01: reset highlight (card) */
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 탭 카드 window-resets 글자 단위 wrap 방지 --- */
  .ai-usage-window .window-resets {
    color: #e0e0e0;
    font-size: 0.78rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }
  .ai-usage-window .window-resets .reset-icon {
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .progress-bar {
    width: 100%;
    height: 8px;
    background: ${THEME.bg};
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid ${THEME.border};
  }
  .progress-fill {
    height: 100%;
    border-radius: var(--radius-sm);
    transition: width 0.3s ease-out, background-color 0.3s;
  }
  .ai-usage-window .window-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.72rem;
    color: #999;
    margin-top: 2px;
  }
  .level-badge {
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: var(--radius-md);
    font-weight: 500;
    text-transform: uppercase;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  /* --- AI Usage iter5 (task #80) V-01: 색약 보조 아이콘 --- */
  .level-icon {
    font-style: normal;
    font-size: 0.8em;
    line-height: 1;
  }
  .level-none   { background: rgba(46, 204, 113, 0.2);  color: var(--level-none); }
  .level-info   { background: rgba(52, 152, 219, 0.2);  color: var(--level-info); }
  .level-warn   { background: rgba(250, 204, 21, 0.22); color: var(--level-warn); }
  .level-danger { background: rgba(249, 115, 22, 0.22); color: var(--level-danger); }
  .level-stop   { background: rgba(220, 38, 38, 0.25);  color: var(--level-stop); }
  .progress-fill.level-none   { background: var(--level-none); }
  .progress-fill.level-info   { background: var(--level-info); }
  .progress-fill.level-warn   { background: var(--level-warn); }
  .progress-fill.level-danger { background: var(--level-danger); }
  .progress-fill.level-stop   { background: var(--level-stop); }
  /* --- AI Usage iter2 (task #79) --- D-08: minimal-mode-badge 한글+크기 */
  .minimal-mode-badge {
    font-size: 0.78rem;
    padding: 1px 6px;
    border-radius: var(--radius-md);
    background: rgba(155, 89, 182, 0.25);
    color: #c199d8;
    margin-left: 6px;
  }
  .ai-usage-footer {
    font-size: 0.74rem;
    color: #888;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px dashed ${THEME.border};
  }
  /* --- AI Usage iter2 (task #79) --- D-05: footer hierarchy */
  .ai-usage-footer .api-error {
    color: var(--level-stop);
    font-weight: 600;
    font-size: 0.82rem;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .ai-usage-footer .api-error .err-icon { font-size: 0.95rem; }
  .ai-usage-footer .fail-count {
    color: var(--level-danger);
    font-size: 0.76rem;
  }
  .ai-usage-footer .last-success {
    color: #888;
    font-size: 0.72rem;
    margin-left: auto;
  }
  /* Legacy .warn kept for any stray callers */
  .ai-usage-footer .warn { color: var(--level-stop); }
  /* --- AI Usage Summary Box (always visible, task #79 follow-up) --- */
  .ai-usage-summary {
    background: ${THEME.sidebar};
    border: 1px solid ${THEME.border};
    border-radius: var(--radius-md);
    padding: 10px 14px;
    margin: 10px 0 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: opacity 0.2s;
  }
  /* --- AI Usage iter2 (task #79) --- D-04: stale readability (summary) */
  .ai-usage-summary.stale {
    opacity: 0.7;
    filter: saturate(0.5);
  }
  .ai-usage-summary-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 6px 2px;
    min-height: 34px;
    font-size: 0.8rem;
    color: #bbb;
  }
  .ai-usage-summary-row + .ai-usage-summary-row {
    border-top: 1px dashed ${THEME.border};
  }
  .ai-usage-summary-row .provider-badge {
    font-size: 0.74rem;
    padding: 2px 10px;
    border-radius: var(--radius-md);
    background: ${THEME.bg};
    color: #e0e0e0;
    border: 1px solid ${THEME.border};
    font-weight: 600;
    min-width: 54px;
    text-align: center;
  }
  /* --- AI Usage iter2 (task #79) --- D-06: plan-hint-badge neutral */
  .ai-usage-summary-row .plan-hint-badge {
    font-size: 0.7rem;
    padding: 1px 8px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.08);
    color: #cfd3d9;
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-weight: 500;
  }
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 라벨 글자 단위 wrap 방지 --- */
  .ai-usage-summary-row .window-label {
    font-size: 0.76rem;
    color: #aaa;
    margin-left: 4px;
    white-space: nowrap;
  }
  .ai-usage-summary-row .window-percent {
    font-size: 0.8rem;
    color: #e0e0e0;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    min-width: 36px;
    text-align: right;
  }
  .ai-usage-summary-row .mini-progress {
    flex: 0 1 110px;
    min-width: 70px;
    max-width: 140px;
    height: 5px;
    background: ${THEME.bg};
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid ${THEME.border};
  }
  .ai-usage-summary-row .mini-progress-fill {
    height: 100%;
    border-radius: var(--radius-sm);
    transition: width 0.3s ease-out, background-color 0.3s;
    width: 0%;
  }
  .ai-usage-summary-row .mini-progress-fill.level-none   { background: var(--level-none); }
  .ai-usage-summary-row .mini-progress-fill.level-info   { background: var(--level-info); }
  .ai-usage-summary-row .mini-progress-fill.level-warn   { background: var(--level-warn); }
  .ai-usage-summary-row .mini-progress-fill.level-danger { background: var(--level-danger); }
  .ai-usage-summary-row .mini-progress-fill.level-stop   { background: var(--level-stop); }
  /* --- AI Usage iter2 (task #79) --- U-01: reset highlight (summary row) */
  /* --- AI Usage iter6 (task #80) C-01: nowrap — 리셋 텍스트 글자 단위 wrap 방지 --- */
  .ai-usage-summary-row .window-resets {
    font-size: 0.78rem;
    color: #e0e0e0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-right: 2px;
    white-space: nowrap;
  }
  .ai-usage-summary-row .window-resets .reset-icon {
    font-size: 0.82rem;
    opacity: 0.85;
  }
  .ai-usage-summary-row .summary-sep {
    color: #555;
    margin: 0 2px;
  }
  /* --- AI Usage iter3 (task #79) S-02: summary-win 그룹 wrapper — narrow viewport flex-wrap 단위 보장 */
  .ai-usage-summary-row .summary-win {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
  }
  .ai-usage-summary .summary-empty {
    font-size: 0.8rem;
    color: #888;
    padding: 6px 2px;
  }
  /* --- AI Usage iter5 (task #80) V-02-b: row-identity 그룹 wrapper — provider+badge+dot 묶음 --- */
  .ai-usage-summary-row .row-identity {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    flex-wrap: nowrap;
  }
  /* --- AI Usage iter3 (task #79) --- S-06: status dot (api_error / failures) */
  .ai-usage-summary-row .status-dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.15);
    cursor: help;
  }
  .ai-usage-summary-row .status-dot-error {
    background: var(--level-stop);
    box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.25);
  }
  .ai-usage-summary-row .status-dot-warn {
    background: var(--level-danger);
    box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.25);
  }
  /* --- AI Usage iter3 (task #79) --- S-01: summary-row minimal mode badge spacing override */
  .ai-usage-summary-row .minimal-mode-badge {
    margin-left: 2px;
  }
  /* --- AI Usage iter3 (task #79) --- Z-02: SSE disconnect banner */
  /* --- AI Usage iter5 (task #80) V-03: sticky banner --- */
  .ai-usage-disconnect-banner {
    display: none;
    background: rgba(220, 38, 38, 0.18);
    border: 1px solid var(--level-stop);
    color: #ffb3b3;
    font-size: 0.82rem;
    font-weight: 500;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    margin: 10px 0 8px;
    animation: ai-usage-banner-fadein 0.25s ease-out;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .ai-usage-disconnect-banner.visible {
    display: block;
  }
  @keyframes ai-usage-banner-fadein {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* M01-4 base: 데스크톱 기본 — mobile 라벨 숨김, desktop 라벨 표시 */
  /* 반드시 @media (max-width:640px) 블록보다 먼저 선언해야 override 방지 */
  .tab .tab-label-desktop { display: inline; }
  .tab .tab-label-mobile { display: none; }

  /* --- AI Usage M-01 mobile (task #80): 모바일 세로 반응형 --- */
  @media (max-width: 640px) {
    /* 요약 박스 컴팩트 */
    .ai-usage-summary {
      padding: 6px 8px;
      margin: 6px 0 8px;
      gap: 4px;
    }
    .ai-usage-summary-row {
      gap: 6px;
      padding: 4px 2px;
      min-height: 26px;
      font-size: 0.72rem;
    }
    .ai-usage-summary-row + .ai-usage-summary-row {
      border-top-width: 1px;
    }
    .ai-usage-summary-row .provider-badge {
      font-size: 0.68rem;
      padding: 1px 6px;
      min-width: 42px;
    }
    .ai-usage-summary-row .window-label {
      font-size: 0.68rem;
    }
    .ai-usage-summary-row .window-percent {
      font-size: 0.72rem;
      min-width: 28px;
    }
    .ai-usage-summary-row .mini-progress {
      flex: 0 1 60px;
      min-width: 40px;
      max-width: 90px;
    }
    .ai-usage-summary-row .window-resets {
      font-size: 0.68rem;
    }
    /* 요약 박스 max-height → 화면 50% 초과 금지 */
    .ai-usage-summary {
      max-height: 50vh;
      overflow-y: auto;
    }
    /* 탭 버튼 컴팩트 + 한 줄 유지 */
    .tab {
      padding: 8px 10px;
      font-size: 0.78rem;
      white-space: nowrap;
    }
    /* 배너 sticky 유지, 모바일 padding 축소 */
    .ai-usage-disconnect-banner {
      font-size: 0.76rem;
      padding: 6px 10px;
    }
    /* M01-4: 탭 라벨 모바일 축약 "AI 계정 상황" → "AI 계정" */
    .tab .tab-label-desktop { display: none; }
    .tab .tab-label-mobile { display: inline; }
  }

</style>
</head>
<body>
  <div class="header">
    <h1>Admin Panel</h1>
    <a class="back-link" href="/chat">← Chat</a>
  </div>

  <!-- --- AI Usage iter3 (task #79) --- Z-02: SSE disconnect banner -->
  <div class="ai-usage-disconnect-banner" id="ai-usage-disconnect-banner" role="alert" aria-live="polite">
    ⚠ 실시간 연결 끊김 · 재시도 중...
  </div>

  <!-- --- AI Usage iter5 (task #80) Z-07: role=region + aria-label --- -->
  <div class="ai-usage-summary" id="ai-usage-summary" role="region" aria-label="AI 계정 사용량 요약">
    <div class="summary-empty" id="ai-usage-summary-empty">AI 계정 사용량을 불러오는 중입니다...</div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="approvals" onclick="switchTab('approvals')">Pending Approvals</button>
    <button class="tab" data-tab="ai-usage" onclick="switchTab('ai-usage')"><span class="tab-label-desktop">AI 계정 상황</span><span class="tab-label-mobile">AI 계정</span></button>
    <button class="tab" data-tab="audits" onclick="switchTab('audits')">Chat Audits</button>
  </div>

  <div id="tab-approvals" class="tab-panel active">
    <div class="section">
      <h2>Pending Approvals</h2>
      <div id="pendingList"><div class="empty">Loading...</div></div>
    </div>

    <div class="section">
      <h2>Registered Users</h2>
      <div id="userList"><div class="empty">Loading...</div></div>
    </div>
  </div>

  <!-- --- AI Usage iter5 (task #80) Z-07: role=region + aria-label --- -->
  <div id="tab-ai-usage" class="tab-panel" role="region" aria-label="AI 계정 사용량 상세">
    <div class="section">
      <div class="ai-usage-header-row">
        <h2>AI 계정 상황</h2>
        <span id="aiUsageMeta" class="ai-usage-meta" role="status" aria-live="polite">
          <span id="aiUsageMetaText">대기 중...</span>
        </span>
      </div>
      <div id="aiUsageGrid" class="ai-usage-grid">
        <div class="empty">Loading...</div>
      </div>
    </div>
  </div>

  <div id="tab-audits" class="tab-panel">
    <div class="section">
      <div class="audit-header-row">
        <h2>Chat Audits</h2>
        <span id="auditLiveIndicator" class="live-indicator" data-state="offline" role="status" aria-live="polite" title="실시간 갱신 연결 상태">
          <span class="live-dot" aria-hidden="true"></span>
          <span id="auditLiveLabel">offline</span>
        </span>
      </div>
      <div class="audit-filters">
        <select id="auditFromAgent" aria-label="보낸 신원으로 거르기"><option value="">보낸 신원: 전체</option></select>
        <select id="auditToAgent" aria-label="받는 신원으로 거르기"><option value="">받는 신원: 전체</option></select>
        <input type="text" id="auditSearch" placeholder="내용 검색" aria-label="내용 검색" />
        <button onclick="applyAuditFilters()">Apply</button>
        <button class="clear-btn" id="auditClearBtn" onclick="clearAuditFilters()" aria-label="검색 조건 지우기" title="검색 조건 지우기">×</button>
      </div>
      <div id="auditCounters" class="audit-counters" aria-live="polite"></div>
      <div id="auditTopStatus" class="audit-status"></div>
      <div class="audit-list-wrap">
        <div id="auditList" class="audit-list" role="log" aria-live="polite" aria-relevant="additions" aria-label="메시지 기록">
          <div class="empty">이 탭을 열면 메시지를 불러옵니다</div>
        </div>
        <button type="button" id="auditPill" class="audit-pill" onclick="scrollAuditsToBottom()" aria-label="가장 최근 메시지로 이동">⬇ 새 메시지 0개 · 바닥으로</button>
      </div>
    </div>
  </div>

<script>
const TOKEN = document.cookie.split('; ').find(c => c.startsWith('mesh_token='))?.split('=').slice(1).join('=') || '';
const headers = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// --- KST timestamp helper (Asia/Seoul, browser-locale independent via Intl) ---
function toKST(isoOrSqliteUtc) {
  if (isoOrSqliteUtc == null) return '';
  const s = String(isoOrSqliteUtc).trim();
  const withT = s.includes('T') ? s : s.replace(' ', 'T');
  const withZ = /Z$|[+-]\\d\\d:?\\d\\d$/.test(withT) ? withT : withT + 'Z';
  const d = new Date(withZ);
  if (isNaN(d.getTime())) return String(isoOrSqliteUtc);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value ?? '';
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
         get('hour') + ':' + get('minute') + ':' + get('second') + ' KST';
}

async function loadPending() {
  try {
    const res = await fetch('/api/v1/admin/pending', { headers });
    const data = await res.json();
    const list = data.users || [];
    const el = document.getElementById('pendingList');
    if (list.length === 0) {
      el.innerHTML = '<div class="empty">승인 대기 중인 사용자가 없습니다</div>';
      return;
    }
    el.innerHTML = list.map(p =>
      '<div class="card">' +
      '<div class="info"><div class="name">' + esc(p.github_login) + '</div>' +
      '<div class="meta">GitHub ID: ' + p.github_id + ' · ' + toKST(p.requested_at) + '</div></div>' +
      '<div><button class="btn btn-approve" onclick="approve(\\'' + esc(p.github_login) + '\\')">승인</button>' +
      '<button class="btn btn-deny" onclick="deny(\\'' + esc(p.github_login) + '\\')">거부</button></div>' +
      '</div>'
    ).join('');
  } catch(e) {
    document.getElementById('pendingList').innerHTML = '<div class="empty">불러오지 못했습니다</div>';
  }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/v1/agents', { headers });
    const data = await res.json();
    const users = (data.agents || []).filter(a => a.type === 'user');
    const agents = (data.agents || []).filter(a => a.type !== 'user');
    const el = document.getElementById('userList');
    const all = [...users.map(u => ({...u, isUser: true})), ...agents.map(a => ({...a, isUser: false}))];
    if (all.length === 0) {
      el.innerHTML = '<div class="empty">등록된 사용자/에이전트가 없습니다</div>';
      return;
    }
    el.innerHTML = all.map(u =>
      '<div class="card"><div class="info"><div class="name">' + esc(u.name) +
      (u.isUser ? ' <span class="status status-approved">user</span>' : ' <span style="font-size:0.8rem;color:#555;">agent</span>') +
      '</div><div class="meta">' + (u.description || '') + '</div></div></div>'
    ).join('');
  } catch(e) {}
}

// Both of these ignored the response. The routes are gated on \`user.admit\`,
// so an operator without it clicked approve, watched the list re-render with
// the same person still pending, and was told nothing — the refusal and a
// successful approval of somebody who then reappears look identical.
async function reportIfRefused(res, what) {
  if (res.ok) return false;
  let detail = '';
  try { detail = (await res.json()).error || ''; } catch (e) { detail = await res.text().catch(() => ''); }
  alert(what + ' 실패 (' + res.status + ')' + (detail ? ': ' + detail : ''));
  return true;
}

async function approve(login) {
  if (!confirm(login + ' 사용자를 승인하시겠습니까?')) return;
  const res = await fetch('/api/v1/admin/approve', { method: 'POST', headers, body: JSON.stringify({ github_login: login }) });
  if (await reportIfRefused(res, login + ' 승인')) return;
  loadPending();
  loadUsers();
}

async function deny(login) {
  if (!confirm(login + ' 사용자를 거부하시겠습니까?')) return;
  const res = await fetch('/api/v1/admin/deny', { method: 'POST', headers, body: JSON.stringify({ github_login: login }) });
  if (await reportIfRefused(res, login + ' 거부')) return;
  loadPending();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Tabs ---

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
  if (name === 'audits') {
    if (!auditState.initialized) {
      auditState.initialized = true;
      loadAuditAgents();
      resetAndLoadAudits();
    } else {
      // Re-open SSE if we came back to the tab.
      connectAuditStream();
    }
  } else {
    // Leaving audits tab: close SSE to stop receiving (and free resources).
    disconnectAuditStream();
  }
  // --- AI Usage (task #79) ---
  // Summary box is always visible + auto-refreshing via SSE, so we keep the
  // stream alive regardless of tab. The tab-detail grid re-renders on next
  // snapshot even if we enter/leave the tab. Init-on-demand only if the page
  // didn't auto-init (fallback safety).
  if (name === 'ai-usage' && !aiUsageState.initialized) {
    aiUsageState.initialized = true;
    initAiUsage();
  }
}

// --- Chat Audits ---

const auditState = {
  initialized: false,
  loading: false,
  hasMore: true,
  oldestId: null,
  messages: [],     // newest-first internally
  expanded: {},     // id -> true when full content shown
  filters: { from_agent: '', to_agent: '', search: '' },
  reqSeq: 0,
  searchDebounce: null,
  eventSource: null,
  reconnectTimer: null,
  seenIds: new Set(),   // de-dupe vs initial load
  // v2: live indicator state
  liveState: 'offline',          // 'live' | 'reconnecting' | 'offline'
  reconnectAttempts: 0,
  // v2: floating pill — count of new messages arrived while scrolled up
  pendingNewCount: 0,
  // v2: throttled batching via rAF when bursts happen
  rafQueued: false,
  rafQueue: [],
  // v2: counters
  totalCount: 0,     // total messages received (loaded + live)
  hiddenCount: 0,    // live messages that didn't match filter
};

async function loadAuditAgents() {
  try {
    const res = await fetch('/api/v1/admin/chat-audits/agents', { headers });
    const data = await res.json();
    const agents = data.agents || [];
    const fromSel = document.getElementById('auditFromAgent');
    const toSel = document.getElementById('auditToAgent');
    const fromCur = fromSel.value;
    const toCur = toSel.value;
    fromSel.innerHTML = '<option value="">보낸 신원: 전체</option>' + agents.map(a => '<option value="' + esc(a) + '">' + esc(a) + '</option>').join('');
    toSel.innerHTML = '<option value="">받는 신원: 전체</option>' + agents.map(a => '<option value="' + esc(a) + '">' + esc(a) + '</option>').join('');
    fromSel.value = fromCur;
    toSel.value = toCur;
  } catch(e) { /* ignore */ }
}

function applyAuditFilters() {
  auditState.filters.from_agent = document.getElementById('auditFromAgent').value || '';
  auditState.filters.to_agent = document.getElementById('auditToAgent').value || '';
  auditState.filters.search = document.getElementById('auditSearch').value || '';
  resetAndLoadAudits();
}

function clearAuditFilters() {
  // (Scenario E): clear dropdowns/search, then full reload + reconnect.
  document.getElementById('auditFromAgent').value = '';
  document.getElementById('auditToAgent').value = '';
  document.getElementById('auditSearch').value = '';
  auditState.filters.from_agent = '';
  auditState.filters.to_agent = '';
  auditState.filters.search = '';
  resetAndLoadAudits();
}

// --- v2: Live indicator ---
function setAuditLiveState(next) {
  if (auditState.liveState === next) return;
  auditState.liveState = next;
  const ind = document.getElementById('auditLiveIndicator');
  const lbl = document.getElementById('auditLiveLabel');
  if (!ind || !lbl) return;
  ind.setAttribute('data-state', next);
  if (next === 'live') lbl.textContent = 'live';
  else if (next === 'reconnecting') lbl.textContent = 'reconnecting…';
  else lbl.textContent = 'offline';
}

// --- v2: Counters line ---
function updateAuditCounters() {
  const el = document.getElementById('auditCounters');
  if (!el) return;
  const match = auditState.messages.length;
  const total = auditState.totalCount;
  const hidden = auditState.hiddenCount;
  el.textContent = '전체 ' + total + ' · 필터 매치 ' + match + ' · 숨김 ' + hidden;
}

// --- v2: Floating pill ---
function updateAuditPill() {
  const pill = document.getElementById('auditPill');
  if (!pill) return;
  if (auditState.pendingNewCount > 0) {
    const n = auditState.pendingNewCount > 99 ? '99+' : String(auditState.pendingNewCount);
    pill.textContent = '⬇ 새 메시지 ' + n + '개 · 바닥으로';
    pill.classList.add('show');
  } else {
    pill.classList.remove('show');
  }
}

function scrollAuditsToBottom() {
  const list = document.getElementById('auditList');
  if (!list) return;
  list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  auditState.pendingNewCount = 0;
  updateAuditPill();
}

function isAuditNearBottom() {
  const list = document.getElementById('auditList');
  if (!list) return true;
  return (list.scrollHeight - list.scrollTop - list.clientHeight) < 50;
}

function resetAndLoadAudits() {
  auditState.loading = false;
  auditState.hasMore = true;
  auditState.oldestId = null;
  auditState.messages = [];
  auditState.expanded = {};
  auditState.seenIds = new Set();
  auditState.pendingNewCount = 0;
  auditState.rafQueue = [];
  auditState.rafQueued = false;
  auditState.totalCount = 0;
  auditState.hiddenCount = 0;
  updateAuditPill();
  updateAuditCounters();
  const list = document.getElementById('auditList');
  list.innerHTML = '<div class="audit-status">Loading...</div>';
  document.getElementById('auditTopStatus').textContent = '';
  // Restart the SSE stream with new filters (also covers initial connection).
  disconnectAuditStream();
  loadOlderAudits(true).then(() => {
    connectAuditStream();
  });
}

async function loadOlderAudits(initial) {
  if (auditState.loading) return;
  if (!initial && !auditState.hasMore) return;
  auditState.loading = true;
  const mySeq = ++auditState.reqSeq;
  const topStatus = document.getElementById('auditTopStatus');
  topStatus.textContent = auditState.oldestId ? 'Loading older...' : '';

  const params = new URLSearchParams();
  params.set('limit', '100');
  if (auditState.oldestId) params.set('before_id', auditState.oldestId);
  if (auditState.filters.from_agent) params.set('from_agent', auditState.filters.from_agent);
  if (auditState.filters.to_agent) params.set('to_agent', auditState.filters.to_agent);
  if (auditState.filters.search) params.set('search', auditState.filters.search);

  try {
    const res = await fetch('/api/v1/admin/chat-audits?' + params.toString(), { headers });
    if (mySeq !== auditState.reqSeq) { auditState.loading = false; return; } // stale
    const data = await res.json();
    const batch = data.messages || [];
    // Merge: batch is ts DESC (newest first). Append to end of our newest-first array.
    auditState.messages = auditState.messages.concat(batch);
    for (const m of batch) auditState.seenIds.add(m.id);
    auditState.hasMore = !!data.has_more;
    auditState.oldestId = data.oldest_id || auditState.oldestId;
    // Counters: initial load seeds totalCount from loaded-range.
    auditState.totalCount = auditState.messages.length;
    updateAuditCounters();
    renderAudits(initial);
  } catch(e) {
    topStatus.textContent = 'Failed to load.';
  } finally {
    auditState.loading = false;
  }
}

function renderAudits(initialLoad) {
  const list = document.getElementById('auditList');
  const topStatus = document.getElementById('auditTopStatus');

  if (auditState.messages.length === 0) {
    list.innerHTML = '<div class="empty">검색 조건에 맞는 메시지가 없습니다</div>';
    topStatus.textContent = '';
    return;
  }

  // Render in chronological order (oldest at top, newest at bottom).
  // Our internal array is newest-first, so iterate reversed.
  const rendered = [];
  rendered.push('<div id="auditSentinel" style="height:1px;"></div>');
  for (let i = auditState.messages.length - 1; i >= 0; i--) {
    rendered.push(renderAuditMsg(auditState.messages[i]));
  }
  // Preserve scroll position if not initial load — we're prepending older content.
  const prevScrollHeight = list.scrollHeight;
  const prevScrollTop = list.scrollTop;

  list.innerHTML = rendered.join('');

  if (initialLoad) {
    // Scroll to the bottom to show newest.
    list.scrollTop = list.scrollHeight;
  } else {
    // Older messages were prepended. Keep viewing position stable.
    const newHeight = list.scrollHeight;
    list.scrollTop = prevScrollTop + (newHeight - prevScrollHeight);
  }

  if (auditState.hasMore) {
    topStatus.textContent = '';
    observeAuditSentinel();
  } else {
    topStatus.textContent = 'No more messages';
  }
}

function renderAuditMsg(m) {
  const content = m.content || '';
  const expanded = !!auditState.expanded[m.id];
  const truncate = content.length > 500 && !expanded;
  const shown = truncate ? content.slice(0, 500) + '…' : content;
  const expandBtn = content.length > 500
    ? '<button class="expand-btn" onclick="toggleAuditExpand(\\'' + esc(m.id).replace(/'/g, "\\\\'") + '\\')">' + (expanded ? 'collapse' : 'expand') + '</button>'
    : '';
  const replyLine = m.reply_to ? '<div class="reply-to">↩ reply_to: ' + esc(m.reply_to) + '</div>' : '';
  const statusBadge = m.status ? ' <span style="font-size:0.72rem;color:#777;">[' + esc(m.status) + ']</span>' : '';
  const extraCls = m.recovered ? ' recovered' : '';
  return (
    '<div class="audit-msg' + extraCls + '" data-id="' + esc(m.id) + '">' +
      '<div class="hdr">' +
        '<span class="route">' + esc(m.from_agent) + '<span class="arrow">→</span>' + esc(m.to_agent) + statusBadge + '</span>' +
        '<span>' + esc(toKST(m.ts)) + '</span>' +
      '</div>' +
      '<div class="content">' + esc(shown) + expandBtn + '</div>' +
      replyLine +
    '</div>'
  );
}

function toggleAuditExpand(id) {
  auditState.expanded[id] = !auditState.expanded[id];
  // Re-render in place (cheap for ~100s of messages)
  const list = document.getElementById('auditList');
  const prevScrollTop = list.scrollTop;
  const prevScrollHeight = list.scrollHeight;
  renderAudits(false);
  // After re-render above, prevScrollHeight diff already handled; but renderAudits uses
  // its own old/new heights captured before innerHTML replacement. For toggle, we want
  // to preserve the top offset; since renderAudits sees no height change for initial=false,
  // and our captured prev-values came before its call (stale), this is approximate but fine.
}

// IntersectionObserver for infinite scroll upward (sentinel at top).
let auditObserver = null;
function observeAuditSentinel() {
  const list = document.getElementById('auditList');
  const sentinel = document.getElementById('auditSentinel');
  if (!sentinel) return;
  if (auditObserver) auditObserver.disconnect();
  auditObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && auditState.hasMore && !auditState.loading) {
        loadOlderAudits(false);
      }
    }
  }, { root: list, rootMargin: '100px 0px 0px 0px', threshold: 0 });
  auditObserver.observe(sentinel);
}

// --- Chat Audits SSE (live tail) — v2 ---

const AUDIT_MAX_RECONNECT = 5;   // after N failed attempts → offline, stop auto-retry

function disconnectAuditStream() {
  if (auditState.eventSource) {
    try { auditState.eventSource.close(); } catch(e) {}
    auditState.eventSource = null;
  }
  if (auditState.reconnectTimer) {
    clearTimeout(auditState.reconnectTimer);
    auditState.reconnectTimer = null;
  }
  // When explicitly disconnected (leaving tab, filter change, etc.), reflect offline.
  setAuditLiveState('offline');
}

function connectAuditStream() {
  // Close any prior connection first.
  if (auditState.eventSource) {
    try { auditState.eventSource.close(); } catch(e) {}
    auditState.eventSource = null;
  }
  if (auditState.reconnectTimer) {
    clearTimeout(auditState.reconnectTimer);
    auditState.reconnectTimer = null;
  }
  const params = new URLSearchParams();
  if (auditState.filters.from_agent) params.set('from_agent', auditState.filters.from_agent);
  if (auditState.filters.to_agent) params.set('to_agent', auditState.filters.to_agent);
  if (auditState.filters.search) params.set('search', auditState.filters.search);
  const qs = params.toString();
  // EventSource uses same-origin cookie auth (mesh_token) — no custom headers needed.
  // EventSource auto-attaches Last-Event-ID header on reconnects (tracked from id: fields).
  const url = '/api/v1/admin/chat-audits/stream' + (qs ? ('?' + qs) : '');
  let es;
  try { es = new EventSource(url); }
  catch(e) { setAuditLiveState('offline'); return; }
  auditState.eventSource = es;
  setAuditLiveState('reconnecting');   // assume reconnecting until onopen
  es.onopen = () => {
    auditState.reconnectAttempts = 0;
    setAuditLiveState('live');
  };
  es.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (!msg || !msg.id) return;
      if (auditState.seenIds.has(msg.id)) return;   // dedupe
      queueLiveAuditMessage(msg);
    } catch(e) {}
  });
  es.addEventListener('gap-too-large', (ev) => {
    try {
      const info = JSON.parse(ev.data) || {};
      const status = document.getElementById('auditTopStatus');
      if (status) status.textContent = '복구할 메시지가 많습니다 (' + (info.count || '?') + '). 수동 새로고침 권장.';
    } catch(e) {}
  });
  es.onerror = () => {
    if (!auditState.eventSource) return;
    // EventSource itself will silently retry at the browser default — but we want an
    // explicit backoff + offline detection + Last-Event-ID gap fetch via a fresh EventSource.
    try { es.close(); } catch(e) {}
    auditState.eventSource = null;
    auditState.reconnectAttempts++;
    if (auditState.reconnectAttempts >= AUDIT_MAX_RECONNECT) {
      setAuditLiveState('offline');
      return;
    }
    setAuditLiveState('reconnecting');
    if (auditState.reconnectTimer) clearTimeout(auditState.reconnectTimer);
    // Exponential backoff capped at 30s (1→2→4→8→16→30).
    const delay = Math.min(30000, 1000 * Math.pow(2, auditState.reconnectAttempts - 1));
    auditState.reconnectTimer = setTimeout(() => {
      const panel = document.getElementById('tab-audits');
      if (panel && panel.classList.contains('active')) {
        connectAuditStream();
      }
    }, delay);
  };
}

// Queue + rAF batch — burst-safe (scenario 1-1: 20+ msg/s without frame drop).
function queueLiveAuditMessage(msg) {
  // Filter-match check on client side as well (defense-in-depth — server filters already applied).
  const f = auditState.filters;
  const matches =
    (!f.from_agent || msg.from_agent === f.from_agent) &&
    (!f.to_agent   || msg.to_agent   === f.to_agent) &&
    (!f.search     || (msg.content || '').toLowerCase().includes(f.search.toLowerCase()));
  auditState.totalCount++;
  if (!matches) {
    auditState.hiddenCount++;
    updateAuditCounters();
    return;
  }
  auditState.rafQueue.push(msg);
  if (!auditState.rafQueued) {
    auditState.rafQueued = true;
    requestAnimationFrame(flushLiveAuditBatch);
  }
}

function flushLiveAuditBatch() {
  auditState.rafQueued = false;
  const batch = auditState.rafQueue;
  auditState.rafQueue = [];
  if (batch.length === 0) return;
  const list = document.getElementById('auditList');
  if (!list) return;
  // Full render if still on placeholder / first live msg.
  const empty = list.querySelector('.empty');
  if (empty || !list.querySelector('#auditSentinel')) {
    for (const m of batch) {
      if (auditState.seenIds.has(m.id)) continue;
      auditState.seenIds.add(m.id);
      auditState.messages.unshift(m);
    }
    renderAudits(true);
    updateAuditCounters();
    return;
  }
  const nearBottom = isAuditNearBottom();
  const frag = document.createDocumentFragment();
  const newNodes = [];
  for (const m of batch) {
    if (auditState.seenIds.has(m.id)) continue;
    auditState.seenIds.add(m.id);
    auditState.messages.unshift(m);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderAuditMsg(m);
    const node = wrapper.firstElementChild;
    if (node) {
      frag.appendChild(node);
      newNodes.push(node);
    }
  }
  list.appendChild(frag);
  // Glow only live messages, not recovered ones (recovered already has its own styling).
  for (const n of newNodes) {
    if (!n.classList.contains('recovered') && document.visibilityState !== 'hidden') {
      n.classList.add('glow');
      setTimeout(((node) => () => { try { node.classList.remove('glow'); } catch(e) {} })(n), 650);
    }
  }
  if (nearBottom) {
    list.scrollTop = list.scrollHeight;
    auditState.pendingNewCount = 0;
  } else {
    // User is scrolled up — don't yank their view. Show pill with count.
    auditState.pendingNewCount += newNodes.length;
  }
  updateAuditPill();
  updateAuditCounters();
}

// Debounced search on typing.
document.addEventListener('DOMContentLoaded', () => {
  const searchEl = document.getElementById('auditSearch');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      if (auditState.searchDebounce) clearTimeout(auditState.searchDebounce);
      auditState.searchDebounce = setTimeout(() => { applyAuditFilters(); }, 400);
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (auditState.searchDebounce) clearTimeout(auditState.searchDebounce);
        applyAuditFilters();
      }
    });
  }
  const fromEl = document.getElementById('auditFromAgent');
  const toEl = document.getElementById('auditToAgent');
  if (fromEl) fromEl.addEventListener('change', applyAuditFilters);
  if (toEl) toEl.addEventListener('change', applyAuditFilters);
  // Auto-hide pill when user scrolls to bottom manually.
  const listEl = document.getElementById('auditList');
  if (listEl) {
    listEl.addEventListener('scroll', () => {
      if (isAuditNearBottom() && auditState.pendingNewCount > 0) {
        auditState.pendingNewCount = 0;
        updateAuditPill();
      }
    }, { passive: true });
  }
});

window.addEventListener('beforeunload', () => {
  disconnectAuditStream();
  disconnectAiUsageStream();
});

// --- AI Usage (task #79) ---

const aiUsageState = {
  initialized: false,
  snapshot: null,          // last rendered snapshot (preserved on error)
  eventSource: null,
  stalenessTicker: null,
  loadTimeoutId: null,     // --- AI Usage iter5 (task #80) S-04: load timeout ---
};

// last_updated_at 5.5분 이상 경과 시 stale 판정
const AI_USAGE_STALE_MS = 5.5 * 60 * 1000;

async function initAiUsage() {
  // --- AI Usage iter5 (task #80) S-04: 10초 load timeout fallback ---
  aiUsageState.loadTimeoutId = setTimeout(() => {
    if (!aiUsageState.snapshot) {
      const grid = document.getElementById('aiUsageGrid');
      if (grid) grid.innerHTML = '<div class="empty">사용량을 아직 받지 못했습니다. 다음 수집까지 최대 5분 걸립니다.</div>';
      const summary = document.getElementById('ai-usage-summary');
      if (summary && !aiUsageState.snapshot) {
        summary.innerHTML = '<div class="summary-empty">사용량을 아직 받지 못했습니다. 다음 수집까지 최대 5분 걸립니다.</div>';
      }
    }
  }, 10000);

  // Initial load: fetch current snapshot once, then open SSE for live updates.
  try {
    const res = await fetch('/api/v1/admin/ai-usage', { headers });
    if (res.ok) {
      const data = await res.json();
      if (data && data.snapshot) {
        clearTimeout(aiUsageState.loadTimeoutId);
        renderAiUsage(data.snapshot);
      } else {
        renderAiUsageEmpty();
      }
    } else {
      renderAiUsageEmpty();
    }
  } catch(e) {
    renderAiUsageEmpty();
  }
  subscribeAiUsageSSE();
  startStalenessTicker();
}

// --- AI Usage iter2 (task #79) --- D-09: 사용자 친화 한국어 empty copy
function renderAiUsageEmpty() {
  const grid = document.getElementById('aiUsageGrid');
  if (grid) grid.innerHTML = '<div class="empty">아직 사용량 데이터가 없습니다. 첫 수집까지 최대 5분 걸릴 수 있습니다.</div>';
  const metaText = document.getElementById('aiUsageMetaText');
  if (metaText) metaText.textContent = '대기 중...';
  const meta = document.getElementById('aiUsageMeta');
  if (meta) meta.classList.remove('stale');
  // Summary box: show empty hint (do not overwrite if a snapshot is already rendered)
  const summary = document.getElementById('ai-usage-summary');
  if (summary && !aiUsageState.snapshot) {
    summary.classList.remove('stale');
    summary.innerHTML = '<div class="summary-empty" id="ai-usage-summary-empty">아직 사용량 데이터가 없습니다. 첫 수집까지 최대 5분 걸릴 수 있습니다.</div>';
  }
}

function renderAiUsage(snapshot) {
  // snapshot이 null/undefined이면 기존 DOM 유지 (에러 시 마지막 값 유지)
  if (!snapshot || !Array.isArray(snapshot.accounts)) return;
  aiUsageState.snapshot = snapshot;
  const grid = document.getElementById('aiUsageGrid');
  if (grid) {
    if (snapshot.accounts.length === 0) {
      grid.innerHTML = '<div class="empty">표시할 계정이 없습니다.</div>'; // D-09: 그대로 유지 — 이미 한국어 사용자 친화
    } else {
      grid.innerHTML = snapshot.accounts.map(renderAiUsageCard).join('');
    }
  }
  // Also update the always-visible summary box (task #79 follow-up)
  renderAiUsageSummary(snapshot);
  updateAiUsageMeta();
}

function renderAiUsageSummary(snapshot) {
  const summary = document.getElementById('ai-usage-summary');
  if (!summary) return;
  if (!snapshot || !Array.isArray(snapshot.accounts) || snapshot.accounts.length === 0) {
    summary.innerHTML = '<div class="summary-empty">표시할 계정이 없습니다.</div>';
    return;
  }
  summary.innerHTML = snapshot.accounts.map(renderAiUsageSummaryRow).join('');
}

// --- AI Usage iter2 (task #79) --- U-01 + D-01: reset 승격, ARIA 부여, last_success_at per-row 제거
// --- AI Usage iter3 (task #79) --- S-01: summary-row minimal 배지, S-06: status dot
function renderAiUsageSummaryRow(acc) {
  if (!acc || typeof acc !== 'object') return '';
  const providerLabel = providerDisplayName(acc.provider);
  const planBadge = acc.plan_hint
    ? '<span class="plan-hint-badge">' + esc(acc.plan_hint) + '</span>'
    : '';
  const fiveHour = renderSummaryWindow('5시간 누적', acc.five_hour, providerLabel);
  const weekly = renderSummaryWindow('주간', acc.weekly, providerLabel);
  const sep = (fiveHour && weekly) ? '<span class="summary-sep">·</span>' : '';
  // S-01: weekly.minimal_mode_active 시 row 끝에 "최소 모드" 배지 (V-04: title에 "주간" 명시)
  const minimalBadge = (acc.weekly && acc.weekly.minimal_mode_active)
    ? '<span class="minimal-mode-badge" title="주간 최소 모드 활성">최소 모드</span>'
    : '';
  // S-06: status dot (api_error → red, consecutive_failures>0 → orange, else none)
  let statusDot = '';
  if (acc.api_error) {
    const errMsg = String(acc.api_error).slice(0, 100);
    statusDot = '<span class="status-dot status-dot-error" title="API 오류: ' + esc(errMsg) + '" ' +
      'aria-label="API 오류 발생: ' + esc(errMsg) + '" role="img"></span>';
  } else if (typeof acc.consecutive_failures === 'number' && acc.consecutive_failures > 0) {
    const n = acc.consecutive_failures;
    statusDot = '<span class="status-dot status-dot-warn" title="연속 실패 ' + n + '회" ' +
      'aria-label="연속 실패 ' + n + '회" role="img"></span>';
  }
  // --- AI Usage iter5 (task #80) V-02-b: status-dot provider 옆에 배치 → narrow wrap 시 귀속 명확
  return (
    '<div class="ai-usage-summary-row" data-provider="' + esc(acc.provider || '') + '" data-account-id="' + esc(acc.account_id || '') + '">' +
      '<span class="row-identity">' +
        '<span class="provider-badge">' + esc(providerLabel) + '</span>' +
        planBadge +
        statusDot +
      '</span>' +
      fiveHour +
      sep +
      weekly +
      minimalBadge +
    '</div>'
  );
}

// --- AI Usage iter2 (task #79) --- U-01 + D-01: reset 시간 강조 + ARIA
// --- AI Usage M-01 mobile (task #80): 요약 박스는 compact reset 텍스트 사용 ---
// --- AI Usage iter6 (task #80) C-01: data-mobile-label 속성 추가 (모바일 @media::before 축약 대응) ---
const SUMMARY_WINDOW_MOBILE_LABEL = {
  '5시간 누적': '5h',
  '주간': '주간',
};
function renderSummaryWindow(label, win, providerLabel) {
  if (!win || typeof win !== 'object') return '';
  const ratio = typeof win.ratio === 'number' ? Math.max(0, Math.min(1, win.ratio)) : 0;
  const pct = Math.round(ratio * 100);
  const level = typeof win.level === 'string' ? win.level.toLowerCase() : 'none';
  // M-01: 요약 박스는 항상 compact reset 텍스트 ("3h 19m" 등), 탭 카드(renderWindow)는 full 유지
  const resetText = win.resets_at ? formatRelativeFutureCompact(win.resets_at) : '';
  const fullResetText = win.resets_at ? formatRelativeFuture(win.resets_at) : '';
  const resetHtml = resetText
    ? '<span class="window-resets" title="' + esc(fullResetText) + '"><span class="reset-icon" aria-hidden="true">⏰</span>' + esc(resetText) + '</span>'
    : '';
  const ariaLabel = (providerLabel ? providerLabel + ' ' : '') + label + ' 사용량 ' + pct + ' 퍼센트';
  // C-01: data-mobile-label — @media::before content: attr(data-mobile-label) 로 모바일 축약 렌더링
  const mobileLabel = SUMMARY_WINDOW_MOBILE_LABEL[label] ?? label;
  // --- AI Usage iter3 (task #79) S-02: 4토큰(label/percent/progress/resets)을 summary-win wrapper로 묶어 narrow viewport wrap 단위 보장
  return (
    '<span class="summary-win">' +
      '<span class="window-label" data-mobile-label="' + esc(mobileLabel) + '">' + esc(label) + '</span>' +
      '<span class="window-percent">' + pct + '%</span>' +
      '<div class="mini-progress" title="' + esc(String(win.level || 'NONE')) + '" ' +
        'role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" ' +
        'aria-label="' + esc(ariaLabel) + '">' +
        '<div class="mini-progress-fill level-' + esc(level) + '" style="width:' + pct + '%;"></div>' +
      '</div>' +
      resetHtml +
    '</span>'
  );
}

// --- AI Usage iter2 (task #79) --- D-10: "5시간 창" → "5시간 누적"
function renderAiUsageCard(acc) {
  if (!acc || typeof acc !== 'object') return '';
  const providerLabel = providerDisplayName(acc.provider);
  const planBadge = acc.plan_hint
    ? '<span class="plan-badge">' + esc(acc.plan_hint) + '</span>'
    : '';
  const fiveHourHtml = acc.five_hour ? renderWindow('5h', '5시간 누적', acc.five_hour, providerLabel) : '';
  const weeklyHtml = acc.weekly ? renderWindow('weekly', '주간', acc.weekly, providerLabel) : '';
  const footer = renderCardFooter(acc);
  return (
    '<div class="ai-usage-card" data-account-id="' + esc(acc.account_id) + '">' +
      '<div class="account-hdr">' +
        '<span class="account-name">' + esc(acc.account_id || '(unknown)') + '</span>' +
        '<span class="provider-badge provider-badge--strong">' + esc(providerLabel) + '</span>' +
      '</div>' +
      (planBadge ? '<div>' + planBadge + '</div>' : '') +
      fiveHourHtml +
      weeklyHtml +
      footer +
    '</div>'
  );
}

function providerDisplayName(provider) {
  if (!provider) return 'unknown';
  const p = String(provider);
  if (p === 'anthropic-claude') return 'Claude';
  if (p === 'openai-codex') return 'Codex';
  return p;
}

// --- AI Usage iter5 (task #80) V-01: 색약 보조 아이콘 맵 ---
function levelIcon(level) {
  switch ((level || '').toLowerCase()) {
    case 'none':   return '✓';
    case 'info':   return 'ⓘ';
    case 'warn':   return '⚠';
    case 'danger': return '▲';
    case 'stop':   return '⛔';
    default:       return '';
  }
}

// --- AI Usage iter2 (task #79) --- U-01 + D-01 + D-08: reset 승격, ARIA, 한글 "최소 모드"
function renderWindow(kind, label, win, providerLabel) {
  if (!win || typeof win !== 'object') return '';
  const ratio = typeof win.ratio === 'number' ? Math.max(0, Math.min(1, win.ratio)) : 0;
  const pct = Math.round(ratio * 100);
  const level = typeof win.level === 'string' ? win.level.toLowerCase() : 'none';
  const levelCls = 'level-' + level;
  const resetText = win.resets_at ? formatRelativeFuture(win.resets_at) : '';
  const resetHtml = resetText
    ? '<span class="window-resets" title="리셋 예정"><span class="reset-icon" aria-hidden="true">⏰</span>' + esc(resetText) + '</span>'
    : '';
  const minimalMode = win.minimal_mode_active
    ? '<span class="minimal-mode-badge" title="최소 모드 활성">최소 모드</span>'
    : '';
  const ariaLabel = (providerLabel ? providerLabel + ' ' : '') + label + ' 사용량 ' + pct + ' 퍼센트';
  return (
    '<div class="ai-usage-window" data-kind="' + esc(kind) + '">' +
      '<div class="window-hdr">' +
        '<span class="window-label">' + esc(label) + minimalMode + '</span>' +
        resetHtml +
      '</div>' +
      '<div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" ' +
        'aria-label="' + esc(ariaLabel) + '">' +
        '<div class="progress-fill ' + levelCls + '" style="width:' + pct + '%;"></div>' +
      '</div>' +
      '<div class="window-footer">' +
        /* --- AI Usage iter5 (task #80) V-01: 색약 보조 아이콘 --- */
        '<span class="level-badge ' + levelCls + '">' +
          '<span class="level-icon" aria-hidden="true">' + levelIcon(level) + '</span> ' +
          esc(win.level || 'NONE') +
        '</span>' +
        '<span>' + pct + '%</span>' +
      '</div>' +
    '</div>'
  );
}

// --- AI Usage iter2 (task #79) --- D-05: footer 위계 (api_error 큰 글씨 → fail count → last_success 작게)
function renderCardFooter(acc) {
  const parts = [];
  if (acc.api_error) {
    parts.push('<span class="api-error" title="' + esc(String(acc.api_error)) + '">' +
      '<span class="err-icon" aria-hidden="true">⚠</span>API 에러</span>');
  }
  if (typeof acc.consecutive_failures === 'number' && acc.consecutive_failures > 0) {
    parts.push('<span class="fail-count">연속 실패 ' + acc.consecutive_failures + '회</span>');
  }
  // D-05: api_error 없을 때만 last_success_at 표시 — 에러가 묻히지 않도록
  if (!acc.api_error && acc.last_success_at) {
    parts.push('<span class="last-success">마지막 성공: ' + esc(formatRelativePast(acc.last_success_at)) + '</span>');
  }
  if (parts.length === 0) return '';
  return '<div class="ai-usage-footer">' + parts.join('') + '</div>';
}

// --- AI Usage iter3 (task #79) --- Z-02: SSE disconnect banner helpers
function showAiUsageDisconnectBanner() {
  const banner = document.getElementById('ai-usage-disconnect-banner');
  if (banner) banner.classList.add('visible');
}
function hideAiUsageDisconnectBanner() {
  const banner = document.getElementById('ai-usage-disconnect-banner');
  if (banner) banner.classList.remove('visible');
}

function subscribeAiUsageSSE() {
  if (aiUsageState.eventSource) {
    try { aiUsageState.eventSource.close(); } catch(e) {}
    aiUsageState.eventSource = null;
  }
  let es;
  try {
    es = new EventSource('/api/v1/admin/ai-usage/stream');
  } catch(e) {
    // Construction failed — treat as disconnected
    showAiUsageDisconnectBanner();
    return;
  }
  aiUsageState.eventSource = es;
  es.addEventListener('ai-usage-update', (ev) => {
    try {
      const snap = JSON.parse(ev.data);
      // --- AI Usage iter5 (task #80) S-04: snapshot 수신 시 load timeout 취소 ---
      if (aiUsageState.loadTimeoutId) {
        clearTimeout(aiUsageState.loadTimeoutId);
        aiUsageState.loadTimeoutId = null;
      }
      renderAiUsage(snap);
      // Successful frame → connection healthy, hide banner
      hideAiUsageDisconnectBanner();
    } catch(e) { /* keep previous snapshot on parse error */ }
  });
  es.addEventListener('ping', () => { /* heartbeat — no-op */ });
  // --- AI Usage iter3 (task #79) --- Z-02: onopen / onerror for disconnect banner
  es.onopen = () => {
    hideAiUsageDisconnectBanner();
  };
  es.onerror = () => {
    // EventSource auto-reconnects; show banner while readyState != OPEN
    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
    if (es.readyState !== 1) {
      showAiUsageDisconnectBanner();
    }
  };
}

function disconnectAiUsageStream() {
  if (aiUsageState.eventSource) {
    try { aiUsageState.eventSource.close(); } catch(e) {}
    aiUsageState.eventSource = null;
  }
  if (aiUsageState.stalenessTicker) {
    clearInterval(aiUsageState.stalenessTicker);
    aiUsageState.stalenessTicker = null;
  }
}

function startStalenessTicker() {
  if (aiUsageState.stalenessTicker) clearInterval(aiUsageState.stalenessTicker);
  aiUsageState.stalenessTicker = setInterval(updateStalenessTicker, 30000);
}

function updateStalenessTicker() {
  updateAiUsageMeta();
  // Also refresh relative times inside cards (last_success_at / resets_at)
  // by re-rendering with the preserved snapshot — cheap for small grids.
  if (aiUsageState.snapshot) renderAiUsage(aiUsageState.snapshot);
}

function updateAiUsageMeta() {
  const meta = document.getElementById('aiUsageMeta');
  const metaText = document.getElementById('aiUsageMetaText');
  const summary = document.getElementById('ai-usage-summary');
  const snap = aiUsageState.snapshot;
  if (!snap || !snap.last_updated_at) {
    if (metaText) metaText.textContent = '대기 중...';
    if (meta) meta.classList.remove('stale');
    if (summary) summary.classList.remove('stale');
    return;
  }
  const ts = Date.parse(snap.last_updated_at);
  const age = Date.now() - ts;
  const rel = formatRelativePast(snap.last_updated_at);
  const grid = document.getElementById('aiUsageGrid');
  if (age > AI_USAGE_STALE_MS) {
    if (meta) meta.classList.add('stale');
    if (metaText) metaText.innerHTML = '<span class="warn-icon">⚠</span> 갱신 지연 · 마지막 갱신 ' + esc(rel);
    if (grid) grid.querySelectorAll('.ai-usage-card').forEach(c => c.classList.add('stale'));
    if (summary) summary.classList.add('stale');
  } else {
    if (meta) meta.classList.remove('stale');
    if (metaText) metaText.textContent = '마지막 갱신: ' + rel;
    if (grid) grid.querySelectorAll('.ai-usage-card').forEach(c => c.classList.remove('stale'));
    if (summary) summary.classList.remove('stale');
  }
}

function formatRelativePast(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const diff = Date.now() - t;
  if (diff < 0) return '방금';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + '초 전';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 ' + (m % 60) + '분 전';
  const d = Math.floor(h / 24);
  return d + '일 전';
}

function formatRelativeFuture(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const diff = t - Date.now();
  if (diff <= 0) return '리셋됨';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + '초 뒤 리셋';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분 뒤 리셋';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return h + '시간 ' + rem + '분 뒤 리셋';
  const d = Math.floor(h / 24);
  return d + '일 뒤 리셋';
}

// --- AI Usage M-01 mobile (task #80): 요약 박스 전용 compact reset helper ---
// 변환 예시: "3h 19m" / "55m" / "3d" / "리셋됨"
function formatRelativeFutureCompact(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const diff = t - Date.now();
  if (diff <= 0) return '리셋됨';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? h + 'h ' + rem + 'm' : h + 'h';
  const d = Math.floor(h / 24);
  return d + 'd';
}

loadPending();
loadUsers();
// Auto-initialize AI Usage summary box on page load (task #79 follow-up).
// Always-visible summary box + 5-min auto refresh via SSE, regardless of tab.
if (document.getElementById('ai-usage-summary') && !aiUsageState.initialized) {
  aiUsageState.initialized = true;
  initAiUsage();
}
</script>
</body>
</html>`
}
