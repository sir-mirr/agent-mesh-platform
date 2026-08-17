import React, { useState } from "react";
import {
  PageHeader,
  DataTable,
  Button,
  Modal,
  Input,
  SubNavPills,
  Toast,
} from "@/components/index.ts";

interface SwarmGroup {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  members: string[]; // agent IDs
  createdAt: string;
}

const INITIAL_GROUPS: SwarmGroup[] = [
  {
    id: "grp_support",
    name: "Support Swarm",
    description: "고객 지원 및 자동 응답 에이전트 그룹",
    memberCount: 2,
    members: ["agt_support_01", "agt_support_02"],
    createdAt: "2026-08-15 10:20:00",
  },
  {
    id: "grp_billing",
    name: "Billing Core",
    description: "정산 및 인보이스 결제 처리 스웜",
    memberCount: 1,
    members: ["agt_finance_02"],
    createdAt: "2026-08-15 11:45:00",
  },
  {
    id: "grp_analytics",
    name: "Analytics Swarm",
    description: "시장 인텔리전스 및 데이터 수집 워커 그룹",
    memberCount: 1,
    members: ["agt_analyzer_03"],
    createdAt: "2026-08-16 09:30:00",
  },
];

export function GroupsPage() {
  const [groups, setGroups] = useState<SwarmGroup[]>(INITIAL_GROUPS);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<SwarmGroup | null>(null);

  // Form states
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [assignAgentId, setAssignAgentId] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const subNavItems = [
    { label: "내 에이전트", href: "/creator", icon: "🤖" },
    { label: "스웜 그룹 관리", href: "/creator/groups", icon: "👥" },
    { label: "스웜 토폴로지", href: "/creator/topology", icon: "🌐" },
    { label: "메시지 테스트", href: "/creator/playground", icon: "💬" },
    { label: "소켓리스 큐", href: "/creator/lease-queue", icon: "📥" },
    { label: "에이전트 등록", href: "/creator/register", icon: "➕" },
  ];

  const handleCreateGroup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName) return;

    const newGroup: SwarmGroup = {
      id: `grp_${Date.now()}`,
      name: newGroupName,
      description: newGroupDesc || "사용자 생성 스웜 그룹",
      memberCount: 0,
      members: [],
      createdAt: new Date().toISOString().replace("T", " ").substring(0, 19),
    };

    setGroups([...groups, newGroup]);
    setIsCreateOpen(false);
    setNewGroupName("");
    setNewGroupDesc("");
    setToastMessage(`스웜 그룹 [${newGroup.name}]이(가) 성공적으로 생성되었습니다.`);
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
      header: "스웜 그룹 명 / ID",
      render: (item: SwarmGroup) => (
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
      header: "그룹 설명",
      render: (item: SwarmGroup) => (
        <span style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
          {item.description}
        </span>
      ),
    },
    {
      key: "memberCount",
      header: "소속 에이전트",
      render: (item: SwarmGroup) => (
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
          {item.memberCount}명
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "생성 일시",
      render: (item: SwarmGroup) => (
        <span style={{ fontSize: "0.78rem", color: "var(--color-text-muted)" }}>
          {item.createdAt}
        </span>
      ),
    },
    {
      key: "actions",
      header: "작업",
      align: "right" as const,
      render: (item: SwarmGroup) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelectedGroup(item);
              setIsAssignOpen(true);
            }}
          >
            에이전트 배속/이동
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SubNavPills items={subNavItems} />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="25"
        title="스웜 그룹 관리 & 에이전트 배속"
        subtitle="스웜 그룹 생성 및 소유 에이전트 멤버십 이동·배치 (SPEC § 11.3 / § 12 group.manage)"
        actions={
          <Button variant="primary" size="sm" onClick={() => setIsCreateOpen(true)}>
            ➕ 스웜 그룹 생성
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
      />

      {/* Create Group Modal */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="신규 스웜 그룹 생성"
      >
        <form onSubmit={handleCreateGroup} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Input
            label="스웜 그룹 이름"
            placeholder="예: Analytics Swarm"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            required
          />
          <Input
            label="스웜 그룹 설명"
            placeholder="그룹의 역할 및 격리 목적을 입력하세요"
            value={newGroupDesc}
            onChange={(e) => setNewGroupDesc(e.target.value)}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Button variant="secondary" size="sm" type="button" onClick={() => setIsCreateOpen(false)}>
              취소
            </Button>
            <Button variant="primary" size="sm" type="submit">
              생성하기
            </Button>
          </div>
        </form>
      </Modal>

      {/* Assign Agent Modal */}
      {selectedGroup && (
        <Modal
          isOpen={isAssignOpen}
          onClose={() => setIsAssignOpen(false)}
          title={`[${selectedGroup.name}] 에이전트 배속`}
        >
          <form onSubmit={handleAssignAgent} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
              배속할 에이전트 ID를 입력하거나 선택하세요. 에이전트 이동 시 기존 그룹에서 자동으로 탈퇴되고 신규 그룹으로 이전됩니다.
            </p>
            <Input
              label="에이전트 ID (agt_*)"
              placeholder="예: agt_support_01"
              value={assignAgentId}
              onChange={(e) => setAssignAgentId(e.target.value)}
              required
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Button variant="secondary" size="sm" type="button" onClick={() => setIsAssignOpen(false)}>
                취소
              </Button>
              <Button variant="primary" size="sm" type="submit">
                배속 완료
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
