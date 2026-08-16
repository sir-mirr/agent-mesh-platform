import { writeFileSync } from 'fs';
import { join } from 'path';
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
  isImplemented: boolean;
  html: string;
}

const ALL_SCREENS: ScreenSpec[] = [
  // ========================================================
  // SUITE 1: PUBLIC & MARKETING (8)
  // ========================================================
  {
    num: 1,
    path: 'preview/public/index.html',
    url: '/public/index.html',
    suite: 'public',
    suiteTitle: 'Public & Marketing',
    role: 'Public / All Users',
    title: 'Main Landing & Agent Constellation',
    subtitle: 'The Next-Gen Multi-Agent Messaging Backbone & Cryptographic Trust Fabric',
    isImplemented: true,
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

      <div class="features-grid" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-top:20px;">
        <div class="card">
          <div style="font-size:1.5rem; margin-bottom:8px;">⚡</div>
          <strong style="font-size:1.05rem;">Asynchronous Agent Messaging</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px; line-height:1.6;">
            Empowers intermittent and serverless AI agents to reliably send and receive leased batches of messages on-demand with cryptographic signatures.
          </p>
        </div>
        <div class="card">
          <div style="font-size:1.5rem; margin-bottom:8px;">🔒</div>
          <strong style="font-size:1.05rem;">Cryptographic Identity Verification</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px; line-height:1.6;">
            Enforces strict public key fingerprint matching and operator-governed approval workflows, ensuring every participant is authentic and auditable.
          </p>
        </div>
        <div class="card">
          <div style="font-size:1.5rem; margin-bottom:8px;">📊</div>
          <strong style="font-size:1.05rem;">Immutable Real-Time Auditing</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px; line-height:1.6;">
            Maintains a tamper-evident, permanent audit trail of every agent-to-agent communication, streamed live for enterprise compliance and oversight.
          </p>
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
    subtitle: 'Origin author vs carrier socket identity, Level 1/2 attestation, and zero-leak privacy (SPEC v0.3 & § 8.2)',
    isImplemented: true,
    html: `
      <div class="protocol-grid">
        <div class="protocol-card">
          <div style="font-size:1.4rem; margin-bottom:8px;">⏱️</div>
          <strong style="font-size:1.05rem;">1. Socketless Lease State Machine (SPEC § 8.10)</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">
            Single-roundtrip combined lease & ack (<code>POST /api/v1/inbox</code>) eliminates race conditions where incoming messages are accidentally deleted by an earlier ACK.
          </p>
          <div class="protocol-step-box"><strong>Step 1: Available Pool</strong><br>Buffered in SQLite queue pool.</div>
          <div class="protocol-step-box" style="border-color:#F59E0B; background:#FFFDF5;"><strong>Step 2: Leased (300s TTL)</strong><br>Claimed in batch. Atomic countdown locks batch.</div>
          <div class="protocol-step-box" style="border-color:#10B981; background:#F0FDF4;"><strong>Step 3: Piggybacked Ack on Next Call</strong><br>Acknowledged atomically when claiming next batch.</div>
        </div>

        <div class="protocol-card">
          <div style="font-size:1.4rem; margin-bottom:8px;">🔑</div>
          <strong style="font-size:1.05rem;">2. Origin vs Carrier Identity (SPEC § 8.2)</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">
            Explicit distinction between author identity and socket-holder identity:
          </p>
          <div class="protocol-step-box">
            <strong>Agent Direct Dispatch:</strong><br>
            <code>from: "mesh-claude"</code> · <code>sent_by: "mesh-claude"</code><br>
            <small style="color:#059669;">Ed25519 author signature over payload body.</small>
          </div>
          <div class="protocol-step-box" style="background:#FFFDF5; border-color:#F59E0B;">
            <strong>Human Web Dispatch:</strong><br>
            <code>from: "alice_dev"</code> · <code>sent_by: "http-server"</code><br>
            <small style="color:#92400E;">No author Ed25519 signature; signed by http-server socket carrier.</small>
          </div>
        </div>

        <div class="protocol-card">
          <div style="font-size:1.4rem; margin-bottom:8px;">🛡️</div>
          <strong style="font-size:1.05rem;">3. Attestation Levels & Privacy Boundaries</strong>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:6px;">
            Level 1 (Agent self-claim) vs Level 2 (Hub kernel-observed socket attestation):
          </p>
          <div class="protocol-step-box" style="border-color:#3B82F6; background:#EFF6FF;">
            <strong>Level 2 Hub Observation:</strong><br>
            <code>surface.observed_source: "socket" | "forwarded"</code>
          </div>
          <div class="protocol-step-box">
            <strong>Platform vs Tenant Privacy:</strong><br>
            Platform Operator has 0% message body access.
          </div>
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
    subtitle: 'Interactive simulation of 300s TTL atomic lease locking, piggybacked ack, and crash recovery (SPEC § 8.10)',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Live State Transition Simulator</div>
            <div class="card-subtitle">Test how messages transition across Available, Leased, and Acknowledged states</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Simulated atomic lease acquisition (POST /api/v1/inbox).')">📥 Poll & Lease Message</button>
        </div>

        <div style="display:flex; gap:16px; margin:20px 0;">
          <div style="flex:1; background:var(--bg-surface-sub); padding:16px; border-radius:var(--radius-md); border:1px solid var(--border-default);">
            <strong style="font-size:1rem; color:var(--text-primary);">1. Available Pool (3)</strong>
            <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Messages awaiting worker acquisition.</p>
            <div class="code-snippet-box" style="margin-top:10px;">msg_94210 (140B)<br>msg_94211 (210B)<br>msg_94212 (512B)</div>
          </div>
          <div style="flex:1; background:#FFFDF5; border:1px solid #F59E0B; padding:16px; border-radius:var(--radius-md);">
            <strong style="font-size:1rem; color:#92400E;">2. Leased Active (2)</strong>
            <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Locked with in-flight countdown timer.</p>
            <div class="code-snippet-box" style="margin-top:10px; color:#FDE68A;">msg_892147 · 274s remaining<br>msg_892148 · 289s remaining</div>
          </div>
          <div style="flex:1; background:#F0FDF4; border:1px solid #10B981; padding:16px; border-radius:var(--radius-md);">
            <strong style="font-size:1rem; color:#065F46;">3. Consumed / Deleted (12)</strong>
            <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Atomically acknowledged via next /inbox call.</p>
            <div class="code-snippet-box" style="margin-top:10px; color:#A7F3D0;">msg_892146 (ACK ✓)<br>msg_892145 (ACK ✓)</div>
          </div>
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
    isImplemented: true,
    html: `
      <div class="card" style="max-width:500px; margin:40px auto; padding:32px; box-shadow:var(--shadow-lg);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h2 style="font-size:1.3rem; font-weight:800;">Agent Operator Sign In</h2>
          <span class="badge badge-success">GitHub OAuth</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:20px; line-height:1.6;">
          Authenticate with your GitHub developer identity to manage personal agent public keys and test live routing in the messaging playground.
        </p>
        <div style="background:var(--bg-surface-sub); border:1px solid var(--border-default); border-radius:var(--radius-md); padding:12px; margin-bottom:20px; font-size:0.8rem;">
          <strong>Requested Permission Scopes:</strong><br>
          • <code>read:user</code> (Identity name binding)<br>
          • <code>repo:status</code> (Key verification linking)
        </div>
        <a href="/creator/index.html" class="btn btn-primary" style="width:100%; padding:10px; font-size:0.95rem;">
          Continue with GitHub (alice_dev) →
        </a>
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
    isImplemented: true,
    html: `
      <div class="card" style="max-width:500px; margin:40px auto; padding:32px; box-shadow:var(--shadow-lg);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h2 style="font-size:1.3rem; font-weight:800;">Tenant Admin Login</h2>
          <span class="badge badge-leased">Enterprise SSO</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:20px; line-height:1.6;">
          Access the Acme Corp company security gateway, approve 50-character agent public keys, generate RFC 8628 pairing codes, and configure cross-tenant egress policies.
        </p>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:block; font-size:0.8rem; font-weight:700; margin-bottom:4px;">Organization Tenant Domain</label>
          <input type="text" value="acme-corp" readonly style="width:100%; padding:8px 12px; background:var(--bg-surface-sub); border:1px solid var(--border-default); border-radius:var(--radius-md); font-weight:600;">
        </div>
        <a href="/tenant/index.html" class="btn btn-primary" style="width:100%; background:#0284C7; padding:10px; font-size:0.95rem;">
          Sign In to Acme Corp →
        </a>
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
    isImplemented: true,
    html: `
      <div class="card" style="max-width:500px; margin:40px auto; padding:32px; box-shadow:var(--shadow-lg);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h2 style="font-size:1.3rem; font-weight:800;">Platform Operator Portal</h2>
          <span class="badge badge-danger">Master Key</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:20px; line-height:1.6;">
          Manage the 14 global backbone highways, provision new tenant boundaries, monitor cluster node telemetry, and inspect transit metadata.
        </p>
        <div class="form-group" style="margin-bottom:20px;">
          <label style="display:block; font-size:0.8rem; font-weight:700; margin-bottom:4px;">Operator Master Key</label>
          <input type="password" value="adm_live_k9x2_master_fabric_mesh" style="width:100%; padding:8px 12px; border:1px solid var(--border-default); border-radius:var(--radius-md); font-family:var(--font-mono);">
        </div>
        <div style="background:#EFF6FF; border:1px solid #BFDBFE; color:#1E40AF; padding:10px 14px; border-radius:var(--radius-md); font-size:0.8rem; margin-bottom:20px;">
          🔒 <strong>Privacy Boundary Note:</strong> Platform Operator accounts strictly cannot inspect decrypted message payloads.
        </div>
        <a href="/platform/index.html" class="btn btn-primary" style="width:100%; padding:10px; font-size:0.95rem;">
          Sign In as Platform Operator →
        </a>
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
    isImplemented: false,
    html: `
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
        <div class="card">
          <strong style="font-size:1.1rem;">Starter Swarm</strong>
          <div style="font-size:1.6rem; font-weight:900; color:var(--primary); margin:8px 0;">$0 <small style="font-size:0.8rem; color:var(--text-muted);">/month</small></div>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:14px;">Ideal for individual developers building prototype autonomous agents.</p>
          <ul style="font-size:0.82rem; color:var(--text-secondary); line-height:1.8; margin-left:18px; margin-bottom:20px;">
            <li>Up to 10 Managed Agents</li>
            <li>100,000 Ingress Requests / month</li>
            <li>1 Gateway Bridge</li>
          </ul>
        </div>

        <div class="card" style="border:2px solid var(--primary); background:#F8FAFC;">
          <div class="badge badge-success" style="margin-bottom:6px;">Most Popular</div>
          <strong style="font-size:1.1rem; display:block;">Enterprise Mesh</strong>
          <div style="font-size:1.6rem; font-weight:900; color:var(--primary); margin:8px 0;">$499 <small style="font-size:0.8rem; color:var(--text-muted);">/month</small></div>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:14px;">Complete corporate governance and security compliance suite.</p>
          <ul style="font-size:0.82rem; color:var(--text-secondary); line-height:1.8; margin-left:18px; margin-bottom:20px;">
            <li>Up to 50 Managed Agents (Acme Corp)</li>
            <li>5,000,000 Ingress Requests / month</li>
            <li>4 Dedicated Swarm Clusters</li>
          </ul>
        </div>

        <div class="card">
          <strong style="font-size:1.1rem;">Global Fabric</strong>
          <div style="font-size:1.6rem; font-weight:900; color:#7C3AED; margin:8px 0;">Custom <small style="font-size:0.8rem; color:var(--text-muted);">/month</small></div>
          <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:14px;">Dedicated global backbone highways and multi-region failover.</p>
        </div>
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
    isImplemented: false,
    html: `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Cryptographic Audit Immutability Architecture</div>
            <div class="card-subtitle">Every message transit event is cryptographically committed to a SHA-256 Merkle hash chain</div>
          </div>
          <span class="badge badge-warning">Design Concept</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); line-height:1.6; margin-bottom:16px;">
          The Agent Mesh Platform guarantees complete non-repudiation. When an agent dispatches a message, its Ed25519 digital signature is immutably recorded. Even platform operators cannot alter historical logs without breaking the Merkle root hash.
        </p>
        <div class="code-snippet-box">
Root Merkle Hash: sha256:7c4d8e1a9f0234bc56de78fa90bc12de34fa56bc78de90fa12bc34de56fa78bc
Block Height: #894,210 · Audit Log Checkpoint: 2026-08-17 00:00:00 UTC (Verified ✓)
        </div>
      </div>
    `
  },

  // ========================================================
  // SUITE 2: PLATFORM OPERATOR CONSOLE (12)
  // ========================================================
  {
    num: 9,
    path: 'preview/platform/index.html',
    url: '/platform/index.html',
    suite: 'platform',
    suiteTitle: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Platform Operator Overview & Backbone Matrix',
    subtitle: 'Global infrastructure status, highway routing bridges, and active tenants',
    isImplemented: true,
    html: `
      <div class="telemetry-grid">
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Active Tenants</div><div style="font-size:1.4rem; font-weight:800; color:var(--primary);">3</div></div>
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Global Nodes</div><div style="font-size:1.4rem; font-weight:800;">139</div></div>
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Highways Active</div><div style="font-size:1.4rem; font-weight:800; color:#7C3AED;">14</div></div>
        <div class="telemetry-card"><div style="color:var(--text-secondary); font-size:0.8rem;">Observed Source</div><div style="font-size:1.4rem; font-weight:800; color:#059669;">socket (v4)</div></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Global Backbone Routing Matrix</div></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">14 inter-gateway bridges operating with 0.000% packet drop rate across cluster decks.</p>
      </div>
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    subtitle: 'Simulate regional gateway outage and automatic inter-continental rerouting (Future Roadmap)',
    isImplemented: false,
    html: `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Multi-Region Gateway Failover Engine (Future Architecture)</div>
            <div class="card-subtitle">Hub is currently single-instance in-memory map; this simulates multi-region routing topology</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="alert('Simulated US-East outage triggered! Traffic rerouted to EU-West and AP-Seoul.')">⚡ Simulate US-East Outage</button>
        </div>
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
    subtitle: 'Configure token refill rates, burst multipliers, and HTTP 429 policies (Deferred)',
    isImplemented: false,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Token Bucket Configuration (Proposed)</div></div>
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: false,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Highway QoS Allocation (Design Proposal)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Core Hub Deck: Priority 1 (Unthrottled) · IoT Edge Deck: Priority 3.</p></div>
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
    isImplemented: true,
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
    subtitle: 'Inspection of kernel socket vs X-Forwarded-For attestation telemetry (GET /api/v1/admin/agent-sources)',
    isImplemented: true,
    html: `
      <div class="card">
        <!-- Deployment Mode Header Banner -->
        <div style="background:#F0FDF4; border:1px solid #86EFAC; color:#166534; padding:14px; border-radius:var(--radius-md); font-size:0.875rem; margin-bottom:16px;">
          <strong>🛡️ Active Deployment Mode: <code>socket</code> (Direct Kernel Observed Source)</strong><br>
          <span style="font-size:0.8rem; color:#15803D;">The hub directly inspects peer TCP socket addresses. Invariants are cryptographically sound.</span>
        </div>

        <div class="card-header">
          <div>
            <div class="card-title">Agent Sources Ledger</div>
            <div class="card-subtitle">Backing schema: <code>agent_sources (identity, observed, first_seen, last_seen, requests)</code> · Endpoint: <code>GET /api/v1/admin/agent-sources</code></div>
          </div>
          <span class="badge badge-success">surface.version: 4</span>
        </div>

        <table class="data-table">
          <thead>
            <tr>
              <th>Agent Identity</th>
              <th>Observed Address</th>
              <th>First Seen</th>
              <th>Last Seen</th>
              <th>Total Requests</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>acme-corp:core-lead</strong></td>
              <td><code>10.0.4.12:49182</code></td>
              <td>2026-08-16 10:00:00</td>
              <td>2026-08-17 01:05:12</td>
              <td><strong>142,890</strong></td>
            </tr>
            <tr>
              <td><strong>acme-corp:core-agent-3</strong></td>
              <td><code>10.0.4.15:51290</code></td>
              <td>2026-08-16 10:05:00</td>
              <td>2026-08-17 01:04:44</td>
              <td><strong>98,420</strong></td>
            </tr>
            <tr>
              <td><strong>nova-biotech:research-lead</strong></td>
              <td><code>10.0.5.88:42100</code></td>
              <td>2026-08-16 11:20:00</td>
              <td>2026-08-17 01:02:00</td>
              <td><strong>34,100</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `
  },

  // ========================================================
  // SUITE 3: TENANT ADMIN CONSOLE (16)
  // ========================================================
  {
    num: 21,
    path: 'preview/tenant/index.html',
    url: '/tenant/index.html',
    suite: 'tenant',
    suiteTitle: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Executive Overview & Autonomous Fleet Dashboard',
    subtitle: 'Acme Corp fleet metrics, daily throughput, and swarm cluster allocation',
    isImplemented: true,
    html: `
      <div class="telemetry-grid">
        <div class="telemetry-card"><div>Monthly Ingress</div><div style="font-size:1.4rem; font-weight:800; color:var(--primary);">1.42M</div></div>
        <div class="telemetry-card"><div>Active Agents</div><div style="font-size:1.4rem; font-weight:800; color:#059669;">28 / 50</div></div>
        <div class="telemetry-card"><div>Avg Latency</div><div style="font-size:1.4rem; font-weight:800; color:#7C3AED;">1.15 ms</div></div>
        <div class="telemetry-card"><div>Audit Retention</div><div style="font-size:1.4rem; font-weight:800; color:#D97706;">Indefinite (§15.6)</div></div>
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
    isImplemented: true,
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
    subtitle: 'Scheduled key rotations allowing dual-key validity during transitions (Design Concept)',
    isImplemented: false,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Rolling Key Schedule (Proposed)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">core-lead: Dual-key active with 48h grace window.</p></div>
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    subtitle: 'Fine-grained source network attestation filters for incoming agent requests (SPEC § 8.11)',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Source Network CIDR Policy</div><span class="badge badge-success">SPEC § 8.11 Active</span></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Permitted subnet: <code>10.0.0.0/16</code> · Exact match: <code>10.0.4.12/32</code>.</p>
      </div>
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    subtitle: 'Audit trail of all administrative content inspection actions (Proposed)',
    isImplemented: false,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Audit Read Ledger (Proposed)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">alice_admin inspected msg_892147 at 2026-08-16 20:50:00 KST.</p></div>
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
    subtitle: 'Export audit logs to AWS S3, Splunk HEC, and Datadog (Proposed)',
    isImplemented: false,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">SIEM Streaming Pipeline (Proposed)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Target: s3://acme-corp-compliance-logs-2026/agent-mesh/ (Active).</p></div>
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
    subtitle: 'Fine-grained capabilities (v0.9.0 / SPEC § 11) and instant revocation rules',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Fine-Grained Capability Grants (SPEC § 11)</div>
            <div class="card-subtitle">8 explicit capability gates: <code>key.approve</code>, <code>agent.provision</code>, <code>agent.teardown</code>, <code>audit.read.metadata</code>, <code>audit.read.content</code>, <code>inbox.read.depth</code>, <code>group.manage</code>, <code>role.grant</code></div>
          </div>
        </div>

        <div style="background:#EFF6FF; border:1px solid #BFDBFE; color:#1E40AF; padding:12px; border-radius:var(--radius-md); font-size:0.85rem; margin-bottom:16px;">
          ⚡ <strong>Instant Revocation:</strong> Capability grants are verified dynamically on every request. Revoking a capability immediately results in HTTP 403 on the user's next action without requiring logout.
        </div>

        <table class="data-table">
          <thead><tr><th>Admin Identity</th><th>Active Capabilities</th><th>Actions</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>alice_admin (Super Admin)</strong></td>
              <td><code>key.approve, agent.provision, agent.teardown, audit.read.content, group.manage, role.grant</code></td>
              <td><button class="btn btn-secondary btn-sm" onclick="alert('Cannot revoke own primary grant.')">Edit Grants</button></td>
            </tr>
            <tr>
              <td><strong>bob_compliance (Auditor)</strong></td>
              <td><code>audit.read.metadata, audit.read.content, inbox.read.depth</code></td>
              <td><button class="btn btn-secondary btn-sm" onclick="alert('Simulated capability revocation: Next click will return HTTP 403 { error: \\\"Missing capability: audit.read.content\\\", capability: \\\"audit.read.content\\\" }')">Revoke Content Read</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    `
  },

  // ========================================================
  // SUITE 4: AGENT OPERATIONS & STUDIO (12)
  // ========================================================
  {
    num: 37,
    path: 'preview/creator/index.html',
    url: '/creator/index.html',
    suite: 'creator',
    suiteTitle: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Agent Operations Main Studio',
    subtitle: 'Developer console for scale simulation, messaging, and queue inspection',
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
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
    subtitle: 'Live message dispatcher with verified recipient routing and delivery receipts (POST /api/v1/outbox)',
    isImplemented: true,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Dispatch Test Message</div></div><div class="code-snippet-box">POST /api/v1/outbox -> Delivered to socket in 1.1ms ✓</div></div>
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
    isImplemented: true,
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
    subtitle: 'At-least-once lease queue inspector with live countdown timers (SPEC § 8.10)',
    isImplemented: true,
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
    title: 'Combined Lease & Ack Actions Simulator',
    subtitle: 'Simulate worker batch acquisition with piggybacked ack parameter (SPEC § 8.10)',
    isImplemented: true,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">POST /api/v1/inbox Actions Simulator</div></div><button class="btn btn-primary btn-sm" onclick="alert('Batch leased and previous acked.')">📥 Poll Next + Ack Previous</button></div>
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
    isImplemented: true,
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
    isImplemented: true,
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
    subtitle: 'Propose new identity name and Ed25519 public key with 409 conflict checks (POST /api/v1/agents)',
    isImplemented: true,
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
    isImplemented: true,
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
    isImplemented: true,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">Traffic Pulse Simulation</div></div><button class="btn btn-primary btn-sm" onclick="alert('Simulated traffic pulses dispatched across 14 highways.')">⚡ Simulate Traffic Pulses</button></div>
    `
  },

  // ========================================================
  // SUITE 5: DEVELOPER PORTAL & REAL APIS (12)
  // ========================================================
  {
    num: 49,
    path: 'preview/dev/index.html',
    url: '/dev/index.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Developer Hub Overview & Quickstart',
    subtitle: 'REST API, WebSocket documentation, and client SDK downloads (Contracts v0.9.0)',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Official Endpoints (Contracts v0.9.0)</div></div>
        <table class="data-table">
          <thead><tr><th>Method</th><th>Path</th><th>Description</th><th>SPEC Section</th></tr></thead>
          <tbody>
            <tr><td><span class="api-method-post">POST</span></td><td><code>/api/v1/inbox</code></td><td>Combined batch lease & previous batch acknowledgement</td><td>SPEC § 8.10</td></tr>
            <tr><td><span class="api-method-post">POST</span></td><td><code>/api/v1/outbox</code></td><td>Dispatch signed message to recipient queue</td><td>SPEC § 8.1</td></tr>
            <tr><td><span class="api-method-get">GET</span></td><td><code>/api/v1/outbox</code></td><td>List sent messages in transit</td><td>SPEC § 8.1</td></tr>
            <tr><td><span class="api-method-delete">DELETE</span></td><td><code>/api/v1/outbox/{id}</code></td><td>Cancel pending outbox delivery</td><td>SPEC § 8.1</td></tr>
            <tr><td><span class="api-method-get">GET</span></td><td><code>/api/v1/inbox/history</code></td><td>Fetch historical delivered messages</td><td>SPEC § 8.10</td></tr>
            <tr><td><span class="api-method-post">POST</span></td><td><code>/api/v1/agents</code></td><td>Provision identity and propose public key</td><td>SPEC § 9.1</td></tr>
            <tr><td><span class="api-method-get">GET</span></td><td><code>/api/v1/capabilities</code></td><td>Query surface version 4 & observed source</td><td>SPEC § 8.11</td></tr>
          </tbody>
        </table>
      </div>
    `
  },
  {
    num: 50,
    path: 'preview/dev/openapi-explorer.html',
    url: '/dev/openapi-explorer.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Interactive OpenAPI 3.1 Endpoint Runner',
    subtitle: 'Execute real HTTP requests against local agent mesh endpoints',
    isImplemented: true,
    html: `
      <div class="card"><div class="card-header"><div class="card-title">OpenAPI 3.1 Test Runner</div></div><div class="code-snippet-box">POST /api/v1/outbox -> HTTP 200 OK: {"delivered": true, "msg_id": "msg_948192"}</div></div>
    `
  },
  {
    num: 51,
    path: 'preview/dev/api-outbox.html',
    url: '/dev/api-outbox.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/outbox & GET /api/v1/outbox',
    subtitle: 'Dispatch and inspect outbound signed messages across the mesh (SPEC § 8.1)',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">POST /api/v1/outbox</div><button class="btn btn-primary btn-sm" onclick="alert('POST /api/v1/outbox executed.')">▶ Execute</button></div>
        <div class="code-snippet-box">{
  "to": "acme-corp:core-lead",
  "payload": { "action": "SYNC_STATE", "data": [1, 2, 3] }
}</div>
      </div>
    `
  },
  {
    num: 52,
    path: 'preview/dev/api-inbox.html',
    url: '/dev/api-inbox.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/inbox (Atomic Lease & Ack)',
    subtitle: 'Specification and test runner for single-roundtrip lease and previous batch acknowledgement (SPEC § 8.10)',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">POST /api/v1/inbox (SPEC § 8.10 Invariant)</div>
            <div class="card-subtitle">Combines lease acquisition and previous batch ack into a single atomic transaction</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('POST /api/v1/inbox executed.')">▶ Execute /inbox</button>
        </div>

        <div style="background:#EFF6FF; border:1px solid #BFDBFE; color:#1E40AF; padding:12px; border-radius:var(--radius-md); font-size:0.85rem; margin-bottom:16px;">
          💡 <strong>Architectural Rationale:</strong> Separate lease and acknowledgement calls create a race condition window where messages arriving between read and ack can be deleted by an earlier ack. Piggybacking <code>ack_ids</code> onto the next lease call provides zero-window safety.
        </div>

        <div class="code-snippet-box">{
  "ack_ids": ["msg_892145", "msg_892146"],
  "limit": 10,
  "lease_seconds": 300
}</div>
      </div>
    `
  },
  {
    num: 53,
    path: 'preview/dev/api-outbox-delete.html',
    url: '/dev/api-outbox-delete.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: DELETE /api/v1/outbox/{message_id}',
    subtitle: 'Cancel in-flight message delivery before recipient lease acquisition',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">DELETE /api/v1/outbox/{message_id}</div><button class="btn btn-danger btn-sm" onclick="alert('Outbox message canceled.')">▶ Execute Delete</button></div>
        <div class="code-snippet-box">DELETE /api/v1/outbox/msg_948192 -> HTTP 200 OK: {"canceled": true}</div>
      </div>
    `
  },
  {
    num: 54,
    path: 'preview/dev/api-inbox-history.html',
    url: '/dev/api-inbox-history.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: GET /api/v1/inbox/history',
    subtitle: 'Fetch delivered and processed message history for participant audits (SPEC § 8.10)',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">GET /api/v1/inbox/history</div><button class="btn btn-primary btn-sm" onclick="alert('Fetched inbox history.')">▶ Execute GET</button></div>
        <div class="code-snippet-box">GET /api/v1/inbox/history?limit=20 -> [ {"id": "msg_892146", "delivered_at": "2026-08-16T23:59:00Z"} ]</div>
      </div>
    `
  },
  {
    num: 55,
    path: 'preview/dev/api-agents-provision.html',
    url: '/dev/api-agents-provision.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/agents (Provision & Key Proposal)',
    subtitle: 'Provision agent identity, propose public key, and verify with GET /api/v1/agents/{id}/keys',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">POST /api/v1/agents</div>
            <div class="card-subtitle">Identity registration and rolling key proposals supersede pending keys without touching active keys</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Agent provisioned.')">▶ Execute Provision</button>
        </div>

        <div style="background:#EFF6FF; border:1px solid #BFDBFE; color:#1E40AF; padding:12px; border-radius:var(--radius-md); font-size:0.85rem; margin-bottom:16px;">
          🔑 <strong>Verification Best Practice:</strong> Do not rely solely on the <code>2xx</code> response of <code>POST /api/v1/agents</code>. Always query <code>GET /api/v1/agents/{identity}/keys</code> to ensure your 50-character SHA-256 fingerprint has been successfully registered in the database.
        </div>

        <div class="code-snippet-box">{
  "identity": "acme-corp:core-agent-9",
  "type": "standard",
  "public_key": "91cBIH2CQfK6aV7hT6q3ZpLmQ0vNxB3cR6jFaSdFgHj="
}</div>
      </div>
    `
  },
  {
    num: 56,
    path: 'preview/dev/api-capabilities.html',
    url: '/dev/api-capabilities.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: GET /api/v1/capabilities',
    subtitle: 'Specification for querying surface version 4 and observed source telemetry (SPEC § 8.11)',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">GET /api/v1/capabilities</div><button class="btn btn-primary btn-sm" onclick="alert('Capabilities queried.')">▶ Execute GET</button></div>
        <div class="code-snippet-box">{
  "surface": {
    "version": 4,
    "observed_source": "socket"
  },
  "capabilities": [
    "key.approve",
    "agent.provision",
    "agent.teardown",
    "audit.read.metadata",
    "audit.read.content",
    "inbox.read.depth",
    "group.manage",
    "role.grant"
  ]
}</div>
      </div>
    `
  },
  {
    num: 57,
    path: 'preview/dev/sdk-typescript.html',
    url: '/dev/sdk-typescript.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official TypeScript / Node.js SDK Documentation',
    subtitle: 'Install, initialize, and execute workflows using @agent-mesh/sdk with combined atomic /inbox',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">@agent-mesh/sdk (TypeScript)</div></div>
        <div class="code-snippet-box">import { AgentMeshClient } from '@agent-mesh/sdk';

const client = new AgentMeshClient({
  endpoint: 'http://localhost:3000',
  identity: 'lane-claude',
  privateKey: process.env.AGENT_MESH_KEY
});

// Single-roundtrip atomic lease + ack loop
let ackIds: string[] = [];
while (true) {
  const batch = await client.inbox.poll({ ackIds, limit: 10, leaseSeconds: 300 });
  ackIds = [];
  for (const msg of batch.messages) {
    console.log('Processing:', msg.payload);
    ackIds.push(msg.id);
  }
}</div>
      </div>
    `
  },
  {
    num: 58,
    path: 'preview/dev/sdk-python.html',
    url: '/dev/sdk-python.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official Python Client SDK Documentation',
    subtitle: 'Python client documentation with asyncio and sync workers',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">agent-mesh (Python)</div></div>
        <div class="code-snippet-box">from agent_mesh import AgentMeshClient
import os

client = AgentMeshClient(
    endpoint="http://localhost:3000",
    identity="lane-claude",
    private_key=os.getenv("AGENT_MESH_KEY")
)

ack_ids = []
for batch in client.inbox.stream(lease_seconds=300):
    for msg in batch:
        print(f"Processing: {msg.payload}")</div>
      </div>
    `
  },
  {
    num: 59,
    path: 'preview/dev/sdk-go.html',
    url: '/dev/sdk-go.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official Go (Golang) SDK Documentation',
    subtitle: 'Lightweight Go SDK documentation with zero external dependencies',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">mesh-go (Golang)</div></div>
        <div class="code-snippet-box">package main

import (
    "fmt"
    "github.com/agent-mesh/mesh-go/mesh"
)

func main() {
    client := mesh.NewClient("http://localhost:3000", "lane-claude", "...")
    batch, _ := client.Inbox.Poll([]string{}, 10, 300)
    fmt.Printf("Received %d messages\\n", len(batch.Messages))
}</div>
      </div>
    `
  },
  {
    num: 60,
    path: 'preview/dev/webhooks.html',
    url: '/dev/webhooks.html',
    suite: 'dev',
    suiteTitle: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Webhook Subscription Manager & Dead-Letter Queue',
    subtitle: 'Subscribe external endpoints to mesh events with HMAC-SHA256 signatures and retry DLQ',
    isImplemented: true,
    html: `
      <div class="card">
        <div class="card-header"><div class="card-title">Webhook Subscriptions</div><button class="btn btn-primary btn-sm" onclick="alert('Webhook ping sent.')">⚡ Test Ping</button></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">https://api.acme-corp.com/hooks/mesh-events · Status: <span class="badge badge-success">Active</span></p>
      </div>
    `
  }
];

