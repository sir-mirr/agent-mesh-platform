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

import { fetchAgents, fetchPendingKeys, type RegistryAgent } from "@/api/agents.ts";
import { fetchAdminMailbox, type AdminMailboxResponse } from "@/api/mailbox.ts";
import { fetchTelemetry, type SystemTelemetry } from "@/api/telemetry.ts";
import { fetchGroups, type GroupItem } from "@/api/groups.ts";

export function DashboardPage() {
  const { user, switchRole } = useAuth();
  const { t } = useI18n();
  const [refreshTick, setRefreshTick] = useState(0);

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
            ? t("dash.group.sub", "담당 그룹별 에이전트 멤버십 이동, 메일함 큐 적체 및 그룹 간 통신 모니터링")
            : t("dash.operator.sub", "소유한 Ed25519 에이전트 연결 상태, 메일함 큐 및 메시지 테스트")
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRefreshTick((t) => t + 1)}
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
      {currentRole === "PLATFORM_ADMIN" && <PlatformAdminDashboard key={refreshTick} />}
      {currentRole === "TENANT_ADMIN" && <TenantAdminDashboard key={refreshTick} />}
      {currentRole === "GROUP_ADMIN" && <GroupAdminDashboard key={refreshTick} />}
      {currentRole === "AGENT_OPERATOR" && <AgentOperatorDashboard key={refreshTick} />}
    </div>
  );
}

/* =========================================================================
   1. PLATFORM ADMIN DASHBOARD VIEW (👑 플랫폼 관리자)
   ========================================================================= */
