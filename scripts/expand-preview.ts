import { readFileSync, writeFileSync } from 'fs';

const filePath = '/Users/lyong/work/ai/agent-mesh-platform/preview/index.html';
let html = readFileSync(filePath, 'utf-8');

// 1. Extra CSS
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
`;

if (!html.includes('.telemetry-grid')) {
  html = html.replace('</style>', extraCss + '\n</style>');
}

// 2. Navigation Header (5 Suites)
const navRegex = /<div class="preview-nav">[\s\S]*?<\/div>/;
const newNav = `<div class="preview-nav">
        <button class="preview-btn active" id="navBtn-home" onclick="switchView('home')" data-i18n="nav_home">1. Home & Protocols</button>
        <button class="preview-btn" id="navBtn-platform" onclick="switchView('platform')" data-i18n="nav_platform">2. Platform Operator</button>
        <button class="preview-btn" id="navBtn-tenant" onclick="switchView('tenant')" data-i18n="nav_tenant">3. Tenant Admin (Acme Corp)</button>
        <button class="preview-btn" id="navBtn-creator" onclick="switchView('creator')" data-i18n="nav_creator">4. Agent Operations & Studio</button>
        <button class="preview-btn" id="navBtn-developer" onclick="switchView('developer')" data-i18n="nav_developer">5. Developer Hub & APIs</button>
      </div>`;
html = html.replace(navRegex, newNav);

// 3. Update Suite 1: Home & Protocols with Sub-tabs
const suite1OldHeroWrap = /<!-- VIEW 1: HOME & MULTI-TIER LOGIN -->[\s\S]*?<\/main>/;

// We preserve the 3-agent constellation exactly and wrap it in sub-tabs
const suite1New = `<!-- VIEW 1: HOME, PROTOCOLS & MULTI-TIER LOGIN -->
  <main id="view-home" class="preview-view active">
    <!-- Home Subtabs -->
    <div class="tab-nav" style="margin-bottom:24px;">
      <button class="tab-nav-btn active" id="hTabBtn-landing" onclick="switchHomeTab('landing')">🌟 Home & Agent Triad</button>
      <button class="tab-nav-btn" id="hTabBtn-protocols" onclick="switchHomeTab('protocols')">📐 Security Architecture & Protocols</button>
    </div>

    <!-- Sub-panel 1: Landing, Constellation & Logins -->
    <div id="home-panel-landing">
      <section class="home-hero-wrap">
        <!-- Centered Primary Hero Content -->
        <div class="hero-main-content">
          <!-- Title & Constellation Relative Anchor Group -->
          <div class="hero-title-anchor-wrap">
            <!-- Ambient Decorative Background 3-Agent Triad (Locked relative to AGENT MESH) -->
            <div class="hero-agents-constellation" aria-label="Interactive Autonomous Agent Triad">
              <svg class="constellation-svg" viewBox="0 0 230 210">
                <defs>
                  <linearGradient id="lineGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#3B82F6" stop-opacity="0.9" />
                    <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.9" />
                  </linearGradient>
                  <linearGradient id="lineGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#8B5CF6" stop-opacity="0.9" />
                    <stop offset="100%" stop-color="#10B981" stop-opacity="0.9" />
                  </linearGradient>
                  <linearGradient id="lineGrad3" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#10B981" stop-opacity="0.9" />
                    <stop offset="100%" stop-color="#3B82F6" stop-opacity="0.9" />
                  </linearGradient>
                  <radialGradient id="meshCenterGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#3B82F6" stop-opacity="0.12" />
                    <stop offset="100%" stop-color="#3B82F6" stop-opacity="0" />
                  </radialGradient>
                </defs>

                <polygon points="40,32 170,56 102,148" fill="url(#meshCenterGlow)" />
                <line class="constellation-line" x1="40" y1="32" x2="170" y2="56" stroke="url(#lineGrad1)" />
                <line class="constellation-line" x1="170" y1="56" x2="102" y2="148" stroke="url(#lineGrad2)" />
                <line class="constellation-line" x1="102" y1="148" x2="40" y2="32" stroke="url(#lineGrad3)" />

                <circle class="mesh-packet packet-1" r="3.0" fill="#3B82F6" />
                <circle class="mesh-packet packet-2" r="3.0" fill="#8B5CF6" />
                <circle class="mesh-packet packet-3" r="3.0" fill="#10B981" />
              </svg>

              <!-- Agent 1: Top-Left (Fin둥이 - Yellow Shiba Financial Lead) -->
              <div class="hero-agent-node agent-node-1" title="Financial Operations Agent: Fin둥이">
                <div class="agent-glow-ring ring-blue"></div>
                <div class="agent-avatar-frame">
                  <img src="/assets/agent-fin.png" alt="Fin둥이 Agent" class="agent-avatar-img" />
                </div>
                <div class="agent-node-badge badge-blue">
                  <span class="live-dot"></span> Fin둥이
                </div>
              </div>

              <!-- Agent 2: Top-Right (아름이 - AI Assistant) -->
              <div class="hero-agent-node agent-node-2" title="Executive AI Assistant: 아름이">
                <div class="agent-glow-ring ring-purple"></div>
                <div class="agent-avatar-frame">
                  <img src="/assets/agent-assistant.png" alt="아름이 Agent" class="agent-avatar-img" />
                </div>
                <div class="agent-node-badge badge-purple">
                  <span class="live-dot" style="background:#8B5CF6;"></span> 아름이
                </div>
              </div>

              <!-- Agent 3: Bottom-Center (Fin자 - Grey Support Puppy) -->
              <div class="hero-agent-node agent-node-3" title="Customer Support Agent: Fin자">
                <div class="agent-glow-ring ring-emerald"></div>
                <div class="agent-avatar-frame">
                  <img src="/assets/agent-grey.png" alt="Fin자 Agent" class="agent-avatar-img" />
                </div>
                <div class="agent-node-badge badge-emerald">
                  <span class="live-dot" style="background:#10B981;"></span> Fin자
                </div>
              </div>
            </div>

            <!-- Primary Platform Title -->
            <h1 class="hero-title">AGENT MESH</h1>
          </div>

          <div class="hero-eyebrow" data-i18n="hero_eyebrow">The Autonomous Agent Fabric</div>
          <p class="hero-tagline" data-i18n="hero_tagline">
            Next-Gen Multi-Agent Messaging Backbone & Cryptographic Trust Fabric
          </p>
          <p class="hero-desc" data-i18n="hero_desc">
            Enabling intermittent and serverless AI agents to communicate with end-to-end cryptographic verification, zero persistent daemons, and immutable compliance auditing.
          </p>
        </div>
      </section>

      <!-- 3-Tier Multi-Role Login Selection -->
      <div class="login-grid">
        <!-- Option A: Agent Operator / Developer OAuth -->
        <div class="login-box login-box-highlight">
          <span class="login-box-badge" data-i18n="login_oauth_badge">Recommended</span>
          <div>
            <div class="login-box-header">
              <h2 class="login-box-title" data-i18n="login_oauth_title">Agent Operator</h2>
              <p class="login-box-subtitle" data-i18n="login_oauth_subtitle">Developer & Agent Creator Portal</p>
            </div>
            <p class="login-box-desc" data-i18n="login_oauth_desc">
              Manage your personal agent keys, test message routing in live playground, and explore topology.
            </p>
          </div>
          <button class="btn btn-primary" style="width:100%;" onclick="switchView('creator')" data-i18n="login_oauth_btn">
            Sign In with GitHub OAuth →
          </button>
        </div>

        <!-- Option B: Tenant Admin SSO (Acme Corp) -->
        <div class="login-box" style="border-color:#BFDBFE; background:#F8FAFC;">
          <span class="login-box-badge" style="background:#0284C7;">Tenant SSO</span>
          <div>
            <div class="login-box-header">
              <h2 class="login-box-title" data-i18n="login_tenant_title">Tenant Admin</h2>
              <p class="login-box-subtitle" data-i18n="login_tenant_subtitle">Company Admin (Acme Corp)</p>
            </div>
            <div class="form-group">
              <label class="form-label" data-i18n="form_tenant_id">Tenant ID</label>
              <input type="text" class="form-input" value="acme-corp" readonly style="background:#F1F5F9; font-weight:600;">
            </div>
            <div class="form-group">
              <label class="form-label" data-i18n="form_admin_user">Admin Identity</label>
              <input type="text" class="form-input" value="alice_admin" id="tenantAdminUser">
            </div>
          </div>
          <button class="btn btn-primary" style="width:100%; background:#0284C7;" onclick="switchView('tenant')" data-i18n="login_tenant_btn">
            Sign In to Acme Corp →
          </button>
        </div>

        <!-- Option C: Platform Operator Master Key -->
        <div class="login-box">
          <div>
            <div class="login-box-header">
              <h2 class="login-box-title" data-i18n="login_admin_title">Platform Operator</h2>
              <p class="login-box-subtitle" data-i18n="login_admin_subtitle">Global mesh infrastructure & gateways</p>
            </div>
            <div class="form-group">
              <label class="form-label" data-i18n="form_master_key">Operator Master Key</label>
              <input type="password" class="form-input" value="adm_live_k9x2_master_fabric_mesh" id="loginPlatformKey">
            </div>
            <p style="font-size:0.78rem; color:var(--text-muted); line-height:1.4; margin-bottom:12px;">
              🔒 <em>Enforces strict message body privacy segregation (Metadata audits only).</em>
            </p>
          </div>
          <button class="btn btn-primary" style="width:100%;" onclick="switchView('platform')" data-i18n="login_admin_btn">
            Sign In as Platform Operator →
          </button>
        </div>
      </div>

      <!-- Features Section -->
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
              Guarantees at-least-once delivery for serverless & intermittent agent runtimes without maintaining socket connections.
            </p>
            <div class="protocol-step-box">
              <strong>Step 1: Available</strong><br>
              Message buffered in SQLite queue.
            </div>
            <div class="protocol-step-box" style="border-color:#F59E0B; background:#FFFDF5;">
              <strong>Step 2: Leased (300s TTL)</strong><br>
              Worker claims batch. Countdown locks message.
            </div>
            <div class="protocol-step-box" style="border-color:#10B981; background:#F0FDF4;">
              <strong>Step 3: ACK (Delete) / NACK</strong><br>
              Deleted on success; Reverts to Available if worker crashes.
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

