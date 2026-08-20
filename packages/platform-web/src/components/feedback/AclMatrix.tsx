import React from "react";
import { useI18n } from "@/contexts/I18nContext.tsx";

export interface AclMatrixProps {
  groups: Array<{ id: string; name: string }>;
  // Record<sourceGroupId, Record<targetGroupId, boolean>> (true: Allow, false: Deny)
  rules: Record<string, Record<string, boolean>>;
  onToggleRule?: (sourceId: string, targetId: string, currentAllowed: boolean) => void;
  readOnly?: boolean;
}

export function AclMatrix({
  groups,
  rules,
  onToggleRule,
  readOnly = false,
}: AclMatrixProps) {
  const { t } = useI18n();
  return (
    <div
      style={{
        overflowX: "auto",
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-xs)",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.85rem",
        }}
      >
        <thead>
          <tr style={{ background: "var(--color-bg-surface-sub)" }}>
            <th
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--color-border)",
                textAlign: "left",
                fontWeight: 700,
                fontSize: "0.78rem",
                color: "var(--color-text-muted)",
              }}
            >
              {t("acl.axis", "출발 \\ 도착 (Source → Target)")}
            </th>
            {groups.map((target) => (
              <th
                key={target.id}
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--color-border)",
                  textAlign: "center",
                  fontWeight: 700,
                  fontSize: "0.78rem",
                  color: "var(--color-text-secondary)",
                }}
              >
                {target.name}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {groups.map((source, sIdx) => (
            <tr
              key={source.id}
              style={{
                borderBottom:
                  sIdx === groups.length - 1
                    ? "none"
                    : "1px solid var(--color-border)",
              }}
            >
              <td
                style={{
                  padding: "12px 16px",
                  fontWeight: 700,
                  color: "var(--color-text-primary)",
                  background: "var(--color-bg-surface-sub)",
                }}
              >
                {source.name}
              </td>

              {groups.map((target) => {
                const isAllowed = rules[source.id]?.[target.id] ?? false;

                return (
                  <td
                    key={target.id}
                      data-testid={`acl-${source.id}-${target.id}`}
                      data-allowed={isAllowed ? "yes" : "no"}
                    style={{
                      padding: "8px",
                      textAlign: "center",
                      verticalAlign: "middle",
                    }}
                  >
                      {(
                        /* **The diagonal is an ordinary cell.** It used to render
                           the literal `자체(허용)` — a claim, not a reading, and the
                           one the operator actually sees. `maySend` requires a rule
                           for same-group sends like any other pair, and a group
                           someone creates has none until they say so; only `default`
                           is seeded, which is why this looked right. Toggleable for
                           the same reason: granting a group egress to itself is a
                           rule someone can make. */
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() =>
                          onToggleRule?.(source.id, target.id, isAllowed)
                        }
                        style={{
                          padding: "4px 10px",
                          borderRadius: "var(--radius-full)",
                          border: "none",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          cursor: readOnly ? "default" : "pointer",
                          background: isAllowed
                            ? "var(--status-success-bg)"
                            : "var(--status-danger-bg)",
                          color: isAllowed
                            ? "var(--status-success)"
                            : "var(--status-danger)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {isAllowed ? t("acl.allow", "ALLOW (허용)") : t("acl.deny", "DENY (차단)")}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
