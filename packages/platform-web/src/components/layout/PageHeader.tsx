import React from "react";
import { StatusBadge } from "@/components/common/StatusBadge.tsx";

export interface PageHeaderProps {
  suiteTag?: string;
  suiteBadgeColor?: "leased" | "success" | "warning" | "neutral";
  screenId?: string | number;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function PageHeader({
  suiteTag,
  suiteBadgeColor = "neutral",
  screenId,
  title,
  subtitle,
  actions,
}: PageHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: 24,
        flexWrap: "wrap",
        gap: 16,
      }}
    >
      <div>
        {(suiteTag || screenId) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
              flexWrap: "wrap",
            }}
          >
            {suiteTag && (
              <StatusBadge
                label={suiteTag}
                status={suiteBadgeColor === "leased" ? "leased" : "neutral"}
                hasDot={false}
                size="sm"
              />
            )}
            {screenId && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.75rem",
                  color: "var(--color-text-muted)",
                }}
              >
                Screen #{screenId}
              </span>
            )}
          </div>
        )}

        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 800,
            letterSpacing: "-0.03em",
            color: "var(--color-text-primary)",
          }}
        >
          {title}
        </h1>

        {subtitle && (
          <p
            style={{
              fontSize: "0.88rem",
              color: "var(--color-text-secondary)",
              marginTop: 4,
              lineHeight: 1.4,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>

      {actions && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {actions}
        </div>
      )}
    </div>
  );
}
