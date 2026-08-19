import React, { useState, useEffect } from "react";
import { Modal, Button, StatusBadge, CodeBlock } from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { publicApiOrigin } from "@/config/env.ts";

export interface PendingAgentRequest {
  id: string;
  identity: string;
  name: string;
  groupName: string;
  requestedAt: string;
  /**
   * `null` when the proposal did not carry one.
   *
   * A required string here is what made `|| "sha256:verified_mesh_identity"`
   * the easy path at the call sites: a type that cannot say *absent* leaves
   * inventing a value as the only way to satisfy it.
   */
  fingerprint: string | null;
  status: "pending" | "approved" | "rejected";
}

interface AgentPairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  request: PendingAgentRequest | null;
  onApprove?: (fingerprint: string, identity: string, code: string) => void;
  onDeny?: (fingerprint: string, identity: string) => void;
}

export function AgentPairingModal({
  isOpen,
  onClose,
  request,
  onApprove,
  onDeny,
}: AgentPairingModalProps) {
  const { t } = useI18n();
  const [pairingCode, setPairingCode] = useState<string>("");
  const [ttl, setTtl] = useState<number>(300);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen && request) {
      // Generate a realistic pairing code: PAIR-XXXX-IDENTITY
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const cleanId = request.identity.replace(/^agt_/, "").toUpperCase();
      setPairingCode(`PAIR-${randomSuffix}-${cleanId}`);
      setTtl(300);
      setCopied(false);
    }
  }, [isOpen, request]);

  useEffect(() => {
    if (!isOpen || ttl <= 0) return;
    const timer = setInterval(() => {
      setTtl((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, ttl]);

  if (!request) return null;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(pairingCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("pairing.modal.title", "🤖 AI 에이전트 등록 요청 & 페어링 인증")}
      maxWidth={580}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
          {/*
            **Both decisions name a key by its fingerprint**, and with none there
            is no key to decide about. Disabled rather than sent as an empty
            string: § 10.2 approval is what lets an identity open a lane, and a
            request the server cannot resolve is not a request an operator
            should be able to make by clicking.
          */}
          <Button
            variant="danger"
            size="sm"
            disabled={request.fingerprint === null}
            onClick={() => {
              if (request.fingerprint === null) return;
              onDeny?.(request.fingerprint, request.identity);
              onClose();
            }}
          >
            {t("common.reject", "등록 거절")}
          </Button>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("common.close", "닫기")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={request.fingerprint === null}
              onClick={() => {
                if (request.fingerprint === null) return;
                onApprove?.(request.fingerprint, request.identity, pairingCode);
                onClose();
              }}
            >
              ✓ {t("pairing.modal.approveAndBind", "소유권 승인 & 활성화")}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Agent Info Card */}
        <div
          style={{
            background: "var(--color-bg-surface-sub)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-lg)",
            padding: "14px 18px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
            <div>
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", fontWeight: 600 }}>
                클라이언트 AI 에이전트 요청
              </span>
              <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
                {request.name}
              </h3>
            </div>
            <StatusBadge label={t("reg.pending", "대기 중")} status="pending" size="sm" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: "0.8rem" }}>
            <div>
              <span style={{ color: "var(--color-text-muted)" }}>에이전트 ID: </span>
              <code style={{ fontWeight: 600 }}>{request.identity}</code>
            </div>
            <div>
              <span style={{ color: "var(--color-text-muted)" }}>배속 그룹: </span>
              <strong style={{ color: "var(--color-primary)" }}>{request.groupName}</strong>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <span style={{ color: "var(--color-text-muted)" }}>공개키 지문: </span>
              <code style={{ fontSize: "0.72rem" }}>{request.fingerprint}</code>
            </div>
          </div>
        </div>

        {/* Pairing Code Box */}
        <div
          style={{
            background: "#F8FAFC",
            border: "2px dashed var(--color-primary)",
            borderRadius: "var(--radius-xl)",
            padding: "18px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 6 }}>
            🔑 1회용 에이전트 인증/페어링 코드 (SPEC § 11.3)
          </div>

          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "1.45rem",
              fontWeight: 800,
              letterSpacing: "0.08em",
              color: "var(--color-primary)",
              margin: "8px 0",
              userSelect: "all",
            }}
          >
            {pairingCode}
          </div>

          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 10 }}>
            <Button variant="primary" size="sm" onClick={handleCopyCode}>
              {copied ? `✓ ${t("reg.copied", "복사됨")}` : `📋 ${t("reg.copy", "코드 복사")}`}
            </Button>
            <span style={{ fontSize: "0.78rem", color: ttl < 60 ? "var(--color-danger)" : "var(--color-text-muted)" }}>
              ⏱️ 유효시간: <strong>{ttl}초</strong>
            </span>
          </div>
        </div>

        {/* Client CLI Instructions */}
        <div>
          <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--color-text-secondary)" }}>
            에이전트 클라이언트 / 터미널에 전달할 인증 명령:
          </span>
          <div style={{ marginTop: 6 }}>
            <CodeBlock
              language="bash"
              code={`curl -X POST ${publicApiOrigin()}/api/v1/pairing-codes/redeem \\
  -H "Content-Type: application/json" \\
  -d '{"code": "${pairingCode}", "owner": "admin"}'`}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
