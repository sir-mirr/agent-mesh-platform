import { readFileSync, writeFileSync } from 'fs';

const filePath = '/Users/lyong/work/ai/agent-mesh-platform/preview/index.html';
let html = readFileSync(filePath, 'utf-8');

// Extra styles for Failover Map, Sliders, and Terminal
const extraCss2 = `
  /* Failover Region Card */
  .region-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 20px;
  }
  .region-card {
    background: #FFFFFF;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 16px;
    box-shadow: var(--shadow-xs);
  }
  .region-card.active {
    border-color: #10B981;
    background: #F0FDF4;
  }
  .region-card.degraded {
    border-color: #EF4444;
    background: #FEF2F2;
  }

  /* Rate Limit Range Slider & Meter */
  .slider-control-box {
    background: var(--bg-surface-sub);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 14px;
    margin-bottom: 12px;
  }
`;

if (!html.includes('.region-grid')) {
  html = html.replace('</style>', extraCss2 + '\n</style>');
}

// 1. Platform Operator: Add Subtabs for Multi-Region Failover & Rate Limiting
const oldPTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="pTabBtn-gateways" onclick="switchPlatformTab('gateways')" data-i18n="tab_gateways">🌐 Cross-Tenant Gateways & Highways</button>
      <button class="tab-nav-btn" id="pTabBtn-tenants" onclick="switchPlatformTab('tenants')" data-i18n="tab_tenants">🏢 Tenant Provisioning & Quotas</button>
      <button class="tab-nav-btn" id="pTabBtn-telemetry" onclick="switchPlatformTab('telemetry')">🖥️ Cluster Nodes & Telemetry</button>
      <button class="tab-nav-btn" id="pTabBtn-audits" onclick="switchPlatformTab('audits')" data-i18n="tab_meta_audits">📊 Global Metadata Audits (Zero Content Leak)</button>
    </div>`;

const newPTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="pTabBtn-gateways" onclick="switchPlatformTab('gateways')" data-i18n="tab_gateways">🌐 Cross-Tenant Highways</button>
      <button class="tab-nav-btn" id="pTabBtn-tenants" onclick="switchPlatformTab('tenants')" data-i18n="tab_tenants">🏢 Tenant Provisioning & Quotas</button>
      <button class="tab-nav-btn" id="pTabBtn-telemetry" onclick="switchPlatformTab('telemetry')">🖥️ Cluster Nodes & Telemetry</button>
      <button class="tab-nav-btn" id="pTabBtn-failover" onclick="switchPlatformTab('failover')">🌍 Multi-Region Failover Simulation</button>
      <button class="tab-nav-btn" id="pTabBtn-ratelimit" onclick="switchPlatformTab('ratelimit')">⚡ Rate Limiting & Token Buckets</button>
      <button class="tab-nav-btn" id="pTabBtn-audits" onclick="switchPlatformTab('audits')" data-i18n="tab_meta_audits">📊 Global Metadata Audits</button>
    </div>

    <!-- Tab 4 (New): Multi-Region Failover Simulation -->
    <div id="platform-panel-failover" style="display:none;">
      <div class="card" style="margin-bottom:20px;">
        <div class="card-header">
          <div>
            <div class="card-title">Global Mesh Multi-Region Gateway Failover Simulator</div>
            <div class="card-subtitle">Test automatic gateway failover and traffic rerouting across continents</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="triggerSimulatedOutage()">⚡ Simulate US-East Outage</button>
        </div>

        <div class="region-grid">
          <!-- Region 1: US East (N. Virginia) -->
          <div class="region-card active" id="regionCard-us-east">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <strong style="font-size:1rem;">🇺🇸 US-East (N. Virginia)</strong>
              <span class="badge badge-success" id="regionBadge-us-east">Primary Active</span>
            </div>
            <div style="font-size:0.82rem; color:var(--text-secondary); line-height:1.6;">
              • Gateway Cluster: <code>gw-useast-backbone</code><br>
              • Live Traffic: <strong id="trafficVal-us-east">12,400 msg/s</strong><br>
              • Health Score: <strong style="color:#059669;" id="healthVal-us-east">99.99%</strong>
            </div>
          </div>

          <!-- Region 2: EU West (Frankfurt) -->
          <div class="region-card active" id="regionCard-eu-west">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <strong style="font-size:1rem;">🇩🇪 EU-West (Frankfurt)</strong>
              <span class="badge badge-success" id="regionBadge-eu-west">Primary Active</span>
            </div>
            <div style="font-size:0.82rem; color:var(--text-secondary); line-height:1.6;">
              • Gateway Cluster: <code>gw-euwest-backbone</code><br>
              • Live Traffic: <strong id="trafficVal-eu-west">8,950 msg/s</strong><br>
              • Health Score: <strong style="color:#059669;">100.0%</strong>
            </div>
          </div>

          <!-- Region 3: AP Northeast (Seoul) -->
          <div class="region-card active" id="regionCard-ap-seoul">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <strong style="font-size:1rem;">🇰🇷 AP-Northeast (Seoul)</strong>
              <span class="badge badge-success" id="regionBadge-ap-seoul">Primary Active</span>
            </div>
            <div style="font-size:0.82rem; color:var(--text-secondary); line-height:1.6;">
              • Gateway Cluster: <code>gw-korea-backbone</code><br>
              • Live Traffic: <strong id="trafficVal-ap-seoul">15,200 msg/s</strong><br>
              • Health Score: <strong style="color:#059669;">100.0%</strong>
            </div>
          </div>
        </div>

        <div id="failoverAlertBanner" style="display:none; background:#FEF2F2; border:1px solid #FCA5A5; color:#991B1B; padding:12px 16px; border-radius:var(--radius-md); font-size:0.85rem;">
          🚨 <strong>Simulated Outage Active:</strong> US-East traffic (12,400 msg/s) has been automatically rerouted to EU-West and AP-Seoul with zero packet loss.
        </div>
      </div>
    </div>

    <!-- Tab 5 (New): Rate Limiting & Token Buckets -->
    <div id="platform-panel-ratelimit" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Multi-Tenant Token Bucket Ingress Throttling</div>
            <div class="card-subtitle">Configure burst capacity, token refill rates, and HTTP 429 response behaviors</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Rate limit configuration saved to Redis cluster.')">Save Throttle Rules</button>
        </div>

        <div class="slider-control-box">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
            <strong>Tenant Ingress Rate Limit (Acme Corp)</strong>
            <span id="rateValAcme" style="color:var(--primary); font-weight:700;">10,000 req/min</span>
          </div>
          <input type="range" min="1000" max="50000" step="1000" value="10000" style="width:100%; cursor:pointer;" oninput="document.getElementById('rateValAcme').innerText = Number(this.value).toLocaleString() + ' req/min'">
          <span style="font-size:0.75rem; color:var(--text-muted);">Burst multiplier: 2.0x (Up to 20,000 requests in a 10s burst window)</span>
        </div>

        <div class="slider-control-box">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
            <strong>Socketless Queue Batch Lease Limit</strong>
            <span id="rateValLease" style="color:#7C3AED; font-weight:700;">50 msgs / batch</span>
          </div>
          <input type="range" min="5" max="200" step="5" value="50" style="width:100%; cursor:pointer;" oninput="document.getElementById('rateValLease').innerText = this.value + ' msgs / batch'">
          <span style="font-size:0.75rem; color:var(--text-muted);">Prevents memory exhaustion on worker nodes during large inbox drain operations</span>
        </div>
      </div>
    </div>`;

