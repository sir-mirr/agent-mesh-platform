import React, { useEffect } from "react";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number | string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = 480,
}: ModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-md)",
          width: "100%",
          maxWidth,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {title && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "18px 24px",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <h2
              style={{
                fontSize: "1.1rem",
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: "var(--color-text-primary)",
              }}
            >
              {title}
            </h2>
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                fontSize: "1.2rem",
                color: "var(--color-text-muted)",
                cursor: "pointer",
                padding: 4,
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div
            style={{
              padding: "14px 24px",
              borderTop: "1px solid var(--color-border)",
              background: "var(--color-bg-surface-sub)",
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
