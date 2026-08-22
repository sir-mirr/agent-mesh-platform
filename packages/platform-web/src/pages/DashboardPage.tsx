import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import { Link } from "react-router-dom";
import {
  PageHeader,
  KpiCard,
  StatusBadge,
  FingerprintBox,
  DataTable,
  Button,
} from "@/components/index.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";
import type { UserRole } from "@/types/auth.ts";

import { fetchAgents, fetchPendingKeys, type KeyProposal, type RegistryAgent, lastSeenText, hasBeenSeen } from "@/api/agents.ts";
import { fetchAdminMailbox, type AdminMailboxResponse } from "@/api/mailbox.ts";
import { fetchGroups, type GroupItem } from "@/api/groups.ts";

/**
 * The queue card's three states, in one place because two panels draw it.
 *
 * `?? 0` used to sit here, on top of two dead reads, so the card said `0`
 * whether the mesh was idle, backed up, or unreachable. `null` means the route
 * did not answer with a list of mailboxes, and the screen says so in the words
 * /platform/telemetry already uses.
 *
 * **Shared rather than repeated.** The group panel and the operator panel each
 * had their own copy, and a mutation planted on this expression reaches only the
 * first of them — `replace()` with a string argument changes one occurrence. One
 * copy was measured and the other could regress in silence.
 *
 * The history of this comment is worth keeping, because it was wrong twice in
 * opposite directions. It first said the group panel is unreachable by any
 * session — unmeasured, and false at the time: `LoginPage` offered a role
 * `<select>` and passed the choice to `loginWithLocal`, so all four panels
 * opened. That picker has since been removed, on the grounds that a screen
 * deployed to a real server must not let a person choose their own title. So
 * the sentence is true *now*, for a reason that did not exist when it was
 * written: the server hands out `admin` or nothing, and everything else
 * resolves to `AGENT_OPERATOR`.
 *
 * `TenantAdminDashboard` and `GroupAdminDashboard` are therefore unreachable
 * until the server issues those roles. They are left in place rather than
 * deleted, because the question of whether this platform grows tenant and group
 * roles is not one this file can answer — but nothing draws them today.
 */
function queueValue(t: (key: string, fallback: string) => string, total: number | null | undefined): string {
  return total != null ? String(total) : t("common.unmeasured", "— 미측정");
}

/**
 * The answer to the one read both role-specific group panels are built from.
 *
 * An empty array cannot carry this answer. Before this union existed the two
 * panels kept `failure` beside `groups`, then rendered only `groups.length`:
 * loading, refusal, no response, and an answered empty list all became `0` and
 * “no groups”. Keeping the rows and the reason in one value makes that fold
 * harder to express and gives every consumer the same state to draw.
 */
type DashboardGroupsRead =
  | { kind: "loading"; groups: GroupItem[]; missing: null }
  | { kind: "ready"; groups: GroupItem[]; missing: null }
  | { kind: FailureKind; groups: GroupItem[]; missing: string | null };

function useDashboardGroups(): DashboardGroupsRead {
  const [read, setRead] = useState<DashboardGroupsRead>({ kind: "loading", groups: [], missing: null });

  React.useEffect(() => {
    let mounted = true;
    fetchGroups()
      .then((groups) => {
        if (mounted) setRead({ kind: "ready", groups, missing: null });
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        setRead({ kind: failureKind(err), groups: [], missing: refusedCapability(err) });
      });
    return () => { mounted = false; };
  }, []);

  return read;
}

function measuredGroupValue(read: DashboardGroupsRead, value: number): string {
  if (read.kind === "loading") return "...";
  return read.kind === "ready" ? String(value) : "—";
}

function groupReadCaption(
  t: (key: string, fallback: string) => string,
  read: DashboardGroupsRead,
  answered: string,
): string {
  if (read.kind === "loading") return t("common.loading", "조회 중...");
  if (read.kind === "refused") return refusedText(t, read.missing);
  if (read.kind === "unreachable") return t("common.errorLoad", "불러오지 못함");
  return answered;
}

/**
 * The five visible readings of a four-state list.
 *
 * “Could not know” has two causes that send an operator to different places:
 * the server refused the read, or the server never answered. They share the
 * broad failure state but deliberately get different words and test ids.
 */
