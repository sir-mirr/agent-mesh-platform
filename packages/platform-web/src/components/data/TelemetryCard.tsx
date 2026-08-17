import React from "react";

export interface TelemetryCardProps {
  label: string;
  currentValue: string | number;
  maxLabel?: string;
  percentage: number; // 0 to 100
  barColor?: string;
  statusText?: string;
}

export function TelemetryCard({
  label,
  currentValue,
  maxLabel,
  percentage,
  barColor = "var(--color-primary)",
  statusText,
}: TelemetryCardProps) {
  const clampedPercentage = Math.min(100, Math.max(0, percentage));

  return (
    <div
      style={{
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
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
        <span
          style={{
            fontSize: "0.78rem",
            fontWeight: 700,
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.88rem",
            fontWeight: 700,
            color: "var(--color-text-primary)",
          }}
        >
          {currentValue} {maxLabel && <span style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>/ {maxLabel}</span>}
        </span>
      </div>

      {/* Progress Bar */}
      <div
        style={{
          height: 8,
          background: "var(--color-bg-surface-sub)",
          borderRadius: "var(--radius-full)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${clampedPercentage}%`,
            background: barColor,
            borderRadius: "var(--radius-full)",
            transition: "width 0.4s ease",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.72rem",
          color: "var(--color-text-muted)",
        }}
      >
        <span>{statusText || `${clampedPercentage.toFixed(1)}%`}</span>
        <span>{maxLabel || "100%"}</span>
      </div>
    </div>
  );
}
