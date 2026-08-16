import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// Common sub-nav items per suite
const SUITE_SUBNAVS: Record<string, { label: string; url: string }[]> = {
  public: [
    { label: '🌟 Landing', url: '/public/index.html' },
    { label: '📐 Security Architecture', url: '/public/security-architecture.html' },
    { label: '⏱️ Lease State Machine', url: '/public/lease-state-machine.html' },
    { label: '👤 Operator Login', url: '/public/login-operator.html' },
    { label: '🏢 Tenant Login', url: '/public/login-tenant.html' },
    { label: '🛡️ Platform Login', url: '/public/login-platform.html' },
    { label: '💎 Pricing & SLAs', url: '/public/pricing-tiers.html' },
    { label: '📜 Compliance & Trust', url: '/public/compliance-overview.html' }
  ],
  platform: [
    { label: '📊 Overview', url: '/platform/index.html' },
    { label: '🌐 14 Highways', url: '/platform/highways.html' },
    { label: '🏢 Tenants', url: '/platform/tenant-manager.html' },
    { label: '🏢 Tenant Detail', url: '/platform/tenant-detail.html' },
    { label: '🖥️ Telemetry', url: '/platform/telemetry.html' },
    { label: '🌍 Failover Sim', url: '/platform/failover-sim.html' },
    { label: '⚡ Rate Limiting', url: '/platform/rate-limiting.html' },
    { label: '🔒 Metadata Audits', url: '/platform/metadata-audits.html' },
    { label: '🔌 Gateway Sockets', url: '/platform/gateway-inspect.html' },
    { label: '📶 QoS Shaper', url: '/platform/bandwidth-shaper.html' },
    { label: '🔐 Root CA', url: '/platform/certificate-authority.html' },
    { label: '👁️ §8.11 Sources', url: '/platform/observed-sources.html' }
  ],
  tenant: [
    { label: '📈 Executive Overview', url: '/tenant/index.html' },
    { label: '🔑 Key Approvals (3)', url: '/tenant/key-approvals.html' },
    { label: '🔄 Key Rotations', url: '/tenant/key-rotations.html' },
    { label: '⛔ Compromised Keys', url: '/tenant/compromised-keys.html' },
    { label: '📁 Swarm Groups', url: '/tenant/groups.html' },
    { label: '📁 Group Detail', url: '/tenant/group-detail.html' },
    { label: '🛡️ Egress ACL', url: '/tenant/egress-acl.html' },
    { label: '⚙️ Send Policy Default', url: '/tenant/send-policy-default.html' },
    { label: '🌐 Network CIDR', url: '/tenant/network-attestation.html' },
    { label: '🚨 Audit Failure Policy', url: '/tenant/audit-failure-policy.html' },
    { label: '⚡ Pairing Codes', url: '/tenant/pairing-codes.html' },
    { label: '📜 Pairing History', url: '/tenant/pairing-history.html' },
    { label: '📋 Participant Audits', url: '/tenant/participant-audits.html' },
    { label: '👁️ Audit Read Log', url: '/tenant/audit-read-events.html' },
    { label: '📦 SIEM / S3 Export', url: '/tenant/siem-export.html' },
    { label: '👥 Organization RBAC', url: '/tenant/organization-rbac.html' }
  ],
  creator: [
    { label: '🎛️ Studio Home', url: '/creator/index.html' },
    { label: '🌐 10-Stage Topology', url: '/creator/topology.html' },
    { label: '🎯 Cluster Focus', url: '/creator/topology-focus.html' },
    { label: '💬 Message Playground', url: '/creator/playground.html' },
    { label: '🧾 Delivery Receipts', url: '/creator/message-receipts.html' },
    { label: '📥 Lease Queue (300s)', url: '/creator/lease-queue.html' },
    { label: '⚡ ACK/NACK Actions', url: '/creator/lease-batch-actions.html' },
    { label: '🔬 WebSocket Trace', url: '/creator/websocket-trace.html' },
    { label: '🔌 CLI Runner Guide', url: '/creator/agent-runner.html' },
    { label: '➕ Register Agent', url: '/creator/agent-register.html' },
    { label: '⚠️ Teardown Agent', url: '/creator/agent-teardown.html' },
    { label: '✨ Traffic Pulse Sim', url: '/creator/traffic-pulse-sim.html' }
  ],
  dev: [
    { label: '📖 Developer Hub', url: '/dev/index.html' },
    { label: '⚡ OpenAPI 3.1 Runner', url: '/dev/openapi-explorer.html' },
    { label: 'POST /messages/send', url: '/dev/api-messages-send.html' },
    { label: 'POST /inbox/lease', url: '/dev/api-inbox-lease.html' },
    { label: 'DELETE /inbox/ack', url: '/dev/api-inbox-ack.html' },
    { label: 'POST /keys/propose', url: '/dev/api-keys-propose.html' },
    { label: 'GET /capabilities', url: '/dev/api-capabilities.html' },
    { label: 'TypeScript SDK', url: '/dev/sdk-typescript.html' },
    { label: 'Python SDK', url: '/dev/sdk-python.html' },
    { label: 'Go SDK', url: '/dev/sdk-go.html' },
    { label: '🪝 Webhooks', url: '/dev/webhooks.html' },
    { label: '🔄 Dead-Letter Queue', url: '/dev/dead-letter-queue.html' }
  ]
};