function DashboardGroupReadState({
  read,
  testIdPrefix,
  emptyMessage,
  children,
}: {
  read: DashboardGroupsRead;
  testIdPrefix: "tenant-groups" | "group-groups";
  emptyMessage: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const state = read.kind === "ready"
    ? read.groups.length > 0 ? "present" : "empty"
    : read.kind;

  if (state === "present") {
    return <div data-testid={`${testIdPrefix}-present`} style={{ display: "contents" }}>{children}</div>;
  }

  const message = state === "loading"
    ? t("common.loading", "조회 중...")
    : state === "refused"
    ? refusedText(t, read.missing)
    : state === "unreachable"
    ? t("groups.error", "그룹 목록을 불러오지 못했습니다 (서버가 답하지 않았습니다).")
    : emptyMessage;
  const failed = state === "refused" || state === "unreachable";

  return (
    <div
      data-testid={`${testIdPrefix}-${state}`}
      style={{ padding: 20, textAlign: "center", color: failed ? "var(--color-danger)" : "var(--color-text-muted)", fontSize: "0.82rem" }}
    >
      {message}
    </div>
  );
}

/**
 * The other list reads in the tenant and group panels need the same answer
 * vocabulary as groups, without pretending that one route answered another.
 * A separate value per request is deliberate: sharing one error bit made a
 * failed agents read take down a healthy groups answer, while keeping only the
 * arrays made every unanswered read look empty.
 */
type DashboardListRead<T> =
  | { kind: "loading"; items: T[]; missing: null }
  | { kind: "ready"; items: T[]; missing: null }
  | { kind: FailureKind; items: T[]; missing: string | null };

function useDashboardList<T>(load: () => Promise<T[]>): DashboardListRead<T> {
  const [read, setRead] = useState<DashboardListRead<T>>({ kind: "loading", items: [], missing: null });

  React.useEffect(() => {
    let mounted = true;
    load()
      .then((items) => {
        if (mounted) setRead({ kind: "ready", items, missing: null });
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        setRead({ kind: failureKind(err), items: [], missing: refusedCapability(err) });
      });
    return () => { mounted = false; };
  }, [load]);

  return read;
}

type DashboardListState = "loading" | "refused" | "unreachable" | "empty" | "present";

function dashboardListState<T>(read: DashboardListRead<T>): DashboardListState {
  return read.kind === "ready" ? read.items.length > 0 ? "present" : "empty" : read.kind;
}

function measuredListValue<T>(read: DashboardListRead<T>, value: string | number): string {
  if (read.kind === "loading") return "...";
  return read.kind === "ready" ? String(value) : "—";
}

function listReadCaption<T>(
  t: (key: string, fallback: string) => string,
  read: DashboardListRead<T>,
  answered: string,
): string {
  if (read.kind === "loading") return t("common.loading", "조회 중...");
  if (read.kind === "refused") return refusedText(t, read.missing);
  if (read.kind === "unreachable") return t("common.errorLoad", "불러오지 못함");
  return answered;
}

function DashboardListReadState<T>({
  read,
  testIdPrefix,
  emptyMessage,
  children,
}: {
  read: DashboardListRead<T>;
  testIdPrefix: string;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const state = dashboardListState(read);

  if (state === "present") {
    return <div data-testid={`${testIdPrefix}-present`} style={{ display: "contents" }}>{children}</div>;
  }

  const message = state === "loading"
    ? t("common.loading", "조회 중...")
    : state === "refused"
    ? refusedText(t, read.missing)
    : state === "unreachable"
    ? t("common.errorLoad", "불러오지 못함")
    : emptyMessage;
  const failed = state === "refused" || state === "unreachable";

  return (
    <div
      data-testid={`${testIdPrefix}-${state}`}
      style={{ padding: 20, textAlign: "center", color: failed ? "var(--color-danger)" : "var(--color-text-muted)", fontSize: "0.82rem" }}
    >
      {message}
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [refreshTick, setRefreshTick] = useState(0);

  const currentRole: UserRole = user?.role || "AGENT_OPERATOR";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* 1. Header with Role Indicator & Quick Switcher for Testing */}
      <PageHeader
        title={
          currentRole === "PLATFORM_ADMIN"
            ? t("dash.platform.title", "플랫폼 운영 현황")
            : currentRole === "TENANT_ADMIN"
            ? t("dash.tenant.title", "조직 운영 대시보드")
            : currentRole === "GROUP_ADMIN"
            ? t("dash.group.title", "에이전트 그룹 운영 관리 대시보드")
            : t("dash.operator.title", "소유 에이전트 운영 대시보드")
        }
        subtitle={
          currentRole === "PLATFORM_ADMIN"
            ? t("dash.platform.sub", "등록 신원, 그룹, 메시지 대기 현황")
            : currentRole === "TENANT_ADMIN"
            ? t("dash.tenant.sub", "조직 소속 에이전트 그룹, 그룹 간 전송 규칙 및 감사 현황")
            : currentRole === "GROUP_ADMIN"
            ? t("dash.group.sub", "담당 그룹별 에이전트 멤버십 이동, 메일함 큐 적체 및 그룹 간 통신 모니터링")
            : t("dash.operator.sub", "메시에 등록된 신원, 메일함 대기 수, 메시지 테스트")
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
                  {t("dash.registerLink", "➕ Register an agent")}
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
                  {t("dash.egressLink", "🛡️ 그룹 간 전송 규칙")}
                </Button>
              </Link>
            )}
            {currentRole === "PLATFORM_ADMIN" && (
              <Link to="/creator/topology">
                <Button variant="primary" size="sm">
                  {t("dash.topologyLink", "🌐 Open topology")}
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
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  React.useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    Promise.all([
      fetchGroups().then(setGroups),
      fetchAgents().then(setAgents),
    ]).catch((err: unknown) => {
      setIsError(true);
      setFailure(failureKind(err));
    }).finally(() => {
      setIsLoading(false);
    });
  }, []);

  // This card's own subtitle says "live registry", so it counts the registry —
  // one source, named. It used to prefer the registry and fall back to
  // telemetry's `total_agents`, which counts mesh identities, and then to `0`;
  // three different answers under one label, and `||` meant an empty registry
  // took the second of them.
  const totalAgents = agents.length;
  return (
    <>
      {/* Top Global KPI Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.pa.nodes", "등록된 신원")}
          value={isLoading ? "..." : isError ? "—" : String(totalAgents)}
          subValue={isLoading ? t("common.loading", "조회 중...") : isError ? (failure === "refused" ? t("common.refused", "권한 없음") : t("common.errorLoad", "불러오지 못함")) : t("dash.pa.nodesSub", "신원 목록 응답")}
          color="var(--color-primary)"
          icon="🌐"
        />
        <KpiCard
          label={t("dash.pa.tenants", "등록된 그룹")}
          value={isLoading ? "..." : isError ? "—" : String(groups.length)}
          subValue={isLoading ? t("common.loading", "조회 중...") : isError ? t("groups.error", "그룹 목록을 불러오지 못했습니다.") : (groups.length > 0 ? `${groups.length} ${t("dash.pa.tenantsUnit", "개 그룹 등록")}` : t("dash.pa.tenantsNone", "등록된 그룹 없음"))}
          color="#6366F1"
          icon="🏢"
        />
      </div>

      {/* Group membership breakdown */}
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
              {t("dash.pa.tenantTrafficTitle", "그룹별 에이전트 구성")}
            </h3>
            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
              {t("dash.pa.tenantSub", "등록된 그룹과 그룹별 에이전트 수")}
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
            {t("dash.pa.tenantLoading", "그룹 목록을 불러오는 중입니다...")}
          </div>
        ) : isError ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-danger)", fontSize: "0.85rem" }}>
            {t("dash.pa.tenantError", "그룹 정보를 불러오지 못했습니다 (서버가 답하지 않았습니다).")}
          </div>
        ) : groups.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.85rem" }}>
            {t("dash.pa.tenantEmpty", "현재 등록된 그룹이 없습니다.")}
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
                    {t("dash.pa.group", "등록된 그룹")}
                  </span>
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", display: "flex", gap: 12 }}>
                  {/* **The api layer refused these claims; this line was making
                      them anyway.** `api/groups.ts` keeps `member_count` and
                      `egress_allowed` as `null` when the route did not report
                      them, with a comment saying that drawing a group as
                      "allowed to reach nothing" is a claim. `?? 0` here made
                      exactly that claim, one line apart, for both fields. */}
                  <span>{t("dash.pa.agentsLabel", "에이전트")}: <strong>{g.member_count ?? g.members?.length ?? t("common.unknownValue", "—")}</strong></span>
                  <span>{t("dash.pa.egressLabel", "전송 허용 대상")}: <strong>{g.egress_allowed?.length ?? t("common.unknownValue", "—")}</strong></span>
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
  const groupsRead = useDashboardGroups();
  const groups = groupsRead.groups;
  const agentsRead = useDashboardList<RegistryAgent>(fetchAgents);
  const agents = agentsRead.items;
  const pendingKeysRead = useDashboardList<KeyProposal>(fetchPendingKeys);
  const pendingKeys = pendingKeysRead.items;

  const totalEgressRules = groups.every((group) => Array.isArray(group.egress_allowed))
    ? groups.reduce((total, group) => total + group.egress_allowed!.length, 0)
    : null;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.ta.groups", "조직 소속 그룹")}
          value={measuredGroupValue(groupsRead, groups.length)}
          valueTestId="tenant-groups-count"
          subValue={groupReadCaption(
            t,
            groupsRead,
            groups.length > 0 ? `${groups.length} ${t("dash.ta.groupsActive", "개 그룹 활성")}` : t("dash.ta.noGroups", "등록된 그룹 없음"),
          )}
          color="var(--color-primary)"
          icon="👥"
        />
        <KpiCard
          label={t("dash.ta.agents", "총 소속 에이전트")}
          value={measuredListValue(agentsRead, agents.length)}
          valueTestId={`tenant-agents-${dashboardListState(agentsRead)}`}
          subValue={listReadCaption(t, agentsRead, t("dash.ta.agentsSub", "레지스트리 실데이터"))}
          color="var(--color-success)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.ta.egress", "허용된 전송 대상")}
          value={groupsRead.kind === "ready" && totalEgressRules === null
            ? t("common.unmeasured", "— 미측정")
            : measuredGroupValue(groupsRead, totalEgressRules ?? 0)}
          valueTestId="tenant-egress-count"
          subValue={groupReadCaption(t, groupsRead, t("dash.ta.egressSub", "명시적으로 허용하지 않은 전송은 차단"))}
          color="#6366F1"
          icon="🛡️"
        />
        <KpiCard
          label={t("dash.ta.approval", "미승인 키 대기 큐")}
          value={measuredListValue(pendingKeysRead, pendingKeys.length)}
          valueTestId="tenant-pending-keys-count"
          subValue={listReadCaption(
            t,
            pendingKeysRead,
            pendingKeys.length > 0 ? t("dash.ta.review", "검토 필요") : t("dash.ta.noPending", "대기 없음"),
          )}
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

          <DashboardGroupReadState
            read={groupsRead}
            testIdPrefix="tenant-groups"
            emptyMessage={t("dash.ta.groupsEmpty", "등록된 조직 그룹이 없습니다.")}
          >
            {groups.map((g) => (
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
                    {g.description || t("dash.ta.clusterDesc", "조직 에이전트 클러스터")}
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
                  {/* The same claim as the panel above, on the tenant card. */}
                  {g.member_count ?? t("common.unknownValue", "—")} {t("dash.ta.agentsUnit", "에이전트")}
                </span>
              </div>
            ))}
          </DashboardGroupReadState>
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
              <Button variant="ghost" size="sm">{t("dash.openHub", "Open hub →")}</Button>
            </Link>
          </div>

          <DashboardListReadState
            read={pendingKeysRead}
            testIdPrefix="tenant-pending-keys"
            emptyMessage={t("dash.ta.keysEmpty", "현재 대기 중인 공개키 제안이 없습니다 (All Verified).")}
          >
            {pendingKeys.map((p) => (
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
                    🔑 {p.identity} ({t("dash.ta.agentsUnit", "에이전트")})
                  </span>
                  <span style={{ fontSize: "0.72rem", background: "#FEF3C7", color: "#B45309", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>
                    {t("dash.ta.review", "검토 필요")}
                  </span>
                </div>
                <div style={{ fontSize: "0.75rem", color: "#B45309", fontFamily: "var(--font-mono)" }}>
                  {t("reg.fingerprint", "키 지문")}: {p.fingerprint}
                </div>
              </div>
            ))}
          </DashboardListReadState>
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
  const groupsRead = useDashboardGroups();
  const groups = groupsRead.groups;
  const agentsRead = useDashboardList<RegistryAgent>(fetchAgents);
  const agents = agentsRead.items;
  const [mailbox, setMailbox] = useState<AdminMailboxResponse | null>(null);

React.useEffect(() => {
    fetchAdminMailbox().then(setMailbox).catch(() => setMailbox(null));
  }, []);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.ga.groups", "담당 관리 그룹")}
          value={measuredGroupValue(groupsRead, groups.length)}
          valueTestId="group-groups-count"
          subValue={groupReadCaption(t, groupsRead, t("dash.ga.groupsSub", "실시간 활성 그룹"))}
          color="var(--color-primary)"
          icon="👥"
        />
        <KpiCard
          label={t("dash.ga.agents", "그룹 내 에이전트")}
          value={measuredListValue(agentsRead, agents.length)}
          valueTestId={`group-agents-${dashboardListState(agentsRead)}`}
          subValue={listReadCaption(
            t,
            agentsRead,
            agents.length > 0 ? `${agents.length} ${t("dash.ga.nodes", "개 노드 등록")}` : t("dash.ga.noAgents", "에이전트 없음"),
          )}
          color="var(--color-success)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.ga.lease", "메일함 큐 적체")}
          value={queueValue(t, mailbox?.total_queued)}
          subValue={t("dash.ga.leaseSub", "현재 대기 중인 메시지")}
          color="var(--color-warning)"
          icon="📥"
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
              {t("dash.ga.membershipSub", "그룹에 속한 에이전트를 확인하고 이동합니다")}
            </p>
          </div>
          <Link to="/creator/groups">
            <Button variant="primary" size="sm">
              {t("groups.assignBtn", "에이전트 배속/이동")}
            </Button>
          </Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          <DashboardGroupReadState
            read={groupsRead}
            testIdPrefix="group-groups"
            emptyMessage={t("dash.ga.groupsEmpty", "등록된 관리 그룹이 없습니다.")}
          >
            {groups.map((item) => (
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
                    {t("dash.ga.members", "구성원")} ({item.members?.length || 0})
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
            ))}
          </DashboardGroupReadState>
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
  /**
   * **This is the dashboard an ordinary account lands on**, and until now a
   * refused read drew `0` on it: "Owned Agents 0", "Online Sockets 0". Measured
   * with a real member account and only `/api/v1/agents` failing — the screen
   * said nothing was there, which is a statement about the mesh made without an
   * answer from it. The platform admin's panel already had this state; the
   * three panels below it did not.
   */
  const [isError, setIsError] = useState(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  /**
   * **The third state.** `agents` starts as `[]`, and an empty list drew `0` —
   * so on a slow link this panel said "Agents 0 registered" until the answer
   * arrived and then jumped to 14. Measured with the route delayed 2.5s.
   *
   * A screen has four things to tell apart: there are none, there are some, the
   * answer has not come back yet, and it never will. This panel had two.
   */
  const [isLoading, setIsLoading] = useState(true);

  React.useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err: unknown) => {
        setAgents([]);
        setIsError(true);
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
      })
      .finally(() => setIsLoading(false));
    fetchAdminMailbox().then(setMailbox).catch(() => setMailbox(null));
  }, []);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("dash.kpi.agents", "소유 에이전트")}
          valueTestId="operator-agents-count"
          value={isLoading ? "..." : isError ? "—" : String(agents.length)}
          subValue={isLoading ? t("common.loading", "조회 중...") : isError ? t("common.errorLoad", "불러오지 못함") : t("dash.kpi.agentsSub", "개 등록됨")}
          color="var(--color-primary)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.kpi.inbox", "미수신 메일함")}
          value={queueValue(t, mailbox?.total_queued)}
          subValue={t("dash.kpi.inboxSub", "메일함 대기")}
          color="var(--color-warning)"
          icon="📥"
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
              {t("dash.op.fleetTitle", "등록 에이전트 요약")}
            </h3>
            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
              {t("dash.op.fleetSub", "신원 목록이 알려 준 등록 정보와 마지막 접속 기록")}
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
            <div
              data-testid={isLoading ? "operator-agents-loading" : isError ? "operator-agents-unreachable" : "operator-agents-empty"}
              style={{ padding: 20, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.82rem" }}
            >
              {/*
                The cards above already say `—` when the read was refused, and
                this line went on inviting the person to register their first
                agent — an empty list and an unanswered question drawn as the
                same sentence, one panel apart.
              */}
              {isLoading ? (
                t("common.loading", "조회 중...")
              ) : isError ? (
                t("common.errorLoad", "불러오지 못함")
              ) : (
                <>
                  {t("dash.op.empty", "등록된 소유 에이전트가 없습니다.")} <Link to="/creator/register" style={{ color: "var(--color-primary)", textDecoration: "underline" }}>{t("dash.op.register", "새 에이전트를 등록하세요")}</Link>.
                </>
              )}
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
                    {t("dash.op.kind", "종류")}: <strong>{agt.type ?? "—"}</strong> · {t("dash.op.state", "상태")}:{" "}
                    {lastSeenText(t, agt.last_seen_at)}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <StatusBadge
                    label={hasBeenSeen(agt) ? t("dash.op.seen", "접속 기록 있음") : t("dash.op.neverSeen", "접속 기록 없음")}
                    status={hasBeenSeen(agt) ? "online" : "pending"}
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
