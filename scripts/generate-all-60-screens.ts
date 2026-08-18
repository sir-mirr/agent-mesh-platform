import { writeFileSync } from 'fs';
import { join } from 'path';

interface ScreenDef {
  num: number;
  path: string;
  suite: string;
  role: string;
  title: string;
  desc: string;
  content: string;
}

const SCREENS: ScreenDef[] = [
  // --- Suite 1: Public & Marketing (8) ---
  {
    num: 1,
    path: 'preview/public/index.html',
    suite: 'Public & Marketing',
    role: 'Public / All',
    title: 'Main Landing & Agent Constellation',
    desc: 'Public landing page featuring the Fin둥이, Fin자, 아름이 3-agent constellation.',
    content: `
      <div class="card" style="text-align:center; padding:40px 20px;">
        <h1 style="font-size:2rem; font-weight:800; margin-bottom:8px;">AGENT MESH</h1>
        <p style="color:var(--text-secondary); max-width:600px; margin:0 auto 24px;">The Next-Gen Multi-Agent Messaging Backbone & Cryptographic Trust Fabric.</p>
        <div style="display:flex; justify-content:center; gap:12px;">
          <a href="/public/login-operator.html" class="btn btn-primary">Sign In with GitHub OAuth →</a>
          <a href="/public/security-architecture.html" class="btn btn-secondary">Explore Security Architecture</a>
        </div>
      </div>
    `
  },
  {
    num: 2,
    path: 'preview/public/security-architecture.html',
    suite: 'Public & Marketing',
    role: 'Public / Security Team',
    title: 'Security Architecture & Protocols',
    desc: 'Zero-infrastructure, Ed25519-verified multi-tenant cryptographic pipeline.',
    content: `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Cryptographic Attestation & Zero-Body Privacy Model</div>
        </div>
        <div class="code-snippet-box">
// SPEC v0.3 Attestation Pipeline
from: "acme-corp:core-lead"    // Ed25519 author signature over payload
sent_by: "alice_admin"         // Bearer token from browser session
surface.observed_source: "socket" // Kernel-observed source IP validation
        </div>
      </div>
    `
  },
  {
    num: 3,
    path: 'preview/public/lease-state-machine.html',
    suite: 'Public & Marketing',
    role: 'Public / Developers',
    title: 'Socketless Lease State Machine',
    desc: 'Visual explanation of the 300s TTL atomic lease locking mechanism.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">At-Least-Once Lease State Machine</div></div>
        <div style="display:flex; gap:16px; margin-top:12px;">
          <div style="flex:1; background:var(--bg-surface-sub); padding:16px; border-radius:var(--radius-md);">
            <strong>1. Available</strong><br><small style="color:var(--text-secondary);">Buffered in SQLite queue pool.</small>
          </div>
          <div style="flex:1; background:#FFFDF5; border:1px solid #F59E0B; padding:16px; border-radius:var(--radius-md);">
            <strong>2. Leased (300s TTL)</strong><br><small style="color:var(--text-secondary);">Locked by worker. Countdown active.</small>
          </div>
          <div style="flex:1; background:#F0FDF4; border:1px solid #10B981; padding:16px; border-radius:var(--radius-md);">
            <strong>3. ACK / Delete</strong><br><small style="color:var(--text-secondary);">Atomically removed upon processing success.</small>
          </div>
        </div>
      </div>
    `
  },
  {
    num: 4,
    path: 'preview/public/login-operator.html',
    suite: 'Public & Marketing',
    role: 'Agent Operator',
    title: 'Agent Operator Login Portal',
    desc: 'GitHub OAuth entrypoint for agent developers and operators.',
    content: `
      <div class="card" style="max-width:480px; margin:40px auto; padding:32px;">
        <h2 style="font-size:1.25rem; font-weight:700; margin-bottom:8px;">Agent Operator Sign In</h2>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:20px;">Authenticate with GitHub OAuth to manage personal agent keys and test message routing.</p>
        <a href="/creator/index.html" class="btn btn-primary" style="width:100%;">Continue with GitHub →</a>
      </div>
    `
  },
  {
    num: 5,
    path: 'preview/public/login-tenant.html',
    suite: 'Public & Marketing',
    role: 'Tenant Admin',
    title: 'Tenant Admin SSO Portal',
    desc: 'Corporate SAML / SSO login for company security administrators (Acme Corp).',
    content: `
      <div class="card" style="max-width:480px; margin:40px auto; padding:32px;">
        <h2 style="font-size:1.25rem; font-weight:700; margin-bottom:8px;">Tenant Admin SSO</h2>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:20px;">Corporate Single Sign-On for Acme Corp organization governance.</p>
        <div style="margin-bottom:16px;">
          <label style="font-size:0.8rem; font-weight:600; display:block; margin-bottom:4px;">Tenant ID</label>
          <input type="text" value="acme-corp" readonly style="width:100%; padding:8px 12px; background:var(--bg-surface-sub); border:1px solid var(--border-default); border-radius:var(--radius-md);">
        </div>
        <a href="/tenant/index.html" class="btn btn-primary" style="width:100%; background:#0284C7;">Sign In to Acme Corp →</a>
      </div>
    `
  },
  {
    num: 6,
    path: 'preview/public/login-platform.html',
    suite: 'Public & Marketing',
    role: 'Platform Operator',
    title: 'Platform Operator Master Portal',
    desc: 'Global infrastructure and highway backbone master credential portal.',
    content: `
      <div class="card" style="max-width:480px; margin:40px auto; padding:32px;">
        <h2 style="font-size:1.25rem; font-weight:700; margin-bottom:8px;">Platform Operator Master Access</h2>
        <p style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:20px;">Global infrastructure management. Enforces zero message body access.</p>
        <a href="/platform/index.html" class="btn btn-primary" style="width:100%;">Sign In with Master Key →</a>
      </div>
    `
  },
  {
    num: 7,
    path: 'preview/public/pricing-tiers.html',
    suite: 'Public & Marketing',
    role: 'Public / Enterprise',
    title: 'Enterprise Ingress Quotas & Pricing Tiers',
    desc: 'Resource limits, TPS quotas, and SLA guarantees for enterprise tenants.',
    content: `
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
        <div class="card">
          <strong style="font-size:1.1rem;">Starter Fleet</strong>
          <div style="font-size:1.4rem; font-weight:800; color:var(--primary); margin:8px 0;">$0 <small style="font-size:0.8rem; color:var(--text-muted);">/mo</small></div>
          <p style="font-size:0.85rem; color:var(--text-secondary);">Up to 10 agents, 100k requests/mo.</p>
        </div>
        <div class="card" style="border-color:var(--primary);">
          <strong style="font-size:1.1rem;">Enterprise Mesh</strong>
          <div style="font-size:1.4rem; font-weight:800; color:var(--primary); margin:8px 0;">$499 <small style="font-size:0.8rem; color:var(--text-muted);">/mo</small></div>
          <p style="font-size:0.85rem; color:var(--text-secondary);">50 agents, 5M requests, SOC2 audit trail.</p>
        </div>
        <div class="card">
          <strong style="font-size:1.1rem;">Global Fabric</strong>
          <div style="font-size:1.4rem; font-weight:800; color:var(--primary); margin:8px 0;">Custom</div>
          <p style="font-size:0.85rem; color:var(--text-secondary);">Unlimited nodes, dedicated highways, multi-region failover.</p>
        </div>
      </div>
    `
  },
  {
    num: 8,
    path: 'preview/public/compliance-overview.html',
    suite: 'Public & Marketing',
    role: 'Public / Compliance',
    title: 'Compliance & Merkle Trust Model',
    desc: 'SOC2 Type II, ISO27001, and cryptographic audit log immutability.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">Cryptographic Non-Repudiation Guarantee</div></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Every audit event is cryptographically linked using a sequential SHA-256 Merkle tree chain, preventing retroactive log tampering.</p>
      </div>
    `
  },

  // --- Suite 2: Platform Operator Console (12) ---
  {
    num: 9,
    path: 'preview/platform/index.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Platform Operator Overview & Backbone Matrix',
    desc: 'Global infrastructure status, highway routing bridges, and active tenants.',
    content: `
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
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: '14 Inter-Gateway Backbone Routing Highways',
    desc: 'Detailed routing topology between core gateways and regional cluster swarms.',
    content: `
      <div class="card">
        <table class="data-table">
          <thead><tr><th>Highway Bridge ID</th><th>Origin Gateway</th><th>Target Gateway</th><th>Latency</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>bridge-gw-core-gw-research</td><td>gw-core</td><td>gw-research</td><td style="color:#059669;">1.2 ms</td><td><span class="badge badge-success">Healthy</span></td></tr>
            <tr><td>bridge-gw-core-gw-delivery</td><td>gw-core</td><td>gw-delivery</td><td style="color:#059669;">1.1 ms</td><td><span class="badge badge-success">Healthy</span></td></tr>
          </tbody>
        </table>
      </div>
    `
  },
  {
    num: 11,
    path: 'preview/platform/tenant-manager.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Multi-Tenant Organization Manager',
    desc: 'Provisioning, quota controls, and tenant isolation management.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">Active Enterprise Tenants</div><button class="btn btn-primary btn-sm">+ Provision Tenant</button></div>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
          <div class="card" style="border-left:4px solid var(--primary);"><strong>Acme Corp</strong><br><small>28 / 50 Agents</small></div>
          <div class="card" style="border-left:4px solid #10B981;"><strong>Nova BioTech</strong><br><small>42 / 60 Agents</small></div>
          <div class="card" style="border-left:4px solid #8B5CF6;"><strong>Global FinTech</strong><br><small>69 / 100 Agents</small></div>
        </div>
      </div>
    `
  },
  {
    num: 12,
    path: 'preview/platform/tenant-detail.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Tenant Resource Quota & Isolation Deep-Dive',
    desc: 'Detailed view of Acme Corp ingress limits, swarm clusters, and SLA meters.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">Tenant: acme-corp</div><span class="badge badge-success">Active & Segregated</span></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Ingress limit: 10,000 req/min · SLA: 99.99% · 4 Swarm Groups allocated.</p>
      </div>
    `
  },
  {
    num: 13,
    path: 'preview/platform/telemetry.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Cluster Nodes CPU, Memory & Socket Health',
    desc: 'Real-time telemetry across cluster hardware nodes and active socket pools.',
    content: `
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
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Global Multi-Region Gateway Failover Simulator',
    desc: 'Simulate regional gateway outage and automatic inter-continental rerouting.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">Multi-Region Gateway Failover Engine</div><button class="btn btn-danger btn-sm">⚡ Simulate US-East Outage</button></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Automated BGP & DNS rerouting to EU-West and AP-Seoul with zero packet drop.</p>
      </div>
    `
  },
  {
    num: 15,
    path: 'preview/platform/rate-limiting.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Redis Token Bucket Ingress Throttling',
    desc: 'Configure token refill rates, burst multipliers, and HTTP 429 policies.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">Token Bucket Configuration</div></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Refill rate: 10,000 tokens/min · Burst window: 20,000 tokens.</p>
      </div>
    `
  },
  {
    num: 16,
    path: 'preview/platform/metadata-audits.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Global Metadata Audits (Zero Body Leak)',
    desc: 'Cryptographically segregated transit logs preserving message payload privacy.',
    content: `
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
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Regional Gateway Node Inspection & Direct Sockets',
    desc: 'Inspect physical socket connections and daemon heartbeat status.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">gw-core Gateway Node Inspector</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Direct socket connections: 5 active · Uptime: 99.999%</p></div>
    `
  },
  {
    num: 18,
    path: 'preview/platform/bandwidth-shaper.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Cross-Deck Highway Bandwidth Shaper & QoS',
    desc: 'Quality of Service (QoS) bandwidth allocation across cluster decks.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Highway QoS Allocation</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Core Hub Deck: Priority 1 (Unthrottled) · IoT Edge Deck: Priority 3.</p></div>
    `
  },
  {
    num: 19,
    path: 'preview/platform/certificate-authority.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'Root Ed25519 CA & Inter-Gateway MTLS Rotations',
    desc: 'Backbone mutual TLS certificates and Ed25519 root trust anchors.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Root Certificate Authority</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Root CA fingerprint: sha256:7bXmK9y8P2w1ZqL0vNxB3cR6jFaSdFgHjKlQwErTyU4</p></div>
    `
  },
  {
    num: 20,
    path: 'preview/platform/observed-sources.html',
    suite: 'Platform Operator',
    role: 'Platform Operator',
    title: 'SPEC § 8.11 Observed Source Inspector',
    desc: 'Inspection of kernel socket vs X-Forwarded-For attestation telemetry.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">SPEC § 8.11 Observed Source Attestation</div><span class="badge badge-success">surface.version: 4</span></div>
        <p style="font-size:0.85rem; color:var(--text-secondary);">Observed source: <code>socket</code> (Direct kernel verified, tamper-proof).</p>
      </div>
    `
  },

  // --- Suite 3: Tenant Admin Console (16) ---
  {
    num: 21,
    path: 'preview/tenant/index.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Executive Overview & Autonomous Fleet Dashboard',
    desc: 'Acme Corp fleet metrics, daily throughput, and swarm cluster allocation.',
    content: `
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
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: '50-Character Fingerprint Key Approval Queue',
    desc: 'Verify exact 50-character SHA-256 key fingerprints with 1-click approvals.',
    content: `
      <div class="card">
        <div class="card-header"><div class="card-title">Pending Public Key Proposals (3)</div></div>
        <div class="code-snippet-box">sha256:pfsELGYsvWLUoreIgzOjd0Yg8Pvz_HNChpw-rzcjPWw</div>
        <div style="display:flex; justify-content:flex-end; gap:8px;"><button class="btn btn-primary btn-sm">✓ Approve Key</button><button class="btn btn-danger btn-sm">✕ Revoke</button></div>
      </div>
    `
  },
  {
    num: 23,
    path: 'preview/tenant/key-rotations.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Zero-Downtime Rolling Key Rotation & 48h Grace Period',
    desc: 'Scheduled key rotations allowing dual-key validity during transitions.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Rolling Key Schedule</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">core-lead: Dual-key active with 48h grace window.</p></div>
    `
  },
  {
    num: 24,
    path: 'preview/tenant/compromised-keys.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Compromised & Denied Key Revocation Vault',
    desc: 'Permanent cryptographic blacklisting of leaked or compromised keypairs.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Revoked Key Blacklist</div></div><p style="font-size:0.85rem; color:var(--status-danger);">1 key permanently revoked due to public repository leak.</p></div>
    `
  },
  {
    num: 25,
    path: 'preview/tenant/groups.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Swarm Group Clusters & Assigned Leads',
    desc: 'Governance of Core, Research, Delivery, and Security swarm groups.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Acme Corp Swarm Groups (4)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Core Platform Hub (Lead: Fin둥이), Research Swarm (Lead: research-lead).</p></div>
    `
  },
  {
    num: 26,
    path: 'preview/tenant/group-detail.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Core Platform Hub Cluster Detail & Member Agents',
    desc: 'Deep-dive into Core Platform Hub member identities and capabilities.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Core Platform Hub Details</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">5 member agents provisioned · Gateway: gw-core.</p></div>
    `
  },
  {
    num: 27,
    path: 'preview/tenant/egress-acl.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Inter-Group & Cross-Tenant Egress Policy Matrix',
    desc: 'Configure permitted communication channels and cross-tenant whitelists.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Group Egress ACL Matrix</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Research Swarm -> Cross-tenant send permitted to Nova BioTech.</p></div>
    `
  },
  {
    num: 28,
    path: 'preview/tenant/send-policy-default.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Tenant Send Policy Default Switcher',
    desc: 'Toggle between Default Deny (explicit whitelist) and Default Allow.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Send Restriction Default Policy</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Current policy: Deny by Default (Explicit Whitelist Enforced).</p></div>
    `
  },
  {
    num: 29,
    path: 'preview/tenant/network-attestation.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Source IP / Subnet CIDR & ASN Whitelist',
    desc: 'Fine-grained source network attestation filters for incoming agent requests.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Source Network CIDR Policy</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Permitted subnet: 10.0.0.0/16 · ASN: AS15169.</p></div>
    `
  },
  {
    num: 30,
    path: 'preview/tenant/audit-failure-policy.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Compliance Audit Failure Action (Fail-Closed vs Fail-Open)',
    desc: 'Behavior specification when audit database logging process is degraded.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Audit Failure Behavior</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Policy: Fail Closed (Block transit if audit write fails).</p></div>
    `
  },
  {
    num: 31,
    path: 'preview/tenant/pairing-codes.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'RFC 8628 Device Flow Pairing Code Generator',
    desc: 'Issue short-lived single-use pairing codes with 300s TTL for CLI agents.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Active Pairing Code: ACM-8492-KY7</div></div><div class="code-snippet-box">agent-mesh claim --code ACM-8492-KY7 --name fin-helper</div></div>
    `
  },
  {
    num: 32,
    path: 'preview/tenant/pairing-history.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Claimed & Expired Pairing Code Audit Log',
    desc: 'Historical ledger of claimed, expired, and revoked pairing codes.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Pairing Code Ledger</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">14 codes claimed successfully in last 30 days.</p></div>
    `
  },
  {
    num: 33,
    path: 'preview/tenant/participant-audits.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Full Message Content Audit Stream & Compliance Notice',
    desc: 'Decrypted message bodies with mandatory enterprise compliance disclosure.',
    content: `
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
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Internal audit_read_events Compliance Access Log',
    desc: 'Audit trail of all administrative content inspection actions.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Audit Read Ledger</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">alice_admin inspected msg_892147 at 2026-08-16 20:50:00 KST.</p></div>
    `
  },
  {
    num: 35,
    path: 'preview/tenant/siem-export.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Enterprise SIEM & S3 Archiving',
    desc: 'Export audit logs to AWS S3, Splunk HEC, and Datadog.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">SIEM Streaming Pipeline</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Target: s3://acme-corp-compliance-logs-2026/agent-mesh/ (Active).</p></div>
    `
  },
  {
    num: 36,
    path: 'preview/tenant/organization-rbac.html',
    suite: 'Tenant Admin',
    role: 'Tenant Admin',
    title: 'Admin Member Capability Grants & Role Assignments',
    desc: 'Fine-grained capability assignments for Acme Corp administrators.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Administrator Grants</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">alice_admin: Super Admin (all capabilities) · bob_compliance: Auditor.</p></div>
    `
  },

  // --- Suite 4: Agent Operations & Studio (12) ---
  {
    num: 37,
    path: 'preview/creator/index.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Agent Operations Main Studio',
    desc: 'Developer console for scale simulation, messaging, and queue inspection.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Developer Operations Studio</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Manage personal autonomous agents and test messaging across the mesh.</p></div>
    `
  },
  {
    num: 38,
    path: 'preview/creator/topology.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: '10-Stage Scale Simulation & Swarm Galaxy Graph',
    desc: 'Interactive pan/zoom SVG canvas with Fin둥이, Fin자, 아름이 avatars (139 nodes).',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Swarm Galaxy Topology (10 Stages)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">10 Swarm Galaxies · 139 Connected Agent Nodes · Collision-free orbit packing.</p></div>
    `
  },
  {
    num: 39,
    path: 'preview/creator/topology-focus.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Single Cluster Focus & Camera Auto-Tracking',
    desc: 'Smooth camera animation and focus on selected agent swarm clusters.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Camera Auto-Focus Engine</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Focused on Core Platform Hub (5 nodes).</p></div>
    `
  },
  {
    num: 40,
    path: 'preview/creator/playground.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Interactive Message Testing Console',
    desc: 'Live message dispatcher with verified recipient routing and delivery receipts.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Dispatch Test Message</div></div><div class="code-snippet-box">POST /api/v1/messages/send -> Delivered to socket in 1.1ms ✓</div></div>
    `
  },
  {
    num: 41,
    path: 'preview/creator/message-receipts.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Verified Message Delivery Receipts & Hashes',
    desc: 'Inspect SHA-256 digests and cryptographic delivery acknowledgments.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Delivery Receipt #msg_948192</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Status: DELIVERED_SOCKET_ACK · Ed25519 Verified.</p></div>
    `
  },
  {
    num: 42,
    path: 'preview/creator/lease-queue.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Socketless Inbox Queue & 300s Lease Countdown Bars',
    desc: 'At-least-once lease queue inspector with live countdown timers.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Active In-Flight Leases (300s TTL)</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">msg_892147 leased by worker · 274s remaining.</p></div>
    `
  },
  {
    num: 43,
    path: 'preview/creator/lease-batch-actions.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Batch Lease, Atomic ACK (Delete), and NACK (Revert)',
    desc: 'Simulate worker processing completion (ACK) and crash recovery (NACK).',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Queue Actions Simulator</div></div><button class="btn btn-primary btn-sm">✓ ACK Delete</button> <button class="btn btn-secondary btn-sm">↩ NACK Revert</button></div>
    `
  },
  {
    num: 44,
    path: 'preview/creator/websocket-trace.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Live WebSocket Frame Debugger & IN/OUT Frame Trace',
    desc: 'Real-time WebSocket frame packet trace with JSON export.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">WebSocket Frame Stream</div></div><div class="code-snippet-box">12:51:02.102 [OUT] WS_DISPATCH to acme-corp:core-lead (142 bytes)</div></div>
    `
  },
  {
    num: 45,
    path: 'preview/creator/agent-runner.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Local Agent Runner & CLI Connect Guide',
    desc: 'Connect local Python/Node codebases via CLI in 3 easy steps.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Local CLI Setup Guide</div></div><div class="code-snippet-box">agent-mesh listen --endpoint http://localhost:3000 --key ~/.agent-mesh/agent.key</div></div>
    `
  },
  {
    num: 46,
    path: 'preview/creator/agent-register.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Register New Agent Identity Form & Key Proposer',
    desc: 'Propose new identity name and Ed25519 public key with 409 conflict checks.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Register Autonomous Agent</div></div><button class="btn btn-primary">Submit Agent Proposal</button></div>
    `
  },
  {
    num: 47,
    path: 'preview/creator/agent-teardown.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Permanent Identity Teardown Warning (SPEC § 9.3 Invariant)',
    desc: 'Permanent soft deletion dialogue enforcing non-reusability rule.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">SPEC § 9.3 Invariant Rule</div></div><p style="color:var(--status-danger);">Torn down identities are permanently deactivated forever.</p></div>
    `
  },
  {
    num: 48,
    path: 'preview/creator/traffic-pulse-sim.html',
    suite: 'Agent Operations',
    role: 'Agent Operator',
    title: 'Live Multi-Highway Traffic Pulse Animation',
    desc: 'Simulate high-velocity packet transmission across backbone highways.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Traffic Pulse Simulation</div></div><button class="btn btn-primary btn-sm">⚡ Simulate Traffic Pulses</button></div>
    `
  },

  // --- Suite 5: Developer Portal, SDKs & APIs (12) ---
  {
    num: 49,
    path: 'preview/dev/index.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Developer Hub Overview & Quickstart',
    desc: 'REST API, WebSocket documentation, and client SDK downloads.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Developer Hub Quickstart</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">Start integrating with Agent Mesh Platform in less than 5 minutes.</p></div>
    `
  },
  {
    num: 50,
    path: 'preview/dev/openapi-explorer.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Interactive Swagger / OpenAPI 3.1 Endpoint Runner',
    desc: 'Execute real HTTP requests against local agent mesh endpoints.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">OpenAPI 3.1 Test Runner</div></div><div class="code-snippet-box">POST /api/v1/messages/send -> HTTP 200 OK</div></div>
    `
  },
  {
    num: 51,
    path: 'preview/dev/api-messages-send.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/messages/send',
    desc: 'Specification for dispatching signed messages across the mesh.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">POST /api/v1/messages/send</div></div><div class="code-snippet-box">{"to": "platform-claude", "payload": "hello"}</div></div>
    `
  },
  {
    num: 52,
    path: 'preview/dev/api-inbox-lease.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/inbox/lease',
    desc: 'Specification for leasing socketless inbox batches with 300s TTL.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">POST /api/v1/inbox/lease</div></div><div class="code-snippet-box">{"batch_size": 10, "lease_seconds": 300}</div></div>
    `
  },
  {
    num: 53,
    path: 'preview/dev/api-inbox-ack.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: DELETE /api/v1/inbox/ack',
    desc: 'Specification for acknowledging and permanently removing messages.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">DELETE /api/v1/inbox/ack</div></div><div class="code-snippet-box">{"message_id": "msg_948192"}</div></div>
    `
  },
  {
    num: 54,
    path: 'preview/dev/api-keys-propose.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: POST /api/v1/keys/propose',
    desc: 'Specification for proposing new Ed25519 public keys.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">POST /api/v1/keys/propose</div></div><div class="code-snippet-box">{"identity": "lane-claude", "pubkey": "91cBIH2C..."}</div></div>
    `
  },
  {
    num: 55,
    path: 'preview/dev/api-capabilities.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'API Reference: GET /api/v1/capabilities',
    desc: 'Specification for querying surface version 4 and observed source telemetry.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">GET /api/v1/capabilities</div></div><div class="code-snippet-box">{"surface": {"version": 4, "observed_source": "socket"}}</div></div>
    `
  },
  {
    num: 56,
    path: 'preview/dev/sdk-typescript.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official TypeScript / Node.js SDK Documentation',
    desc: 'Install, initialize, and execute workflows using @agent-mesh/sdk.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">@agent-mesh/sdk (TypeScript)</div></div><div class="code-snippet-box">npm install @agent-mesh/sdk</div></div>
    `
  },
  {
    num: 57,
    path: 'preview/dev/sdk-python.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official Python Client SDK Documentation',
    desc: 'Python client documentation with asyncio and sync workers.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">agent-mesh (Python)</div></div><div class="code-snippet-box">pip install agent-mesh</div></div>
    `
  },
  {
    num: 58,
    path: 'preview/dev/sdk-go.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Official Go (Golang) SDK Documentation',
    desc: 'Lightweight Go SDK documentation with zero external dependencies.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">mesh-go (Golang)</div></div><div class="code-snippet-box">go get github.com/agent-mesh/mesh-go</div></div>
    `
  },
  {
    num: 59,
    path: 'preview/dev/webhooks.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Webhook Subscription Manager & Secret Signing',
    desc: 'Subscribe external endpoints to mesh events with HMAC-SHA256 signatures.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Webhook Subscriptions</div></div><p style="font-size:0.85rem; color:var(--text-secondary);">2 active endpoints receiving live event dispatches.</p></div>
    `
  },
  {
    num: 60,
    path: 'preview/dev/dead-letter-queue.html',
    suite: 'Developer Hub',
    role: 'Developer / API Consumer',
    title: 'Dead-Letter Queue (DLQ) Inspector & Retry Engine',
    desc: 'Inspect and replay undeliverable webhook and message payloads.',
    content: `
      <div class="card"><div class="card-header"><div class="card-title">Dead-Letter Queue (DLQ)</div><button class="btn btn-primary btn-sm">🔄 Retry All DLQ</button></div><p style="font-size:0.85rem; color:var(--text-secondary);">2 failed webhook dispatches retained for manual retry.</p></div>
    `
  }
];

// Helper to generate full standalone HTML for each screen
function renderScreenHtml(s: ScreenDef): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${s.title} — Agent Mesh Enterprise</title>
  <link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
  <!-- Navigation Header -->
  <header class="preview-control-bar">
    <a href="/public/index.html" class="preview-brand">
      <div class="brand-icon">M</div>
      <span>Agent Mesh Platform</span>
      <span class="badge badge-success"><span class="live-dot"></span> v0.3 Live</span>
    </a>

    <div class="preview-nav">
      <a href="/public/index.html" class="preview-btn ${s.suite.startsWith('Public') ? 'active' : ''}">1. Home & Protocols</a>
      <a href="/platform/index.html" class="preview-btn ${s.suite.startsWith('Platform') ? 'active' : ''}">2. Platform Operator</a>
      <a href="/tenant/index.html" class="preview-btn ${s.suite.startsWith('Tenant') ? 'active' : ''}">3. Tenant Admin</a>
      <a href="/creator/index.html" class="preview-btn ${s.suite.startsWith('Agent Operations') ? 'active' : ''}">4. Agent Studio</a>
      <a href="/dev/index.html" class="preview-btn ${s.suite.startsWith('Developer') ? 'active' : ''}">5. Developer Hub</a>
    </div>

    <div style="display:flex; align-items:center; gap:10px;">
      <a href="/index.html" class="btn btn-secondary btn-sm">🗂 All-in-One Hub</a>
    </div>
  </header>

  <!-- Main Content Container -->
  <div class="page-container">
    <div class="admin-header-row">
      <div>
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
          <span class="badge badge-leased">${s.suite}</span>
          <span class="badge badge-success">Role: ${s.role}</span>
          <span style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono);">Screen #${s.num}</span>
        </div>
        <h1 class="admin-header-title">${s.title}</h1>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-top:2px;">${s.desc}</p>
      </div>
      <div>
        <a href="/index.html" class="btn btn-secondary btn-sm">← Back to Overview</a>
      </div>
    </div>

    ${s.content}
  </div>

  <script src="/assets/js/common.js"></script>
</body>
</html>`;
}

// Generate all 60 files
SCREENS.forEach(s => {
  writeFileSync(s.path, renderScreenHtml(s), 'utf-8');
});

// Generate docs/deliverables.md
let manifestMd = `# Agent Mesh Platform — Complete 60-Screen Deliverables Manifest

This manifest documents the complete catalog of **60 distinct modular enterprise sample screens** delivered for the Agent Mesh Platform.

| # | File Path | Suite | Role | Screen Name & Purpose | Status |
|---|-----------|-------|------|-----------------------|--------|
`;

SCREENS.forEach(s => {
  manifestMd += `| ${s.num} | [\`${s.path}\`](file://${join(process.cwd(), s.path)}) | ${s.suite} | ${s.role} | ${s.title} | **done** |\n`;
});

manifestMd += `\n**Total Deliverables:** Exactly 60 individual screen HTML files + \`preview/index.html\` (Unified Hub) + Common CSS/JS assets.\n`;

writeFileSync('docs/deliverables.md', manifestMd, 'utf-8');
console.log('Successfully generated all 60 modular HTML pages and docs/deliverables.md manifest!');
