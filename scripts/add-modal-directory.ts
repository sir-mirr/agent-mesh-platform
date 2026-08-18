import { readFileSync, writeFileSync } from 'fs';

const filePath = 'preview/index.html';
let html = readFileSync(filePath, 'utf-8');

// Add 60 pages directory modal
const modalDirectoryHtml = `
  <!-- MODAL: 60 Screen Directory Modal -->
  <div id="screenDirectoryModal" class="modal-overlay">
    <div class="modal-container" style="max-width:900px; max-height:85vh; display:flex; flex-direction:column;">
      <div class="modal-header">
        <div>
          <div class="modal-title">Agent Mesh Platform — 60 Enterprise Screen Catalog</div>
          <div class="card-subtitle">Complete modular breakdown across all 5 operational suites</div>
        </div>
        <button class="modal-close-btn" onclick="closeModal('screenDirectoryModal')">✕</button>
      </div>
      <div class="modal-body" style="overflow-y:auto; padding:20px;">
        <!-- Suite 1 -->
        <h3 style="font-size:1rem; font-weight:700; color:var(--primary); margin-bottom:8px;">1. Public & Marketing Suite (8 Screens)</h3>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; margin-bottom:20px;">
          <a href="/public/index.html" class="subnav-pill" style="display:block;">#1 Main Landing & Constellation</a>
          <a href="/public/security-architecture.html" class="subnav-pill" style="display:block;">#2 Security Architecture</a>
          <a href="/public/lease-state-machine.html" class="subnav-pill" style="display:block;">#3 Lease State Machine (300s)</a>
          <a href="/public/login-operator.html" class="subnav-pill" style="display:block;">#4 Operator GitHub Login</a>
          <a href="/public/login-tenant.html" class="subnav-pill" style="display:block;">#5 Tenant Admin SSO Login</a>
          <a href="/public/login-platform.html" class="subnav-pill" style="display:block;">#6 Platform Operator Login</a>
          <a href="/public/pricing-tiers.html" class="subnav-pill" style="display:block;">#7 Ingress Quotas & Pricing</a>
          <a href="/public/compliance-overview.html" class="subnav-pill" style="display:block;">#8 Compliance & Merkle Trust</a>
        </div>

        <!-- Suite 2 -->
        <h3 style="font-size:1rem; font-weight:700; color:var(--primary); margin-bottom:8px;">2. Platform Operator Console (12 Screens)</h3>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; margin-bottom:20px;">
          <a href="/platform/index.html" class="subnav-pill" style="display:block;">#9 Operator Overview</a>
          <a href="/platform/highways.html" class="subnav-pill" style="display:block;">#10 14 Backbone Highways</a>
          <a href="/platform/tenant-manager.html" class="subnav-pill" style="display:block;">#11 Tenant Manager & Quotas</a>
          <a href="/platform/tenant-detail.html" class="subnav-pill" style="display:block;">#12 Tenant Isolation Deep-Dive</a>
          <a href="/platform/telemetry.html" class="subnav-pill" style="display:block;">#13 Hardware & Socket Telemetry</a>
          <a href="/platform/failover-sim.html" class="subnav-pill" style="display:block;">#14 Multi-Region Failover Sim</a>
          <a href="/platform/rate-limiting.html" class="subnav-pill" style="display:block;">#15 Token Bucket Throttling</a>
          <a href="/platform/metadata-audits.html" class="subnav-pill" style="display:block;">#16 Global Metadata Audits</a>
          <a href="/platform/gateway-inspect.html" class="subnav-pill" style="display:block;">#17 Gateway Node Inspector</a>
          <a href="/platform/bandwidth-shaper.html" class="subnav-pill" style="display:block;">#18 Cross-Deck QoS Shaper</a>
          <a href="/platform/certificate-authority.html" class="subnav-pill" style="display:block;">#19 Root Ed25519 CA & MTLS</a>
          <a href="/platform/observed-sources.html" class="subnav-pill" style="display:block;">#20 SPEC §8.11 Observed Source</a>
        </div>

        <!-- Suite 3 -->
        <h3 style="font-size:1rem; font-weight:700; color:var(--primary); margin-bottom:8px;">3. Tenant Admin Console (16 Screens)</h3>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; margin-bottom:20px;">
          <a href="/tenant/index.html" class="subnav-pill" style="display:block;">#21 Executive Overview</a>
          <a href="/tenant/key-approvals.html" class="subnav-pill" style="display:block;">#22 50-Char Key Approvals</a>
          <a href="/tenant/key-rotations.html" class="subnav-pill" style="display:block;">#23 Rolling Key Rotations (48h)</a>
          <a href="/tenant/compromised-keys.html" class="subnav-pill" style="display:block;">#24 Compromised Key Vault</a>
          <a href="/tenant/groups.html" class="subnav-pill" style="display:block;">#25 Swarm Groups & Leads</a>
          <a href="/tenant/group-detail.html" class="subnav-pill" style="display:block;">#26 Core Swarm Detail</a>
          <a href="/tenant/egress-acl.html" class="subnav-pill" style="display:block;">#27 Inter-Group Egress ACL</a>
          <a href="/tenant/send-policy-default.html" class="subnav-pill" style="display:block;">#28 Send Policy Default Toggle</a>
          <a href="/tenant/network-attestation.html" class="subnav-pill" style="display:block;">#29 Network CIDR & ASN</a>
          <a href="/tenant/audit-failure-policy.html" class="subnav-pill" style="display:block;">#30 Fail-Closed Audit Policy</a>
          <a href="/tenant/pairing-codes.html" class="subnav-pill" style="display:block;">#31 RFC 8628 Pairing Generator</a>
          <a href="/tenant/pairing-history.html" class="subnav-pill" style="display:block;">#32 Pairing Code Ledger</a>
          <a href="/tenant/participant-audits.html" class="subnav-pill" style="display:block;">#33 Full Content Audit Stream</a>
          <a href="/tenant/audit-read-events.html" class="subnav-pill" style="display:block;">#34 audit_read_events Access Log</a>
          <a href="/tenant/siem-export.html" class="subnav-pill" style="display:block;">#35 SIEM & S3 Archiving</a>
          <a href="/tenant/organization-rbac.html" class="subnav-pill" style="display:block;">#36 Organization RBAC Grants</a>
        </div>

        <!-- Suite 4 -->
        <h3 style="font-size:1rem; font-weight:700; color:var(--primary); margin-bottom:8px;">4. Agent Operations & Studio (12 Screens)</h3>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; margin-bottom:20px;">
          <a href="/creator/index.html" class="subnav-pill" style="display:block;">#37 Operations Studio Home</a>
          <a href="/creator/topology.html" class="subnav-pill" style="display:block;">#38 10-Stage Galaxy Topology</a>
          <a href="/creator/topology-focus.html" class="subnav-pill" style="display:block;">#39 Single Cluster Auto-Focus</a>
          <a href="/creator/playground.html" class="subnav-pill" style="display:block;">#40 Live Message Playground</a>
          <a href="/creator/message-receipts.html" class="subnav-pill" style="display:block;">#41 Verified Delivery Receipts</a>
          <a href="/creator/lease-queue.html" class="subnav-pill" style="display:block;">#42 300s Lease Queue Inspector</a>
          <a href="/creator/lease-batch-actions.html" class="subnav-pill" style="display:block;">#43 ACK / NACK Queue Controls</a>
          <a href="/creator/websocket-trace.html" class="subnav-pill" style="display:block;">#44 WebSocket Packet Trace</a>
          <a href="/creator/agent-runner.html" class="subnav-pill" style="display:block;">#45 CLI Runner Guide</a>
          <a href="/creator/agent-register.html" class="subnav-pill" style="display:block;">#46 Register Agent (409 Check)</a>
          <a href="/creator/agent-teardown.html" class="subnav-pill" style="display:block;">#47 Teardown Invariant (§9.3)</a>
          <a href="/creator/traffic-pulse-sim.html" class="subnav-pill" style="display:block;">#48 Live Traffic Pulse Sim</a>
        </div>

        <!-- Suite 5 -->
        <h3 style="font-size:1rem; font-weight:700; color:var(--primary); margin-bottom:8px;">5. Developer Hub & APIs (12 Screens)</h3>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
          <a href="/dev/index.html" class="subnav-pill" style="display:block;">#49 Developer Hub Overview</a>
          <a href="/dev/openapi-explorer.html" class="subnav-pill" style="display:block;">#50 OpenAPI 3.1 Test Runner</a>
          <a href="/dev/api-messages-send.html" class="subnav-pill" style="display:block;">#51 POST /messages/send API</a>
          <a href="/dev/api-inbox-lease.html" class="subnav-pill" style="display:block;">#52 POST /inbox/lease API</a>
          <a href="/dev/api-inbox-ack.html" class="subnav-pill" style="display:block;">#53 DELETE /inbox/ack API</a>
          <a href="/dev/api-keys-propose.html" class="subnav-pill" style="display:block;">#54 POST /keys/propose API</a>
          <a href="/dev/api-capabilities.html" class="subnav-pill" style="display:block;">#55 GET /capabilities (v4)</a>
          <a href="/dev/sdk-typescript.html" class="subnav-pill" style="display:block;">#56 TypeScript SDK Guide</a>
          <a href="/dev/sdk-python.html" class="subnav-pill" style="display:block;">#57 Python SDK Guide</a>
          <a href="/dev/sdk-go.html" class="subnav-pill" style="display:block;">#58 Go SDK Guide</a>
          <a href="/dev/webhooks.html" class="subnav-pill" style="display:block;">#59 Webhook Subscriptions</a>
          <a href="/dev/dead-letter-queue.html" class="subnav-pill" style="display:block;">#60 Dead-Letter Queue (DLQ)</a>
        </div>
      </div>
    </div>
  </div>
`;

if (!html.includes('id="screenDirectoryModal"')) {
  html = html.replace('</body>', modalDirectoryHtml + '\n</body>');
  html = html.replace('<div class="preview-brand">', `<button class="btn btn-secondary btn-sm" onclick="openModal('screenDirectoryModal')" style="margin-right:12px;">📑 60 Screens Catalog</button>\n      <div class="preview-brand">`);
  writeFileSync(filePath, html, 'utf-8');
}
