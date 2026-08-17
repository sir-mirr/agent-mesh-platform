import React from "react";

export interface ColumnDef<T> {
  key: string;
  header: string;
  render?: (item: T, index: number) => React.ReactNode;
  width?: string | number;
  align?: "left" | "center" | "right";
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  keyExtractor: (item: T, index: number) => string | number;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  emptyMessage?: string;
}

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  isLoading = false,
  isError = false,
  errorMessage = "데이터를 불러오는 중 오류가 발생했습니다.",
  emptyMessage = "표시할 데이터가 없습니다.",
}: DataTableProps<T>) {
  return (
    <div
      style={{
        width: "100%",
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
          fontSize: "0.86rem",
          textAlign: "left",
        }}
      >
        <thead>
          <tr style={{ background: "var(--color-bg-surface-sub)" }}>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  padding: "10px 16px",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  color: "var(--color-text-secondary)",
                  borderBottom: "1px solid var(--color-border)",
                  width: col.width,
                  textAlign: col.align || "left",
                  letterSpacing: "0.02em",
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>

        {data.length > 0 && (
          <tbody>
            {data.map((item, index) => (
              <tr
                key={keyExtractor(item, index)}
                style={{
                  borderBottom:
                    index === data.length - 1
                      ? "none"
                      : "1px solid var(--color-border)",
                  transition: "background 0.1s ease",
                }}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    style={{
                      padding: "12px 16px",
                      color: "var(--color-text-primary)",
                      textAlign: col.align || "left",
                      verticalAlign: "middle",
                    }}
                  >
                    {col.render
                      ? col.render(item, index)
                      : String((item as Record<string, unknown>)[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>

      {data.length === 0 && (
        <div
          style={{
            padding: "36px 16px",
            textAlign: "center",
            color: "var(--color-text-muted)",
            fontSize: "0.86rem",
            background: "var(--color-bg-surface)",
          }}
        >
          {isLoading ? "데이터를 불러오는 중입니다..." : isError ? (
            <span style={{ color: "var(--color-danger)" }}>⚠️ {errorMessage}</span>
          ) : emptyMessage}
        </div>
      )}
    </div>
  );
}
