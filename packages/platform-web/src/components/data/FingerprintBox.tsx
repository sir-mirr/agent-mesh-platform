import React, { useState } from "react";

export interface FingerprintBoxProps {
  fingerprint: string;
  prefix?: string;
  label?: string;
  showCopy?: boolean;
}

export function FingerprintBox({
  fingerprint,
  prefix = "sha256:",
  label,
  showCopy = true,
}: FingerprintBoxProps) {
  const [copied, setCopied] = useState(false);

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
            {copied ? "✓ 복사됨" : "복사"}
          </button>
        )}
      </div>
    </div>
  );
}
