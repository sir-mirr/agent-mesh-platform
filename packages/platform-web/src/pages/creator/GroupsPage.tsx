import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  Button,
  Modal,
  Input,
  Toast,
  type ToastType,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";

interface AgentGroup {
  id: string;
  tenant: string | null;
  description: string;
  /** `null` when the route did not report one, which is not the same as none. */
  memberCount: number | null;
  members: string[]; // agent IDs
  /** `null` when the route did not send one. */
  createdAt: string | null;
}

import { assignGroupMemberApi, fetchGroups, createGroupApi } from "@/api/groups.ts";
import {
  agentMemberIdentities,
  agentRegistryEntries,
  fetchAgents,
  type RegistryAgent,
} from "@/api/agents.ts";
import { fetchTenantDirectory, type TenantDirectoryItem } from "@/api/tenants.ts";

type TenantReadState = "idle" | "loading" | "ready" | "refused" | "unreachable";
type AssignCandidateState =
  | { kind: "idle" | "loading" | "tenant-unknown" }
  | { kind: "ready"; agents: RegistryAgent[] }
  | { kind: "failed"; failure: FailureKind; missing: string | null };

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 10px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-border)",
  background: "var(--color-bg-surface)",
  color: "var(--color-text-primary)",
};

export function GroupsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { hasCapability } = useRbac();
  const canManage = hasCapability("group.manage");
  const isPlatformAdmin = user?.role === "PLATFORM_ADMIN";
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<AgentGroup | null>(null);
  const [tenants, setTenants] = useState<TenantDirectoryItem[]>([]);
  const [tenantReadState, setTenantReadState] = useState<TenantReadState>("idle");
  const [tenantFailureName, setTenantFailureName] = useState<string | null>(null);
  const [assignCandidates, setAssignCandidates] = useState<AssignCandidateState>({ kind: "idle" });
  const [isAssigning, setIsAssigning] = useState(false);
  const assignRequest = React.useRef(0);
  const assignInFlight = React.useRef(false);

  // Form states
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newGroupTenant, setNewGroupTenant] = useState("");
  const [assignAgentId, setAssignAgentId] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<ToastType>("success");

  const loadGroups = async () => {
    setIsLoading(true);
    setIsError(false);
    setFailure(null);
    try {
      const [list, registry] = await Promise.all([fetchGroups(), fetchAgents()]);
      setGroups(
        (list || []).map((g) => {
          // `members` is a unified identity list. This page labels both the
          // count and the chips as agents, so a web user in the same policy
          // group must not appear in either place.
          const members = agentMemberIdentities(g.members ?? [], registry);
          // **`?? null`, not `=== null`.** The field is optional on the type,
          // and a route that never sent it is the same *unknown* as one that
          // sent `null` — `=== null` alone reads a missing field as a real
          // count and hands the line below an empty list to measure.
          //
          // The same line already went wrong the other way: `||` behind a real
          // `member_count: 0` fell through to a fallback, so *unknown* and
          // *nobody* took the same road out of here. Caught by
          // `scripts/mutation-check.ts` only once the test stopped asserting on
          // the whole row, which holds a dash from another column whatever this
          // one does.
          const counted = g.member_count ?? null;
          return {
            id: g.id,
            tenant: g.tenant ?? null,
            description: g.description ?? "",
            // `null` still means the route never supplied a member list. Once
            // it did, the count is the filtered agent list rather than every
            // identity in the policy group.
            memberCount: counted === null ? null : members.length,
            members,
            // **A date nobody sent is not a date.** This filled it with a fixed
            // timestamp, and a plausible one: a name can be doubted on sight and
            // `2026-08-17 12:00:00` cannot. `api/groups.ts` keeps `created_at`
            // as `null` on purpose; the screen said otherwise in one line.
            createdAt: g.created_at ? new Date(g.created_at).toLocaleString() : null,
          };
        })
      );
    } catch (err: unknown) {
      setIsError(true);
      setFailure(failureKind(err));
      setMissing(refusedCapability(err));
      setGroups([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Load real groups on mount
  React.useEffect(() => {
    loadGroups();
  }, []);

  React.useEffect(() => {
    if (!isPlatformAdmin) {
      setTenants([]);
      setTenantReadState("idle");
      setTenantFailureName(null);
      setNewGroupTenant("");
      return;
    }

    let cancelled = false;
    setTenantReadState("loading");
    setTenantFailureName(null);
    fetchTenantDirectory().then(
      (directory) => {
        if (cancelled) return;
        const active = directory.tenants.filter((tenant) => tenant.deleted_at === null);
        setTenants(active);
        setNewGroupTenant((current) =>
          active.some((tenant) => tenant.id === current)
            ? current
            : active.find((tenant) => tenant.id === directory.tenant)?.id ?? active[0]?.id ?? "",
        );
        setTenantReadState("ready");
      },
      (err: unknown) => {
        if (cancelled) return;
        const kind = failureKind(err);
        setTenants([]);
        setNewGroupTenant("");
        setTenantReadState(kind);
        setTenantFailureName(refusedCapability(err));
      },
    );
    return () => { cancelled = true; };
  }, [isPlatformAdmin]);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName) return;

    try {
      if (isPlatformAdmin && !newGroupTenant) return;
      const res = await createGroupApi(
        newGroupName,
        newGroupDesc,
        isPlatformAdmin ? newGroupTenant : undefined,
      );
      setIsCreateOpen(false);
      const targetName = res.group_id || newGroupName;
      setNewGroupName("");
      setNewGroupDesc("");
      if (res.created) {
        setToastType("success");
        setToastMessage(`${t("groups.created", "그룹 생성")}: ${targetName}`);
      } else {
        setToastType("success");
        setToastMessage(`${t("groups.exists", "이미 있는 그룹")}: ${targetName}`);
      }
      await loadGroups();
    } catch (err: any) {
      setToastType("error");
      setToastMessage(`${t("groups.createFailed", "그룹 생성 실패")}: ${err.message ?? ""}`);
    }
  };

  const openAssignModal = async (group: AgentGroup) => {
    const request = ++assignRequest.current;
    setSelectedGroup(group);
    setAssignAgentId("");
    setIsAssignOpen(true);
    setAssignCandidates({ kind: "loading" });

    if (group.tenant === null) {
      setAssignCandidates({ kind: "tenant-unknown" });
      return;
    }

    try {
      const registry = await fetchAgents(group.tenant);
      if (request !== assignRequest.current) return;
      const agents = agentRegistryEntries(registry).filter(
        (agent) => agent.tenant === group.tenant && !group.members.includes(agent.identity),
      );
      setAssignCandidates({ kind: "ready", agents });
    } catch (err: unknown) {
      if (request !== assignRequest.current) return;
      setAssignCandidates({
        kind: "failed",
        failure: failureKind(err),
        missing: refusedCapability(err),
      });
    }
  };

  const closeAssignModal = (force = false) => {
    if (assignInFlight.current && !force) return;
    assignRequest.current += 1;
    setIsAssignOpen(false);
    setAssignAgentId("");
    setAssignCandidates({ kind: "idle" });
  };

  const handleAssignAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedGroup || !assignAgentId) return;
    if (assignInFlight.current) return;

    // The select is not the security boundary. Keep the exact selected row in
    // the handler too, so removing `disabled` in the DOM cannot submit a person
    // or a row the tenant-filtered response never offered.
    if (
      assignCandidates.kind !== "ready"
      || !assignCandidates.agents.some((agent) => agent.identity === assignAgentId)
    ) {
      setToastType("error");
      setToastMessage(`${t("groups.assignUnknown", "등록된 에이전트만 배속할 수 있습니다")}: ${assignAgentId}`);
      return;
    }

    assignInFlight.current = true;
    setIsAssigning(true);
    try {
      await assignGroupMemberApi(
        selectedGroup.id,
        assignAgentId,
        selectedGroup.tenant ?? undefined,
      );
      const assigned = assignAgentId;
      const groupId = selectedGroup.id;
      closeAssignModal(true);
      setToastType("success");
      setToastMessage(`${t("groups.assigned", "배속 완료")}: ${assigned} → ${groupId}`);
      await loadGroups();
    } catch (err: any) {
      setToastType("error");
      setToastMessage(`${t("groups.assignFailed", "에이전트 배속 실패")}: ${err.message ?? ""}`);
    } finally {
      assignInFlight.current = false;
      setIsAssigning(false);
    }
  };

  const columns = [
    {
      key: "id",
      header: t("groups.col.name", "그룹 ID"),
      render: (item: AgentGroup) => (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            color: "var(--color-text-primary)",
          }}
        >
          {item.id}
        </span>
      ),
    },
    {
      key: "description",
      header: t("groups.col.desc", "그룹 설명"),
      render: (item: AgentGroup) => (
        <span style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
          {item.description}
        </span>
      ),
    },
    {
      key: "memberCount",
      header: t("groups.col.agents", "소속 에이전트"),
      render: (item: AgentGroup) => (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            padding: "2px 8px",
            background: "var(--color-primary-light)",
            color: "var(--color-primary)",
            borderRadius: "var(--radius-full)",
            fontSize: "0.78rem",
          }}
        >
          {item.memberCount ?? t("common.unknownValue", "—")}
        </span>
      ),
    },
    {
      key: "members",
      header: t("groups.col.members", "배속 에이전트 목록"),
      render: (item: AgentGroup) => (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {item.members.map((id) => (
            <span
              key={id}
              style={{
                fontSize: "0.72rem",
                fontFamily: "var(--font-mono)",
                background: "var(--color-bg-surface-sub)",
                padding: "2px 6px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border)",
              }}
            >
              {id}
            </span>
          ))}
          {item.members.length === 0 && (
            <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
              -
            </span>
          )}
        </div>
      ),
    },
    {
      key: "createdAt",
      header: t("groups.col.created", "생성 일시"),
      render: (item: AgentGroup) => (
        <span style={{ fontSize: "0.78rem", color: "var(--color-text-muted)" }}>
          {item.createdAt ?? t("common.unknownValue", "—")}
        </span>
      ),
    },
    {
      key: "tenant",
      header: t("groups.col.tenant", "소속 테넌트"),
      render: (item: AgentGroup) => (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
          {item.tenant ?? t("common.unknownValue", "—")}
        </span>
      ),
    },
    {
      key: "actions",
      header: t("groups.col.actions", "작업"),
      align: "right" as const,
      render: (item: AgentGroup) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void openAssignModal(item);
            }}
          >
            {t("groups.assignBtn", "에이전트 배속/이동")}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        title={t("groups.title", "그룹 관리 & 에이전트 배속")}
        subtitle={t("groups.subtitle", "그룹을 만들고 에이전트의 소속 그룹을 옮깁니다")}
        actions={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setIsCreateOpen(true)}>
              {t("groups.createBtn", "➕ 그룹 생성")}
            </Button>
          ) : undefined
        }
      />

      {toastMessage && (
        <Toast
          type={toastType}
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      <DataTable
        columns={columns}
        data={groups}
        keyExtractor={(item) => `${item.tenant ?? "unknown"}:${item.id}`}
        isLoading={isLoading}
        isError={isError}
        errorMessage={
          failure === "refused"
            ? refusedText(t, missing)
            : t("groups.error", "그룹 목록을 불러오지 못했습니다 (서버가 답하지 않았습니다).")
        }
        emptyMessage={t("groups.empty", "등록된 그룹이 없습니다.")}
      />

      {/* Create Group Modal */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title={t("groups.modal.createTitle", "신규 그룹 생성")}
      >
        <form onSubmit={handleCreateGroup} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Input
            label={t("groups.modal.nameLabel", "그룹 이름")}
            placeholder={t("groups.modal.namePlaceholder", "예: Analytics Group (데이터 분석)")}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            required
          />
          <Input
            label={t("groups.modal.descLabel", "그룹 설명")}
            placeholder={t("groups.modal.descPlaceholder", "그룹의 역할 및 격리 목적을 입력하세요")}
            value={newGroupDesc}
            onChange={(e) => setNewGroupDesc(e.target.value)}
          />
          {isPlatformAdmin && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label htmlFor="new-group-tenant" style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                {t("groups.modal.tenantLabel", "소속 테넌트")}
              </label>
              {tenantReadState === "loading" && (
                <span data-testid="group-tenant-loading" style={{ color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
                  {t("groups.modal.tenantLoading", "테넌트 목록을 불러오는 중입니다.")}
                </span>
              )}
              {tenantReadState === "refused" && (
                <span data-testid="group-tenant-refused" style={{ color: "var(--color-danger)", fontSize: "0.82rem" }}>
                  {refusedText(t, tenantFailureName)}
                </span>
              )}
              {tenantReadState === "unreachable" && (
                <span data-testid="group-tenant-unreachable" style={{ color: "var(--color-danger)", fontSize: "0.82rem" }}>
                  {t("groups.modal.tenantUnavailable", "테넌트 목록을 불러오지 못했습니다.")}
                </span>
              )}
              {tenantReadState === "ready" && tenants.length === 0 && (
                <span data-testid="group-tenant-empty" style={{ color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
                  {t("groups.modal.tenantEmpty", "그룹을 만들 수 있는 활성 테넌트가 없습니다.")}
                </span>
              )}
              {tenantReadState === "ready" && tenants.length > 0 && (
                <select
                  id="new-group-tenant"
                  value={newGroupTenant}
                  onChange={(event) => setNewGroupTenant(event.target.value)}
                  required
                  style={selectStyle}
                >
                  {tenants.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.id})</option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Button variant="secondary" size="sm" type="button" onClick={() => setIsCreateOpen(false)}>
              {t("common.cancel", "취소")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={isPlatformAdmin && (tenantReadState !== "ready" || !newGroupTenant)}
            >
              {t("common.create", "생성하기")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Assign Agent Modal */}
      {selectedGroup && (
        <Modal
          isOpen={isAssignOpen}
          onClose={() => closeAssignModal()}
          title={`${t("groups.modal.assignTitle", "에이전트 배속 및 이동")} - ${selectedGroup.id}`}
        >
          <form onSubmit={handleAssignAgent} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
              {t("groups.modal.assignDesc", "이 테넌트에서 배속할 에이전트를 선택하세요. 이동 시 기존 그룹에서 자동으로 탈퇴됩니다.")}
            </p>
            {assignCandidates.kind === "loading" && (
              <p data-testid="assign-candidates-loading" style={{ color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
                {t("groups.modal.assignLoading", "배속 가능한 에이전트를 확인하는 중입니다.")}
              </p>
            )}
            {assignCandidates.kind === "tenant-unknown" && (
              <p data-testid="assign-candidates-tenant-unknown" style={{ color: "var(--color-danger)", fontSize: "0.82rem" }}>
                {t("groups.modal.assignTenantUnknown", "그룹의 테넌트를 알 수 없어 배속 후보를 확인할 수 없습니다.")}
              </p>
            )}
            {assignCandidates.kind === "failed" && (
              <p data-testid={`assign-candidates-${assignCandidates.failure}`} style={{ color: "var(--color-danger)", fontSize: "0.82rem" }}>
                {assignCandidates.failure === "refused"
                  ? refusedText(t, assignCandidates.missing)
                  : t("groups.modal.assignUnavailable", "배속 가능한 에이전트를 불러오지 못했습니다.")}
              </p>
            )}
            {assignCandidates.kind === "ready" && assignCandidates.agents.length === 0 && (
              <p data-testid="assign-candidates-empty" style={{ color: "var(--color-text-muted)", fontSize: "0.82rem" }}>
                {t("groups.modal.assignEmpty", "이 테넌트에 배속 가능한 에이전트가 없습니다.")}
              </p>
            )}
            {assignCandidates.kind === "ready" && assignCandidates.agents.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label htmlFor="assign-agent" style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                  {t("groups.modal.agentIdLabel", "배속할 에이전트")}
                </label>
                <select
                  id="assign-agent"
                  value={assignAgentId}
                  onChange={(event) => setAssignAgentId(event.target.value)}
                  required
                  disabled={isAssigning}
                  style={selectStyle}
                >
                  <option value="">{t("groups.modal.agentPlaceholder", "에이전트를 선택하세요")}</option>
                  {assignCandidates.agents.map((agent) => (
                    <option key={agent.identity} value={agent.identity}>{agent.identity}</option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => closeAssignModal()}
                disabled={isAssigning}
              >
                {t("common.cancel", "취소")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={assignCandidates.kind !== "ready" || !assignAgentId || isAssigning}
              >
                {isAssigning ? t("groups.modal.assignSaving", "저장 중...") : t("common.save", "배속 완료")}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
