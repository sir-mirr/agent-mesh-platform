import { readFileSync, writeFileSync } from 'fs';

const filePath = 'preview/index.html';
let html = readFileSync(filePath, 'utf-8');

// 1. Add Extra CSS
const extraCss = `
  /* Telemetry & Metrics Bars */
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

  /* Protocol Flow Architecture Cards */
  .protocol-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin: 20px 0;
  }
  .protocol-card {
    background: #FFFFFF;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    padding: 20px;
    box-shadow: var(--shadow-xs);
  }
  .protocol-step-box {
    background: var(--bg-surface-sub);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 12px;
    margin: 10px 0;
    font-size: 0.82rem;
    line-height: 1.5;
  }

  /* WebSocket Trace Log Inspector */
  .trace-stream-wrap {
    background: #0F172A;
    border-radius: var(--radius-md);
    padding: 14px;
    font-family: var(--font-mono);
    color: #F8FAFC;
    font-size: 0.8rem;
    max-height: 380px;
    overflow-y: auto;
  }
  .trace-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid #1E293B;
  }
  .trace-time { color: #64748B; min-width: 65px; }
  .trace-badge-in { background: #065F46; color: #A7F3D0; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; }
  .trace-badge-out { background: #1E40AF; color: #BFDBFE; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; }
  .trace-badge-ack { background: #581C87; color: #E9D5FF; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; }

  /* API Endpoint Explorer Cards */
  .api-endpoint-card {
    background: #FFFFFF;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 16px;
    margin-bottom: 14px;
    box-shadow: var(--shadow-xs);
  }
  .api-method-post { background: #10B981; color: #fff; font-weight: 700; font-size: 0.75rem; padding: 3px 8px; border-radius: 4px; }
  .api-method-get { background: #3B82F6; color: #fff; font-weight: 700; font-size: 0.75rem; padding: 3px 8px; border-radius: 4px; }
  .api-method-delete { background: #EF4444; color: #fff; font-weight: 700; font-size: 0.75rem; padding: 3px 8px; border-radius: 4px; }

  /* Webhook Subscribers Grid */
  .webhook-card {
    background: #FFFFFF;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

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
html = html.replace('</style>', extraCss + '\n</style>');

// 2. Update Top Navigation Header with 5th Suite
const navOld = `<button class="preview-btn" id="navBtn-creator" onclick="switchView('creator')" data-i18n="nav_creator">4. Agent Operations</button>
      </div>`;
const navNew = `<button class="preview-btn" id="navBtn-creator" onclick="switchView('creator')" data-i18n="nav_creator">4. Agent Operations & Studio</button>
        <button class="preview-btn" id="navBtn-developer" onclick="switchView('developer')" data-i18n="nav_developer">5. Developer Hub & APIs</button>
      </div>`;
html = html.replace(navOld, navNew);

// 3. Wrap Suite 1 (Home) in Subtabs: Landing vs Architecture Protocols
const homeWrapOld = `<main id="view-home" class="preview-view active">
    <section class="home-hero-wrap">`;
const homeWrapNew = `<main id="view-home" class="preview-view active">
    <div class="tab-nav" style="margin-bottom:24px;">
      <button class="tab-nav-btn active" id="hTabBtn-landing" onclick="switchHomeTab('landing')">🌟 Home & Constellation</button>
      <button class="tab-nav-btn" id="hTabBtn-protocols" onclick="switchHomeTab('protocols')">📐 Security Architecture & Protocols</button>
    </div>

    <!-- Sub-panel 1: Landing, Triad Constellation & Logins -->
    <div id="home-panel-landing">
      <section class="home-hero-wrap">`;
html = html.replace(homeWrapOld, homeWrapNew);

const homeEndOld = `    <!-- Features Section -->
    <div class="features-grid">
      <div class="feature-item">
        <div class="feature-icon-wrap">⚡</div>
        <h3 class="feature-heading" data-i18n="feat_1_title">Asynchronous Agent Messaging</h3>
        <p class="feature-body" data-i18n="feat_1_desc">Empowers intermittent and serverless AI agents to reliably send and receive leased batches of messages on-demand with cryptographic signatures.</p>
      </div>
      <div class="feature-item">
        <div class="feature-icon-wrap">🔒</div>
        <h3 class="feature-heading" data-i18n="feat_2_title">Cryptographic Identity Verification</h3>
        <p class="feature-body" data-i18n="feat_2_desc">Enforces strict public key fingerprint matching and operator-governed approval workflows, ensuring every participant is authentic and auditable.</p>
      </div>
      <div class="feature-item">
        <div class="feature-icon-wrap">📊</div>
        <h3 class="feature-heading" data-i18n="feat_3_title">Immutable Real-Time Auditing</h3>
        <p class="feature-body" data-i18n="feat_3_desc">Maintains a tamper-evident, permanent audit trail of every agent-to-agent communication, streamed live for enterprise compliance and oversight.</p>
      </div>
    </div>
  </main>`;

const homeEndNew = `    <!-- Features Section -->
    <div class="features-grid">
      <div class="feature-item">
        <div class="feature-icon-wrap">⚡</div>
        <h3 class="feature-heading" data-i18n="feat_1_title">Asynchronous Agent Messaging</h3>
        <p class="feature-body" data-i18n="feat_1_desc">Empowers intermittent and serverless AI agents to reliably send and receive leased batches of messages on-demand with cryptographic signatures.</p>
      </div>
      <div class="feature-item">
        <div class="feature-icon-wrap">🔒</div>
        <h3 class="feature-heading" data-i18n="feat_2_title">Cryptographic Identity Verification</h3>
        <p class="feature-body" data-i18n="feat_2_desc">Enforces strict public key fingerprint matching and operator-governed approval workflows, ensuring every participant is authentic and auditable.</p>
      </div>
      <div class="feature-item">
        <div class="feature-icon-wrap">📊</div>
        <h3 class="feature-heading" data-i18n="feat_3_title">Immutable Real-Time Auditing</h3>
        <p class="feature-body" data-i18n="feat_3_desc">Maintains a tamper-evident, permanent audit trail of every agent-to-agent communication, streamed live for enterprise compliance and oversight.</p>
      </div>
    </div>
    </div>

    <!-- Sub-panel 2: Security Architecture & Protocols -->
    <div id="home-panel-protocols" style="display:none;">
      <div class="card" style="margin-bottom:20px;">
        <div class="card-header">
          <div>
            <div class="card-title">Agent Mesh Security Architecture & Protocol Invariants</div>
            <div class="card-subtitle">Zero-infrastructure, Ed25519 verified, multi-tenant agent fabric (v0.3 Specification)</div>
          </div>
          <span class="badge badge-success">RFC 8628 & Ed25519 Verified</span>
        </div>

        <div class="protocol-grid">
          <!-- Protocol 1: At-Least-Once Lease Locks -->
          <div class="protocol-card">
            <div style="font-size:1.4rem; margin-bottom:8px;">⏱️</div>
            <strong style="font-size:1.05rem;">1. Socketless Lease State Machine</strong>
            <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">
              Guarantees at-least-once delivery for serverless & intermittent agent runtimes without persistent sockets.
            </p>
            <div class="protocol-step-box">
              <strong>Step 1: Available</strong><br>
              Message buffered in SQLite queue pool.
            </div>
            <div class="protocol-step-box" style="border-color:#F59E0B; background:#FFFDF5;">
              <strong>Step 2: Leased (300s TTL)</strong><br>
              Worker claims batch. Countdown locks message.
            </div>
            <div class="protocol-step-box" style="border-color:#10B981; background:#F0FDF4;">
              <strong>Step 3: ACK (Delete) / NACK</strong><br>
              Deleted on success; Reverts to Available on crash.
            </div>
          </div>

          <!-- Protocol 2: Cryptographic Attestation Pipeline -->
          <div class="protocol-card">
            <div style="font-size:1.4rem; margin-bottom:8px;">🔑</div>
            <strong style="font-size:1.05rem;">2. Cryptographic Attestation</strong>
            <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">
              Dual-layer verification: End-to-end author signature + Proxy gateway transmission token.
            </p>
            <div class="protocol-step-box">
              <code>from: acme-corp:core-lead</code><br>
              Ed25519 signature over full payload body.
            </div>
            <div class="protocol-step-box">
              <code>sent_by: alice_admin</code><br>
              Bearer session proof authenticated in browser.
            </div>
            <div class="protocol-step-box" style="border-color:#3B82F6; background:#EFF6FF;">
              <strong>50-char SHA-256 Fingerprint</strong><br>
              Atomic approval prevents identity collision.
            </div>
          </div>

          <!-- Protocol 3: Zero-Body Leakage Privacy Boundary -->
          <div class="protocol-card">
            <div style="font-size:1.4rem; margin-bottom:8px;">🛡️</div>
            <strong style="font-size:1.05rem;">3. Privacy Boundary Segregation</strong>
            <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">
              Role-based zero-trust isolation between Platform Operators and Tenant Administrators.
            </p>
            <div class="protocol-step-box" style="border-color:#3B82F6; background:#EFF6FF;">
              <strong>Platform Operator:</strong><br>
              Zero message body access. Transit telemetry only.
            </div>
            <div class="protocol-step-box" style="border-color:#F59E0B; background:#FFFDF5;">
              <strong>Tenant Admin:</strong><br>
              Content inspection logged in <code>audit_read_events</code>.
            </div>
            <div class="protocol-step-box">
              <strong>Egress ACL Enforcement:</strong><br>
              Default Deny cross-tenant boundary barrier.
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>`;
html = html.replace(homeEndOld, homeEndNew);

// 4. Update Platform Operator Tabs & Add Telemetry, Failover, Rate Limit Panels
const pTabsOld = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="pTabBtn-gateways" onclick="switchPlatformTab('gateways')" data-i18n="tab_gateways">🌐 Cross-Tenant Gateways & Highways</button>
      <button class="tab-nav-btn" id="pTabBtn-tenants" onclick="switchPlatformTab('tenants')" data-i18n="tab_tenants">🏢 Tenant Provisioning & Quotas</button>
      <button class="tab-nav-btn" id="pTabBtn-audits" onclick="switchPlatformTab('audits')" data-i18n="tab_meta_audits">📊 Global Metadata Audits (Zero Content Leak)</button>
    </div>`;

