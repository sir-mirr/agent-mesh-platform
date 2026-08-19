import React from "react";

export interface KpiCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  color?: string;
  icon?: string;
  trend?: {
    value: string;
    isPositive: boolean;
  };
}

export function KpiCard({
  label,
  value,
  subValue,
  color = "var(--color-primary)",
  icon,
  trend,
}: KpiCardProps) {
  return (
    <div
      // The label, so a scenario can name the card it is reading. Locating a
      // KPI by surrounding text matches whatever else shares the container.
      data-kpi={label}
      style={{
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: "var(--shadow-xs)",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: "0.78rem",
            fontWeight: 700,
            color: "var(--color-text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {label}
        </span>
        {icon && <span style={{ fontSize: "1.1rem" }}>{icon}</span>}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "1.85rem",
            fontWeight: 800,
            color,
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
          }}
        >
          {value}
        </span>
        {subValue && (
          <span
            style={{
              fontSize: "0.82rem",
              color: "var(--color-text-muted)",
              fontWeight: 500,
            }}
          >
            {subValue}
          </span>
        )}
      </div>

      {trend && (
        <div
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            color: trend.isPositive ? "var(--color-success)" : "var(--color-danger)",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span>{trend.isPositive ? "↑" : "↓"}</span>
          <span>{trend.value}</span>
        </div>
      )}
    </div>
  );
}
