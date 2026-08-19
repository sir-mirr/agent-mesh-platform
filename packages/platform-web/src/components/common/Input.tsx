import React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export function Input({
  label,
  error,
  helperText,
  style,
  id,
  ...props
}: InputProps) {
  const generatedId = React.useId();
  const inputId = id || generatedId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontSize: "0.82rem",
            fontWeight: 600,
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </label>
      )}

      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          width: "100%",
        }}
      >

        <input
          id={inputId}
          style={{
            width: "100%",
            padding: "9px 12px",
            paddingLeft: 12,
            paddingRight: 12,
            background: "var(--color-bg-surface)",
            border: `1px solid ${error ? "var(--color-danger)" : "var(--color-border)"}`,
            borderRadius: "var(--radius-md)",
            fontSize: "0.88rem",
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-sans)",
            outline: "none",
            transition: "border-color 0.15s ease",
            ...style,
          }}
          {...props}
        />

      </div>

      {error ? (
        <span style={{ fontSize: "0.75rem", color: "var(--color-danger)" }}>{error}</span>
      ) : helperText ? (
        <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{helperText}</span>
      ) : null}
    </div>
  );
}