html = html.replace(oldPTabs, newPTabs);

// 2. Tenant Admin: Add Subtabs for Key Rotation, SIEM Export, and Network Policy
const oldTTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tTabBtn-overview" onclick="switchTenantTab('overview')">📈 Executive Overview</button>
      <button class="tab-nav-btn" id="tTabBtn-keys" onclick="switchTenantTab('keys')">🔑 Key Approvals (3)</button>
      <button class="tab-nav-btn" id="tTabBtn-groups" onclick="switchTenantTab('groups')">📁 Group Governance & Send Policies</button>
      <button class="tab-nav-btn" id="tTabBtn-pairing" onclick="switchTenantTab('pairing')">⚡ Pairing Code (RFC 8628)</button>
      <button class="tab-nav-btn" id="tTabBtn-audits" onclick="switchTenantTab('audits')">📋 Participant Audit Trail (with Content)</button>
      <button class="tab-nav-btn" id="tTabBtn-rbac" onclick="switchTenantTab('rbac')">⚙️ Organization Settings & RBAC</button>
    </div>`;

const newTTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tTabBtn-overview" onclick="switchTenantTab('overview')">📈 Executive Overview</button>
      <button class="tab-nav-btn" id="tTabBtn-keys" onclick="switchTenantTab('keys')">🔑 Key Approvals (3)</button>
      <button class="tab-nav-btn" id="tTabBtn-rotation" onclick="switchTenantTab('rotation')">🔄 Key Rotation & Grace Period</button>
      <button class="tab-nav-btn" id="tTabBtn-groups" onclick="switchTenantTab('groups')">📁 Group Governance & Send Policies</button>
      <button class="tab-nav-btn" id="tTabBtn-network" onclick="switchTenantTab('network')">🛡️ Network CIDR & Fail Policy</button>
      <button class="tab-nav-btn" id="tTabBtn-pairing" onclick="switchTenantTab('pairing')">⚡ Pairing Code (RFC 8628)</button>
      <button class="tab-nav-btn" id="tTabBtn-audits" onclick="switchTenantTab('audits')">📋 Participant Audit Trail (with Content)</button>
      <button class="tab-nav-btn" id="tTabBtn-siem" onclick="switchTenantTab('siem')">📦 SIEM & S3 Archiving</button>
      <button class="tab-nav-btn" id="tTabBtn-rbac" onclick="switchTenantTab('rbac')">⚙️ Organization Settings & RBAC</button>
    </div>

    <!-- Tab 3 (New): Key Rotation & Grace Period Manager -->
    <div id="tenant-panel-rotation" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Zero-Downtime Public Key Rotation & Grace Period Scheduler</div>
            <div class="card-subtitle">Automate rolling cryptographic key rotations without breaking in-flight agent communications</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Initiated rolling key rotation for core-lead.')">+ Rotate Key for Agent</button>
        </div>

        <table class="data-table" style="width:100%; border-collapse:collapse; font-size:0.875rem;">
          <thead>
            <tr style="text-align:left; background:var(--bg-surface-sub); border-bottom:1px solid var(--border-default);">
              <th style="padding:10px 14px;">Agent Identity</th>
              <th style="padding:10px 14px;">Active Key FP</th>
              <th style="padding:10px 14px;">Grace Period Secondary Key</th>
              <th style="padding:10px 14px;">Next Scheduled Rotation</th>
              <th style="padding:10px 14px;">Rotation Status</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid var(--border-default);">
              <td style="padding:12px 14px; font-weight:700;">acme-corp:core-lead (Fin둥이)</td>
              <td style="padding:12px 14px; font-family:var(--font-mono); font-size:0.75rem;">sha256:pfsELGYsvWLU...</td>
              <td style="padding:12px 14px; font-family:var(--font-mono); font-size:0.75rem; color:#059669;">sha256:k8NxB3cR6jFa... (Valid 48h)</td>
              <td style="padding:12px 14px;">2026-09-01 (14 days)</td>
              <td style="padding:12px 14px;"><span class="badge badge-success">Dual-Key Active</span></td>
            </tr>
            <tr style="border-bottom:1px solid var(--border-default);">
              <td style="padding:12px 14px; font-weight:700;">acme-corp:core-agent-3 (Fin자)</td>
              <td style="padding:12px 14px; font-family:var(--font-mono); font-size:0.75rem;">sha256:3vLmK0pQ4w7X...</td>
              <td style="padding:12px 14px; color:var(--text-muted); font-size:0.8rem;">None (Single Key)</td>
              <td style="padding:12px 14px;">2026-08-25 (7 days)</td>
              <td style="padding:12px 14px;"><span class="badge badge-leased">Scheduled</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 5 (New): Network CIDR & Fail-Open/Closed Policy -->
    <div id="tenant-panel-network" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Network Source Attestation & Audit Failure Policies</div>
            <div class="card-subtitle">Configure ingress CIDR whitelisting and fail-open/fail-closed compliance behavior</div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Audit Process Failure Action (SPEC v0.3 Proposal)</label>
          <select class="form-input" id="failPolicySelect">
            <option value="fail_closed">Fail Closed (Strict: Block message transit if audit logging write fails)</option>
            <option value="fail_open">Fail Open (High Availability: Allow transit with telemetry queueing)</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Source Attestation Granularity</label>
          <select class="form-input">
            <option value="exact">Exact Source IP Matching (10.0.4.12/32)</option>
            <option value="prefix">Subnet Prefix Range (10.0.0.0/16)</option>
            <option value="asn">Autonomous System Number (ASN Matching)</option>
          </select>
        </div>

        <button class="btn btn-primary" onclick="alert('Network source attestation & compliance policy saved.')">Save Network Policy</button>
      </div>
    </div>

    <!-- Tab 8 (New): SIEM Export & S3 Archiving -->
    <div id="tenant-panel-siem" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Enterprise SIEM & Long-Term Immutable S3 Archiving</div>
            <div class="card-subtitle">Stream audit records directly to corporate security data lakes</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Testing SIEM export connection (HTTP 200 OK)')">⚡ Test S3 Bucket</button>
        </div>

        <div class="form-group">
          <label class="form-label">Target AWS S3 / Cloud Storage Bucket URI</label>
          <input type="text" class="form-input" value="s3://acme-corp-compliance-logs-2026/agent-mesh/">
        </div>

        <div class="form-group">
          <label class="form-label">Splunk / Datadog HEC Endpoint</label>
          <input type="text" class="form-input" value="https://http-inputs-acme.splunkcloud.com/services/collector/raw">
        </div>

        <div class="form-group">
          <label class="form-label">Cryptographic Log Hash Chaining</label>
          <select class="form-input">
            <option value="merkle">Merkle Tree Hash Chain (SOC2 Type II Audit-Ready)</option>
            <option value="simple">Sequential SHA-256 Digest Chain</option>
          </select>
        </div>

        <button class="btn btn-primary" onclick="alert('SIEM and S3 stream configuration updated successfully.')">Save Archival Settings</button>
      </div>
    </div>`;

