import React, { useState, useMemo } from "react";
import {
  PageHeader,
  Breadcrumbs,
  Button,
  ReceiptCard,
  JsonViewer,
} from "@/components/index.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { fetchAgents, type RegistryAgent } from "@/api/agents.ts";
import { sendMessageApi } from "@/api/messages.ts";

interface RegisteredAgent {
  id: string;
  name: string;
  group: string;
  ownerId: string;
  status: "online" | "offline";
  fingerprint: string | null;
}

const PAYLOAD_PRESETS = [
  {
    label: "정산 쿼리 (Settlement)",
    data: { action: "QUERY_SETTLEMENT", order_id: "ORD-98214", currency: "KRW" },
  },
  {
    label: "헬스체크 핑 (Heartbeat)",
    data: { action: "PING_HEARTBEAT", timestamp: Date.now(), client_version: "v1.0.4" },
  },
  {
    label: "상태 동기화 (Sync State)",
    data: { action: "SYNC_STATE", cluster_id: "grp_support", epoch: 4029 },
  },
  {
    label: "보안 알림 (Security Alert)",
    data: { action: "SECURITY_ALERT", code: "EGRESS_CHECK", target_group: "grp_billing" },
  },
];

export function PlaygroundPage() {
  const { user } = useAuth();
  const { t } = useI18n();

  const currentRole = user?.role || "AGENT_OPERATOR";
  const [agentsList, setAgentsList] = useState<RegisteredAgent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [isSending, setIsSending] = useState(false);

  // Load real agents from backend
  React.useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    fetchAgents().then((list) => {
      const mapped = (list || []).map((a) => ({
        id: a.identity,
        name: a.description || a.identity,
        group: a.type || "Default Group",
        ownerId: "admin",
        status: (a.status === "active" ? "online" : "offline") as "online" | "offline",
        // Absent, not invented — see `fetchAgents`.
          fingerprint: a.fingerprint ?? null,
      }));
      setAgentsList(mapped);
      if (mapped.length > 0) {
        setSender(mapped[0]!.id);
        setRecipient(mapped[1]?.id || mapped[0]!.id);
      }
    }).catch(() => {
      setIsError(true);
      setAgentsList([]);
    }).finally(() => {
      setIsLoading(false);
    });
  }, []);

  // 1. Filter sender agents visible/permitted to the current user
  const senderAgents = useMemo(() => {
    if (currentRole === "PLATFORM_ADMIN" || currentRole === "TENANT_ADMIN") {
      return agentsList;
    }
    return agentsList.filter(
      (a) => a.ownerId === user?.id || a.group === "Support Group"
    );
  }, [currentRole, user, agentsList]);

  // 2. Filter recipient agents visible/reachable to the current user
  const recipientAgents = useMemo(() => {
    if (currentRole === "PLATFORM_ADMIN" || currentRole === "TENANT_ADMIN") {
      return agentsList;
    }
    return agentsList.filter((a) => a.group !== "Security Mesh");
  }, [currentRole, agentsList]);

  const [sender, setSender] = useState<string>(
    senderAgents[0]?.id || "agt_support_01"
  );
  const [recipient, setRecipient] = useState<string>(
    recipientAgents.find((a) => a.id !== (senderAgents[0]?.id || "agt_support_01"))?.id || "agt_finance_02"
  );

  const [payloadText, setPayloadText] = useState(
    JSON.stringify(PAYLOAD_PRESETS[0]?.data || {}, null, 2)
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

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSending(true);
    const senderObj = agentsList.find((a) => a.id === sender);
    try {
      const res = await sendMessageApi({
        to: recipient,
        text: payloadText,
      });
      setReceipt({
        messageId: res.id || "영수증 미발급",
        sender: res.from || sender,
        recipient: res.to || recipient,
        timestamp: res.ts || new Date().toISOString(),
        signatureVerified: typeof (res as any).signature_verified === "boolean"
          ? (res as any).signature_verified
          : typeof (res as any).verified === "boolean"
          ? (res as any).verified
          : false,
        sha256Digest: (res as any).digest || (res as any).sha256 || senderObj?.fingerprint || "—",
        leaseStatus: res.status === "delivered" ? "Acked" : "Available",
      });
    } catch (err: any) {
      setReceipt(null);
      alert(`메시지 발송 실패: ${err.message}`);
    } finally {
      setIsSending(false);
    }
  };

  const selectedSenderObj = agentsList.find((a) => a.id === sender);
  const selectedRecipientObj = agentsList.find((a) => a.id === recipient);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="40"
        title={t("play.title", "메시지 라우팅 플레이그라운드")}
        subtitle={t("play.subtitle", "RFC 7519 JWT 토큰 기반 프록시 메시지 전송 및 전자서명 배달 영수증 검증 테스트")}
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
              ✉️ {t("play.dispatchTitle", "메시지 발송 (Outbox Dispatch)")}
            </h3>
          </div>

          {isLoading ? (
            <div style={{ padding: "12px 16px", background: "var(--color-bg-surface-sub)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", color: "var(--color-text-muted)", fontSize: "0.82rem", textAlign: "center" }}>
              에이전트 목록을 불러오는 중입니다...
            </div>
          ) : isError ? (
            <div style={{ padding: "12px 16px", background: "var(--status-warning-bg)", borderRadius: "var(--radius-md)", border: "1px solid var(--status-warning-br)", color: "var(--color-text-primary)", fontSize: "0.82rem", textAlign: "center" }}>
              에이전트 목록을 불러오지 못했습니다 (서버 연결 실패 또는 권한 오류).
            </div>
          ) : agentsList.length === 0 ? (
            <div style={{ padding: "12px 16px", background: "var(--color-bg-surface-sub)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", color: "var(--color-text-muted)", fontSize: "0.82rem", textAlign: "center" }}>
              현재 등록된 에이전트 데이터가 없습니다. 먼저 에이전트를 등록하세요.
            </div>
          ) : null}

          <form onSubmit={handleSendMessage} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Sender Agent Combobox */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--color-text-secondary)" }}>
                {t("play.senderLabel", "발신 에이전트 (Sender - 소유/관리 권한 필터링)")}
              </label>
              <select
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                  background: "#FFFFFF",
                  color: "var(--color-text-primary)",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  outline: "none",
                  cursor: "pointer",
                }}
                required
              >
                {senderAgents.map((agt) => (
                  <option key={agt.id} value={agt.id}>
                    {agt.status === "online" ? "🟢" : "⚪"} {agt.name} ({agt.id}) — [{agt.group}]
                  </option>
                ))}
              </select>
              {selectedSenderObj && (
                <div style={{ fontSize: "0.74rem", color: "var(--color-text-muted)", display: "flex", gap: 8, marginTop: 2 }}>
                  <span>소속: <strong>{selectedSenderObj.group}</strong></span>
                  <span>상태: <strong style={{ color: selectedSenderObj.status === "online" ? "var(--color-success)" : "var(--color-text-muted)" }}>{selectedSenderObj.status.toUpperCase()}</strong></span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{selectedSenderObj.fingerprint ? `${selectedSenderObj.fingerprint.substring(0, 20)}...` : "지문 없음"}</span>
                </div>
              )}
            </div>

            {/* Recipient Agent Combobox */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--color-text-secondary)" }}>
                {t("play.recipientLabel", "수신 에이전트 (Recipient - 활성 메시 대상)")}
              </label>
              <select
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                  background: "#FFFFFF",
                  color: "var(--color-text-primary)",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  outline: "none",
                  cursor: "pointer",
                }}
                required
              >
                {recipientAgents.map((agt) => (
                  <option key={agt.id} value={agt.id}>
                    {agt.status === "online" ? "🟢" : "⚪"} {agt.name} ({agt.id}) — [{agt.group}]
                  </option>
                ))}
              </select>
              {selectedRecipientObj && (
                <div style={{ fontSize: "0.74rem", color: "var(--color-text-muted)", display: "flex", gap: 8, marginTop: 2 }}>
                  <span>소속: <strong>{selectedRecipientObj.group}</strong></span>
                  <span>상태: <strong style={{ color: selectedRecipientObj.status === "online" ? "var(--color-success)" : "var(--color-text-muted)" }}>{selectedRecipientObj.status.toUpperCase()}</strong></span>
                </div>
              )}
            </div>

            {/* Preset Payload Buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--color-text-secondary)" }}>
                빠른 페이로드 템플릿:
              </label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {PAYLOAD_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setPayloadText(JSON.stringify(preset.data, null, 2))}
                    style={{
                      fontSize: "0.75rem",
                      padding: "4px 8px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--color-border)",
                      background: "var(--color-bg-surface-sub)",
                      color: "var(--color-text-secondary)",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* JSON Payload Input */}
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
                required
              />
            </div>

            <Button variant="primary" size="md" type="submit">
              🚀 {t("play.sendBtn", "메시지 발송 및 서명 생성")}
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
              <JsonViewer data={JSON.parse(payloadText || "{}")} title="발송된 메시지 본문 (Dispatched Payload)" />
            </>
          ) : (
            <div
              style={{
                background: "var(--color-bg-surface)",
                border: "1px dashed var(--color-border)",
                borderRadius: "var(--radius-xl)",
                padding: 40,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                color: "var(--color-text-muted)",
                fontSize: "0.9rem",
                height: "100%",
                minHeight: 380,
              }}
            >
              <span style={{ fontSize: "2rem" }}>📜</span>
              <span>{t("play.emptyReceipt", "메시지를 발송하면 암호학적 배달 영수증이 여기에 표시됩니다.")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
