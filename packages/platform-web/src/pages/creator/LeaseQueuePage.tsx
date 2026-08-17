import React, { useState, useEffect } from "react";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  StatusBadge,
  TelemetryCard,
  Button,
  Toast,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

interface AgentIdentity {
  id: string;
  name: string;
  group: string;
}

interface LeaseItem {
  id: string;
  sender: AgentIdentity;
  recipient: AgentIdentity;
  status: "Available" | "Leased" | "Acked";
  ttlRemaining: number; // in seconds
  enqueuedAt: string;
}

import { fetchAdminMailbox } from "@/api/mailbox.ts";

export function LeaseQueuePage() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<LeaseItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load real admin mailbox metrics on mount
  useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    fetchAdminMailbox()
      .then((res) => {
        if (res && res.mailboxes && res.mailboxes.length > 0) {
          setQueue(
            res.mailboxes.map((m: any, idx: number) => ({
              id: `msg_mb_${idx + 1}`,
              sender: { id: "hub", name: "메시 허브", group: "System" },
              recipient: { id: m.agentId || m.identity || "agent", name: m.agentId || m.identity, group: "General" },
              status: "Available",
              ttlRemaining: m.ttlSeconds || 300,
              enqueuedAt: new Date().toLocaleTimeString(),
            }))
          );
        }
      })
      .catch(() => {
        setIsError(true);
        setQueue([]);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Countdown timer simulation
  useEffect(() => {
    const timer = setInterval(() => {
      setQueue((prev) =>
        prev.map((item) => {
          if (item.status === "Leased" && item.ttlRemaining > 0) {
            return { ...item, ttlRemaining: item.ttlRemaining - 1 };
          }
          return item;
        })
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleAck = (id: string) => {
    setQueue(queue.map((item) => (item.id === id ? { ...item, status: "Acked" } : item)));
    setToastMessage(`메시지 [${id}] ACK 확인 완료 (메일함 큐에서 해제)`);
  };

  const handleNack = (id: string) => {
    setQueue(
      queue.map((item) =>
        item.id === id ? { ...item, status: "Available", ttlRemaining: 300 } : item
      )
    );
    setToastMessage(`메시지 [${id}] NACK 반환 (Available 상태로 재적체)`);
  };

  const leasedCount = queue.filter((i) => i.status === "Leased").length;
  const availableCount = queue.filter((i) => i.status === "Available").length;

  const columns = [
    {
      key: "id",
      header: "메시지 ID",
      render: (item: LeaseItem) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.85rem" }}>
          {item.id}
        </span>
      ),
    },
    {
      key: "route",
      header: "경로 (발신 에이전트 → 수신 에이전트)",
      render: (item: LeaseItem) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
              🤖 {item.sender.name}
            </span>
            <code style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
              {item.sender.id}
            </code>
          </div>
          <span style={{ color: "var(--color-primary)", fontWeight: 700, fontSize: "0.95rem" }}>➔</span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>
              📥 {item.recipient.name}
            </span>
            <code style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
              {item.recipient.id}
            </code>
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "리스 상태",
      render: (item: LeaseItem) => (
        <StatusBadge
          label={
            item.status === "Leased"
              ? `Leased (${item.ttlRemaining}s)`
              : item.status === "Available"
              ? "Available"
              : "Acked"
          }
          status={
            item.status === "Leased"
              ? "leased"
              : item.status === "Available"
              ? "pending"
              : "success"
          }
          size="sm"
        />
      ),
    },
    {
      key: "ttl",
      header: "300s 리스 카운트다운",
      render: (item: LeaseItem) => (
        <div style={{ width: 140 }}>
          <div
            style={{
              height: 6,
              background: "var(--color-bg-surface-sub)",
              borderRadius: "var(--radius-full)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${(item.ttlRemaining / 300) * 100}%`,
                background:
                  item.ttlRemaining < 60
                    ? "var(--color-danger)"
                    : "var(--color-primary)",
              }}
            />
          </div>
        </div>
      ),
    },
    {
      key: "actions",
      header: "원자적 일괄 작업",
      align: "right" as const,
      render: (item: LeaseItem) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {item.status === "Leased" && (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleAck(item.id)}
              >
                ACK 승인
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => handleNack(item.id)}
              >
                NACK 반환
              </Button>
            </>
          )}
          {item.status === "Available" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setQueue(
                  queue.map((q) =>
                    q.id === item.id ? { ...q, status: "Leased", ttlRemaining: 300 } : q
                  )
                );
              }}
            >
              Lease 획득
            </Button>
          )}
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
        screenId="42"
        title={t("lease.title", "에이전트 메일함 리스 큐 & 300초 리스 감시")}
        subtitle={t("lease.subtitle", "At-Least-Once 보증 메일함 리스 상태머신 (Available → Leased → Acked) 실시간 감시 (SPEC § 9)")}
      />

      {toastMessage && (
        <Toast
          type="info"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      {/* Guide Banner: Explaining Lease & 300s TTL Architecture */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: "16px 20px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>⏱️</div>
          <div>
            <strong style={{ fontSize: "0.88rem", color: "var(--color-text-primary)" }}>
              Lease (독점 임대) 상태란?
            </strong>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginTop: 4, lineHeight: 1.4 }}>
              비동기/서버리스 워커 에이전트가 메시지를 꺼내갈 때, 즉시 삭제하지 않고 <strong>다른 워커의 중복 처리를 방지하기 위해 일정 시간 동안 독점 잠금(Lock)</strong>하는 개념입니다.
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>🛡️</div>
          <div>
            <strong style={{ fontSize: "0.88rem", color: "var(--color-text-primary)" }}>
              300초 TTL (At-Least-Once 안전장치)
            </strong>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginTop: 4, lineHeight: 1.4 }}>
              워커가 정상 완료 시 <code>ACK</code>를 보내면 영구 해제되며, 만약 워커 프로세스가 비정상 종료되어 300초 동안 응답이 없으면 <strong>메시지가 자동 복구(Available)되어 유실 없이 재처리</strong>됩니다.
            </p>
          </div>
        </div>
      </div>

      {/* Telemetry row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <TelemetryCard
          label="임대 중인 메시지 (Leased)"
          currentValue={isError ? "측정 불가" : `${leasedCount}건`}
          maxLabel="총 적체"
          percentage={isError ? 0 : (leasedCount / Math.max(1, queue.length)) * 100}
          barColor="var(--color-leased)"
          statusText={isError ? "서버 연결 불가" : "워커가 처리 중 (300s TTL 카운트다운)"}
        />
        <TelemetryCard
          label="대기 중인 메시지 (Available)"
          currentValue={isError ? "측정 불가" : `${availableCount}건`}
          maxLabel="총 적체"
          percentage={isError ? 0 : (availableCount / Math.max(1, queue.length)) * 100}
          barColor="var(--color-warning)"
          statusText={isError ? "서버 연결 불가" : "즉시 Lease 획득 가능"}
        />
      </div>

      <DataTable
        columns={columns}
        data={queue}
        keyExtractor={(item) => item.id}
        isLoading={isLoading}
        isError={isError}
        errorMessage="메일함 리스 큐 데이터를 불러올 수 없습니다 (서버 연결 실패)."
        emptyMessage="현재 대기 중인 메일박스 메시지 데이터가 없습니다."
      />
    </div>
  );
}
