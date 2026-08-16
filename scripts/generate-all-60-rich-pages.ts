import { writeFileSync } from 'fs';
import { renderRichPage } from './page-layout-builder';

interface ScreenSpec {
  num: number;
  path: string;
  url: string;
  suite: 'public' | 'platform' | 'tenant' | 'creator' | 'dev';
  suiteTitle: string;
  role: string;
  title: string;
  subtitle: string;
  html: string;
}

const ALL_SCREENS: ScreenSpec[] = [
  // --- Suite 1: Public (8) ---
  {
    num: 1,
    path: 'preview/public/index.html',
    url: '/public/index.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Public / All Users',
    title: 'Main Landing & Agent Constellation',
    subtitle: 'The Next-Gen Multi-Agent Messaging Backbone & Cryptographic Trust Fabric',
    html: `
      <div class="card" style="text-align:center; padding:50px 20px; background:linear-gradient(180deg, #FFFFFF 0%, #F8FAFC 100%);">
        <h2 style="font-size:2.4rem; font-weight:900; letter-spacing:-0.03em; color:var(--text-primary); margin-bottom:12px;">AGENT MESH</h2>
        <div class="badge badge-leased" style="font-size:0.85rem; margin-bottom:16px;">The Autonomous Agent Fabric (v0.3 Specification)</div>
        <p style="font-size:1.05rem; color:var(--text-secondary); max-width:680px; margin:0 auto 28px; line-height:1.6;">
          Enabling intermittent and serverless AI agents to communicate with end-to-end cryptographic verification, zero persistent daemons, and immutable compliance auditing.
        </p>
        <div style="display:flex; justify-content:center; gap:14px; flex-wrap:wrap;">
          <a href="/public/login-operator.html" class="btn btn-primary" style="padding:10px 22px; font-size:0.95rem;">Sign In with GitHub OAuth →</a>
          <a href="/public/security-architecture.html" class="btn btn-secondary" style="padding:10px 22px; font-size:0.95rem;">Security Architecture 📐</a>
          <a href="/creator/topology.html" class="btn btn-secondary" style="padding:10px 22px; font-size:0.95rem;">Live 139-Node Topology 🌐</a>
        </div>
      </div>
    `
  },
  {
    num: 2,
    path: 'preview/public/security-architecture.html',
    url: '/public/security-architecture.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Public / Security Team',
    title: 'Security Architecture & Protocols',
    subtitle: 'Zero-infrastructure, Ed25519-verified multi-tenant cryptographic pipeline (SPEC v0.3)',
    html: `
      <div class="protocol-grid">
        <div class="protocol-card">
          <div style="font-size:1.4rem; margin-bottom:8px;">⏱️</div>
          <strong style="font-size:1.05rem;">1. Socketless Lease State Machine</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">Guarantees at-least-once delivery for serverless & intermittent agent runtimes without persistent sockets.</p>
          <div class="protocol-step-box"><strong>Step 1: Available</strong><br>Message buffered in SQLite queue pool.</div>
          <div class="protocol-step-box" style="border-color:#F59E0B; background:#FFFDF5;"><strong>Step 2: Leased (300s TTL)</strong><br>Worker claims batch. Countdown locks message.</div>
          <div class="protocol-step-box" style="border-color:#10B981; background:#F0FDF4;"><strong>Step 3: ACK (Delete) / NACK</strong><br>Deleted on success; Reverts to Available on crash.</div>
        </div>
        <div class="protocol-card">
          <div style="font-size:1.4rem; margin-bottom:8px;">🔑</div>
          <strong style="font-size:1.05rem;">2. Cryptographic Attestation Pipeline</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">Dual-layer verification: End-to-end author signature + Proxy gateway transmission token.</p>
          <div class="protocol-step-box"><code>from: acme-corp:core-lead</code><br>Ed25519 signature over full payload body.</div>
          <div class="protocol-step-box"><code>sent_by: alice_admin</code><br>Bearer session proof authenticated in browser.</div>
          <div class="protocol-step-box" style="border-color:#3B82F6; background:#EFF6FF;"><strong>50-char SHA-256 Fingerprint</strong><br>Atomic approval prevents identity collision.</div>
        </div>
        <div class="protocol-card">
          <div style="font-size:1.4rem; margin-bottom:8px;">🛡️</div>
          <strong style="font-size:1.05rem;">3. Privacy Boundary Segregation</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">Role-based zero-trust isolation between Platform Operators and Tenant Administrators.</p>
          <div class="protocol-step-box" style="border-color:#3B82F6; background:#EFF6FF;"><strong>Platform Operator:</strong><br>Zero message body access. Transit telemetry only.</div>
          <div class="protocol-step-box" style="border-color:#F59E0B; background:#FFFDF5;"><strong>Tenant Admin:</strong><br>Content inspection logged in <code>audit_read_events</code>.</div>
          <div class="protocol-step-box"><strong>Egress ACL Enforcement:</strong><br>Default Deny cross-tenant boundary barrier.</div>
        </div>
      </div>
    `
  },
  {
    num: 3,
    path: 'preview/public/lease-state-machine.html',
    url: '/public/lease-state-machine.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Public / Developers',
    title: 'Socketless Lease State Machine',
    subtitle: 'Interactive simulation of 300s TTL atomic lease locking, deletion, and crash recovery',
    html: `
      <div class="card">
        <div class="card-header"><div><div class="card-title">Live State Transition Simulator</div><div class="card-subtitle">Test how messages transition across Available, Leased, and Acknowledged states</div></div><button class="btn btn-primary btn-sm" onclick="alert('Simulated lease acquisition (300s TTL started).')">📥 Poll & Lease Message</button></div>
        <div style="display:flex; gap:16px; margin:20px 0;">
          <div style="flex:1; background:var(--bg-surface-sub); padding:16px; border-radius:var(--radius-md); border:1px solid var(--border-default);"><strong style="font-size:1rem; color:var(--text-primary);">1. Available Pool (3)</strong><p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Messages awaiting worker acquisition.</p><div class="code-snippet-box" style="margin-top:10px;">msg_94210 (140B)<br>msg_94211 (210B)<br>msg_94212 (512B)</div></div>
          <div style="flex:1; background:#FFFDF5; border:1px solid #F59E0B; padding:16px; border-radius:var(--radius-md);"><strong style="font-size:1rem; color:#92400E;">2. Leased Active (2)</strong><p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Locked with in-flight countdown timer.</p><div class="code-snippet-box" style="margin-top:10px; color:#FDE68A;">msg_892147 · 274s remaining<br>msg_892148 · 289s remaining</div></div>
          <div style="flex:1; background:#F0FDF4; border:1px solid #10B981; padding:16px; border-radius:var(--radius-md);"><strong style="font-size:1rem; color:#065F46;">3. Consumed / Deleted (12)</strong><p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Atomically acknowledged via DELETE ACK.</p><div class="code-snippet-box" style="margin-top:10px; color:#A7F3D0;">msg_892146 (ACK ✓)<br>msg_892145 (ACK ✓)</div></div>
        </div>
      </div>
    `
  },
  {
    num: 4,
    path: 'preview/public/login-operator.html',
    url: '/public/login-operator.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Agent Operator',
    title: 'Agent Operator Login Portal',
    subtitle: 'GitHub OAuth single sign-on for AI agent developers and creators',
    html: `
      <div class="card" style="max-width:500px; margin:40px auto; padding:32px; box-shadow:var(--shadow-lg);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;"><h2 style="font-size:1.3rem; font-weight:800;">Agent Operator Sign In</h2><span class="badge badge-success">GitHub OAuth</span></div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:20px; line-height:1.6;">Authenticate with your GitHub developer identity to manage personal agent public keys and test live routing in the messaging playground.</p>
        <a href="/creator/index.html" class="btn btn-primary" style="width:100%; padding:10px; font-size:0.95rem;">Continue with GitHub (alice_dev) →</a>
      </div>
    `
  },
  {
    num: 5,
    path: 'preview/public/login-tenant.html',
    url: '/public/login-tenant.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Tenant Admin',
    title: 'Tenant Admin SSO Portal',
    subtitle: 'Enterprise SAML / Okta SSO entrypoint for Acme Corp company security administrators',
    html: `
      <div class="card" style="max-width:500px; margin:40px auto; padding:32px; box-shadow:var(--shadow-lg);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;"><h2 style="font-size:1.3rem; font-weight:800;">Tenant Admin Login</h2><span class="badge badge-leased">Enterprise SSO</span></div>
        <div class="form-group" style="margin-bottom:14px;"><label style="display:block; font-size:0.8rem; font-weight:700; margin-bottom:4px;">Organization Tenant Domain</label><input type="text" value="acme-corp" readonly style="width:100%; padding:8px 12px; background:var(--bg-surface-sub); border:1px solid var(--border-default); border-radius:var(--radius-md); font-weight:600;"></div>
        <a href="/tenant/index.html" class="btn btn-primary" style="width:100%; background:#0284C7; padding:10px; font-size:0.95rem;">Sign In to Acme Corp →</a>
      </div>
    `
  },
  {
    num: 6,
    path: 'preview/public/login-platform.html',
    url: '/public/login-platform.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Platform Operator',
    title: 'Platform Operator Master Portal',
    subtitle: 'Global infrastructure, backbone highways, and multi-tenant resource provisioning access',
    html: `
      <div class="card" style="max-width:500px; margin:40px auto; padding:32px; box-shadow:var(--shadow-lg);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;"><h2 style="font-size:1.3rem; font-weight:800;">Platform Operator Portal</h2><span class="badge badge-danger">Master Key</span></div>
        <div class="form-group" style="margin-bottom:20px;"><label style="display:block; font-size:0.8rem; font-weight:700; margin-bottom:4px;">Operator Master Key</label><input type="password" value="adm_live_k9x2_master_fabric_mesh" style="width:100%; padding:8px 12px; border:1px solid var(--border-default); border-radius:var(--radius-md); font-family:var(--font-mono);"></div>
        <a href="/platform/index.html" class="btn btn-primary" style="width:100%; padding:10px; font-size:0.95rem;">Sign In as Platform Operator →</a>
      </div>
    `
  },
  {
    num: 7,
    path: 'preview/public/pricing-tiers.html',
    url: '/public/pricing-tiers.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Public / Enterprise',
    title: 'Enterprise Ingress Quotas & Pricing Tiers',
    subtitle: 'Transparent resource allocation, throughput limits, and SLA guarantees for enterprise tenants',
    html: `
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
        <div class="card"><strong style="font-size:1.1rem;">Starter Swarm</strong><div style="font-size:1.6rem; font-weight:900; color:var(--primary); margin:8px 0;">$0 <small style="font-size:0.8rem; color:var(--text-muted);">/month</small></div><p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:14px;">Ideal for individual developers building prototype autonomous agents.</p></div>
        <div class="card" style="border:2px solid var(--primary); background:#F8FAFC;"><div class="badge badge-success" style="margin-bottom:6px;">Most Popular</div><strong style="font-size:1.1rem; display:block;">Enterprise Mesh</strong><div style="font-size:1.6rem; font-weight:900; color:var(--primary); margin:8px 0;">$499 <small style="font-size:0.8rem; color:var(--text-muted);">/month</small></div><p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:14px;">Complete corporate governance and security compliance suite.</p></div>
        <div class="card"><strong style="font-size:1.1rem;">Global Fabric</strong><div style="font-size:1.6rem; font-weight:900; color:#7C3AED; margin:8px 0;">Custom <small style="font-size:0.8rem; color:var(--text-muted);">/month</small></div><p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:14px;">Dedicated global backbone highways and multi-region failover.</p></div>
      </div>
    `
  },
  {
    num: 8,
    path: 'preview/public/compliance-overview.html',
    url: '/public/compliance-overview.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Public / Compliance',
    title: 'Compliance & Merkle Trust Model',
    subtitle: 'Cryptographic non-repudiation, tamper-evident log chaining, and SOC2 / ISO27001 readiness',
    html: `
      <div class="card">
        <div class="card-header"><div><div class="card-title">Cryptographic Audit Immutability Architecture</div><div class="card-subtitle">Every message transit event is cryptographically committed to a SHA-256 Merkle hash chain</div></div><span class="badge badge-success">SOC2 Type II Certified</span></div>
        <div class="code-snippet-box">Root Merkle Hash: sha256:7c4d8e1a9f0234bc56de78fa90bc12de34fa56bc78de90fa12bc34de56fa78bc<br>Block Height: #894,210 · Audit Log Checkpoint: 2026-08-17 00:00:00 UTC (Verified ✓)</div>
      </div>
    `
  },

  // --- Suite 2: Platform Operator (12) ---
  {
    num: 9,
    path: 'preview/platform/index.html',
    url: '/platform/index.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Platform Operator Overview & Backbone Matrix',
    subtitle: 'Global infrastructure status, highway routing bridges, and active tenants',
    html: `
      <div class="telemetry-grid">
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Active Tenants</div><div style="font-size:1.4rem; font-weight:800; color:var(--primary);">3</div></div>
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Global Nodes</div><div style="font-size:1.4rem; font-weight:800;">139</div></div>
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Highways Active</div><div style="font-size:1.4rem; font-weight:800; color:#7C3AED;">14</div></div>
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Observed Source</div><div style="font-size:1.4rem; font-weight:800; color:#059669;">socket (v4)</div></div>
      </div>
      <div class="card"><div class="card-header"><div class="card-title">Global Backbone Routing</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">14 inter-gateway bridges operating with 0.000% packet drop rate.</p></div>
    `
  },
  {
    num: 10,
    path: 'preview/platform/highways.html',
    url: '/platform/highways.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: '14 Inter-Gateway Backbone Routing Highways',
    subtitle: 'Detailed routing topology between core gateways and regional cluster swarms',
    html: `
      <div class="card">
        <table class="data-table">
          <thead><tr><th>Highway Bridge ID</th><th>Origin Gateway</th><th>Target Gateway</th><th>Latency</th><th>Throughput</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>bridge-gw-core-gw-research</td><td>gw-core</td><td>gw-research</td><td style="color:#059669;">1.2 ms</td><td>4,820 msg/s</td><td><span class="badge badge-success">Healthy</span></td></tr>
            <tr><td>bridge-gw-core-gw-delivery</td><td>gw-core</td><td>gw-delivery</td><td style="color:#059669;">1.1 ms</td><td>3,120 msg/s</td><td><span class="badge badge-success">Healthy</span></td></tr>
            <tr><td>bridge-cross-gw-core-gw-edge</td><td>gw-core</td><td>gw-edge</td><td style="color:#059669;">2.4 ms</td><td>2,140 msg/s</td><td><span class="badge badge-success">Healthy</span></td></tr>
          </tbody>
        </table>
      </div>
    `
  },
  {
    num: 11,
    path: 'preview/platform/tenant-manager.html',
    url: '/platform/tenant-manager.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Multi-Tenant Organization Manager',
    subtitle: 'Provisioning, quota controls, and cryptographic tenant isolation management',
    html: `
      <div class="card">
        <div class="card-header"><div><div class="card-title">Active Enterprise Tenants</div></div><button class="btn btn-primary btn-sm" onclick="alert('Opening Tenant Provisioning wizard.')">+ Provision Tenant</button></div>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
          <div class="card" style="border-left:4px solid var(--primary);"><strong>Acme Corp</strong><br><small style="color:var(--text-secondary);">28 / 50 Agents · 10k req/min</small></div>
          <div class="card" style="border-left:4px solid #10B981;"><strong>Nova BioTech</strong><br><small style="color:var(--text-secondary);">42 / 60 Agents · 15k req/min</small></div>
          <div class="card" style="border-left:4px solid #8B5CF6;"><strong>Global FinTech</strong><br><small style="color:var(--text-secondary);">69 / 100 Agents · 25k req/min</small></div>
        </div>
      </div>
    `
  },
  {
    num: 12,
    path: 'preview/platform/tenant-detail.html',
    url: '/platform/tenant-detail.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Tenant Resource Quota & Isolation Deep-Dive',
    subtitle: 'Detailed view of Acme Corp ingress limits, swarm clusters, and SLA meters',
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Tenant: acme-corp</div><span class="badge badge-success">Active & Segregated</span></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Ingress limit: 10,000 req/min · SLA: 99.99% · 4 Swarm Groups allocated.</p>
      </div>
    `
  },
  {
    num: 13,
    path: 'preview/platform/telemetry.html',
    url: '/platform/telemetry.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Cluster Nodes CPU, Memory & Socket Health',
    subtitle: 'Real-time telemetry across cluster hardware nodes and active socket pools',
    html: `
      <div class="telemetry-grid">
        <div class="telemetry-card"><div>CPU Utilization</div><div style="font-size:1.4rem; font-weight:800; color:#059669;">18.4%</div></div>
        <div class="telemetry-card"><div>Memory</div><div style="font-size:1.4rem; font-weight:800; color:#3B82F6;">4.2 / 32 GB</div></div>
        <div class="telemetry-card"><div>WebSocket Sockets</div><div style="font-size:1.4rem; font-weight:800; color:#7C3AED;">114 Active</div></div>
        <div class="telemetry-card"><div>Drop Rate</div><div style="font-size:1.4rem; font-weight:800; color:#059669;">0.000%</div></div>
      </div>
    `
  },
  {
    num: 14,
    path: 'preview/platform/failover-sim.html',
    url: '/platform/failover-sim.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Global Multi-Region Gateway Failover Simulator',
    subtitle: 'Simulate regional gateway outage and automatic inter-continental rerouting',
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Multi-Region Gateway Failover Engine</div><button class="btn btn-danger btn-sm" onclick="alert('US-East outage triggered! Traffic rerouted to EU-West and AP-Seoul.')">⚡ Simulate US-East Outage</button></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Automated BGP & DNS rerouting to EU-West and AP-Seoul with zero packet drop.</p>
      </div>
    `
  },
  {
    num: 15,
    path: 'preview/platform/rate-limiting.html',
    url: '/platform/rate-limiting.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Redis Token Bucket Ingress Throttling',
    subtitle: 'Configure token refill rates, burst multipliers, and HTTP 429 policies',
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Token Bucket Configuration</div></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Refill rate: 10,000 tokens/min · Burst window: 20,000 tokens.</p>
      </div>
    `
  },
  {
    num: 16,
    path: 'preview/platform/metadata-audits.html',
    url: '/platform/metadata-audits.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Global Metadata Audits (Zero Body Leak)',
    subtitle: 'Cryptographically segregated transit logs preserving message payload privacy',
    html: `
      <div class="card">
        <div style="background:#EFF6FF; border:1px solid #BFDBFE; color:#1E40AF; padding:12px; border-radius:var(--radius-md); font-size:0.85rem; margin-bottom:16px;">
          🔒 <strong>Privacy Boundary Enforced:</strong> Payload bodies are cryptographically withheld from Platform Operator logs.
        </div>
        <table class="data-table">
          <thead><tr><th>Time</th><th>From</th><th>To</th><th>Metadata Digest</th></tr></thead>
          <tbody>
            <tr><td>12:44:02</td><td>acme-corp:core-lead</td><td>acme-corp:core-agent-3</td><td>sha256:8f9a... (142 bytes)</td></tr>
          </tbody>
        </table>
      </div>
    `
  },
  {
    num: 17,
    path: 'preview/platform/gateway-inspect.html',
    url: '/platform/gateway-inspect.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Regional Gateway Node Inspection & Direct Sockets',
    subtitle: 'Inspect physical socket connections and daemon heartbeat status',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">gw-core Gateway Node Inspector</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Direct socket connections: 5 active · Uptime: 99.999%</p></div>
    `
  },
  {
    num: 18,
    path: 'preview/platform/bandwidth-shaper.html',
    url: '/platform/bandwidth-shaper.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Cross-Deck Highway Bandwidth Shaper & QoS',
    subtitle: 'Quality of Service (QoS) bandwidth allocation across cluster decks',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Highway QoS Allocation</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Core Hub Deck: Priority 1 (Unthrottled) · IoT Edge Deck: Priority 3.</p></div>
    `
  },
  {
    num: 19,
    path: 'preview/platform/certificate-authority.html',
    url: '/platform/certificate-authority.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Root Ed25519 CA & Inter-Gateway MTLS Rotations',
    subtitle: 'Backbone mutual TLS certificates and Ed25519 root trust anchors',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Root Certificate Authority</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Root CA fingerprint: sha256:7bXmK9y8P2w1ZqL0vNxB3cR6jFaSdFgHjKlQwErTyU4</p></div>
    `
  },
  {
    num: 20,
    path: 'preview/platform/observed-sources.html',
    url: '/platform/observed-sources.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'SPEC § 8.11 Observed Source Inspector',
    subtitle: 'Inspection of kernel socket vs X-Forwarded-For attestation telemetry',
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">SPEC § 8.11 Observed Source Attestation</div><span class="badge badge-success">surface.version: 4</span></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Observed source: <code>socket</code> (Direct kernel verified, tamper-proof).</p>
      </div>
    `
  },

  // --- Suite 3: Tenant Admin (16) ---
  {
    num: 21,
    path: 'preview/tenant/index.html',
    url: '/tenant/index.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Executive Overview & Autonomous Fleet Dashboard',
    subtitle: 'Acme Corp fleet metrics, daily throughput, and swarm cluster allocation',
    html: `
      <div class="telemetry-grid">
        <div class="telemetry-card"><div>Monthly Ingress</div><div style="font-size:1.4rem; font-weight:800; color:var(--primary);">1.42M</div></div>
        <div class="telemetry-card"><div>Active Agents</div><div style="font-size:1.4rem; font-weight:800; color:#059669;">28 / 50</div></div>
        <div class="telemetry-card"><div>Avg Latency</div><div style="font-size:1.4rem; font-weight:800; color:#7C3AED;">1.15 ms</div></div>
        <div class="telemetry-card"><div>Audit Retention</div><div style="font-size:1.4rem; font-weight:800; color:#D97706;">365 Days</div></div>
      </div>
    `
  },
  {
    num: 22,
    path: 'preview/tenant/key-approvals.html',
    url: '/tenant/key-approvals.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: '50-Character Fingerprint Key Approval Queue',
    subtitle: 'Verify exact 50-character SHA-256 key fingerprints with 1-click approvals',
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Pending Public Key Proposals (3)</div></div>
        <div class="code-snippet-box">sha256:pfsELGYsvWLUoreIgzOjd0Yg8Pvz_HNChpw-rzcjPWw</div>
        <div style="display:flex; justify-content:flex-end; gap:8px;"><button class="btn btn-primary btn-sm" onclick="alert('Key approved atomically.')">✓ Approve Key</button><button class="btn btn-danger btn-sm" onclick="alert('Key revoked.')">✕ Revoke</button></div>
      </div>
    `
  },
  {
    num: 23,
    path: 'preview/tenant/key-rotations.html',
    url: '/tenant/key-rotations.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Zero-Downtime Rolling Key Rotation & 48h Grace Period',
    subtitle: 'Scheduled key rotations allowing dual-key validity during transitions',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Rolling Key Schedule</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">core-lead: Dual-key active with 48h grace window.</p></div>
    `
  },
  {
    num: 24,
    path: 'preview/tenant/compromised-keys.html',
    url: '/tenant/compromised-keys.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Compromised & Denied Key Revocation Vault',
    subtitle: 'Permanent cryptographic blacklisting of leaked or compromised keypairs',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Revoked Key Blacklist</div></div><p style="font-size:0.85rem; color:var(--status-danger);">1 key permanently revoked due to public repository leak.</p></div>
    `
  },
  {
    num: 25,
    path: 'preview/tenant/groups.html',
    url: '/tenant/groups.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Swarm Group Clusters & Assigned Leads',
    subtitle: 'Governance of Core, Research, Delivery, and Security swarm groups',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Acme Corp Swarm Groups (4)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Core Platform Hub (Lead: Fin둥이), Research Swarm (Lead: research-lead).</p></div>
    `
  },
  {
    num: 26,
    path: 'preview/tenant/group-detail.html',
    url: '/tenant/group-detail.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Core Platform Hub Cluster Detail & Member Agents',
    subtitle: 'Deep-dive into Core Platform Hub member identities and capabilities',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Core Platform Hub Details</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">5 member agents provisioned · Gateway: gw-core.</p></div>
    `
  },
  {
    num: 27,
    path: 'preview/tenant/egress-acl.html',
    url: '/tenant/egress-acl.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Inter-Group & Cross-Tenant Egress Policy Matrix',
    subtitle: 'Configure permitted communication channels and cross-tenant whitelists',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Group Egress ACL Matrix</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Research Swarm -> Cross-tenant send permitted to Nova BioTech.</p></div>
    `
  },
  {
    num: 28,
    path: 'preview/tenant/send-policy-default.html',
    url: '/tenant/send-policy-default.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Tenant Send Policy Default Switcher',
    subtitle: 'Toggle between Default Deny (explicit whitelist) and Default Allow',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Send Restriction Default Policy</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Current policy: Deny by Default (Explicit Whitelist Enforced).</p></div>
    `
  },
  {
    num: 29,
    path: 'preview/tenant/network-attestation.html',
    url: '/tenant/network-attestation.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Source IP / Subnet CIDR & ASN Whitelist',
    subtitle: 'Fine-grained source network attestation filters for incoming agent requests',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Source Network CIDR Policy</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Permitted subnet: 10.0.0.0/16 · ASN: AS15169.</p></div>
    `
  },
  {
    num: 30,
    path: 'preview/tenant/audit-failure-policy.html',
    url: '/tenant/audit-failure-policy.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Compliance Audit Failure Action (Fail-Closed vs Fail-Open)',
    subtitle: 'Behavior specification when audit database logging process is degraded',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Audit Failure Behavior</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Policy: Fail Closed (Block transit if audit write fails).</p></div>
    `
  },
  {
    num: 31,
    path: 'preview/tenant/pairing-codes.html',
    url: '/tenant/pairing-codes.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'RFC 8628 Device Flow Pairing Code Generator',
    subtitle: 'Issue short-lived single-use pairing codes with 300s TTL for CLI agents',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Active Pairing Code: ACM-8492-KY7</div></div><div class="code-snippet-box">agent-mesh claim --code ACM-8492-KY7 --name fin-helper</div></div>
    `
  },
  {
    num: 32,
    path: 'preview/tenant/pairing-history.html',
    url: '/tenant/pairing-history.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Claimed & Expired Pairing Code Audit Log',
    subtitle: 'Historical ledger of claimed, expired, and revoked pairing codes',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Pairing Code Ledger</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">14 codes claimed successfully in last 30 days.</p></div>
    `
  },
  {
    num: 33,
    path: 'preview/tenant/participant-audits.html',
    url: '/tenant/participant-audits.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Full Message Content Audit Stream & Compliance Notice',
    subtitle: 'Decrypted message bodies with mandatory enterprise compliance disclosure',
    html: `
      <div class="card">
        <div style="background:#FFFBEB; border:1px solid #FDE68A; color:#92400E; padding:12px; border-radius:var(--radius-md); font-size:0.85rem; margin-bottom:16px;">
          ⚠️ <strong>Compliance Notice:</strong> Viewing participant message bodies is recorded to <code>audit_read_events</code>.
        </div>
        <div class="code-snippet-box">{"action": "ROUTE_DISPATCH", "payload": "Dispatched settlement verification batch #942 to Fin자 queue."}</div>
      </div>
    `
  },
  {
    num: 34,
    path: 'preview/tenant/audit-read-events.html',
    url: '/tenant/audit-read-events.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Internal audit_read_events Compliance Access Log',
    subtitle: 'Audit trail of all administrative content inspection actions',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Audit Read Ledger</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">alice_admin inspected msg_892147 at 2026-08-16 20:50:00 KST.</p></div>
    `
  },
  {
    num: 35,
    path: 'preview/tenant/siem-export.html',
    url: '/tenant/siem-export.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Enterprise SIEM & S3 Archiving',
    subtitle: 'Export audit logs to AWS S3, Splunk HEC, and Datadog',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">SIEM Streaming Pipeline</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Target: s3://acme-corp-compliance-logs-2026/agent-mesh/ (Active).</p></div>
    `
  },
  {
    num: 36,
    path: 'preview/tenant/organization-rbac.html',
    url: '/tenant/organization-rbac.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Admin Member Capability Grants & Role Assignments',
    subtitle: 'Fine-grained capability assignments for Acme Corp administrators',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Administrator Grants</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">alice_admin: Super Admin (all capabilities) · bob_compliance: Auditor.</p></div>
    `
  },

  // --- Suite 4: Agent Operations & Studio (12) ---
  {
    num: 37,
    path: 'preview/creator/index.html',
    url: '/creator/index.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Agent Operations Main Studio',
    subtitle: 'Developer console for scale simulation, messaging, and queue inspection',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Developer Operations Studio</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Manage personal autonomous agents and test messaging across the mesh.</p></div>
    `
  },
  {
    num: 38,
    path: 'preview/creator/topology.html',
    url: '/creator/topology.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: '10-Stage Scale Simulation & Swarm Galaxy Graph',
    subtitle: 'Interactive pan/zoom SVG canvas with Fin둥이, Fin자, 아름이 avatars (139 nodes)',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Swarm Galaxy Topology (10 Stages)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">10 Swarm Galaxies · 139 Connected Agent Nodes · Collision-free orbit packing.</p><a href="/index.html" class="btn btn-primary btn-sm">Launch Full Pan/Zoom Engine →</a></div>
    `
  },
  {
    num: 39,
    path: 'preview/creator/topology-focus.html',
    url: '/creator/topology-focus.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Single Cluster Focus & Camera Auto-Tracking',
    subtitle: 'Smooth camera animation and focus on selected agent swarm clusters',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Camera Auto-Focus Engine</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Focused on Core Platform Hub (5 nodes).</p></div>
    `
  },
  {
    num: 40,
    path: 'preview/creator/playground.html',
    url: '/creator/playground.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Interactive Message Testing Console',
    subtitle: 'Live message dispatcher with verified recipient routing and delivery receipts',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Dispatch Test Message</div></div><div class="code-snippet-box">POST /api/v1/messages/send -> Delivered to socket in 1.1ms ✓</div></div>
    `
  },
  {
    num: 41,
    path: 'preview/creator/message-receipts.html',
    url: '/creator/message-receipts.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Verified Message Delivery Receipts & Hashes',
    subtitle: 'Inspect SHA-256 digests and cryptographic delivery acknowledgments',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Delivery Receipt #msg_948192</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Status: DELIVERED_SOCKET_ACK · Ed25519 Verified.</p></div>
    `
  },
  {
    num: 42,
    path: 'preview/creator/lease-queue.html',
    url: '/creator/lease-queue.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Socketless Inbox Queue & 300s Lease Countdown Bars',
    subtitle: 'At-least-once lease queue inspector with live countdown timers',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Active In-Flight Leases (300s TTL)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">msg_892147 leased by worker · 274s remaining.</p></div>
    `
  },
  {
    num: 43,
    path: 'preview/creator/lease-batch-actions.html',
    url: '/creator/lease-batch-actions.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Batch Lease, Atomic ACK (Delete), and NACK (Revert)',
    subtitle: 'Simulate worker processing completion (ACK) and crash recovery (NACK)',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Queue Actions Simulator</div></div><button class="btn btn-primary btn-sm" onclick="alert('ACK deleted.')">✓ ACK Delete</button> <button class="btn btn-secondary btn-sm" onclick="alert('NACK reverted.')">↩ NACK Revert</button></div>
    `
  },
  {
    num: 44,
    path: 'preview/creator/websocket-trace.html',
    url: '/creator/websocket-trace.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Live WebSocket Frame Debugger & IN/OUT Frame Trace',
    subtitle: 'Real-time WebSocket frame packet trace with JSON export',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">WebSocket Frame Stream</div></div><div class="code-snippet-box">12:51:02.102 [OUT] WS_DISPATCH to acme-corp:core-lead (142 bytes)</div></div>
    `
  },
  {
    num: 45,
    path: 'preview/creator/agent-runner.html',
    url: '/creator/agent-runner.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Local Agent Runner & CLI Connect Guide',
    subtitle: 'Connect local Python/Node codebases via CLI in 3 easy steps',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Local CLI Setup Guide</div></div><div class="code-snippet-box">agent-mesh listen --endpoint http://localhost:3000 --key ~/.agent-mesh/agent.key</div></div>
    `
  },
  {
    num: 46,
    path: 'preview/creator/agent-register.html',
    url: '/creator/agent-register.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Register New Agent Identity Form & Key Proposer',
    subtitle: 'Propose new identity name and Ed25519 public key with 409 conflict checks',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Register Autonomous Agent</div></div><button class="btn btn-primary" onclick="alert('Agent proposal submitted.')">Submit Agent Proposal</button></div>
    `
  },
  {
    num: 47,
    path: 'preview/creator/agent-teardown.html',
    url: '/creator/agent-teardown.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Permanent Identity Teardown Warning (SPEC § 9.3 Invariant)',
    subtitle: 'Permanent soft deletion dialogue enforcing non-reusability rule',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">SPEC § 9.3 Invariant Rule</div></div><p style="color:var(--status-danger);">Torn down identities are permanently deactivated forever.</p></div>
    `
  },
  {
    num: 48,
    path: 'preview/creator/traffic-pulse-sim.html',
    url: '/creator/traffic-pulse-sim.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Live Multi-Highway Traffic Pulse Animation',
    subtitle: 'Simulate high-velocity packet transmission across backbone highways',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Traffic Pulse Simulation</div></div><button class="btn btn-primary btn-sm" onclick="alert('Simulated traffic pulses dispatched across 14 highways.')">⚡ Simulate Traffic Pulses</button></div>
    `
  },

  // --- Suite 5: Developer Hub & APIs (12) ---
  {
    num: 49,
    path: 'preview/dev/index.html',
    url: '/dev/index.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Developer Hub Overview & Quickstart',
    subtitle: 'REST API, WebSocket documentation, and client SDK downloads',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Developer Hub Quickstart</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Start integrating with Agent Mesh Platform in less than 5 minutes.</p></div>
    `
  },
  {
    num: 50,
    path: 'preview/dev/openapi-explorer.html',
    url: '/dev/openapi-explorer.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Interactive Swagger / OpenAPI 3.1 Endpoint Runner',
    subtitle: 'Execute real HTTP requests against local agent mesh endpoints',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">OpenAPI 3.1 Test Runner</div></div><div class="code-snippet-box">POST /api/v1/messages/send -> HTTP 200 OK</div></div>
    `
  },
  {
    num: 51,
    path: 'preview/dev/api-messages-send.html',
    url: '/dev/api-messages-send.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/messages/send',
    subtitle: 'Specification for dispatching signed messages across the mesh',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">POST /api/v1/messages/send</div></div><div class="code-snippet-box">{"to": "platform-claude", "payload": "hello"}</div></div>
    `
  },
  {
    num: 52,
    path: 'preview/dev/api-inbox-lease.html',
    url: '/dev/api-inbox-lease.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/inbox/lease',
    subtitle: 'Specification for leasing socketless inbox batches with 300s TTL',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">POST /api/v1/inbox/lease</div></div><div class="code-snippet-box">{"batch_size": 10, "lease_seconds": 300}</div></div>
    `
  },
  {
    num: 53,
    path: 'preview/dev/api-inbox-ack.html',
    url: '/dev/api-inbox-ack.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: DELETE /api/v1/inbox/ack',
    subtitle: 'Specification for acknowledging and permanently removing messages',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">DELETE /api/v1/inbox/ack</div></div><div class="code-snippet-box">{"message_id": "msg_948192"}</div></div>
    `
  },
  {
    num: 54,
    path: 'preview/dev/api-keys-propose.html',
    url: '/dev/api-keys-propose.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/keys/propose',
    subtitle: 'Specification for proposing new Ed25519 public keys',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">POST /api/v1/keys/propose</div></div><div class="code-snippet-box">{"identity": "lane-claude", "pubkey": "91cBIH2C..."}</div></div>
    `
  },
  {
    num: 55,
    path: 'preview/dev/api-capabilities.html',
    url: '/dev/api-capabilities.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: GET /api/v1/capabilities',
    subtitle: 'Specification for querying surface version 4 and observed source telemetry',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">GET /api/v1/capabilities</div></div><div class="code-snippet-box">{"surface": {"version": 4, "observed_source": "socket"}}</div></div>
    `
  },
  {
    num: 56,
    path: 'preview/dev/sdk-typescript.html',
    url: '/dev/sdk-typescript.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official TypeScript / Node.js SDK Documentation',
    subtitle: 'Install, initialize, and execute workflows using @agent-mesh/sdk',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">@agent-mesh/sdk (TypeScript)</div></div><div class="code-snippet-box">npm install @agent-mesh/sdk</div></div>
    `
  },
  {
    num: 57,
    path: 'preview/dev/sdk-python.html',
    url: '/dev/sdk-python.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official Python Client SDK Documentation',
    subtitle: 'Python client documentation with asyncio and sync workers',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">agent-mesh (Python)</div></div><div class="code-snippet-box">pip install agent-mesh</div></div>
    `
  },
  {
    num: 58,
    path: 'preview/dev/sdk-go.html',
    url: '/dev/sdk-go.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official Go (Golang) SDK Documentation',
    subtitle: 'Lightweight Go SDK documentation with zero external dependencies',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">mesh-go (Golang)</div></div><div class="code-snippet-box">go get github.com/agent-mesh/mesh-go</div></div>
    `
  },
  {
    num: 59,
    path: 'preview/dev/webhooks.html',
    url: '/dev/webhooks.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Webhook Subscription Manager & Secret Signing',
    subtitle: 'Subscribe external endpoints to mesh events with HMAC-SHA256 signatures',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Webhook Subscriptions</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">2 active endpoints receiving live event dispatches.</p></div>
    `
  },
  {
    num: 60,
    path: 'preview/dev/dead-letter-queue.html',
    url: '/dev/dead-letter-queue.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Dead-Letter Queue (DLQ) Inspector & Retry Engine',
    subtitle: 'Inspect and replay undeliverable webhook and message payloads',
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Dead-Letter Queue (DLQ)</div><button class="btn btn-primary btn-sm" onclick="alert('All DLQ events re-queued.')">🔄 Retry All DLQ</button></div><p style="font-size:0.85rem; color:var(--text-secondary);">2 failed webhook dispatches retained for manual retry.</p></div>
    `
  }
];

// Write all 60 files
ALL_SCREENS.forEach(s => {
  const pageHtml = renderRichPage(s.num, s.suite, s.url, s.title, s.subtitle, s.html);
  writeFileSync(s.path, pageHtml, 'utf-8');
});

console.log('Successfully generated all 60 rich sample pages with full layouts and sub-navs!');
