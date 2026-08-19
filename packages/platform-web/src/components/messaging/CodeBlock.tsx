import React, { useState } from "react";
import { useI18n } from "@/contexts/I18nContext.tsx";

export interface CodeBlockProps {
  code: string;
  language?: string;
  title?: string;
  showCopy?: boolean;
}

export function CodeBlock({
  code,
  language = "bash",
  title,
  showCopy = true,
}: CodeBlockProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div
      style={{
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        border: "1px solid #1E293B",
        background: "#0F172A",
        color: "#F8FAFC",
        margin: "10px 0",
      }}
    >
      {(title || showCopy) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 14px",
            background: "#1E293B",
            fontSize: "0.75rem",
            color: "#94A3B8",
            borderBottom: "1px solid #334155",
          }}
        >
          <span>{title || language.toUpperCase()}</span>
          {showCopy && (
            <button
              onClick={handleCopy}
              style={{
                background: "transparent",
                border: "none",
                color: copied ? "#10B981" : "#94A3B8",
                cursor: "pointer",
                fontSize: "0.75rem",
                fontWeight: 600,
              }}
            >
              {copied ? `✓ ${t("reg.copied", "복사됨")}` : t("reg.copy", "코드 복사")}
            </button>
          )}
        </div>
      )}

      <pre
        style={{
          margin: 0,
          padding: "14px",
          fontFamily: "var(--font-mono)",
          fontSize: "0.82rem",
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
