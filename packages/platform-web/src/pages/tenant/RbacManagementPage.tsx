import React, { useState, useEffect } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  Toast,
  Button,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";
import { fetchLocalUsers } from "@/api/users.ts";
import { fetchGrants, addGrantApi, deleteGrantApi, type GrantItem } from "@/api/grants.ts";
import { CAPABILITY } from "@/types/auth.ts";

const CAPABILITY_COPY: Record<string, [key: string, fallback: string]> = {
  [CAPABILITY.KEY_APPROVE]: ["rbac.cap.keyApprove", "등록 키 승인"],
  [CAPABILITY.AGENT_TEARDOWN]: ["rbac.cap.agentRemove", "에이전트 제거"],
  [CAPABILITY.AGENT_PROVISION]: ["rbac.cap.agentRegister", "에이전트 등록"],
  [CAPABILITY.GROUP_MANAGE]: ["rbac.cap.groupManage", "그룹 관리"],
  [CAPABILITY.ROLE_GRANT]: ["rbac.cap.permissionManage", "계정 권한 변경"],
  [CAPABILITY.AUDIT_READ_METADATA]: ["rbac.cap.auditDetails", "감사 기록의 시간·경로·길이 보기"],
  [CAPABILITY.AUDIT_READ_CONTENT]: ["rbac.cap.auditContent", "감사 기록의 메시지 본문 보기"],
  [CAPABILITY.MAILBOX_READ_DEPTH]: ["rbac.cap.mailboxBacklog", "메일함 적체 보기"],
  [CAPABILITY.TENANT_READ_STATS]: ["rbac.cap.groupStats", "그룹 메시지 통계 보기"],
  [CAPABILITY.SOURCE_READ]: ["rbac.cap.sourceRead", "허용된 발신처 보기"],
  [CAPABILITY.USER_ADMIT]: ["rbac.cap.userAdmit", "사용자 승인"],
  [CAPABILITY.USAGE_READ]: ["rbac.cap.activityRead", "운영 동작 지표 보기"],
};

export function capabilityLabel(
  t: (key: string, fallback: string) => string,
  capabilityId: string,
): string {
  const copy = CAPABILITY_COPY[capabilityId];
  if (copy) return t(copy[0], copy[1]);
  return capabilityId.replace(/[._]+/g, " ");
}

interface OrgMember {
  id: string;
  name: string;
  email: string;
  capabilities: string[];
  /** `true` only when a server response marks this subject's grants immutable. */
  fixedAdmin: boolean | null;
  /** Existing cells the grant route says its DELETE endpoint will refuse. */
  immutableReasons: Record<string, string>;
}

