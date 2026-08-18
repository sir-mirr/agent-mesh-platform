import React from "react";
import { Link, useLocation } from "react-router-dom";

export interface NavPillItem {
  label: string;
  href: string;
  icon?: string;
}

export interface SubNavPillsProps {
  items: NavPillItem[];
}

export function SubNavPills({ items }: SubNavPillsProps) {
  const location = useLocation();

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginBottom: 20,
        overflowX: "auto",
        paddingBottom: 4,
      }}
    >
      {items.map((item) => {
        const isActive = location.pathname === item.href;

        return (
          <Link
            key={item.href}
            to={item.href}
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius-full)",
              background: isActive ? "var(--color-primary-light)" : "var(--color-bg-surface)",
              border: `1px solid ${isActive ? "var(--color-primary)" : "var(--color-border)"}`,
              color: isActive ? "var(--color-primary)" : "var(--color-text-secondary)",
              fontSize: "0.8rem",
              fontWeight: 600,
              textDecoration: "none",
              transition: "all 0.15s ease",
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {item.icon && <span>{item.icon}</span>}
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