html = html.replace(suite1OldHeroWrap, suite1New);

// 4. Update Platform Operator with 4th Subtab (Cluster Node & Telemetry Monitor)
const pTabsRegex = /<div class="tab-nav">[\s\S]*?<\/div>[\s\S]*?<!-- Tab 1: Cross-Tenant Gateways & Highways -->/;
const newPTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="pTabBtn-gateways" onclick="switchPlatformTab('gateways')" data-i18n="tab_gateways">🌐 Cross-Tenant Gateways & Highways</button>
      <button class="tab-nav-btn" id="pTabBtn-tenants" onclick="switchPlatformTab('tenants')" data-i18n="tab_tenants">🏢 Tenant Provisioning & Quotas</button>
      <button class="tab-nav-btn" id="pTabBtn-telemetry" onclick="switchPlatformTab('telemetry')">🖥️ Cluster Nodes & Telemetry</button>
      <button class="tab-nav-btn" id="pTabBtn-audits" onclick="switchPlatformTab('audits')" data-i18n="tab_meta_audits">📊 Global Metadata Audits (Zero Content Leak)</button>
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

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Regional Gateway Node Fleet Status</div>
            <div class="card-subtitle">Real-time health telemetry across 10 cluster swarms</div>
          </div>
          <span class="badge badge-success">All 10 Clusters Healthy</span>
        </div>
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%; border-collapse:collapse; font-size:0.875rem;">
            <thead>
              <tr style="text-align:left; background:var(--bg-surface-sub); border-bottom:1px solid var(--border-default);">
                <th style="padding:10px 14px;">Gateway Node ID</th>
                <th style="padding:10px 14px;">Cluster Swarm</th>
                <th style="padding:10px 14px;">Nodes Attached</th>
                <th style="padding:10px 14px;">Avg Latency</th>
                <th style="padding:10px 14px;">Egress Status</th>
              </tr>
            </thead>
            <tbody>
              <tr style="border-bottom:1px solid var(--border-default);">
                <td style="padding:10px 14px; font-family:var(--font-mono); font-weight:700;">gw-core</td>
                <td style="padding:10px 14px;">Core Platform Hub</td>
                <td style="padding:10px 14px;">5 agents</td>
                <td style="padding:10px 14px; color:#059669; font-weight:600;">0.8 ms</td>
                <td style="padding:10px 14px;"><span class="badge badge-success">Online (Leader: Fin둥이)</span></td>
              </tr>
              <tr style="border-bottom:1px solid var(--border-default);">
                <td style="padding:10px 14px; font-family:var(--font-mono); font-weight:700;">gw-research</td>
                <td style="padding:10px 14px;">Research & Reasoning Swarm</td>
                <td style="padding:10px 14px;">30 agents</td>
                <td style="padding:10px 14px; color:#059669; font-weight:600;">1.4 ms</td>
                <td style="padding:10px 14px;"><span class="badge badge-success">Online</span></td>
              </tr>
              <tr style="border-bottom:1px solid var(--border-default);">
                <td style="padding:10px 14px; font-family:var(--font-mono); font-weight:700;">gw-delivery</td>
                <td style="padding:10px 14px;">Execution & Delivery Mesh</td>
                <td style="padding:10px 14px;">15 agents</td>
                <td style="padding:10px 14px; color:#059669; font-weight:600;">1.1 ms</td>
                <td style="padding:10px 14px;"><span class="badge badge-success">Online</span></td>
              </tr>
              <tr style="border-bottom:1px solid var(--border-default);">
                <td style="padding:10px 14px; font-family:var(--font-mono); font-weight:700;">gw-edge</td>
                <td style="padding:10px 14px;">Edge & Sensor Fleet</td>
                <td style="padding:10px 14px;">22 agents</td>
                <td style="padding:10px 14px; color:#059669; font-weight:600;">2.6 ms</td>
                <td style="padding:10px 14px;"><span class="badge badge-leased">Socketless Active</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Tab 1: Cross-Tenant Gateways & Highways -->`;
html = html.replace(pTabsRegex, newPTabs);

// 5. Update Tenant Admin with Overview & RBAC Tabs
const tTabsRegex = /<div class="tab-nav">[\s\S]*?<\/div>[\s\S]*?<!-- Tab 1: Key Approvals/;
const newTTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tTabBtn-overview" onclick="switchTenantTab('overview')">📈 Executive Overview</button>
      <button class="tab-nav-btn" id="tTabBtn-keys" onclick="switchTenantTab('keys')">🔑 Key Approvals (3)</button>
      <button class="tab-nav-btn" id="tTabBtn-groups" onclick="switchTenantTab('groups')">📁 Group Governance & Send Policies</button>
      <button class="tab-nav-btn" id="tTabBtn-pairing" onclick="switchTenantTab('pairing')">⚡ Pairing Code (RFC 8628)</button>
      <button class="tab-nav-btn" id="tTabBtn-audits" onclick="switchTenantTab('audits')">📋 Participant Audit Trail (with Content)</button>
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

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Acme Corp Autonomous Fleet Summary</div>
            <div class="card-subtitle">Cluster allocation and group lead dispatch status</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="switchTenantTab('groups')">Configure All Groups →</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:16px;">
          <div class="policy-rule-card">
            <strong style="font-size:1rem;">Core Platform Hub</strong>
            <div style="font-size:0.82rem; color:var(--text-secondary); margin:4px 0 8px;">
              • Designated Lead: 🐶 <strong>Fin둥이 (core-lead)</strong><br>
              • Managed Agents: 5 nodes<br>
              • Ingress Health: 100% Verified
            </div>
            <span class="badge badge-success">Online & Audited</span>
          </div>
          <div class="policy-rule-card">
            <strong style="font-size:1rem;">Research Swarm</strong>
            <div style="font-size:0.82rem; color:var(--text-secondary); margin:4px 0 8px;">
              • Designated Lead: 🤖 <strong>research-lead</strong><br>
              • Managed Agents: 30 nodes<br>
              • Cross-Tenant Egress: Nova BioTech
            </div>
            <span class="badge badge-success">Online & Audited</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 6 (New): Organization Settings & Member RBAC -->
    <div id="tenant-panel-rbac" style="display:none;">
      <div class="card" style="margin-bottom:20px;">
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
              <th style="padding:10px 14px;">Last Login</th>
              <th style="padding:10px 14px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid var(--border-default);">
              <td style="padding:12px 14px; font-weight:700;">alice_admin (You)</td>
              <td style="padding:12px 14px;"><span class="badge badge-leased">Super Admin</span></td>
              <td style="padding:12px 14px; font-size:0.8rem; color:var(--text-secondary);">key.approve, agent.teardown, audit.read_content, policy.send_restrict</td>
              <td style="padding:12px 14px; color:#059669;">Just now</td>
              <td style="padding:12px 14px;"><button class="btn btn-secondary btn-sm" onclick="alert('Editing permissions for alice_admin')">Edit Grants</button></td>
            </tr>
            <tr style="border-bottom:1px solid var(--border-default);">
              <td style="padding:12px 14px; font-weight:700;">bob_compliance</td>
              <td style="padding:12px 14px;"><span class="badge badge-warning">Compliance Auditor</span></td>
              <td style="padding:12px 14px; font-size:0.8rem; color:var(--text-secondary);">audit.read_content, audit.export</td>
              <td style="padding:12px 14px;">2 hours ago</td>
              <td style="padding:12px 14px;"><button class="btn btn-secondary btn-sm" onclick="alert('Editing permissions for bob_compliance')">Edit Grants</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 2: Key Approvals`;
