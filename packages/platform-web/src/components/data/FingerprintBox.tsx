import React, { useState } from "react";
import { useI18n } from "@/contexts/I18nContext.tsx";

export interface FingerprintBoxProps {
  /**
   * `null` when the caller does not have one.
   *
   * **It has to be representable.** `/creator` used to pass
   * `a.fingerprint || "sha256:verified_mesh_identity"` because this prop was a
   * required string, and `GET /api/v1/agents` carries no fingerprint — so every
   * row showed that constant under a column headed "Ed25519 public key
   * fingerprint". A fingerprint is what an operator compares to decide an
   * identity is who it claims to be; a constant makes every agent match, and
   * the word `verified` inside it invites skipping the comparison.
   *
   * A type that cannot say "I do not have this" is what made inventing one the
   * easy path.
   */
  fingerprint: string | null;
  prefix?: string;
  label?: string;
  showCopy?: boolean;
  /** What to say when there is none. Named, because "—" alone reads as zero. */
}

export function FingerprintBox({
  fingerprint,
  prefix = "sha256:",
  label,
  showCopy = true,
}: FingerprintBoxProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  if (fingerprint === null || fingerprint === "") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {label && (
          <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-secondary)" }}>
            {label}
          </span>
        )}
        <span
          data-testid="fingerprint-absent"
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--color-text-muted)" }}
        >
          — 지문 없음 (서버가 이 목록에 싣지 않습니다)
        </span>
      </div>
    );
  }

  const fullText = fingerprint.startsWith(prefix)
    ? fingerprint
    : `${prefix}${fingerprint}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <span
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </span>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "var(--color-bg-surface-sub)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          padding: "6px 10px",
          gap: 8,
        }}
      >
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
            color: "var(--color-text-primary)",
            letterSpacing: "0.02em",
            wordBreak: "break-all",
            flex: 1,
            userSelect: "all",
          }}
          title={fullText}
        >
          <span style={{ color: "var(--color-primary)", fontWeight: 700 }}>
            {prefix}
          </span>
          {fullText.slice(prefix.length)}
        </code>

        {showCopy && (
          <button
            onClick={handleCopy}
            type="button"
            style={{
              background: copied ? "var(--color-success)" : "var(--color-bg-surface)",
              border: `1px solid ${copied ? "var(--color-success)" : "var(--color-border-strong)"}`,
              color: copied ? "#FFFFFF" : "var(--color-text-secondary)",
              padding: "3px 8px",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.72rem",
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.15s ease",
              whiteSpace: "nowrap",
            }}
          >
            {copied ? `✓ ${t("reg.copied", "복사됨")}` : t("fp.copy", "복사")}
          </button>
        )}
      </div>
    </div>
  );
}
