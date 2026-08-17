import React, { useState } from "react";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  StatusBadge,
  Button,
} from "@/components/index.ts";
import { useRbac } from "@/contexts/RbacContext.tsx";

interface AuditEvent {
  id: string;
  timestamp: string;
  sender: string;
  recipient: string;
  contentLength: number;
  rawContent: string;
  signatureVerified: boolean;
}

const INITIAL_EVENTS: AuditEvent[] = [
  {
    id: "evt_109281",
    timestamp: "2026-08-17 13:38:12",
    sender: "agt_support_01",
    recipient: "agt_finance_02",
    contentLength: 64,
    rawContent: '{"action":"QUERY_SETTLEMENT","order_id":"ORD-98214"}',
    signatureVerified: true,
  },
  {
    id: "evt_109282",
    timestamp: "2026-08-17 13:37:45",
    sender: "agt_finance_02",
    recipient: "agt_support_01",
    contentLength: 128,
    rawContent: '{"status":"CONFIRMED","tx_hash":"0x7f83...","amount":150000}',
    signatureVerified: true,
  },
];

export function AuditLogsPage() {
  const { hasCapability } = useRbac();
  const [events] = useState<AuditEvent[]>(INITIAL_EVENTS);
  const canReadContent = hasCapability("audit.read_content");

  const columns = [
    {
      key: "timestamp",
      header: "타임스탬프",
      render: (item: AuditEvent) => (
        <span style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
          {item.timestamp}
        </span>
      ),
    },
    {
      key: "route",
      header: "송수신 경로",
      render: (item: AuditEvent) => (
        <span style={{ fontSize: "0.82rem" }}>
          <code>{item.sender}</code> → <code>{item.recipient}</code>
        </span>
      ),
    },
    {
      key: "contentLength",
      header: "길이 (Bytes)",
      render: (item: AuditEvent) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
          {item.contentLength} B
        </span>
      ),
    },
    {
      key: "content",
      header: "메시지 본문 (§ 11.0 프라이버시 경계)",
      render: (item: AuditEvent) => {
        if (!canReadContent) {
          return (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.75rem",
                color: "var(--color-warning)",
                background: "var(--status-warning-bg)",
                padding: "2px 6px",
                borderRadius: "var(--radius-sm)",
              }}
            >
              [content withheld — requires audit.read.content]
            </span>
          );
        }
        return (
          <code
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              background: "var(--color-bg-surface-sub)",
              padding: "2px 6px",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {item.rawContent}
          </code>
        );
      },
    },
    {
      key: "signatureVerified",
      header: "서명 상태",
      render: () => (
        <StatusBadge label="VERIFIED" status="success" size="sm" />
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="TENANT ADMIN"
        suiteBadgeColor="leased"
        screenId="33"
        title="참가자 본문 감사 스트림"
        subtitle="SPEC § 11.0 프라이버시 경계: audit.read.content 권한 보유자에게만 본문 노출, 미보유 시 [content withheld] 리댁션"
        actions={
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            ↻ 감사 로그 갱신
          </Button>
        }
      />

      <div
        style={{
          padding: "12px 16px",
          background: canReadContent ? "var(--status-success-bg)" : "var(--status-warning-bg)",
          border: `1px solid ${canReadContent ? "var(--status-success-br)" : "var(--status-warning-br)"}`,
          borderRadius: "var(--radius-md)",
          fontSize: "0.82rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>
          현재 권한 상태:{" "}
          <strong>
            {canReadContent
              ? "✓ audit.read.content 보유 (본문 열람 가능 — 열람 시 내부 감사 로그 기록됨)"
              : "⚠️ audit.read.content 미보유 (본문 유출 차단, 메타데이터만 열람)"}
          </strong>
        </span>
      </div>

      <DataTable
        columns={columns}
        data={events}
        keyExtractor={(item) => item.id}
      />
    </div>
  );
}