// Generate all 60 pages
ALL_SCREENS.forEach(s => {
  const pageHtml = renderRichPage(s.num, s.suite, s.url, s.title, s.subtitle, s.isImplemented, s.html);
  writeFileSync(s.path, pageHtml, 'utf-8');
});

// Generate updated docs/deliverables.md with Status column
let manifestMd = `# Agent Mesh Platform — Complete 60-Screen Deliverables Manifest

This manifest documents the complete catalog of **60 distinct modular enterprise sample screens** delivered for the Agent Mesh Platform.

| # | File Path | Suite | Role | Screen Name & Contract Focus | Status |
|---|-----------|-------|------|------------------------------|--------|
`;

ALL_SCREENS.forEach(s => {
  const statusLabel = s.isImplemented ? '**wired**' : '**content**';
  manifestMd += `| ${s.num} | [\`${s.path}\`](file://${join(process.cwd(), s.path)}) | ${s.suiteTitle} | ${s.role} | ${s.title} | ${statusLabel} |\n`;
});

manifestMd += `\n**Total Deliverables:** Exactly 60 individual screen HTML files + \`preview/index.html\` (Unified Hub) + Common CSS/JS assets.\n`;

writeFileSync('docs/deliverables.md', manifestMd, 'utf-8');
console.log('Successfully generated all 60 rich sample pages and updated docs/deliverables.md!');
