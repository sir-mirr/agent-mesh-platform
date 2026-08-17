import React from "react";
import { Button } from "./Button.tsx";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "48px 24px",
        background: "var(--color-bg-surface)",
        border: "1px dashed var(--color-border)",
        borderRadius: "var(--radius-lg)",
        gap: 12,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: "var(--color-bg-surface-sub)",
          color: "var(--color-text-secondary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1.4rem",
        }}
      >
        {icon || "📭"}
      </div>

      <div style={{ maxWidth: 400 }}>
        <h3
          style={{
            fontSize: "1rem",
            fontWeight: 700,
            color: "var(--color-text-primary)",
          }}
        >
          {title}
        </h3>
        {description && (
          <p
            style={{
              fontSize: "0.82rem",
              color: "var(--color-text-secondary)",
              marginTop: 4,
              lineHeight: 1.5,
            }}
          >
            {description}
          </p>
        )}
      </div>

      {actionLabel && onAction && (
        <Button variant="primary" size="sm" onClick={onAction} style={{ marginTop: 8 }}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
