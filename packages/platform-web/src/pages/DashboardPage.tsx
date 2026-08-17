import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  PageHeader,
  KpiCard,
  TelemetryCard,
  StatusBadge,
  FingerprintBox,
  DataTable,
  Button,
} from "@/components/index.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";
import type { UserRole } from "@/types/auth.ts";

export function DashboardPage() {
  const { user, switchRole } = useAuth();
  const { t } = useI18n();

  const currentRole: UserRole = user?.role || "AGENT_OPERATOR";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* 1. Header with Role Indicator & Quick Switcher for Testing */}
      <PageHeader
        suiteTag={
          currentRole === "PLATFORM_ADMIN"
            ? "PLATFORM SUITE · ADMIN MASTER"
            : currentRole === "TENANT_ADMIN"
            ? "TENANT SUITE · GOVERNANCE"
            : currentRole === "GROUP_ADMIN"
            ? "STUDIO SUITE · GROUP MANAGER"
            : "STUDIO SUITE · OPERATOR"
        }
        suiteBadgeColor="leased"
        screenId="DASH-01"
        title={
          currentRole === "PLATFORM_ADMIN"
            ? t("dash.platform.title", "플랫폼 인프라 & 글로벌 허브 대시보드")
            : currentRole === "TENANT_ADMIN"
            ? t("dash.tenant.title", "테넌트 조직 거버넌스 & 플릿 대시보드")
            : currentRole === "GROUP_ADMIN"
            ? t("dash.group.title", "에이전트 그룹 운영 관리 대시보드")
            : t("dash.operator.title", "소유 에이전트 운영 대시보드")
        }
        subtitle={
          currentRole === "PLATFORM_ADMIN"
            ? t("dash.platform.sub", "글로벌 분산 노드 토폴로지, 실시간 CPU/RAM 부하 및 테넌트 트래픽 격리 상태")
            : currentRole === "TENANT_ADMIN"
            ? t("dash.tenant.sub", "조직 소속 에이전트 그룹, 그룹 간 Egress 통신 정책 및 보안 감사 현황")
            : currentRole === "GROUP_ADMIN"
            ? t("dash.group.sub", "담당 그룹별 에이전트 멤버십 이동, 소켓리스 큐 적체 및 그룹 간 통신 모니터링")
            : t("dash.operator.sub", "소유한 Ed25519 에이전트 연결 상태, 소켓리스 인박스 큐 및 메시지 테스트")
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.location.reload()}
            >
              ↻ {t("common.refresh", "새로고침")}
            </Button>
            {currentRole === "AGENT_OPERATOR" && (
              <Link to="/creator/register">
                <Button variant="primary" size="sm">
                  {t("nav.register", "➕ 신규 에이전트 등록")}
                </Button>
              </Link>
            )}
            {currentRole === "GROUP_ADMIN" && (
              <Link to="/creator/groups">
                <Button variant="primary" size="sm">
                  {t("groups.createBtn", "➕ 그룹 생성")}
                </Button>
              </Link>
            )}
            {currentRole === "TENANT_ADMIN" && (
              <Link to="/tenant/egress-acl">
                <Button variant="primary" size="sm">
                  {t("nav.egress", "🛡️ Egress ACL 설정")}
                </Button>
              </Link>
            )}
            {currentRole === "PLATFORM_ADMIN" && (
              <Link to="/creator/topology">
                <Button variant="primary" size="sm">
                  {t("nav.topology", "🌐 토폴로지 열기")}
                </Button>
              </Link>
            )}
          </div>
        }
      />

      {/* 2. Role-Tailored KPI Cards & Views */}
      {currentRole === "PLATFORM_ADMIN" && <PlatformAdminDashboard />}
      {currentRole === "TENANT_ADMIN" && <TenantAdminDashboard />}
      {currentRole === "GROUP_ADMIN" && <GroupAdminDashboard />}
      {currentRole === "AGENT_OPERATOR" && <AgentOperatorDashboard />}
    </div>
  );
}

/* =========================================================================
   1. PLATFORM ADMIN DASHBOARD VIEW (👑 플랫폼 관리자)
   ========================================================================= */