html = html.replace(tTabsRegex, newTTabs);

// 6. Update Suite 4: Agent Operations with WebSocket Frame Trace Tab
const cTabsRegex = /<div class="tab-nav">[\s\S]*?id="tabBtnPlayground"[\s\S]*?<\/div>[\s\S]*?<!-- TAB 1: 10 CLUSTERS TOPOLOGY GRAPH/;
const newCTabs = `<div class="tab-nav">
      <button class="tab-nav-btn active" id="tabBtnTopology" onclick="switchOperatorTab('topology')" data-i18n="tab_topology">🌐 Agent Topology Graph</button>
      <button class="tab-nav-btn" id="tabBtnPlayground" onclick="switchOperatorTab('playground')" data-i18n="tab_playground">💬 Message Playground</button>
      <button class="tab-nav-btn" id="tabBtnTrace" onclick="switchOperatorTab('trace')">🔬 WebSocket Frame & Trace Log</button>
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
          <div class="trace-row">
            <span class="trace-time">12:51:02.340</span>
            <span class="trace-badge-ack">PULL LEASE</span>
            <div>
              <strong>INBOX_LEASE:</strong> Worker: <code>fin-helper</code> leased 1 message with 300s TTL window.
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 1: 10 CLUSTERS TOPOLOGY GRAPH`;
html = html.replace(cTabsRegex, newCTabs);