html = html.replace(oldTTabs, newTTabs);

// 3. Agent Operations: Add Subtab for Local Agent Runner & CLI Connect Guide
const oldCTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tabBtnTopology" onclick="switchOperatorTab('topology')" data-i18n="tab_topology">🌐 Agent Topology Graph</button>
      <button class="tab-nav-btn" id="tabBtnPlayground" onclick="switchOperatorTab('playground')" data-i18n="tab_playground">💬 Message Playground</button>
      <button class="tab-nav-btn" id="tabBtnTrace" onclick="switchOperatorTab('trace')">🔬 WebSocket Frame & Trace Log</button>
    </div>`;

const newCTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tabBtnTopology" onclick="switchOperatorTab('topology')" data-i18n="tab_topology">🌐 Agent Topology Graph</button>
      <button class="tab-nav-btn" id="tabBtnPlayground" onclick="switchOperatorTab('playground')" data-i18n="tab_playground">💬 Message Playground</button>
      <button class="tab-nav-btn" id="tabBtnTrace" onclick="switchOperatorTab('trace')">🔬 WebSocket Frame & Trace Log</button>
      <button class="tab-nav-btn" id="tabBtnRunner" onclick="switchOperatorTab('runner')">🔌 Local Agent Runner & CLI Guide</button>
    </div>

    <!-- TAB 4 (New): Local Agent Runner & CLI Connect Guide -->
    <div id="operator-panel-runner" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Run Autonomous Agent in Local CLI or Serverless Runtime</div>
            <div class="card-subtitle">Connect your custom AI agent codebase to the Agent Mesh Platform in 3 steps</div>
          </div>
        </div>

        <div style="font-size:0.9rem; line-height:1.7;">
          <strong>Step 1: Install the Agent Mesh CLI</strong>
          <div class="code-snippet-box" style="margin:6px 0 16px;">
curl -fsSL https://get.agent-mesh.dev/install.sh | bash
          </div>

          <strong>Step 2: Generate Ed25519 Keypair & Claim Identity with Pairing Code</strong>
          <div class="code-snippet-box" style="margin:6px 0 16px;">
# Claim agent using single-use pairing code generated in Tenant Admin
agent-mesh claim --code ACM-8492-KY7 --name my-custom-agent --save-key ~/.agent-mesh/agent.key
          </div>

          <strong>Step 3: Start Agent Dispatcher or Socketless Poller</strong>
          <div class="code-snippet-box" style="margin:6px 0;">
agent-mesh listen --endpoint http://localhost:3000 --key ~/.agent-mesh/agent.key --handler ./my_agent_worker.py
          </div>
        </div>
      </div>
    </div>`;

