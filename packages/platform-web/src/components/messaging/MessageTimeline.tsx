import React from "react";
import { StatusBadge } from "@/components/common/StatusBadge.tsx";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  title: string;
  description?: string;
  status: "success" | "warning" | "danger" | "neutral" | "leased";
  badgeLabel?: string;
}

export interface MessageTimelineProps {
  events: TimelineEvent[];
}

export function MessageTimeline({ events }: MessageTimelineProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {events.map((event, index) => {
        const isLast = index === events.length - 1;

        return (
          <div key={event.id} style={{ display: "flex", gap: 14 }}>
            {/* Timeline Line & Dot */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 20,
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background:
                    event.status === "success"
                      ? "var(--color-success)"
                      : event.status === "danger"
                      ? "var(--color-danger)"
                      : event.status === "leased"
                      ? "var(--color-primary)"
                      : "var(--color-text-muted)",
                  marginTop: 5,
                }}
              />
              {!isLast && (
                <div
                  style={{
                    width: 2,
                    flex: 1,
                    background: "var(--color-border)",
                    margin: "4px 0",
                    minHeight: 30,
                  }}
                />
              )}
            </div>

            {/* Content */}
            <div style={{ flex: 1, paddingBottom: isLast ? 0 : 20 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: "0.85rem",
                    fontWeight: 700,
                    color: "var(--color-text-primary)",
                  }}
                >
                  {event.title}
                </span>
                {event.badgeLabel && (
                  <StatusBadge
                    label={event.badgeLabel}
                    status={event.status}
                    size="sm"
                  />
                )}
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--color-text-muted)",
                    fontFamily: "var(--font-mono)",
                    marginLeft: "auto",
                  }}
                >
                  {event.timestamp}
                </span>
              </div>

              {event.description && (
                <p
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--color-text-secondary)",
                    marginTop: 4,
                    lineHeight: 1.4,
                  }}
                >
                  {event.description}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