const pTabsNew = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="pTabBtn-gateways" onclick="switchPlatformTab('gateways')" data-i18n="tab_gateways">🌐 Cross-Tenant Highways</button>
      <button class="tab-nav-btn" id="pTabBtn-tenants" onclick="switchPlatformTab('tenants')" data-i18n="tab_tenants">🏢 Tenant Provisioning & Quotas</button>
      <button class="tab-nav-btn" id="pTabBtn-telemetry" onclick="switchPlatformTab('telemetry')">🖥️ Cluster Nodes & Telemetry</button>
      <button class="tab-nav-btn" id="pTabBtn-failover" onclick="switchPlatformTab('failover')">🌍 Multi-Region Failover Simulation</button>
      <button class="tab-nav-btn" id="pTabBtn-ratelimit" onclick="switchPlatformTab('ratelimit')">⚡ Rate Limiting & Token Buckets</button>
      <button class="tab-nav-btn" id="pTabBtn-audits" onclick="switchPlatformTab('audits')" data-i18n="tab_meta_audits">📊 Global Metadata Audits</button>
    </div>

    <!-- Tab 3 (New): Cluster Node & Telemetry Monitor -->
    <div id="platform-panel-telemetry" style="display:none;">
      <div class="telemetry-grid">
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">CPU Utilization</div>
          <div style="font-size:1.4rem; font-weight:800; color:#059669; margin-top:4px;">18.4%</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:18%; background:#059669;"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">8 Cores · 2.4 GHz</span>
        </div>
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Memory Consumption</div>
          <div style="font-size:1.4rem; font-weight:800; color:#3B82F6; margin-top:4px;">4.2 / 32 GB</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:13%; background:#3B82F6;"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">SQLite Cache: 280 MB</span>
        </div>
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Active WebSocket Sockets</div>
          <div style="font-size:1.4rem; font-weight:800; color:#7C3AED; margin-top:4px;">114 / 10,000</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:11%; background:#7C3AED;"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">25 Socketless Workers Leased</span>
        </div>
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Packet Transit Drop Rate</div>
          <div style="font-size:1.4rem; font-weight:800; color:#059669; margin-top:4px;">0.000%</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:0%; background:#059669;"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">Zero Leaked Payloads</span>
        </div>
      </div>
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
      </div>
    </div>`;
html = html.replace(pTabsOld, pTabsNew);

// 5. Update Tenant Admin Tabs & Add Overview, Rotation, Network, SIEM, and RBAC Panels
const tTabsOld = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tTabBtn-keys" onclick="switchTenantTab('keys')">🔑 Key Approvals (3)</button>
      <button class="tab-nav-btn" id="tTabBtn-groups" onclick="switchTenantTab('groups')">📁 Group Governance & Send Policies</button>
      <button class="tab-nav-btn" id="tTabBtn-pairing" onclick="switchTenantTab('pairing')">⚡ Pairing Code Onboarding (RFC 8628)</button>
      <button class="tab-nav-btn" id="tTabBtn-audits" onclick="switchTenantTab('audits')">📋 Participant Audit Trail (with Content)</button>
    </div>`;

