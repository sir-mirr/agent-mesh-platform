import React, { useState, useEffect } from "react";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  Toast,
  Button,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { fetchPendingUsers, approveUserApi, denyUserApi, type PendingUser } from "@/api/users.ts";
import { fetchGrants, addGrantApi, deleteGrantApi, type GrantItem } from "@/api/grants.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";

interface OrgMember {
  id: string;
  name: string;
  email: string;
  role: string;
  capabilities: string[];
}

export function RbacManagementPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [availableCaps, setAvailableCaps] = useState<string[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const loadGrantsAndMembers = async () => {
    try {
      setIsLoading(true);
      const res = await fetchGrants();
      const caps = res.capabilities || [
        "key.approve",
        "key.deny",
        "agent.teardown",
        "group.manage",
        "policy.send_restrict",
        "audit.read_content",
        "audit.read_metadata",
        "role.grant",
        "role.assign",
        "server.inspect",
      ];
      setAvailableCaps(caps);

      // Group grants by subject
      const subjectMap = new Map<string, string[]>();
      (res.grants || []).forEach((g: GrantItem) => {
        const list = subjectMap.get(g.subject) || [];
        list.push(g.capability);
        subjectMap.set(g.subject, list);
      });

      // Also ensure current user is represented if present
      if (user && !subjectMap.has(user.name) && !subjectMap.has("admin")) {
        subjectMap.set(user.name, user.capabilities || []);
      }

      const orgMembers: OrgMember[] = Array.from(subjectMap.entries()).map(([subj, assignedCaps]) => ({
        id: subj,
        name: subj,
        email: `${subj.toLowerCase()}@mesh.local`,
        role: subj === "admin" ? "Platform Admin" : "Operator",
        capabilities: assignedCaps,
      }));

      setMembers(orgMembers);
    } catch (err: any) {
      console.warn("[RBAC] fetchGrants fallback:", err.message);
      if (user) {
        setMembers([
          {
            id: user.id || "admin",
            name: user.name || "admin",
            email: user.email || "admin@mesh.local",
            role: user.role,
            capabilities: user.capabilities || ["key.approve", "group.manage", "audit.read_content", "audit.read_metadata", "role.grant"],
          },
        ]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadGrantsAndMembers();
    fetchPendingUsers().then((list) => {
      setPendingUsers(list || []);
    });
  }, [user]);

  const handleApproveUser = async (login: string) => {
    try {
      await approveUserApi(login);
      setPendingUsers(pendingUsers.filter((u) => u.github_login !== login));
      setToastMessage(`사용자 [${login}]의 가입 요청이 승인되었습니다.`);
    } catch (err: any) {
      setToastMessage(`승인 실패: ${err.message}`);
    }
  };

  const handleDenyUser = async (login: string) => {
    try {
      await denyUserApi(login);
      setPendingUsers(pendingUsers.filter((u) => u.github_login !== login));
      setToastMessage(`사용자 [${login}]의 가입 요청이 거부되었습니다.`);
    } catch (err: any) {
      setToastMessage(`거부 실패: ${err.message}`);
    }
  };

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

  const pendingColumns = [
    {
      key: "github_login",
      header: "가입 요청 계정 (GitHub / Local ID)",
      render: (u: PendingUser) => (
        <div>
          <strong style={{ color: "var(--color-text-primary)" }}>{u.github_login}</strong>
          <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
            요청 시각: {u.created_at ? new Date(u.created_at).toLocaleTimeString() : "최근 요청"}
          </div>
        </div>
      ),
    },
    {
      key: "role",
      header: "희망 역할",
      render: (u: PendingUser) => (
        <span style={{ fontSize: "0.78rem", fontWeight: 600 }}>{u.role}</span>
      ),
    },
    {
      key: "actions",
      header: "가입 승인 관리",
      align: "right" as const,
      render: (u: PendingUser) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleApproveUser(u.github_login)}
          >
            ✓ 가입 승인
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => handleDenyUser(u.github_login)}
          >
            ✕ 거부
          </Button>
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
        subtitle="SPEC § 11.3 / § 12: 계정별 Capability(권한) 세분화 부여 및 신규 사용자 가입 승인"
      />

      {toastMessage && (
        <Toast
          type="success"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      {/* 1. Capability Matrix Section */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
          🛡️ 활성 조직원 및 Capability 권한 할당 매트릭스 ({members.length}명)
        </h3>
        <DataTable
          columns={columns}
          data={members}
          keyExtractor={(item) => item.id}
          isLoading={isLoading}
          emptyMessage="현재 등록된 조직원 데이터가 없습니다."
        />
      </div>

      {/* 2. Pending Admissions Queue Section */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
          📋 가입 승인 대기 큐 ({pendingUsers.length}건 대기)
        </h3>
        <DataTable
          columns={pendingColumns}
          data={pendingUsers}
          keyExtractor={(item) => item.github_login}
          emptyMessage="현재 대기 중인 가입 승인 요청이 없습니다."
        />
      </div>
    </div>
  );
}