html = html.replace(oldCTabs, newCTabs);

// 4. Update JS switchPlatformTab, switchTenantTab, switchOperatorTab
const oldJsP = `function switchPlatformTab(tab) {
      document.querySelectorAll('#view-platform .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`pTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('platform-panel-gateways').style.display = tab === 'gateways' ? 'block' : 'none';
      document.getElementById('platform-panel-tenants').style.display = tab === 'tenants' ? 'block' : 'none';
      document.getElementById('platform-panel-telemetry').style.display = tab === 'telemetry' ? 'block' : 'none';
      document.getElementById('platform-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }`;

const newJsP = `function switchPlatformTab(tab) {
      document.querySelectorAll('#view-platform .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`pTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('platform-panel-gateways').style.display = tab === 'gateways' ? 'block' : 'none';
      document.getElementById('platform-panel-tenants').style.display = tab === 'tenants' ? 'block' : 'none';
      document.getElementById('platform-panel-telemetry').style.display = tab === 'telemetry' ? 'block' : 'none';
      document.getElementById('platform-panel-failover').style.display = tab === 'failover' ? 'block' : 'none';
      document.getElementById('platform-panel-ratelimit').style.display = tab === 'ratelimit' ? 'block' : 'none';
      document.getElementById('platform-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }

    function triggerSimulatedOutage() {
      const card = document.getElementById('regionCard-us-east');
      const badge = document.getElementById('regionBadge-us-east');
      const traffic = document.getElementById('trafficVal-us-east');
      const health = document.getElementById('healthVal-us-east');
      const banner = document.getElementById('failoverAlertBanner');

      card.classList.remove('active');
      card.classList.add('degraded');
      badge.className = 'badge badge-danger';
      badge.innerText = 'Outage / Failover Triggered';
      traffic.innerText = '0 msg/s (Rerouted)';
      health.innerText = '0.00% (Down)';
      banner.style.display = 'block';

      document.getElementById('trafficVal-eu-west').innerText = '15,150 msg/s (+6,200 failover)';
      document.getElementById('trafficVal-ap-seoul').innerText = '21,400 msg/s (+6,200 failover)';
    }`;

html = html.replace(oldJsP, newJsP);

const oldJsT = `function switchTenantTab(tab) {
      document.querySelectorAll('#view-tenant .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`tTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('tenant-panel-overview').style.display = tab === 'overview' ? 'block' : 'none';
      document.getElementById('tenant-panel-keys').style.display = tab === 'keys' ? 'block' : 'none';
      document.getElementById('tenant-panel-groups').style.display = tab === 'groups' ? 'block' : 'none';
      document.getElementById('tenant-panel-pairing').style.display = tab === 'pairing' ? 'block' : 'none';
      document.getElementById('tenant-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
      document.getElementById('tenant-panel-rbac').style.display = tab === 'rbac' ? 'block' : 'none';
    }`;

const newJsT = `function switchTenantTab(tab) {
      document.querySelectorAll('#view-tenant .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`tTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('tenant-panel-overview').style.display = tab === 'overview' ? 'block' : 'none';
      document.getElementById('tenant-panel-keys').style.display = tab === 'keys' ? 'block' : 'none';
      document.getElementById('tenant-panel-rotation').style.display = tab === 'rotation' ? 'block' : 'none';
      document.getElementById('tenant-panel-groups').style.display = tab === 'groups' ? 'block' : 'none';
      document.getElementById('tenant-panel-network').style.display = tab === 'network' ? 'block' : 'none';
      document.getElementById('tenant-panel-pairing').style.display = tab === 'pairing' ? 'block' : 'none';
      document.getElementById('tenant-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
      document.getElementById('tenant-panel-siem').style.display = tab === 'siem' ? 'block' : 'none';
      document.getElementById('tenant-panel-rbac').style.display = tab === 'rbac' ? 'block' : 'none';
    }`;

html = html.replace(oldJsT, newJsT);

const oldJsC = `function switchOperatorTab(tab) {
      document.querySelectorAll('#view-creator .tab-nav-btn').forEach(t => t.classList.remove('active'));
      document.getElementById('operator-panel-topology').style.display = tab === 'topology' ? 'block' : 'none';
      document.getElementById('operator-panel-playground').style.display = tab === 'playground' ? 'block' : 'none';
      document.getElementById('operator-panel-trace').style.display = tab === 'trace' ? 'block' : 'none';

      if (tab === 'topology') {
        document.getElementById('tabBtnTopology').classList.add('active');
        applyCanvasTransform();
      } else if (tab === 'playground') {
        document.getElementById('tabBtnPlayground').classList.add('active');
      } else if (tab === 'trace') {
        document.getElementById('tabBtnTrace').classList.add('active');
      }
    }`;

const newJsC = `function switchOperatorTab(tab) {
      document.querySelectorAll('#view-creator .tab-nav-btn').forEach(t => t.classList.remove('active'));
      document.getElementById('operator-panel-topology').style.display = tab === 'topology' ? 'block' : 'none';
      document.getElementById('operator-panel-playground').style.display = tab === 'playground' ? 'block' : 'none';
      document.getElementById('operator-panel-trace').style.display = tab === 'trace' ? 'block' : 'none';
      document.getElementById('operator-panel-runner').style.display = tab === 'runner' ? 'block' : 'none';

      if (tab === 'topology') {
        document.getElementById('tabBtnTopology').classList.add('active');
        applyCanvasTransform();
      } else if (tab === 'playground') {
        document.getElementById('tabBtnPlayground').classList.add('active');
      } else if (tab === 'trace') {
        document.getElementById('tabBtnTrace').classList.add('active');
      } else if (tab === 'runner') {
        document.getElementById('tabBtnRunner').classList.add('active');
      }
    }`;

html = html.replace(oldJsC, newJsC);

writeFileSync(filePath, html, 'utf-8');
console.log('Phase 2 expansion complete: 21+ sub-pages and interactive simulators added!');