const tTabsNew = `<div class="tab-nav">
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

    <!-- Tab 1 (New): Executive Overview & Fleet Metrics -->
    <div id="tenant-panel-overview">
      <div class="telemetry-grid">
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Monthly Ingress Volume</div>
          <div style="font-size:1.4rem; font-weight:800; color:var(--primary); margin-top:4px;">1,429,820</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:28%; background:var(--primary);"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">28% of 5M plan quota</span>
        </div>
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Active Managed Agents</div>
          <div style="font-size:1.4rem; font-weight:800; color:#059669; margin-top:4px;">28 / 50</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:56%; background:#059669;"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">4 Swarm Clusters active</span>
        </div>
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Avg Delivery Latency</div>
          <div style="font-size:1.4rem; font-weight:800; color:#7C3AED; margin-top:4px;">1.15 ms</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:12%; background:#7C3AED;"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">SLA: &lt; 25.0 ms</span>
        </div>
        <div class="telemetry-card">
          <div style="font-size:0.8rem; color:var(--text-secondary); font-weight:600;">Audit DB Log Retention</div>
          <div style="font-size:1.4rem; font-weight:800; color:#D97706; margin-top:4px;">365 Days</div>
          <div class="telemetry-bar-wrap"><div class="telemetry-bar-fill" style="width:100%; background:#D97706;"></div></div>
          <span style="font-size:0.72rem; color:var(--text-muted);">SOC2 & ISO27001 Compliant</span>
        </div>
      </div>
    </div>

    <!-- Tab 3 (New): Key Rotation & Grace Period Manager -->
    <div id="tenant-panel-rotation" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Zero-Downtime Public Key Rotation & Grace Period Scheduler</div>
            <div class="card-subtitle">Automate rolling cryptographic key rotations without breaking in-flight communications</div>
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
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 5 (New): Network CIDR & Fail Policy -->
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

        <button class="btn btn-primary" onclick="alert('SIEM and S3 stream configuration updated successfully.')">Save Archival Settings</button>
      </div>
    </div>

    <!-- Tab 9 (New): Organization Settings & RBAC -->
    <div id="tenant-panel-rbac" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Organization Administrators & Capability Grants</div>
            <div class="card-subtitle">Fine-grained RBAC permissions for Acme Corp security team</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Invite new admin modal opened.')">+ Invite Administrator</button>
        </div>
        <table class="data-table" style="width:100%; border-collapse:collapse; font-size:0.875rem;">
          <thead>
            <tr style="text-align:left; background:var(--bg-surface-sub); border-bottom:1px solid var(--border-default);">
              <th style="padding:10px 14px;">Admin User</th>
              <th style="padding:10px 14px;">Role</th>
              <th style="padding:10px 14px;">Assigned Capabilities</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid var(--border-default);">
              <td style="padding:12px 14px; font-weight:700;">alice_admin (You)</td>
              <td style="padding:12px 14px;"><span class="badge badge-leased">Super Admin</span></td>
              <td style="padding:12px 14px; font-size:0.8rem; color:var(--text-secondary);">key.approve, agent.teardown, audit.read_content, policy.send_restrict</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;
html = html.replace(tTabsOld, tTabsNew);

// Make #tenant-panel-keys default display:none so #tenant-panel-overview is active
html = html.replace('<div id="tenant-panel-keys">', '<div id="tenant-panel-keys" style="display:none;">');

// 6. Update Agent Operations Suite Tabs with Trace Log & CLI Runner
const cTabsOld = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tabBtnTopology" onclick="switchOperatorTab('topology')" data-i18n="tab_topology">🌐 Agent Topology Graph</button>
      <button class="tab-nav-btn" id="tabBtnPlayground" onclick="switchOperatorTab('playground')" data-i18n="tab_playground">📋 My Agents & Message Playground</button>
    </div>`;

