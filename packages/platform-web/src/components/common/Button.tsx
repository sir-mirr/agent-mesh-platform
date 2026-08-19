import React from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "outline";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  isLoading = false,
  disabled,
  style,
  className = "",
  ...props
}: ButtonProps) {
  const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
    sm: { padding: "5px 10px", fontSize: "0.78rem", borderRadius: "var(--radius-sm)" },
    md: { padding: "8px 16px", fontSize: "0.85rem", borderRadius: "var(--radius-md)" },
    lg: { padding: "12px 22px", fontSize: "0.95rem", borderRadius: "var(--radius-lg)" },
  };

  const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
    primary: {
      background: "var(--color-primary)",
      color: "#FFFFFF",
      border: "1px solid transparent",
    },
    secondary: {
      background: "var(--color-bg-surface)",
      color: "var(--color-text-primary)",
      border: "1px solid var(--color-border-strong)",
    },
    danger: {
      background: "var(--color-danger)",
      color: "#FFFFFF",
      border: "1px solid transparent",
    },
    ghost: {
      background: "transparent",
      color: "var(--color-text-secondary)",
      border: "1px solid transparent",
    },
    outline: {
      background: "transparent",
      color: "var(--color-primary)",
      border: "1px solid var(--color-primary)",
    },
  };

  return (
    <button
      disabled={disabled || isLoading}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        cursor: disabled || isLoading ? "not-allowed" : "pointer",
        opacity: disabled || isLoading ? 0.6 : 1,
        transition: "all 0.15s ease",
        outline: "none",
        ...sizeStyles[size],
        ...variantStyles[variant],
        ...style,
      }}
      className={`btn btn-${variant} ${className}`}
      {...props}
    >
      {isLoading ? (
        <span
          style={{
            width: 14,
            height: 14,
            border: "2px solid currentColor",
            borderTopColor: "transparent",
            borderRadius: "50%",
            display: "inline-block",
            animation: "spin 0.6s linear infinite",
          }}
        />
        ) : null}
      {children}
    </button>
  );
}
