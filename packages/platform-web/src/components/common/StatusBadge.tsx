import React from "react";

export type BadgeStatus =
  | "online"
  | "offline"
  | "leased"
  | "pending"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

export interface StatusBadgeProps {
  status?: BadgeStatus;
  label: string;
  hasDot?: boolean;
  size?: "sm" | "md";
}

export function StatusBadge({
  status = "neutral",
  label,
  hasDot = true,
  size = "md",
}: StatusBadgeProps) {
  const statusColors: Record<BadgeStatus, { bg: string; text: string; dot: string }> = {
    online: { bg: "#ECFDF5", text: "#059669", dot: "#10B981" },
    success: { bg: "#ECFDF5", text: "#059669", dot: "#10B981" },
    leased: { bg: "#F0F9FF", text: "#0284C7", dot: "#0EA5E9" },
    pending: { bg: "#FFFBEB", text: "#D97706", dot: "#F59E0B" },
    warning: { bg: "#FFFBEB", text: "#D97706", dot: "#F59E0B" },
    danger: { bg: "#FEF2F2", text: "#DC2626", dot: "#EF4444" },
    offline: { bg: "#F1F5F9", text: "#64748B", dot: "#94A3B8" },
    neutral: { bg: "#F1F5F9", text: "#475569", dot: "#64748B" },
  };

  const current = statusColors[status] || statusColors.neutral;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: size === "sm" ? "2px 8px" : "4px 10px",
        borderRadius: "var(--radius-full)",
        background: current.bg,
        color: current.text,
        fontSize: size === "sm" ? "0.72rem" : "0.78rem",
        fontWeight: 600,
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
      }}
    >
      {hasDot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: current.dot,
            display: "inline-block",
          }}
        />
      )}
      {label}
    </span>
  );
}