const cTabsNew = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tabBtnTopology" onclick="switchOperatorTab('topology')" data-i18n="tab_topology">🌐 Agent Topology Graph</button>
      <button class="tab-nav-btn" id="tabBtnPlayground" onclick="switchOperatorTab('playground')" data-i18n="tab_playground">💬 Message Playground</button>
      <button class="tab-nav-btn" id="tabBtnTrace" onclick="switchOperatorTab('trace')">🔬 WebSocket Frame & Trace Log</button>
      <button class="tab-nav-btn" id="tabBtnRunner" onclick="switchOperatorTab('runner')">🔌 Local Agent Runner & CLI Guide</button>
    </div>

    <!-- TAB 3 (New): WebSocket Frame & Packet Trace -->
    <div id="operator-panel-trace" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Live WebSocket Frame & Packet Trace Inspector</div>
            <div class="card-subtitle">Real-time low-level frame dispatch and cryptographic verification stream</div>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="document.getElementById('traceStreamBox').innerHTML='';">Clear Stream</button>
            <button class="btn btn-primary btn-sm" onclick="alert('Downloading packet capture (.pcap / json)...')">Export Trace JSON</button>
          </div>
        </div>

        <div class="trace-stream-wrap" id="traceStreamBox">
          <div class="trace-row">
            <span class="trace-time">12:51:02.102</span>
            <span class="trace-badge-out">OUT FRAME</span>
            <div>
              <strong>WS_DISPATCH:</strong> To: <code>acme-corp:core-lead</code> · Size: <code>142 bytes</code><br>
              <span style="color:#94A3B8;">payload: {"action":"HEARTBEAT","agent":"lane-claude","uptime":3820}</span>
            </div>
          </div>
          <div class="trace-row">
            <span class="trace-time">12:51:02.104</span>
            <span class="trace-badge-in">IN FRAME</span>
            <div>
              <strong>WS_ACK:</strong> Message ID: <code>msg_948192</code> · Status: <code>BUFFERED_SOCKETLESS</code><br>
              <span style="color:#94A3B8;">sig: 4b9f8a2e1d7c3b5a9e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b... (Ed25519 Verified)</span>
            </div>
          </div>
        </div>
      </div>
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
agent-mesh claim --code ACM-8492-KY7 --name my-custom-agent --save-key ~/.agent-mesh/agent.key
          </div>

          <strong>Step 3: Start Agent Dispatcher or Socketless Poller</strong>
          <div class="code-snippet-box" style="margin:6px 0;">
