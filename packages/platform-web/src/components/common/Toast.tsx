import React from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastProps {
  type?: ToastType;
  message: string;
  onClose?: () => void;
}

export function Toast({ type = "info", message, onClose }: ToastProps) {
  const typeStyles: Record<ToastType, { bg: string; border: string; text: string; icon: string }> = {
    success: { bg: "#ECFDF5", border: "#A7F3D0", text: "#065F46", icon: "✓" },
    error: { bg: "#FEF2F2", border: "#FECACA", text: "#991B1B", icon: "✕" },
    warning: { bg: "#FFFBEB", border: "#FDE68A", text: "#92400E", icon: "!" },
    info: { bg: "#EFF6FF", border: "#BFDBFE", text: "#1E40AF", icon: "ℹ" },
  };

  const current = typeStyles[type];

  return (
    <div
      // **What kind of thing the screen said, not only what it said.** A
      // success and a failure are one word apart in this console's copy —
      // `groups.created` and `groups.createFailed` differ by a suffix, and the
      // button on the page carries the first of them — so a scenario reading
      // page text cannot tell them apart. That is how three checks ended up
      // asserting the absence of a string nobody writes. `data-kpi` exists on
      // the cards for the same reason.
      //
      // The keys rather than their copy, deliberately: `SC-I18N-04` counts
      // Korean in this package's source, and it does not exempt comments —
      // correctly, since a sentence quoted into one is a second copy that
      // stops matching the dictionary the moment the copy changes.
      data-toast={type}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderRadius: "var(--radius-md)",
        background: current.bg,
        border: `1px solid ${current.border}`,
        color: current.text,
        fontSize: "0.85rem",
        fontWeight: 600,
        boxShadow: "var(--shadow-md)",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "currentColor",
          color: current.bg,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "0.7rem",
          fontWeight: 800,
        }}
      >
        {current.icon}
      </span>
      <span>{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "currentColor",
            cursor: "pointer",
            fontSize: "0.9rem",
            marginLeft: 8,
            padding: 2,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
