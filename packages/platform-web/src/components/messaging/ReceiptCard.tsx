import React from "react";
import { StatusBadge } from "@/components/common/StatusBadge.tsx";
import { FingerprintBox } from "@/components/data/FingerprintBox.tsx";

export interface ReceiptCardProps {
  messageId: string;
  sender: string;
  recipient: string;
  timestamp: string;
  signatureVerified: boolean;
  sha256Digest: string;
  leaseStatus?: "Available" | "Leased" | "Acked" | "DeadLetter";
}

export function ReceiptCard({
  messageId,
  sender,
  recipient,
  timestamp,
  signatureVerified,
  sha256Digest,
  leaseStatus = "Acked",
}: ReceiptCardProps) {
  return (
    <div
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

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <StatusBadge
            label={signatureVerified ? "Ed25519 서명 검증됨" : "서명 미검증"}
            status={signatureVerified ? "success" : "danger"}
            size="sm"
          />
          {leaseStatus && (
            <StatusBadge
              label={leaseStatus}
              status={
                leaseStatus === "Acked"
                  ? "success"
                  : leaseStatus === "Leased"
                  ? "leased"
                  : leaseStatus === "Available"
                  ? "pending"
                  : "danger"
              }
              size="sm"
            />
          )}
        </div>
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

      <FingerprintBox
        label="SHA-256 다이제스트"
        fingerprint={sha256Digest}
        prefix="sha256:"
      />
    </div>
  );
}
