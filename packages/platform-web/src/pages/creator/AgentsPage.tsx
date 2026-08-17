import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  StatusBadge,
  FingerprintBox,
  Button,
  ConfirmDialog,
} from "@/components/index.ts";

interface AgentItem {
  id: string;
  name: string;
  groupName: string;
  status: "online" | "offline" | "pending";
  fingerprint: string;
  inboxDepth: number;
  lastSeen: string;
}

const INITIAL_AGENTS: AgentItem[] = [
  {
    id: "agt_support_01",
    name: "Customer Support Agent",
    groupName: "Support Swarm",
    status: "online",
    fingerprint: "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    inboxDepth: 0,
    lastSeen: "방금 전 (Active WS)",
  },
  {
    id: "agt_finance_02",
    name: "Financial Settlement Bot",
    groupName: "Billing Core",
    status: "online",
    fingerprint: "sha256:3urP2MxXOlnreg184OjQ5tAyF2U2533GWGC6xoe_DJc48271039485728192039",
    inboxDepth: 2,
    lastSeen: "2분 전 (Socketless)",
  },
  {
    id: "agt_analyzer_03",
    name: "Market Intelligence Worker",
    groupName: "Analytics Swarm",
    status: "offline",
    fingerprint: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    inboxDepth: 5,
    lastSeen: "14분 전",
  },
];

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentItem[]>(INITIAL_AGENTS);
  const [teardownTarget, setTeardownTarget] = useState<AgentItem | null>(null);
  const [isTeardownOpen, setIsTeardownOpen] = useState(false);

  const handleTeardownConfirm = () => {
    if (!teardownTarget) return;
    setAgents(agents.filter((a) => a.id !== teardownTarget.id));
    setIsTeardownOpen(false);
    setTeardownTarget(null);
  };

  const columns = [
    {
      key: "name",
      header: "에이전트 명 / ID",
      render: (item: AgentItem) => (
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
      key: "groupName",
      header: "소속 그룹",
      render: (item: AgentItem) => (
        <span
          style={{
            padding: "3px 8px",
            background: "var(--color-bg-surface-sub)",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.78rem",
            fontWeight: 600,
          }}
        >
          {item.groupName}
        </span>
      ),
    },
    {
      key: "status",
      header: "상태",
      render: (item: AgentItem) => (
        <StatusBadge
          label={
            item.status === "online"
              ? "ONLINE (WS 연결)"
              : item.status === "offline"
              ? "OFFLINE"
              : "PENDING"
          }
          status={item.status}
          size="sm"
        />
      ),
    },
    {
      key: "fingerprint",
      header: "Ed25519 공개키 지문",
      render: (item: AgentItem) => (
        <FingerprintBox fingerprint={item.fingerprint} showCopy={true} />
      ),
    },
    {
      key: "inboxDepth",
      header: "인박스 적체",
      render: (item: AgentItem) => (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            color:
              item.inboxDepth > 0
                ? "var(--color-warning)"
                : "var(--color-text-muted)",
          }}
        >
          {item.inboxDepth}건
        </span>
      ),
    },
    {
      key: "actions",
      header: "작업",
      align: "right" as const,
      render: (item: AgentItem) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <Link to="/creator/playground">
            <Button variant="secondary" size="sm">
              메시지 테스트
            </Button>
          </Link>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setTeardownTarget(item);
              setIsTeardownOpen(true);
            }}
          >
            Teardown
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
        screenId="37"
        title="소유 에이전트 운영 스튜디오"
        subtitle="등록된 자율 에이전트 플릿 관리, 실시간 온라인 웹소켓 상태 및 암호학적 지문 검증"
        actions={
          <Link to="/creator/register">
            <Button variant="primary" size="sm">
              ➕ 신규 에이전트 등록
            </Button>
          </Link>
        }
      />

      <DataTable
        columns={columns}
        data={agents}
        keyExtractor={(item) => item.id}
      />

      {teardownTarget && (
        <ConfirmDialog
          isOpen={isTeardownOpen}
          onClose={() => setIsTeardownOpen(false)}
          onConfirm={handleTeardownConfirm}
          title={`에이전트 영구 Teardown (§ 9.3)`}
          description={`에이전트 [${teardownTarget.name}] (${teardownTarget.id})의 신원을 영구 파괴합니다. 승인된 공개키는 침해 보관소로 이동하며, 동일 ID로의 재등록이 영구 차단(409)됩니다.`}
          confirmLabel="영구 Teardown 실행"
          isDestructive={true}
          confirmPromptMatch={teardownTarget.id}
        />
      )}
    </div>
  );
}
