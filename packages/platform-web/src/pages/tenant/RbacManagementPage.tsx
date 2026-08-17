import React, { useState, useEffect } from "react";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  Toast,
  Button,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { fetchGrants, addGrantApi, deleteGrantApi, type GrantItem } from "@/api/grants.ts";

interface OrgMember {
  id: string;
  name: string;
  email: string;
  role: string;
  capabilities: string[];
}

export function RbacManagementPage() {
  const { t } = useI18n();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [availableCaps, setAvailableCaps] = useState<string[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);

  const loadGrantsAndMembers = async () => {
    try {
      setIsLoading(true);
      setIsError(false);
      const res = await fetchGrants();
      const caps = res.capabilities || [];
      setAvailableCaps(caps);

      // Group grants by subject strictly from server response
      const subjectMap = new Map<string, string[]>();
      (res.grants || []).forEach((g: GrantItem) => {
        const list = subjectMap.get(g.subject) || [];
        list.push(g.capability);
        subjectMap.set(g.subject, list);
      });

      const orgMembers: OrgMember[] = Array.from(subjectMap.entries()).map(([subj, assignedCaps]) => ({
        id: subj,
        name: subj,
        email: subj,
        role: subj === "admin" ? "Platform Admin" : "Operator",
        capabilities: assignedCaps,
      }));

      setMembers(orgMembers);
    } catch (err: any) {
      console.warn("[RBAC] fetchGrants error:", err.message);
      setIsError(true);
      setMembers([]);
      setAvailableCaps([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadGrantsAndMembers();
  }, []);

  const handleToggleCapability = async (subject: string, capId: string) => {
    const member = members.find((m) => m.id === subject);
    const hasCap = member?.capabilities.includes(capId);

    try {
      if (hasCap) {
        await deleteGrantApi(subject, capId);
        setToastMessage(`[${subject}]의 [${capId}] 권한이 회수되었습니다.`);
      } else {
        await addGrantApi(subject, capId);
        setToastMessage(`[${subject}]에게 [${capId}] 권한이 부여되었습니다.`);
      }
      await loadGrantsAndMembers();
    } catch (err: any) {
      setToastMessage(`권한 변경 실패: ${err.message}`);
    }
  };

  const columns = [
    {
      key: "name",
      header: t("rbac.col.name", "멤버 ID / 주체 (Subject)"),
      render: (item: OrgMember) => (
        <div>
          <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{item.name}</div>
        </div>
      ),
    },
    {
      key: "role",
      header: t("rbac.col.role", "역할 (Role)"),
      render: (item: OrgMember) => (
        <span
          style={{
            padding: "3px 8px",
            background: "var(--color-bg-surface-sub)",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.78rem",
            fontWeight: 600,
          }}
        >
          {item.role}
        </span>
      ),
    },
    {
      key: "capabilities",
      header: t("rbac.col.caps", "부여된 Capability (클릭하여 토글)"),
      render: (item: OrgMember) => (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {availableCaps.map((capId) => {
            const isAssigned = item.capabilities.includes(capId);

            return (
              <button
                key={capId}
                type="button"
                onClick={() => handleToggleCapability(item.id, capId)}
                style={{
                  padding: "4px 9px",
                  borderRadius: "var(--radius-full)",
                  border: isAssigned ? "1px solid var(--color-primary)" : "1px solid var(--color-border)",
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: isAssigned
                    ? "var(--color-primary-light)"
                    : "var(--color-bg-surface-sub)",
                  color: isAssigned
                    ? "var(--color-primary)"
                    : "var(--color-text-muted)",
                  transition: "all 0.15s ease",
                }}
                title={`클릭 시 ${isAssigned ? "권한 회수" : "권한 부여"}`}
              >
                {isAssigned ? "✓ " : "+ "}
                {capId}
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
        suiteTag="TENANT ADMIN"
        suiteBadgeColor="leased"
        screenId="36"
        title={t("rbac.title", "조직 멤버 RBAC 권한 & Capability 관리")}
        subtitle="SPEC § 11.3 / § 12: 계정별 Capability(권한) 세분화 부여 및 회수 (role.grant 인가 전용)"
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
          🛡️ 활성 조직원 및 Capability 권한 할당 매트릭스 ({members.length}명)
        </h3>
        <DataTable
          columns={columns}
          data={members}
          keyExtractor={(item) => item.id}
          isLoading={isLoading}
          isError={isError}
          errorMessage="RBAC 권한 데이터를 불러올 수 없습니다 (role.grant 권한 부족 또는 서버 오류)."
          emptyMessage="현재 등록된 조직원 데이터가 없습니다."
        />
      </div>
    </div>
  );
}