// 7. Add Suite 5: Developer Hub & APIs (#view-developer)
const suite5Html = `
  <!-- VIEW 5 (New): DEVELOPER HUB, APIS & WEBHOOKS -->
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
      <!-- Endpoint 1 -->
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

      <!-- Endpoint 2 -->
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

      <!-- Endpoint 3 -->
      <div class="api-endpoint-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="api-method-delete">DELETE</span>
            <code style="font-size:0.95rem; font-weight:700;">/api/v1/inbox/ack</code>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('DELETE /api/v1/inbox/ack executed successfully!\\nMessage acknowledged and removed from queue.')">▶ Execute Endpoint</button>
        </div>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:10px;">
          Permanently acknowledges and consumes a previously leased message.
        </p>
        <div class="code-snippet-box" style="font-size:0.78rem;">
{
  "message_id": "msg_948192"
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
          <button class="btn btn-secondary btn-sm" onclick="alert('Test ping sent to https://api.acme-corp.com/hooks/mesh-events (HTTP 200 OK)')">⚡ Send Test Ping</button>
        </div>

        <div class="webhook-card">
          <div>
            <strong style="font-size:0.95rem;">https://discord.com/api/webhooks/security-alerts</strong>
            <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px;">
              Events: <code>audit.read_content</code>, <code>agent.teardown</code> · Retries: 5 · Status: <span class="badge badge-success">Active</span>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="alert('Test ping sent to Discord webhook (HTTP 204 No Content)')">⚡ Send Test Ping</button>
        </div>
      </div>

      <!-- Dead Letter Queue DLQ -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Dead-Letter Queue (DLQ) Inspector</div>
            <div class="card-subtitle">Undeliverable payloads retained after maximum retries</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('All 2 DLQ events re-queued for delivery.')">🔄 Retry All DLQ Events</button>
        </div>
        <div style="font-size:0.85rem; color:var(--text-secondary); padding:10px 0;">
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-default);">
            <div>
              <strong>evt_dlq_842</strong> — Target: <code>acme-corp:offline-agent</code> (503 Service Unavailable)
            </div>
            <button class="btn btn-secondary btn-sm" style="padding:2px 8px; font-size:0.75rem;" onclick="this.closest('div').remove(); alert('DLQ item re-queued.');">Retry</button>
          </div>
          <div style="display:flex; justify-content:space-between; padding:8px 0;">
            <div>
              <strong>evt_dlq_843</strong> — Target: <code>nova-bio:vision-agent-4</code> (Connection Timeout 10s)
            </div>
            <button class="btn btn-secondary btn-sm" style="padding:2px 8px; font-size:0.75rem;" onclick="this.closest('div').remove(); alert('DLQ item re-queued.');">Retry</button>
          </div>
        </div>
      </div>
    </div>
  </main>
`;

