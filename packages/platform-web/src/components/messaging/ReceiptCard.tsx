import React from "react";
import { StatusBadge } from "@/components/common/StatusBadge.tsx";
import type { MessageReceipt } from "@/api/messages.ts";

export interface ReceiptCardProps {
  messageId: string;
  sender: string;
  recipient: string;
  timestamp: string;
  /**
   * The status the server stored for this message, in the server's own words.
   * Taken from `MessageReceipt` so a word that stops existing over there
   * becomes a type error here rather than an unreachable branch.
   */
  status: MessageReceipt["status"];
}

/**
 * The card used to carry two more rows: an `Ed25519 서명 검증됨` badge and a
 * `SHA-256 다이제스트` box. Neither had a producer — no route on this platform
 * sends a signature or a per-message digest, which is the same finding that
 * removed `signature_verified` from the audit screen. The badge was therefore
 * always `서명 미검증` in red, and the digest box fell back to the *sender's*
 * agent fingerprint, so a real sha256 sat under a label saying it was the
 * digest of this message. Absent is a better statement than a value that is
 * some other thing's hash.
 */
const STATUS_TEXT: Record<MessageReceipt["status"], { label: string; tone: "success" | "pending" | "danger" }> = {
  pending: { label: "허브 접수 · 수신 대기", tone: "pending" },
  delivered: { label: "배달됨", tone: "success" },
  read: { label: "읽음", tone: "success" },
  failed: { label: "허브가 거절함", tone: "danger" },
};

export function ReceiptCard({
  messageId,
  sender,
  recipient,
  timestamp,
  status,
}: ReceiptCardProps) {
  const stated = STATUS_TEXT[status];

  return (
    <div
      data-testid="receipt-card"
      data-message-id={messageId}
      data-status={status}
      style={{
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxShadow: "var(--shadow-xs)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "1.1rem" }}>🧾</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.85rem",
              fontWeight: 700,
            }}
          >
            {messageId}
          </span>
        </div>

        <StatusBadge
          label={stated ? stated.label : `알 수 없는 상태: ${status}`}
          status={stated ? stated.tone : "neutral"}
          size="sm"
        />
      </div>

      {/* Meta Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          background: "var(--color-bg-surface-sub)",
          padding: "10px 14px",
          borderRadius: "var(--radius-md)",
          fontSize: "0.8rem",
        }}
      >
        <div>
          <span style={{ color: "var(--color-text-muted)" }}>보낸이: </span>
          <strong style={{ fontFamily: "var(--font-mono)" }}>{sender}</strong>
        </div>
        <div>
          <span style={{ color: "var(--color-text-muted)" }}>받는이: </span>
          <strong style={{ fontFamily: "var(--font-mono)" }}>{recipient}</strong>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <span style={{ color: "var(--color-text-muted)" }}>타임스탬프: </span>
          <span>{timestamp}</span>
        </div>
      </div>
    </div>
  );
}