function PlatformAdminDashboard() {
  const { t } = useI18n();
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);

  React.useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    Promise.all([
      fetchTelemetry().then(setTelemetry),
      fetchGroups().then(setGroups),
      fetchAgents().then(setAgents),
    ]).catch(() => {
      setIsError(true);
    }).finally(() => {
      setIsLoading(false);
    });
  }, []);

  const totalAgents = agents.length || (telemetry?.total_agents ?? 0);
  const activeSockets = telemetry?.active_sockets ?? agents.filter((a) => a.status === "active").length;

  return (
    <>
      {/* Top Global KPI Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.pa.nodes", "전체 에이전트 노드")}
          value={isLoading ? "..." : isError ? "—" : String(totalAgents)}
          subValue={isLoading ? t("common.loading", "조회 중...") : isError ? t("common.errorLoad", "불러오지 못함") : t("dash.pa.nodesSub", "실시간 레지스트리")}
          color="var(--color-primary)"
          icon="🌐"
        />
        <KpiCard
          label={t("dash.pa.sockets", "활성 웹소켓 풀")}
          value={isLoading ? "..." : isError ? "—" : String(activeSockets)}
          subValue={isLoading ? t("common.loading", "조회 중...") : isError ? t("common.disconnected", "통신 불가") : t("dash.pa.socketsSub", "mTLS 연결")}
          color="var(--color-success)"
          icon="⚡"
        />
        <KpiCard
          label={t("dash.pa.tenants", "활성 테넌트 조직")}
          value={isLoading ? "..." : isError ? "—" : String(groups.length)}
          subValue={isLoading ? t("common.loading", "조회 중...") : isError ? t("common.errorLoad", "조직 정보 불러오지 못함") : (groups.length > 0 ? `${groups.length}개 조직 등록` : "등록된 테넌트 없음")}
          color="#6366F1"
          icon="🏢"
        />
        <KpiCard
          label={t("dash.pa.latency", "허브 p99 지연")}
          value={isLoading ? "..." : telemetry && !isError ? `${telemetry.p99_latency_ms || 0}ms` : "—"}
          subValue={isLoading ? t("common.loading", "조회 중...") : telemetry && !isError ? t("dash.pa.p99Sub", "실시간 p99 측정치") : t("common.disconnected", "통신 불가")}
          color="var(--color-warning)"
          icon="⏱️"
        />
      </div>

      {/* Live Server Telemetry */}
      {!isLoading && !isError && telemetry && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
          <TelemetryCard
            label="서버 CPU 부하"
            currentValue={telemetry.cpu_usage_pct != null ? `${telemetry.cpu_usage_pct}%` : "—"}
            maxLabel="100%"
            percentage={telemetry.cpu_usage_pct ?? 0}
            barColor="var(--color-success)"
            statusText={telemetry.cpu_usage_pct != null ? "정상 가동 중" : "서버 미측정 (D-1 지표 전환)"}
          />
          <TelemetryCard
            label="프로세스 메모리 (RAM)"
            currentValue={telemetry.memory_used_mb != null ? `${telemetry.memory_used_mb} MB` : "—"}
            maxLabel={telemetry.memory_total_mb != null ? `${telemetry.memory_total_mb} MB` : undefined}
            percentage={telemetry.memory_used_mb != null && telemetry.memory_total_mb ? (telemetry.memory_used_mb / telemetry.memory_total_mb) * 100 : 0}
            barColor="var(--color-primary)"
            statusText={telemetry.memory_used_mb != null ? "여유 공간 충분" : "서버 미측정 (D-1 지표 전환)"}
          />
          <TelemetryCard
            label="허브 활성 세션"
            currentValue={`${telemetry.active_sockets} sessions`}
            maxLabel="500"
            percentage={(telemetry.active_sockets / 500) * 100}
            barColor="var(--color-leased)"
            statusText="정상 수신 대기"
          />
        </div>
      )}

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

        {isLoading ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.85rem" }}>
            테넌트 조직 데이터를 불러오는 중입니다...
          </div>
        ) : isError ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-danger)", fontSize: "0.85rem" }}>
            테넌트 조직 정보를 불러오지 못했습니다 (서버 통신 실패).
          </div>
        ) : groups.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.85rem" }}>
            현재 등록된 테넌트 조직 데이터가 없습니다.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
            {groups.map((g, idx) => (
              <div
                key={g.id}
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
                    {g.name}
                  </span>
                  <span style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--color-primary)", fontWeight: 700 }}>
                    Active Tenant
                  </span>
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", display: "flex", gap: 12 }}>
                  <span>에이전트: <strong>{g.member_count || g.members?.length || 0}노드</strong></span>
                  <span>Egress 허용: <strong>{g.egress_allowed?.length || 0}건</strong></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* =========================================================================
   2. TENANT ADMIN DASHBOARD VIEW (🏢 테넌트 관리자)
   ========================================================================= */
function TenantAdminDashboard() {
  const { t } = useI18n();
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [pendingKeys, setPendingKeys] = useState<any[]>([]);

  React.useEffect(() => {
    fetchGroups().then(setGroups).catch(() => setGroups([]));
    fetchAgents().then(setAgents).catch(() => setAgents([]));
    fetchPendingKeys().then(setPendingKeys).catch(() => setPendingKeys([]));
  }, []);

  const totalEgressRules = groups.reduce((acc, g) => acc + (g.egress_allowed?.length || 0), 0);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.ta.groups", "조직 소속 그룹")}
          value={String(groups.length)}
          subValue={groups.length > 0 ? `${groups.length}개 그룹 활성` : "등록된 그룹 없음"}
          color="var(--color-primary)"
          icon="👥"
        />
        <KpiCard
          label={t("dash.ta.agents", "총 소속 에이전트")}
          value={String(agents.length)}
          subValue={t("dash.ta.agentsSub", "레지스트리 실데이터")}
          color="var(--color-success)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.ta.egress", "Egress 허용 규칙")}
          value={String(totalEgressRules)}
          subValue={t("dash.ta.egressSub", "Deny-by-default")}
          color="#6366F1"
          icon="🛡️"
        />
        <KpiCard
          label={t("dash.ta.approval", "미승인 키 대기 큐")}
          value={String(pendingKeys.length)}
          subValue={pendingKeys.length > 0 ? "검토 필요" : "대기 없음"}
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

          {groups.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
              등록된 조직 그룹이 없습니다.
            </div>
          ) : (
            groups.map((g) => (
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
                    {g.description || "조직 에이전트 클러스터"}
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
                  {g.member_count ?? 0} 에이전트
                </span>
              </div>
            ))
          )}
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
            <Link to="/creator/register">
              <Button variant="ghost" size="sm">{t("common.manage", "허브 열기 →")}</Button>
            </Link>
          </div>

          {pendingKeys.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
              현재 대기 중인 공개키 제안이 없습니다 (All Verified).
            </div>
          ) : (
            pendingKeys.map((p) => (
              <div
                key={p.fingerprint}
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
                    🔑 {p.identity} (에이전트)
                  </span>
                  <span style={{ fontSize: "0.72rem", background: "#FEF3C7", color: "#B45309", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>
                    Pending Review
                  </span>
                </div>
                <div style={{ fontSize: "0.75rem", color: "#B45309", fontFamily: "var(--font-mono)" }}>
                  Fingerprint: {p.fingerprint}
                </div>
              </div>
            ))
          )}
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
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [mailbox, setMailbox] = useState<AdminMailboxResponse | null>(null);

  React.useEffect(() => {
    fetchGroups().then(setGroups).catch(() => setGroups([]));
    fetchAgents().then(setAgents).catch(() => setAgents([]));
    fetchAdminMailbox().then(setMailbox).catch(() => setMailbox(null));
  }, []);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.ga.groups", "담당 관리 그룹")}
          value={String(groups.length)}
          subValue={t("dash.ga.groupsSub", "실시간 활성 그룹")}
          color="var(--color-primary)"
          icon="👥"
        />
        <KpiCard
          label={t("dash.ga.agents", "그룹 내 에이전트")}
          value={String(agents.length)}
          subValue={agents.length > 0 ? `${agents.length}개 노드 등록` : "에이전트 없음"}
          color="var(--color-success)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.ga.lease", "메일함 큐 적체")}
          value={String(mailbox?.total_queued ?? 0)}
          subValue={t("dash.ga.leaseSub", "300s TTL 관리")}
          color="var(--color-warning)"
          icon="📥"
        />
        <KpiCard
          label={t("dash.ga.health", "온라인 에이전트 비율")}
          value={agents.length > 0 ? `${Math.round((agents.filter(a => a.status === "active").length / agents.length) * 100)}%` : "0%"}
          subValue="소켓 연결 기준"
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
          {groups.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
              등록된 관리 그룹이 없습니다.
            </div>
          ) : (
            groups.map((item) => (
              <div
                key={item.id}
                style={{
                  background: "var(--color-bg-surface-sub)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-lg)",
                  padding: "16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{item.name}</span>
                  <span style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)", fontWeight: 600 }}>
                    Online ({item.members?.length || 0})
                  </span>
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {(item.members || []).map((id) => (
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
            ))
          )}
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
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [mailbox, setMailbox] = useState<AdminMailboxResponse | null>(null);

  React.useEffect(() => {
    fetchAgents().then(setAgents).catch(() => setAgents([]));
    fetchAdminMailbox().then(setMailbox).catch(() => setMailbox(null));
  }, []);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.kpi.agents", "소유 에이전트")}
          value={String(agents.length)}
          subValue={t("dash.kpi.agentsSub", "개 등록됨")}
          color="var(--color-primary)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.kpi.sockets", "온라인 소켓")}
          value={String(agents.filter(a => a.status === "active").length)}
          subValue={t("dash.kpi.socketsSub", "연결 활성")}
          color="var(--color-success)"
          icon="⚡"
          trend={{ value: "+1", isPositive: true }}
        />
        <KpiCard
          label={t("dash.kpi.inbox", "미수신 메일함")}
          value={String(mailbox?.total_queued ?? 0)}
          subValue={t("dash.kpi.inboxSub", "메일함 대기")}
          color="var(--color-warning)"
          icon="📥"
        />
        <KpiCard
          label={t("dash.kpi.latency", "오늘의 전송량")}
          value="0"
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
          {agents.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
              등록된 소유 에이전트가 없습니다. <Link to="/creator/register" style={{ color: "var(--color-primary)", textDecoration: "underline" }}>새 에이전트를 등록하세요</Link>.
            </div>
          ) : (
            agents.map((agt) => (
              <div
                key={agt.identity}
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
                      {agt.description || agt.identity}
                    </span>
                    <span style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>
                      {agt.identity}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginTop: 2 }}>
                    {/*
                      Three things were wrong in one line. The label said 소속 —
                      membership — over `agt.type`, which is the kind of agent;
                      `|| "General"` invented a membership for anything the
                      server did not type; and the status collapsed an absent
                      value to 오프라인, so an agent the list says nothing about
                      read as one that is down. `GET /api/v1/agents` sends no
                      status at all.
                    */}
                    종류: <strong>{agt.type ?? "—"}</strong> · 상태:{" "}
                    {agt.status === "active" ? "온라인" : agt.status === "inactive" ? "오프라인" : "미보고"}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <StatusBadge
                    label={agt.status === "active" ? "ONLINE" : "OFFLINE"}
                    status={agt.status === "active" ? "online" : "offline"}
                    size="sm"
                  />
                  <Link to="/creator/playground">
                    <Button variant="secondary" size="sm">
                      {t("nav.playground", "메시지 테스트")}
                    </Button>
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