export function RbacManagementPage() {
  const { t } = useI18n();
  const { hasCapability } = useRbac();
  const canGrant = hasCapability("role.grant");
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [availableCaps, setAvailableCaps] = useState<string[]>([]);
  /**
   * `null` is not "no role" — it is *this screen was not able to ask*. The two
   * were the same value here until now: every subject the grants list named got
   * the word "Operator", including subjects the server has no account for.
   */
  const [rolesBySubject, setRolesBySubject] = useState<Record<string, string> | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);

  const loadGrantsAndMembers = async () => {
    try {
      setIsLoading(true);
      setIsError(false);
      setFailure(null);
      const res = await fetchGrants();
      const caps = res.capabilities || [];
      const immutableSubjects = Array.isArray(res.immutable_subjects)
        ? new Set(res.immutable_subjects)
        : null;
      setAvailableCaps(caps);

      // Asked separately and allowed to fail: a viewer who may read grants but
      // not accounts still gets the table, with the role column saying it does
      // not know rather than filling itself in.
      const accounts = await fetchLocalUsers()
        .then((r) => r.users ?? [])
        .catch(() => null);
      const roles = accounts === null
        ? null
        : Object.fromEntries(accounts.map((u) => [u.username, u.role]));
      setRolesBySubject(roles);

      // Group grants by subject strictly from server response
      const subjectMap = new Map<string, string[]>();
      const immutableReasonMap = new Map<string, Record<string, string>>();
      (res.grants || []).forEach((g: GrantItem) => {
        const list = subjectMap.get(g.subject) || [];
        list.push(g.capability);
        subjectMap.set(g.subject, list);
        if (g.revocable === false) {
          const fixed = immutableReasonMap.get(g.subject) || {};
          fixed[g.capability] = g.immutable_reason ?? "not_revocable";
          immutableReasonMap.set(g.subject, fixed);
        }
      });

      // **A person with no grants is exactly who this screen is for.**
      //
      // The rows used to come only from the grants themselves, so somebody
      // admitted five minutes ago — no capabilities, which is how everyone
      // starts — had no row, and there was no way to give them their first one.
      // The account list was already being fetched for the role column and
      // thrown away for this purpose.
      //
      // Only when that list was readable. If it was refused or unreachable,
      // the rows stay as they were rather than this screen deciding the mesh
      // has no members — the role column already says it could not ask.
      if (immutableSubjects !== null) {
        for (const subject of immutableSubjects) {
          if (!subjectMap.has(subject)) subjectMap.set(subject, []);
        }
      }
      if (roles) {
        for (const username of Object.keys(roles)) {
          if (!subjectMap.has(username)) subjectMap.set(username, []);
        }
      }

      const orgMembers: OrgMember[] = Array.from(subjectMap.entries()).map(([subj, assignedCaps]) => ({
        id: subj,
        name: subj,
        email: subj,
        capabilities: assignedCaps,
        // The account name is deliberately irrelevant. New servers publish the
        // protected subject set beside the grants. The local-user role remains
        // only as a rollout fallback for an older response without that field.
        fixedAdmin: immutableSubjects !== null
          ? immutableSubjects.has(subj)
          : accounts === null
          ? null
          : accounts.some((account) => account.username === subj && account.role === "admin"),
        immutableReasons: immutableReasonMap.get(subj) ?? {},
      }));

      setMembers(orgMembers);
    } catch (err: any) {
      console.warn("[RBAC] fetchGrants error:", err.message);
      setIsError(true);
      setFailure(failureKind(err));
      setMissing(refusedCapability(err));
      setMembers([]);
      setAvailableCaps([]);
      setRolesBySubject(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadGrantsAndMembers();
  }, []);

  const handleToggleCapability = async (subject: string, capId: string) => {
    if (!canGrant) return;
    const member = members.find((m) => m.id === subject);
    // Guard the action as well as the button. A style or `disabled` regression
    // must not turn a fixed administrator into a writable grant row, and an
    // unanswered account read is not evidence that the subject is mutable.
    if (!member || member.fixedAdmin !== false) return;
    const hasCap = member.capabilities.includes(capId);
    // A grant may be immutable even on an ordinary member (for example, the
    // last tenant-wide role.grant holder). Additions remain possible; only the
    // existing cell whose DELETE the server refuses is locked.
    if (hasCap && member.immutableReasons[capId] !== undefined) return;

    try {
      if (hasCap) {
        await deleteGrantApi(subject, capId);
        setToastMessage(`${t("rbac.toast.revoked", "권한 회수")}: ${subject} · ${capabilityLabel(t, capId)}`);
      } else {
        await addGrantApi(subject, capId);
        setToastMessage(`${t("rbac.toast.granted", "권한 부여")}: ${subject} · ${capabilityLabel(t, capId)}`);
      }
      await loadGrantsAndMembers();
    } catch (err: any) {
      setToastMessage(`${t("rbac.toast.failed", "권한 변경 실패")}: ${err.message}`);
    }
  };

  const columns = [
    {
      key: "name",
      header: t("rbac.col.name", "멤버 ID / 주체 (Subject)"),
      render: (item: OrgMember) => (
        <div data-testid={`rbac-subject-${item.id}`}>
          <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{item.name}</div>
        </div>
      ),
    },
    {
      key: "role",
      header: t("rbac.col.role", "역할 (Role)"),
      render: (item: OrgMember) => (
        <span
          data-testid={`rbac-role-${item.id}`}
          style={{
            padding: "3px 8px",
            background: "var(--color-bg-surface-sub)",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.78rem",
            fontWeight: 600,
          }}
        >
          {rolesBySubject === null ? "\u2014" : (rolesBySubject[item.id] ?? "\u2014")}
        </span>
      ),
    },
    {
      key: "capabilities",
      header: t("rbac.col.caps", "부여된 권한 (클릭하여 변경)"),
      render: (item: OrgMember) => (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {availableCaps.map((capId) => {
            const isAssigned = item.capabilities.includes(capId);
            const isFixedAdmin = item.fixedAdmin === true;
            const immutableReason = isAssigned ? item.immutableReasons[capId] : undefined;
            const isFixedGrant = immutableReason !== undefined;
            const isImmutable = isFixedAdmin || isFixedGrant;
            const canChange = canGrant && item.fixedAdmin === false && !isFixedGrant;

            return (
              <button
                key={capId}
                type="button"
                data-testid={`rbac-cap-${item.id}-${capId}`}
                data-fixed-admin={isFixedAdmin ? "true" : undefined}
                data-immutable-reason={immutableReason}
                disabled={!canChange}
                onClick={() => handleToggleCapability(item.id, capId)}
                style={{
                  padding: "4px 9px",
                  borderRadius: "var(--radius-full)",
                  border: isImmutable
                    ? "1px solid var(--color-border)"
                    : isAssigned ? "1px solid var(--color-primary)" : "1px solid var(--color-border)",
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  cursor: canChange ? "pointer" : "not-allowed",
                  opacity: isImmutable ? 0.45 : canChange ? 1 : 0.55,
                  background: isImmutable
                    ? "var(--color-bg-surface-sub)"
                    : isAssigned
                    ? "var(--color-primary-light)"
                    : "var(--color-bg-surface-sub)",
                  color: isImmutable
                    ? "var(--color-text-muted)"
                    : isAssigned
                    ? "var(--color-primary)"
                    : "var(--color-text-muted)",
                  transition: "all 0.15s ease",
                }}
                title={isFixedAdmin
                  ? t("rbac.fixedAdmin", "고정 관리자의 권한은 변경할 수 없습니다")
                  : isFixedGrant
                  ? t("rbac.fixedGrant", "안전상 이 권한은 회수할 수 없습니다")
                  : item.fixedAdmin === null
                  ? t("rbac.accountsUnavailable", "계정 정보를 확인할 수 없어 권한을 변경할 수 없습니다")
                  : canGrant
                  ? (isAssigned ? t("rbac.toast.revoked", "권한 회수") : t("rbac.toast.granted", "권한 부여"))
                  : t("rbac.needs.grant", "이 계정에는 권한을 변경할 수 있는 권한이 없습니다")}
              >
                {isAssigned ? "✓ " : "+ "}
                {capabilityLabel(t, capId)}
              </button>
            );
          })}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Breadcrumbs />

      <PageHeader
        title={t("rbac.title", "계정 권한 관리")}
        subtitle={t("rbac.subtitle", "계정마다 화면과 작업 권한을 부여하거나 회수합니다")}
      />

      {toastMessage && (
        <Toast
          type="success"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      {/* Capability Matrix Section */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
          🛡️ {t("rbac.matrix", "계정별 권한 표")}{" "}
          {isLoading ? `(${t("common.loading", "조회 중...")})` : isError ? t("common.unreachable", "(통신 불가)") : `(${members.length})`}
        </h3>
        <DataTable
          columns={columns}
          data={members}
          keyExtractor={(item) => item.id}
          isLoading={isLoading}
          isError={isError}
          errorMessage={
            failure === "refused"
              ? refusedText(t, missing)
              : t("rbac.error", "권한 목록을 불러오지 못했습니다 (서버가 답하지 않았습니다).")
          }
          emptyMessage={t("rbac.empty", "현재 등록된 조직원 데이터가 없습니다.")}
        />
      </div>
    </div>
  );
}
