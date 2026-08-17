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

interface LeaseItem {
  id: string;
  sender: string;
  recipient: string;
  status: "Available" | "Leased" | "Acked";
  ttlRemaining: number; // in seconds
  enqueuedAt: string;
}

const INITIAL_QUEUE: LeaseItem[] = [
  {
    id: "msg_892147",
    sender: "agt_support_01",
    recipient: "agt_finance_02",
    status: "Leased",
    ttlRemaining: 274,
    enqueuedAt: "2026-08-17 13:35:12",
  },
  {
    id: "msg_892148",
    sender: "agt_analyzer_03",
    recipient: "agt_support_01",
    status: "Available",
    ttlRemaining: 300,
    enqueuedAt: "2026-08-17 13:38:00",
  },
  {
    id: "msg_892149",
    sender: "agt_support_01",
    recipient: "agt_analyzer_03",
    status: "Leased",
    ttlRemaining: 182,
    enqueuedAt: "2026-08-17 13:33:45",
  },
];

export function LeaseQueuePage() {
  const [queue, setQueue] = useState<LeaseItem[]>(INITIAL_QUEUE);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

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
    setToastMessage(`메시지 [${id}] ACK 확인 완료 (큐에서 해제)`);
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
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>
          {item.id}
        </span>
      ),
    },
    {
      key: "route",
      header: "경로 (Sender → Recipient)",
      render: (item: LeaseItem) => (
        <span style={{ fontSize: "0.82rem" }}>
          <code>{item.sender}</code> → <code>{item.recipient}</code>
        </span>
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
        title="소켓리스 인박스 큐 & 300초 리스 감시"
        subtitle="At-Least-Once 보증 소켓리스 리스 상태머신 (Available → Leased → Acked) 실시간 감시"
      />

      {toastMessage && (
        <Toast
          type="info"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      {/* Telemetry row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <TelemetryCard
          label="임대 중인 메시지 (Leased)"
          currentValue={`${leasedCount}건`}
          maxLabel="총 적체"
          percentage={(leasedCount / Math.max(1, queue.length)) * 100}
          barColor="var(--color-leased)"
          statusText="워커가 처리 중"
        />
        <TelemetryCard
          label="대기 중인 메시지 (Available)"
          currentValue={`${availableCount}건`}
          maxLabel="총 적체"
          percentage={(availableCount / Math.max(1, queue.length)) * 100}
          barColor="var(--color-warning)"
          statusText="즉시 Lease 가능"
        />
      </div>

      <DataTable
        columns={columns}
        data={queue}
        keyExtractor={(item) => item.id}
      />
    </div>
  );
}