agent-mesh listen --endpoint http://localhost:3000 --key ~/.agent-mesh/agent.key --handler ./my_agent_worker.py
          </div>
        </div>
      </div>
    </div>`;
html = html.replace(cTabsOld, cTabsNew);

// 7. Add View 5 (Developer Hub & APIs)
const view5Html = `
  <!-- VIEW 5: DEVELOPER HUB, APIS & WEBHOOKS -->
  <main id="view-developer" class="preview-view">
    <div class="admin-header-row">
      <div>
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
          <h1 class="admin-header-title" style="margin:0;">Developer Hub & OpenAPI Explorer</h1>
          <span class="badge badge-leased">OpenAPI 3.1 & SDKs</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-top:2px;">
          REST endpoints, client SDK generators, and webhook subscription management
        </p>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openModal('apiDocsModal')">📖 View Modal Quick Docs</button>
    </div>

    <!-- Developer Tabs -->
    <div class="tab-nav">
      <button class="tab-nav-btn active" id="dTabBtn-api" onclick="switchDevTab('api')">📖 Interactive OpenAPI Explorer</button>
      <button class="tab-nav-btn" id="dTabBtn-sdks" onclick="switchDevTab('sdks')">💻 Multi-Language SDKs</button>
      <button class="tab-nav-btn" id="dTabBtn-webhooks" onclick="switchDevTab('webhooks')">🪝 Webhooks & Dead-Letter Queue</button>
    </div>

    <!-- Sub-tab 1: OpenAPI Endpoint Runner -->
    <div id="dev-panel-api">
      <div class="api-endpoint-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="api-method-post">POST</span>
            <code style="font-size:0.95rem; font-weight:700;">/api/v1/messages/send</code>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('POST /api/v1/messages/send executed successfully!\\nHTTP 200 OK: {\\\"delivered\\\": true, \\\"msg_id\\\": \\\"msg_77810\\\"}')">▶ Execute Endpoint</button>
        </div>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:10px;">
          Dispatches an Ed25519-signed message payload across the Agent Mesh backbone.
        </p>
        <div class="code-snippet-box" style="font-size:0.78rem;">
{
  "to": "acme-corp:core-lead",
  "payload": {
    "action": "QUERY_BALANCE",
    "account_id": "ACC_9921"
  }
}
        </div>
      </div>

      <div class="api-endpoint-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="api-method-post">POST</span>
            <code style="font-size:0.95rem; font-weight:700;">/api/v1/inbox/lease</code>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('POST /api/v1/inbox/lease executed successfully!\\nLeased 1 message batch (300s TTL).')">▶ Execute Endpoint</button>
        </div>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:10px;">
          Pulls and leases socketless messages with atomic at-least-once timeout window.
        </p>
        <div class="code-snippet-box" style="font-size:0.78rem;">
{
  "batch_size": 5,
  "lease_seconds": 300
}
        </div>
      </div>
    </div>

    <!-- Sub-tab 2: Multi-Language SDKs -->
    <div id="dev-panel-sdks" style="display:none;">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Official Agent Mesh SDKs & Code Libraries</div>
            <div class="card-subtitle">Zero external dependencies. Native Ed25519 cryptographic signing.</div>
          </div>
        </div>

        <div class="code-tab-nav">
          <button class="code-tab-btn active" id="sdkTab-ts" onclick="switchSdkLang('ts')">TypeScript / Node.js</button>
          <button class="code-tab-btn" id="sdkTab-py" onclick="switchSdkLang('py')">Python SDK</button>
          <button class="code-tab-btn" id="sdkTab-go" onclick="switchSdkLang('go')">Go (Golang)</button>
        </div>

        <div class="code-snippet-box" id="sdkLangSnippetBox" style="min-height:220px;">