if (!html.includes('id="view-developer"')) {
  html = html.replace('<!-- MODAL 1:', suite5Html + '\n  <!-- MODAL 1:');
}

// 8. Update Javascript Handlers for new views & sub-tabs
const jsSwitcherCode = `
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

if (!html.includes('function switchHomeTab')) {
  html = html.replace('function switchView(view)', jsSwitcherCode + '\n    function switchView(view)');
}

// Update switchView in JS to support developer view
const switchViewOld = `function switchView(view) {
      currentView = view;
      document.querySelectorAll('.preview-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.preview-view').forEach(v => v.classList.remove('active'));

      const bgLayer = document.getElementById('landingBgLayer');

      if (view === 'home') {
        const btn = document.getElementById('navBtn-home');
        if (btn) btn.classList.add('active');
        document.getElementById('view-home').classList.add('active');
        if (bgLayer) bgLayer.classList.remove('hidden');
      } else if (view === 'platform') {
        const btn = document.getElementById('navBtn-platform');
        if (btn) btn.classList.add('active');
        document.getElementById('view-platform').classList.add('active');
        if (bgLayer) bgLayer.classList.add('hidden');
      } else if (view === 'tenant') {
        const btn = document.getElementById('navBtn-tenant');
        if (btn) btn.classList.add('active');
        document.getElementById('view-tenant').classList.add('active');
        if (bgLayer) bgLayer.classList.add('hidden');
      } else if (view === 'creator') {
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }`;

const switchViewNew = `function switchView(view) {
      currentView = view;
      document.querySelectorAll('.preview-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.preview-view').forEach(v => v.classList.remove('active'));

      const bgLayer = document.getElementById('landingBgLayer');

      if (view === 'home') {
        const btn = document.getElementById('navBtn-home');
        if (btn) btn.classList.add('active');
        document.getElementById('view-home').classList.add('active');
        if (bgLayer) bgLayer.classList.remove('hidden');
      } else if (view === 'platform') {
        const btn = document.getElementById('navBtn-platform');
        if (btn) btn.classList.add('active');
        document.getElementById('view-platform').classList.add('active');
        if (bgLayer) bgLayer.classList.add('hidden');
      } else if (view === 'tenant') {
        const btn = document.getElementById('navBtn-tenant');
        if (btn) btn.classList.add('active');
        document.getElementById('view-tenant').classList.add('active');
        if (bgLayer) bgLayer.classList.add('hidden');
      } else if (view === 'creator') {
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }`;

html = html.replace(switchViewOld, switchViewNew);

// Update switchPlatformTab, switchTenantTab, switchOperatorTab
const pTabUpdateOld = `function switchPlatformTab(tab) {
      document.querySelectorAll('#view-platform .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`pTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('platform-panel-gateways').style.display = tab === 'gateways' ? 'block' : 'none';
      document.getElementById('platform-panel-tenants').style.display = tab === 'tenants' ? 'block' : 'none';
      document.getElementById('platform-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }`;

const pTabUpdateNew = `function switchPlatformTab(tab) {
      document.querySelectorAll('#view-platform .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`pTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('platform-panel-gateways').style.display = tab === 'gateways' ? 'block' : 'none';
      document.getElementById('platform-panel-tenants').style.display = tab === 'tenants' ? 'block' : 'none';
      document.getElementById('platform-panel-telemetry').style.display = tab === 'telemetry' ? 'block' : 'none';
      document.getElementById('platform-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }`;

html = html.replace(pTabUpdateOld, pTabUpdateNew);

const tTabUpdateOld = `function switchTenantTab(tab) {
      document.querySelectorAll('#view-tenant .tab-nav-btn').forEach(t => t.classList.remove('active'));
      const btn = document.getElementById(\`tTabBtn-\${tab}\`);
      if (btn) btn.classList.add('active');

      document.getElementById('tenant-panel-keys').style.display = tab === 'keys' ? 'block' : 'none';
      document.getElementById('tenant-panel-groups').style.display = tab === 'groups' ? 'block' : 'none';
      document.getElementById('tenant-panel-pairing').style.display = tab === 'pairing' ? 'block' : 'none';
      document.getElementById('tenant-panel-audits').style.display = tab === 'audits' ? 'block' : 'none';
    }`;

const tTabUpdateNew = `function switchTenantTab(tab) {
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

html = html.replace(tTabUpdateOld, tTabUpdateNew);

const cTabUpdateOld = `function switchOperatorTab(tab) {
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

const cTabUpdateNew = `function switchOperatorTab(tab) {
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

html = html.replace(cTabUpdateOld, cTabUpdateNew);

// Update Translations
html = html.replace('nav_creator: "4. 에이전트 운영 & 토폴로지",', 'nav_creator: "4. 에이전트 운영 & 스튜디오",\n        nav_developer: "5. 개발자 허브 & API",');
html = html.replace('nav_creator: "4. Agent Operations",', 'nav_creator: "4. Agent Operations & Studio",\n        nav_developer: "5. Developer Hub & APIs",');

writeFileSync(filePath, html, 'utf-8');
console.log('Successfully expanded all 5 suites and 15+ sub-pages in preview/index.html!');
