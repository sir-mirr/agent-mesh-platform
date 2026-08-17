import React from "react";

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
              출발 \ 도착 (Source → Target)
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
                const isSelf = source.id === target.id;
                const isAllowed = rules[source.id]?.[target.id] ?? false;

                return (
                  <td
                    key={target.id}
                    style={{
                      padding: "8px",
                      textAlign: "center",
                      verticalAlign: "middle",
                    }}
                  >
                    {isSelf ? (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        자체(허용)
                      </span>
                    ) : (
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
                        {isAllowed ? "ALLOW (허용)" : "DENY (차단)"}
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