import { AgentMeshClient } from '@agent-mesh/sdk';

const client = new AgentMeshClient({
  endpoint: 'http://localhost:3000',
  identity: 'lane-claude',
  privateKey: process.env.AGENT_MESH_KEY
});

// Send signed payload
await client.send({
  to: 'acme-corp:core-lead',
  payload: { hello: 'world' }
});

// Lease socketless inbox with 300s TTL
const batch = await client.inbox.lease({ batchSize: 10, leaseSeconds: 300 });
for (const msg of batch.messages) {
  console.log('Processing:', msg.payload);
  await msg.ack(); // Atomically deletes from queue
}
        </div>
      </div>
    </div>

    <!-- Sub-tab 3: Webhooks & Dead-Letter Queue -->
    <div id="dev-panel-webhooks" style="display:none;">
      <div class="card" style="margin-bottom:20px;">
        <div class="card-header">
          <div>
            <div class="card-title">Subscribed Webhook Dispatch Endpoints</div>
            <div class="card-subtitle">Push events to external webhook targets with automatic retry and HMAC validation</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Creating new webhook subscription modal.')">+ New Webhook</button>
        </div>

        <div class="webhook-card">
          <div>
            <strong style="font-size:0.95rem;">https://api.acme-corp.com/hooks/mesh-events</strong>
            <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px;">
              Events: <code>message.delivered</code>, <code>key.revoked</code> · Retries: 3 · Status: <span class="badge badge-success">Active</span>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="alert('Test ping sent (HTTP 200 OK)')">⚡ Send Test Ping</button>
        </div>
      </div>
    </div>
  </main>`;

html = html.replace('  <!-- MODAL 1: Permanent Identity Teardown Modal', view5Html + '\n\n  <!-- MODAL 1: Permanent Identity Teardown Modal');

// 8. Add JS Handlers safely
const extraJs = `
    function switchHomeTab(tab) {
      document.querySelectorAll('#view-home .tab-nav-btn').forEach(b => b.classList.remove('active'));
      const btn = document.getElementById('hTabBtn-' + tab);
      if (btn) btn.classList.add('active');
      document.getElementById('home-panel-landing').style.display = tab === 'landing' ? 'block' : 'none';
      document.getElementById('home-panel-protocols').style.display = tab === 'protocols' ? 'block' : 'none';
    }

    function switchDevTab(tab) {
      document.querySelectorAll('#view-developer .tab-nav-btn').forEach(b => b.classList.remove('active'));
      const btn = document.getElementById('dTabBtn-' + tab);
      if (btn) btn.classList.add('active');
      document.getElementById('dev-panel-api').style.display = tab === 'api' ? 'block' : 'none';
      document.getElementById('dev-panel-sdks').style.display = tab === 'sdks' ? 'block' : 'none';
      document.getElementById('dev-panel-webhooks').style.display = tab === 'webhooks' ? 'block' : 'none';
    }

    function triggerSimulatedOutage() {
      const card = document.getElementById('regionCard-us-east');
      const badge = document.getElementById('regionBadge-us-east');
      const traffic = document.getElementById('trafficVal-us-east');
      const health = document.getElementById('healthVal-us-east');
      const banner = document.getElementById('failoverAlertBanner');

      if (card) {
        card.classList.remove('active');
        card.classList.add('degraded');
      }
      if (badge) {
        badge.className = 'badge badge-danger';
        badge.innerText = 'Outage / Failover Triggered';
      }
      if (traffic) traffic.innerText = '0 msg/s (Rerouted)';
      if (health) health.innerText = '0.00% (Down)';
      if (banner) banner.style.display = 'block';

      const eu = document.getElementById('trafficVal-eu-west');
      const ap = document.getElementById('trafficVal-ap-seoul');
      if (eu) eu.innerText = '15,150 msg/s (+6,200 failover)';
      if (ap) ap.innerText = '21,400 msg/s (+6,200 failover)';
    }

    const SDK_SNIPPETS = {
      ts: \`import { AgentMeshClient } from '@agent-mesh/sdk';

const client = new AgentMeshClient({
  endpoint: 'http://localhost:3000',
  identity: 'lane-claude',
  privateKey: process.env.AGENT_MESH_KEY
});

// Send signed payload
await client.send({
  to: 'acme-corp:core-lead',
  payload: { hello: 'world' }
});

// Lease socketless inbox with 300s TTL
const batch = await client.inbox.lease({ batchSize: 10, leaseSeconds: 300 });
for (const msg of batch.messages) {
  console.log('Processing:', msg.payload);
  await msg.ack(); // Atomically deletes from queue
}\`,
      py: \`from agent_mesh import AgentMeshClient
import os

client = AgentMeshClient(
    endpoint="http://localhost:3000",
    identity="lane-claude",
    private_key=os.getenv("AGENT_MESH_KEY")
)

# Dispatch signed payload
client.send(to="acme-corp:core-lead", payload={"hello": "world"})

# Lease socketless messages
batch = client.inbox.lease(batch_size=10, lease_seconds=300)
for msg in batch.messages:
    print(f"Processing: {msg.payload}")
    msg.ack()\`,
      go: \`package main

import (
    "fmt"
    "os"
    "github.com/agent-mesh/mesh-go/mesh"
)

func main() {
    client := mesh.NewClient("http://localhost:3000", "lane-claude", os.Getenv("AGENT_MESH_KEY"))
    
    // Dispatch
    client.Send("acme-corp:core-lead", map[string]string{"hello": "world"})
    
    // Lease
    batch, _ := client.Inbox.Lease(10, 300)
    for _, msg := range batch.Messages {
        fmt.Println("Processing:", msg.Payload)
        msg.Ack()
    }
}\`
    };

    function switchSdkLang(lang) {
      document.querySelectorAll('#dev-panel-sdks .code-tab-btn').forEach(b => b.classList.remove('active'));
      const btn = document.getElementById('sdkTab-' + lang);
      if (btn) btn.classList.add('active');
      const box = document.getElementById('sdkLangSnippetBox');
      if (box && SDK_SNIPPETS[lang]) {
        box.innerText = SDK_SNIPPETS[lang];
      }
    }
`;

html = html.replace('function switchView(view) {', extraJs + '\n    function switchView(view) {');

// Update switchView to handle view-developer
const switchViewOld = `      } else if (view === 'creator') {
        const btn = document.getElementById('navBtn-creator');
        if (btn) btn.classList.add('active');
        document.getElementById('view-creator').classList.add('active');
        if (bgLayer) bgLayer.classList.add('hidden');
        renderGalaxyTopologySVG();
        renderMinimapContent();
        initPanZoomEngine();
        initMinimapEvents();
        deselectAll();
        setTimeout(resetCanvasTransform, 30);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });`;

const switchViewNew = `      } else if (view === 'creator') {
        const btn = document.getElementById('navBtn-creator');
        if (btn) btn.classList.add('active');
        document.getElementById('view-creator').classList.add('active');
        if (bgLayer) bgLayer.classList.add('hidden');
        renderGalaxyTopologySVG();
        renderMinimapContent();
        initPanZoomEngine();
        initMinimapEvents();
        deselectAll();
        setTimeout(resetCanvasTransform, 30);
      } else if (view === 'developer') {
        const btn = document.getElementById('navBtn-developer');
        if (btn) btn.classList.add('active');
        document.getElementById('view-developer').classList.add('active');
        if (bgLayer) bgLayer.classList.add('hidden');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });`;
html = html.replace(switchViewOld, switchViewNew);

// Update switchPlatformTab
const pTabFnOld = `function switchPlatformTab(tab) {
      document.querySelectorAll('#view-platform .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`pTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('platform-panel-gateways').style.display = tab === 'gateways' ? 'block' : 'none';
      document.getElementById('platform-panel-tenants').style.display = tab === 'tenants' ? 'block' : 'none';
      document.getElementById('platform-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }`;

const pTabFnNew = `function switchPlatformTab(tab) {
      document.querySelectorAll('#view-platform .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`pTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('platform-panel-gateways').style.display = tab === 'gateways' ? 'block' : 'none';
      document.getElementById('platform-panel-tenants').style.display = tab === 'tenants' ? 'block' : 'none';
      document.getElementById('platform-panel-telemetry').style.display = tab === 'telemetry' ? 'block' : 'none';
      document.getElementById('platform-panel-failover').style.display = tab === 'failover' ? 'block' : 'none';
      document.getElementById('platform-panel-ratelimit').style.display = tab === 'ratelimit' ? 'block' : 'none';
      document.getElementById('platform-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }`;
html = html.replace(pTabFnOld, pTabFnNew);

// Update switchTenantTab
const tTabFnOld = `function switchTenantTab(tab) {
      document.querySelectorAll('#view-tenant .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`tTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('tenant-panel-keys').style.display = tab === 'keys' ? 'block' : 'none';
      document.getElementById('tenant-panel-groups').style.display = tab === 'groups' ? 'block' : 'none';
      document.getElementById('tenant-panel-pairing').style.display = tab === 'pairing' ? 'block' : 'none';
      document.getElementById('tenant-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }`;

const tTabFnNew = `function switchTenantTab(tab) {
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
html = html.replace(tTabFnOld, tTabFnNew);

// Update switchOperatorTab
const cTabFnOld = `function switchOperatorTab(tab) {
      document.querySelectorAll('#view-creator .tab-nav-btn').forEach(t => t.classList.remove('active'));
      if (tab === 'topology') {
        document.getElementById('tabBtnTopology').classList.add('active');
        document.getElementById('operator-panel-topology').style.display = 'block';
        document.getElementById('operator-panel-playground').style.display = 'none';
        applyCanvasTransform();
      } else {
        document.getElementById('tabBtnPlayground').classList.add('active');
        document.getElementById('operator-panel-topology').style.display = 'none';
        document.getElementById('operator-panel-playground').style.display = 'block';
      }
    }`;

const cTabFnNew = `function switchOperatorTab(tab) {
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
html = html.replace(cTabFnOld, cTabFnNew);

// Update I18N
html = html.replace('nav_creator: "4. 에이전트 운영 & 토폴로지",', 'nav_creator: "4. 에이전트 운영 & 스튜디오",\n        nav_developer: "5. 개발자 허브 & API",');
html = html.replace('nav_creator: "4. Agent Operations",', 'nav_creator: "4. Agent Operations & Studio",\n        nav_developer: "5. Developer Hub & APIs",');

writeFileSync(filePath, html, 'utf-8');
console.log('Build completed safely!');
