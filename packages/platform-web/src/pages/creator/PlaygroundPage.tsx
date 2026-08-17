import React, { useState } from "react";
import {
  PageHeader,
  Button,
  Input,
  SubNavPills,
  ReceiptCard,
  JsonViewer,
} from "@/components/index.ts";

export function PlaygroundPage() {
  const [sender, setSender] = useState("agt_support_01");
  const [recipient, setRecipient] = useState("agt_finance_02");
  const [payloadText, setPayloadText] = useState(
    JSON.stringify({ action: "QUERY_SETTLEMENT", order_id: "ORD-98214" }, null, 2)
  );
  const [receipt, setReceipt] = useState<{
    messageId: string;
    sender: string;
    recipient: string;
    timestamp: string;
    signatureVerified: boolean;
    sha256Digest: string;
    leaseStatus: "Available" | "Leased" | "Acked";
  } | null>(null);

  const subNavItems = [
    { label: "내 에이전트", href: "/creator", icon: "🤖" },
    { label: "스웜 그룹 관리", href: "/creator/groups", icon: "👥" },
    { label: "스웜 토폴로지", href: "/creator/topology", icon: "🌐" },
    { label: "메시지 테스트", href: "/creator/playground", icon: "💬" },
    { label: "소켓리스 큐", href: "/creator/lease-queue", icon: "📥" },
    { label: "에이전트 등록", href: "/creator/register", icon: "➕" },
  ];

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    setReceipt({
      messageId: `msg_${Math.random().toString(36).substring(2, 9)}`,
      sender,
      recipient,
      timestamp: new Date().toISOString(),
      signatureVerified: true,
      sha256Digest: "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
      leaseStatus: "Acked",
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SubNavPills items={subNavItems} />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="40"
        title="메시지 테스트 플레이그라운드"
        subtitle="에이전트 간 Ed25519 서명 프록시 메시지 발송 및 실시간 암호학적 영수증 검증"
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Send Form */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>
            ✉️ 메시지 발송 (Outbox Dispatch)
          </h3>

          <form onSubmit={handleSendMessage} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input
              label="발신 에이전트 (Sender)"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              required
            />
            <Input
              label="수신 에이전트 (Recipient)"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              required
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--color-text-secondary)" }}>
                메시지 페이로드 (JSON)
              </label>
              <textarea
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                rows={6}
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.82rem",
                  background: "var(--color-bg-surface-sub)",
                  outline: "none",
                }}
              />
            </div>

            <Button variant="primary" size="md" type="submit">
              🚀 메시지 발송 및 서명 생성
            </Button>
          </form>
        </div>

        {/* Receipt & Trace View */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {receipt ? (
            <>
              <ReceiptCard
                messageId={receipt.messageId}
                sender={receipt.sender}
                recipient={receipt.recipient}
                timestamp={receipt.timestamp}
                signatureVerified={receipt.signatureVerified}
                sha256Digest={receipt.sha256Digest}
                leaseStatus={receipt.leaseStatus}
              />
              <JsonViewer data={JSON.parse(payloadText || "{}")} title="발송된 메시지 본문" />
            </>
          ) : (
            <div
              style={{
                background: "var(--color-bg-surface)",
                border: "1px dashed var(--color-border)",
                borderRadius: "var(--radius-xl)",
                padding: 40,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-text-muted)",
                fontSize: "0.9rem",
                height: "100%",
              }}
            >
              메시지를 발송하면 암호학적 배달 영수증이 여기에 표시됩니다.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
