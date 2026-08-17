import React, { useState } from "react";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  Toast,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

interface OrgMember {
  id: string;
  name: string;
  email: string;
  role: string;
  capabilities: string[];
}

const ALL_CAPABILITIES = [
  { id: "key.approve", label: "키 승인/거부" },
  { id: "agent.teardown", label: "Teardown (§9.3)" },
  { id: "group.manage", label: "그룹 관리" },
  { id: "policy.send_restrict", label: "이그레스 ACL 제어" },
  { id: "audit.read_content", label: "본문 원문 열람" },
  { id: "role.assign", label: "조직 RBAC 할당" },
];

import { fetchPendingUsers, approveUserApi, denyUserApi, type PendingUser } from "@/api/users.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { Button } from "@/components/index.ts";

export function RbacManagementPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load real user and pending users on mount
  React.useEffect(() => {
    if (user) {
      setMembers([
        {
          id: user.id || "usr_current",
          name: `${user.name} (${user.role})`,
          email: user.email || `${user.name.toLowerCase()}@mesh.local`,
          role: user.role,
          capabilities: user.capabilities || ["key.approve", "group.manage", "audit.read_content", "audit.read_metadata", "role.assign"],
        },
      ]);
    }
    fetchPendingUsers().then((list) => {
      setPendingUsers(list || []);
    });
  }, [user]);

  // Load real pending users on mount
  React.useEffect(() => {
    fetchPendingUsers().then((list) => {
      if (list && list.length > 0) {
        setPendingUsers(list);
      }
    });
  }, []);

  const handleApproveUser = async (login: string) => {
    try {
      await approveUserApi(login);
      setPendingUsers(pendingUsers.filter(u => u.github_login !== login));
      setToastMessage(`사용자 [${login}]의 가입 요청이 승인되었습니다.`);
    } catch (err: any) {
      setToastMessage(`승인 실패: ${err.message}`);
    }
  };

  const handleDenyUser = async (login: string) => {
    try {
      await denyUserApi(login);
      setPendingUsers(pendingUsers.filter(u => u.github_login !== login));
      setToastMessage(`사용자 [${login}]의 가입 요청이 거부되었습니다.`);
    } catch (err: any) {
      setToastMessage(`거부 실패: ${err.message}`);
    }
  };

  const handleToggleCapability = (memberId: string, capId: string) => {
    setMembers((prev) =>
      prev.map((m) => {
        if (m.id === memberId) {
          const hasCap = m.capabilities.includes(capId);
          const nextCaps = hasCap
            ? m.capabilities.filter((c) => c !== capId)
            : [...m.capabilities, capId];
          return { ...m, capabilities: nextCaps };
        }
        return m;
      })
    );

    const member = members.find((m) => m.id === memberId);
    setToastMessage(`[${member?.name}]의 [${capId}] 권한이 변경되었습니다.`);
  };

  const columns = [
    {
      key: "name",
      header: t("rbac.col.name", "멤버 이름 / 계정"),
      render: (item: OrgMember) => (
        <div>
          <div style={{ fontWeight: 700 }}>{item.name}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
            {item.email}
          </div>
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
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {ALL_CAPABILITIES.map((cap) => {
            const isAssigned = item.capabilities.includes(cap.id);

            return (
              <button
                key={cap.id}
                type="button"
                onClick={() => handleToggleCapability(item.id, cap.id)}
                style={{
                  padding: "3px 8px",
                  borderRadius: "var(--radius-full)",
                  border: "none",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  background: isAssigned
                    ? "var(--color-primary-light)"
                    : "var(--color-bg-surface-sub)",
                  color: isAssigned
                    ? "var(--color-primary)"
                    : "var(--color-text-muted)",
                  transition: "all 0.15s ease",
                }}
                title={cap.id}
              >
                {isAssigned ? "✓ " : "+ "}
                {cap.label}
              </button>
            );
          })}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="TENANT ADMIN"
        suiteBadgeColor="leased"
        screenId="36"
        title={t("rbac.title", "조직 멤버 RBAC 권한 할당")}
        subtitle={t("rbac.subtitle", "단일 ID 계정별 9대 Capability 즉각 부여 및 회수 (SPEC § 11.3 / § 17 Conformance)")}
      />

      {toastMessage && (
        <Toast
          type="success"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      <DataTable
        columns={columns}
        data={members}
        keyExtractor={(item) => item.id}
      />
    </div>
  );
}