function PlatformAdminDashboard() {
  const { t } = useI18n();

  return (
    <>
      {/* Top Global KPI Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.pa.nodes", "전체 에이전트 노드")}
          value="139"
          subValue={t("dash.pa.nodesSub", "10개 그룹 갤럭시")}
          color="var(--color-primary)"
          icon="🌐"
        />
        <KpiCard
          label={t("dash.pa.sockets", "활성 웹소켓 풀")}
          value="108"
          subValue={t("dash.pa.socketsSub", "mTLS 연결")}
          color="var(--color-success)"
          icon="⚡"
          trend={{ value: "+8", isPositive: true }}
        />
        <KpiCard
          label={t("dash.pa.tenants", "활성 테넌트 조직")}
          value="4"
          subValue={t("dash.pa.tenantsSub", "Acme, Nova, Fin, Edge")}
          color="#6366F1"
          icon="🏢"
        />
        <KpiCard
          label={t("dash.pa.latency", "허브 p99 지연")}
          value="24ms"
          subValue={t("dash.pa.latencySub", "정상 SLA 99.99%")}
          color="var(--color-warning)"
          icon="⏱️"
        />
      </div>

      {/* Live Server Telemetry */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <TelemetryCard
          label="서버 CPU 부하"
          currentValue="14.2%"
          maxLabel="100%"
          percentage={14.2}
          barColor="var(--color-success)"
          statusText="정상 가동 중"
        />
        <TelemetryCard
          label="프로세스 메모리 (RAM)"
          currentValue="148 MB"
          maxLabel="1,024 MB"
          percentage={14.5}
          barColor="var(--color-primary)"
          statusText="여유 공간 충분"
        />
        <TelemetryCard
          label="소켓리스 리스 TTL (300s)"
          currentValue="248s"
          maxLabel="300s"
          percentage={82.6}
          barColor="var(--color-leased)"
          statusText="리스 임대 활성"
        />
      </div>

      {/* Tenant Resource & Traffic Breakdown */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
              {t("dash.pa.tenantTrafficTitle", "테넌트 조직별 트래픽 및 그룹 할당 현황")}
            </h3>
            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
              SPEC § 8.11 테넌트별 Egress 격리 및 처리량 모니터링
            </p>
          </div>
          <Link to="/platform/tenants">
            <Button variant="ghost" size="sm">
              {t("dash.viewDetail", "상세 분석 보기 →")}
            </Button>
          </Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          {[
            { name: "Acme Corp", groups: 4, agents: 43, rps: "1,240 req/s", quota: "42%" },
            { name: "Nova BioTech", groups: 3, agents: 38, rps: "890 req/s", quota: "28%" },
            { name: "Global FinTech", groups: 2, agents: 32, rps: "640 req/s", quota: "19%" },
            { name: "Edge IoT Lab", groups: 1, agents: 26, rps: "310 req/s", quota: "11%" },
          ].map((tnt) => (
            <div
              key={tnt.name}
              style={{
                background: "var(--color-bg-surface-sub)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-lg)",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, color: "var(--color-text-primary)", fontSize: "0.95rem" }}>
                  {tnt.name}
                </span>
                <span style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--color-primary)", fontWeight: 700 }}>
                  {tnt.quota} Quota
                </span>
              </div>
              <div style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", display: "flex", gap: 12 }}>
                <span>그룹: <strong>{tnt.groups}개</strong></span>
                <span>에이전트: <strong>{tnt.agents}노드</strong></span>
                <span>처리량: <strong>{tnt.rps}</strong></span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   2. TENANT ADMIN DASHBOARD VIEW (🏢 테넌트 관리자)
   ========================================================================= */
function TenantAdminDashboard() {
  const { t } = useI18n();

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.ta.groups", "조직 소속 그룹")}
          value="3"
          subValue={t("dash.ta.groupsSub", "Support, Billing, Analytics")}
          color="var(--color-primary)"
          icon="👥"
        />
        <KpiCard
          label={t("dash.ta.agents", "총 소속 에이전트")}
          value="4"
          subValue={t("dash.ta.agentsSub", "3명 활성, 1명 소켓리스")}
          color="var(--color-success)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.ta.egress", "Egress 허용 규칙")}
          value="2"
          subValue={t("dash.ta.egressSub", "Deny-by-default")}
          color="#6366F1"
          icon="🛡️"
        />
        <KpiCard
          label={t("dash.ta.approval", "미승인 키 대기 큐")}
          value="1"
          subValue={t("dash.ta.approvalSub", "승인 필요")}
          color="var(--color-warning)"
          icon="🔑"
        />
      </div>

      {/* Group & Egress Governance Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 16 }}>
        {/* Groups Summary */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ fontSize: "0.98rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
              {t("dash.ta.groupFleet", "조직 에이전트 그룹 현황")}
            </h3>
            <Link to="/creator/groups">
              <Button variant="ghost" size="sm">{t("common.manage", "관리 →")}</Button>
            </Link>
          </div>

          {[
            { id: "grp_support", name: "Support Group", count: 2, desc: "고객 지원 및 자동 응답 에이전트 그룹" },
            { id: "grp_billing", name: "Billing Core", count: 1, desc: "정산 및 인보이스 결제 처리 그룹" },
            { id: "grp_analytics", name: "Analytics Group", count: 1, desc: "시장 인텔리전스 및 데이터 수집 워커 그룹" },
          ].map((g) => (
            <div
              key={g.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 14px",
                background: "var(--color-bg-surface-sub)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--color-text-primary)" }}>
                  {g.name}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
                  {g.desc}
                </div>
              </div>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontSize: "0.78rem",
                  padding: "2px 8px",
                  borderRadius: "var(--radius-full)",
                  background: "var(--color-primary-light)",
                  color: "var(--color-primary)",
                }}
              >
                {g.count} 에이전트
              </span>
            </div>
          ))}
        </div>

        {/* Pending Key Approval & Egress Rule Summary */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ fontSize: "0.98rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
              {t("dash.ta.pendingApproval", "신규 에이전트 공개키 승인 대기 큐")}
            </h3>
            <Link to="/tenant/rbac">
              <Button variant="ghost" size="sm">{t("common.rbac", "RBAC →")}</Button>
            </Link>
          </div>

          <div
            style={{
              padding: "12px 14px",
              background: "#FFFBEB",
              border: "1px solid #FDE68A",
              borderRadius: "var(--radius-md)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: "0.85rem", color: "#92400E" }}>
                🔑 Automated Settlement Agent (agt_settle_09)
              </span>
              <span style={{ fontSize: "0.72rem", background: "#FEF3C7", color: "#B45309", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>
                Pending Review
              </span>
            </div>
            <div style={{ fontSize: "0.75rem", color: "#B45309", fontFamily: "var(--font-mono)" }}>
              Ed25519: sha256:4a8c9b... (Billing Core 배속 제안)
            </div>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
              <Button variant="secondary" size="sm">거부 (Revoke)</Button>
              <Button variant="primary" size="sm">승인 (Approve)</Button>
            </div>
          </div>

          {/* Quick Egress Status */}
          <div style={{ marginTop: 6, paddingTop: 10, borderTop: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 6 }}>
              방향성 Egress ACL 정책 요약 (SPEC § 12)
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              • <code>Support Group</code> → <code>Billing Core</code> : <strong style={{ color: "var(--color-success)" }}>ALLOW (허용)</strong><br />
              • <code>Billing Core</code> → <code>Support Group</code> : <strong style={{ color: "var(--color-danger)" }}>DENY (차단)</strong>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   3. GROUP ADMIN DASHBOARD VIEW (👥 그룹 관리자)
   ========================================================================= */
function GroupAdminDashboard() {
  const { t } = useI18n();

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.ga.groups", "담당 관리 그룹")}
          value="3"
          subValue={t("dash.ga.groupsSub", "Support, Billing, Analytics")}
          color="var(--color-primary)"
          icon="👥"
        />
        <KpiCard
          label={t("dash.ga.agents", "그룹 내 에이전트")}
          value="4"
          subValue={t("dash.ga.agentsSub", "정상 가동")}
          color="var(--color-success)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.ga.lease", "소켓리스 큐 적체")}
          value="3"
          subValue={t("dash.ga.leaseSub", "300s TTL 관리")}
          color="var(--color-warning)"
          icon="📥"
        />
        <KpiCard
          label={t("dash.ga.health", "그룹 헬스 지표")}
          value="100%"
          subValue={t("dash.ga.healthSub", "에러율 0.0%")}
          color="#6366F1"
          icon="💚"
        />
      </div>

      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
              {t("dash.ga.membershipTitle", "그룹별 에이전트 멤버십 & 상태")}
            </h3>
            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
              그룹 내 에이전트 이동 및 배속 관리 (SPEC § 11.3 group.manage)
            </p>
          </div>
          <Link to="/creator/groups">
            <Button variant="primary" size="sm">
              {t("groups.assignBtn", "에이전트 배속/이동")}
            </Button>
          </Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          {[
            { group: "Support Group", members: ["agt_support_01", "agt_support_02"], status: "Online (2/2)" },
            { group: "Billing Core", members: ["agt_finance_02"], status: "Online (1/1)" },
            { group: "Analytics Group", members: ["agt_analyzer_03"], status: "Offline (0/1)" },
          ].map((item) => (
            <div
              key={item.group}
              style={{
                background: "var(--color-bg-surface-sub)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-lg)",
                padding: "16px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{item.group}</span>
                <span style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)", fontWeight: 600 }}>{item.status}</span>
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {item.members.map((id) => (
                  <span
                    key={id}
                    style={{
                      fontSize: "0.72rem",
                      fontFamily: "var(--font-mono)",
                      background: "#FFFFFF",
                      padding: "2px 6px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* =========================================================================
   4. AGENT OPERATOR DASHBOARD VIEW (🤖 일반 에이전트 운영자)
   ========================================================================= */
function AgentOperatorDashboard() {
  const { t } = useI18n();

  const mockAgents = [
    {
      id: "agt_support_01",
      name: "Customer Support Agent",
      group: "Support Group",
      status: "online" as const,
      fingerprint: "sha256:7f83b165...",
      inbox: 0,
      lastSeen: "방금 전 (Active WS)",
    },
    {
      id: "agt_finance_02",
      name: "Financial Settlement Bot",
      group: "Billing Core",
      status: "online" as const,
      fingerprint: "sha256:3urP2MxX...",
      inbox: 2,
      lastSeen: "2분 전 (Socketless)",
    },
    {
      id: "agt_analyzer_03",
      name: "Market Intelligence Worker",
      group: "Analytics Group",
      status: "offline" as const,
      fingerprint: "sha256:e3b0c442...",
      inbox: 5,
      lastSeen: "14분 전",
    },
  ];

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.kpi.agents", "소유 에이전트")}
          value="3"
          subValue={t("dash.kpi.agentsSub", "개 등록됨")}
          color="var(--color-primary)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.kpi.sockets", "온라인 소켓")}
          value="2"
          subValue={t("dash.kpi.socketsSub", "연결 활성")}
          color="var(--color-success)"
          icon="⚡"
          trend={{ value: "+1", isPositive: true }}
        />
        <KpiCard
          label={t("dash.kpi.inbox", "미수신 인박스")}
          value="7"
          subValue={t("dash.kpi.inboxSub", "Lease Queue 대기")}
          color="var(--color-warning)"
          icon="📥"
        />
        <KpiCard
          label={t("dash.kpi.latency", "오늘의 전송량")}
          value="142"
          subValue={t("dash.kpi.latencySub", "건 완료")}
          color="#6366F1"
          icon="🔄"
        />
      </div>

      {/* Owned Agent Fleet Summary Table */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
              {t("dash.op.fleetTitle", "소유 에이전트 플릿 상태 요약")}
            </h3>
            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
              SPEC § 8.11 관측 출처 및 실시간 프레임 상태
            </p>
          </div>
          <Link to="/creator">
            <Button variant="ghost" size="sm">
              {t("dash.viewAll", "전체 보기 →")}
            </Button>
          </Link>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mockAgents.map((agt) => (
            <div
              key={agt.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 16px",
                background: "var(--color-bg-surface-sub)",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--color-border)",
                flexWrap: "wrap",
                gap: 10,
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 700, color: "var(--color-text-primary)", fontSize: "0.9rem" }}>
                    {agt.name}
                  </span>
                  <span style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>
                    {agt.id}
                  </span>
                </div>
                <div style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginTop: 2 }}>
                  소속: <strong>{agt.group}</strong> · 최근 활동: {agt.lastSeen}
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <StatusBadge
                  label={agt.status === "online" ? "ONLINE" : "OFFLINE"}
                  status={agt.status}
                  size="sm"
                />
                <Link to="/creator/playground">
                  <Button variant="secondary" size="sm">
                    {t("nav.playground", "메시지 테스트")}
                  </Button>
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