// Generate comprehensive layout with subnav, breadcrumb, toolbar, and content
export function renderRichPage(
  screenNum: number,
  suiteKey: 'public' | 'platform' | 'tenant' | 'creator' | 'dev',
  pageUrl: string,
  title: string,
  subtitle: string,
  bodyContent: string
): string {
  const subnavItems = SUITE_SUBNAVS[suiteKey] || [];
  const subnavHtml = subnavItems.map(item => `
    <a href="${item.url}" class="subnav-pill ${item.url === pageUrl ? 'active' : ''}">${item.label}</a>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Agent Mesh Enterprise Platform</title>
  <link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
  <!-- Global Top Navigation Header -->
  <header class="preview-control-bar">
    <a href="/index.html" class="preview-brand">
      <div class="brand-icon">M</div>
      <span>Agent Mesh Platform</span>
      <span class="badge badge-success"><span class="live-dot"></span> v0.3 Live (v4 surface)</span>
    </a>

    <div class="preview-nav">
      <a href="/public/index.html" class="preview-btn ${suiteKey === 'public' ? 'active' : ''}">1. Home & Protocols</a>
      <a href="/platform/index.html" class="preview-btn ${suiteKey === 'platform' ? 'active' : ''}">2. Platform Operator</a>
      <a href="/tenant/index.html" class="preview-btn ${suiteKey === 'tenant' ? 'active' : ''}">3. Tenant Admin (Acme Corp)</a>
      <a href="/creator/index.html" class="preview-btn ${suiteKey === 'creator' ? 'active' : ''}">4. Agent Studio</a>
      <a href="/dev/index.html" class="preview-btn ${suiteKey === 'dev' ? 'active' : ''}">5. Developer Hub & APIs</a>
    </div>

    <div style="display:flex; align-items:center; gap:10px;">
      <a href="/index.html" class="btn btn-secondary btn-sm">🗂 All-in-One Hub</a>
    </div>
  </header>

  <!-- Main Page Container -->
  <div class="page-container">
    <!-- Sub-navigation Pills -->
    <div class="subnav-pills">
      ${subnavHtml}
    </div>

    <!-- Header Row -->
    <div class="admin-header-row">
      <div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <span class="badge badge-leased">${suiteKey.toUpperCase()} SUITE</span>
          <span style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-muted);">Screen #${screenNum}</span>
        </div>
        <h1 class="admin-header-title">${title}</h1>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-top:2px;">${subtitle}</p>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-secondary btn-sm" onclick="window.location.reload()">↻ Refresh</button>
        <a href="/index.html" class="btn btn-primary btn-sm">Master Hub →</a>
      </div>
    </div>

    <!-- Body Content -->
    ${bodyContent}
  </div>

  <script src="/assets/js/common.js"></script>
</body>
</html>`;
}
