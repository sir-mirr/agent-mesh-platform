import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const PREVIEW_DIR = join(process.cwd(), 'preview');

// Ensure directories exist
const DIRS = [
  'preview/assets/css',
  'preview/assets/js',
  'preview/public',
  'preview/platform',
  'preview/tenant',
  'preview/creator',
  'preview/dev',
  'docs'
];

DIRS.forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// 1. Shared CSS (Design Tokens & Component Utilities)
const COMMON_CSS = `
  :root {
    --primary: #2563EB;
    --primary-hover: #1D4ED8;
    --primary-light: #EFF6FF;
    --primary-border: #DBEAFE;
    --bg-page: #F8FAFC;
    --bg-surface: #FFFFFF;
    --bg-surface-sub: #F1F5F9;
    --text-primary: #0F172A;
    --text-secondary: #475569;
    --text-muted: #94A3B8;
    --border-default: #E2E8F0;
    --border-strong: #CBD5E1;
    --border-subtle: #F1F5F9;
    --status-success: #059669;
    --status-success-bg: #ECFDF5;
    --status-warning: #D97706;
    --status-warning-bg: #FFFBEB;
    --status-danger: #DC2626;
    --status-danger-bg: #FEF2F2;
    --status-danger-br: #FCA5A5;
    --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --radius-full: 9999px;
    --shadow-xs: 0 1px 2px rgba(15, 23, 42, 0.04);
    --shadow-sm: 0 1px 3px rgba(15, 23, 42, 0.08);
    --shadow-md: 0 4px 6px -1px rgba(15, 23, 42, 0.08), 0 2px 4px -2px rgba(15, 23, 42, 0.04);
    --shadow-lg: 0 10px 15px -3px rgba(15, 23, 42, 0.08);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font-sans);
    background: var(--bg-page);
    color: var(--text-primary);
    line-height: 1.5;
    min-height: 100vh;
  }

  /* Navigation Header */
  .preview-control-bar {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 24px;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border-default);
    box-shadow: var(--shadow-sm);
  }
  .preview-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 1rem;
    font-weight: 700;
    color: var(--text-primary);
    text-decoration: none;
  }
  .brand-icon {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.875rem;
    font-weight: 800;
  }

  .preview-nav {
    display: flex;
    gap: 4px;
    background: var(--bg-surface-sub);
    padding: 3px;
    border-radius: var(--radius-md);
  }
  .preview-btn {
    border: none;
    background: transparent;
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
    text-decoration: none;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .preview-btn:hover { color: var(--text-primary); }
  .preview-btn.active {
    background: var(--bg-surface);
    color: var(--primary);
    box-shadow: var(--shadow-xs);
  }

  /* Main Container */
  .page-container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px;
  }

  /* Header Rows */
  .admin-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 16px;
  }
  .admin-header-title {
    font-size: 1.4rem;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  /* Subnav Pills */
  .subnav-pills {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .subnav-pill {
    padding: 6px 14px;
    border-radius: var(--radius-full);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .subnav-pill:hover { border-color: var(--primary); color: var(--primary); }
  .subnav-pill.active {
    background: var(--primary-light);
    border-color: var(--primary);
    color: var(--primary);
  }

  /* Cards & Grids */
  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: 20px;
    box-shadow: var(--shadow-xs);
    margin-bottom: 20px;
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .card-title { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
  .card-subtitle { font-size: 0.82rem; color: var(--text-secondary); margin-top: 2px; }

  /* Badges & Buttons */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: var(--radius-full);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .badge-success { background: var(--status-success-bg); color: var(--status-success); }
  .badge-warning { background: var(--status-warning-bg); color: var(--status-warning); }
  .badge-danger { background: var(--status-danger-bg); color: var(--status-danger); }
  .badge-leased { background: #EDE9FE; color: #6D28D9; }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    display: inline-block;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 0.85rem;
    font-weight: 600;
    border-radius: var(--radius-md);
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s ease;
    text-decoration: none;
  }
  .btn-primary { background: var(--primary); color: white; }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-secondary { background: var(--bg-surface); border-color: var(--border-strong); color: var(--text-primary); }
  .btn-secondary:hover { background: var(--bg-surface-sub); }
  .btn-danger { background: var(--status-danger-bg); color: var(--status-danger); border-color: var(--status-danger-br); }
  .btn-sm { padding: 4px 10px; font-size: 0.78rem; }

  /* Data Table */
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .data-table th {
    text-align: left;
    background: var(--bg-surface-sub);
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-default);
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .data-table td {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-default);
  }

  /* Code Snippet */
  .code-snippet-box {
    background: #0F172A;
    color: #F8FAFC;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    padding: 14px;
    border-radius: var(--radius-md);
    overflow-x: auto;
    line-height: 1.6;
    margin: 8px 0;
  }

  /* Telemetry Grid */
  .telemetry-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 20px;
  }
  .telemetry-card {
    background: #FFFFFF;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 16px;
    box-shadow: var(--shadow-xs);
  }
  .telemetry-bar-wrap {
    height: 8px;
    background: #E2E8F0;
    border-radius: 4px;
    overflow: hidden;
    margin: 8px 0 4px;
  }
  .telemetry-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.6s ease;
  }
`;
writeFileSync('preview/assets/css/style.css', COMMON_CSS, 'utf-8');

// 2. Shared JavaScript
const COMMON_JS = `
  // Common i18n & capabilities detection (v4 with observed_source)
  const MESH_CAPABILITIES = {
    surface: {
      version: 4,
      observed_source: "socket"
    },
    capabilities: [
      "key.approve",
      "agent.teardown",
      "group.manage",
      "policy.send_restrict",
      "audit.read_content",
      "audit.read_metadata"
    ]
  };

  console.log('[Agent Mesh Platform] Initialized with surface v' + MESH_CAPABILITIES.surface.version + ' (observed_source: ' + MESH_CAPABILITIES.surface.observed_source + ')');
`;
writeFileSync('preview/assets/js/common.js', COMMON_JS, 'utf-8');

console.log('Successfully wrote preview/assets/css/style.css and preview/assets/js/common.js');
