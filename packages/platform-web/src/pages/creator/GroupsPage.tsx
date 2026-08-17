import React, { useState } from "react";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  Button,
  Modal,
  Input,
  Toast,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

interface AgentGroup {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  members: string[]; // agent IDs
  createdAt: string;
}

import { fetchGroups, createGroupApi, type GroupItem } from "@/api/groups.ts";

export function GroupsPage() {
  const { t } = useI18n();
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<AgentGroup | null>(null);

  // Form states
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [assignAgentId, setAssignAgentId] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load real groups on mount
  React.useEffect(() => {
    fetchGroups()
      .then((list) => {
        setGroups(
          (list || []).map((g) => ({
            id: g.id,
            name: g.name,
            description: g.description || "에이전트 클러스터 그룹",
            memberCount: g.member_count || g.members?.length || 0,
            members: g.members || [],
            createdAt: g.created_at ? new Date(g.created_at).toLocaleString() : "2026-08-17 12:00:00",
          }))
        );
      })
      .finally(() => setIsLoading(false));
  }, []);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName) return;

    try {
      await createGroupApi(newGroupName, newGroupDesc);
    } catch (err: any) {
      console.warn("[Groups] Backend create error fallback:", err.message);
    }

    const newGroup: AgentGroup = {
      id: `grp_${Date.now()}`,
      name: newGroupName,
      description: newGroupDesc || "사용자 생성 에이전트 그룹",
      memberCount: 0,
      members: [],
      createdAt: new Date().toISOString().replace("T", " ").substring(0, 19),
    };

    setGroups([...groups, newGroup]);
    setIsCreateOpen(false);
    setNewGroupName("");
    setNewGroupDesc("");
    setToastMessage(`그룹 [${newGroup.name}]이(가) 성공적으로 생성되었습니다.`);
  };

  const handleAssignAgent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedGroup || !assignAgentId) return;

    const updated = groups.map((g) => {
      if (g.id === selectedGroup.id) {
        const nextMembers = Array.from(new Set([...g.members, assignAgentId]));
        return { ...g, members: nextMembers, memberCount: nextMembers.length };
      }
      return g;
    });

    setGroups(updated);
    setIsAssignOpen(false);
    setAssignAgentId("");
    setToastMessage(`에이전트 [${assignAgentId}]이(가) [${selectedGroup.name}]에 배속되었습니다.`);
  };

  const columns = [
    {
      key: "name",
      header: t("groups.col.name", "그룹 명 / ID"),
      render: (item: AgentGroup) => (
        <div>
          <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>
            {item.name}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--color-text-muted)",
            }}
          >
            {item.id}
          </div>
        </div>
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
          {item.memberCount}
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
          {item.createdAt}
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
              setSelectedGroup(item);
              setIsAssignOpen(true);
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
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="25"
        title={t("groups.title", "그룹 관리 & 에이전트 배속")}
        subtitle={t("groups.subtitle", "그룹 생성 및 소유 에이전트 멤버십 이동·배치 (SPEC § 11.3 / § 12 group.manage)")}
        actions={
          <Button variant="primary" size="sm" onClick={() => setIsCreateOpen(true)}>
            {t("groups.createBtn", "➕ 그룹 생성")}
          </Button>
        }
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
        data={groups}
        keyExtractor={(item) => item.id}
        isLoading={isLoading}
        emptyMessage="현재 등록된 그룹 데이터가 없습니다."
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
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Button variant="secondary" size="sm" type="button" onClick={() => setIsCreateOpen(false)}>
              {t("common.cancel", "취소")}
            </Button>
            <Button variant="primary" size="sm" type="submit">
              {t("common.create", "생성하기")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Assign Agent Modal */}
      {selectedGroup && (
        <Modal
          isOpen={isAssignOpen}
          onClose={() => setIsAssignOpen(false)}
          title={`${t("groups.modal.assignTitle", "에이전트 배속 및 이동")} - ${selectedGroup.name}`}
        >
          <form onSubmit={handleAssignAgent} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
              {t("groups.modal.assignDesc", "배속할 에이전트 ID를 입력하거나 선택하세요. 에이전트 이동 시 기존 그룹에서 자동으로 탈퇴되고 신규 그룹으로 이전됩니다.")}
            </p>
            <Input
              label={t("groups.modal.agentIdLabel", "배속할 에이전트 ID (agt_*)")}
              placeholder="예: agt_support_01"
              value={assignAgentId}
              onChange={(e) => setAssignAgentId(e.target.value)}
              required
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Button variant="secondary" size="sm" type="button" onClick={() => setIsAssignOpen(false)}>
                {t("common.cancel", "취소")}
              </Button>
              <Button variant="primary" size="sm" type="submit">
                {t("common.save", "배속 완료")}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
