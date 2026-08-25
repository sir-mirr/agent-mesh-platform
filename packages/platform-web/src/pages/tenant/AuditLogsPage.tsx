import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  Button,
} from "@/components/index.ts";
import { useRbac } from "@/contexts/RbacContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";

import { fetchAuditEvents, type AuditEventItem } from "@/api/audit.ts";

type Translate = (key: string, fallback?: string) => string;

function messageAction(eventType: string | null, t: Translate): string {
  switch (eventType) {
    case "mesh.message.sent":
    case "channel.message.sent":
      return t("audit.event.messageSent", "message sent");
    case "mesh.message.delivered":
      return t("audit.event.messageDelivered", "message delivered");
    case "mesh.message.pending":
      return t("audit.event.messagePending", "waiting for delivery");
    case "mesh.message.recalled":
      return t("audit.event.messageRecalled", "message recalled");
    case "channel.message.received":
      return t("audit.event.messageReceived", "message received");
    default:
      return t("audit.event.messageRecorded", "message event recorded");
  }
}

/**
 * The sentence an operator reads before deciding whether the original record
 * is worth opening. Only message events have a route; all other event kinds
 * keep their own subjects instead of fabricating a recipient.
 */
function eventSummary(item: AuditEventItem, t: Translate): string {
  const when = item.timestamp === "—"
    ? t("audit.event.timeMissing", "time not recorded")
    : item.timestamp;

  if (item.eventType === "mesh.identity.audit_read") {
    const action = item.readTarget === "list"
      ? t("audit.event.auditReadList", "read the audit list")
      : item.readTarget
        ? `${t("audit.event.auditReadOne", "read audit event")} ${item.readTarget}`
        : t("audit.event.auditRead", "read the audit log");
    const subject = item.actor ?? item.identity;
    return `${subject ? `${subject} ` : ""}${action} · ${when}`;
  }

  if (item.eventType === "mesh.identity.type_changed") {
    const transition = item.changeFrom !== null || item.changeTo !== null
      ? `${item.changeFrom ?? "—"} → ${item.changeTo ?? "—"}`
      : null;
    return [
      item.identity,
      t("audit.event.identityTypeChanged", "identity type changed"),
      transition,
      when,
    ].filter(Boolean).join(" · ");
  }

  if (item.isMessage) {
    const route = item.sender && item.recipient
      ? `${item.sender} → ${item.recipient}`
      : item.sender ?? item.recipient;
    const carrier = item.sentBy && item.sentBy !== item.sender
      ? `${t("audit.event.carrier", "carried by")} ${item.sentBy}`
      : null;
    const length = item.contentLength === null ? null : `${item.contentLength} B`;
    return [route, messageAction(item.eventType, t), carrier, length, when]
      .filter(Boolean)
      .join(" · ");
  }

  return [
    item.actor ?? item.identity,
    t("audit.event.recorded", "audit event recorded"),
    when,
  ].filter(Boolean).join(" · ");
}

function prettyJson(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  return rendered === undefined ? "null" : rendered;
}

export function AuditLogsPage() {
  const { t } = useI18n();
  const { hasCapability } = useRbac();
  const [events, setEvents] = useState<AuditEventItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  /** `refused` 와 `unreachable` 은 사람에게 다른 문장이다 — 하나는 권한, 하나는 서버다. */
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const canReadContent = hasCapability("audit.read.content");

  const loadAuditEvents = () => {
    setIsLoading(true);
    setIsError(false);
    setFailure(null);
    setExpanded(new Set());
    fetchAuditEvents()
      .then((list) => {
        setEvents(list || []);
      })
      .catch((err: unknown) => {
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
        setIsError(true);
        setEvents([]);
      })
      .finally(() => setIsLoading(false));
  };

  React.useEffect(() => {
    loadAuditEvents();
  }, []);

  const toggleOriginal = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const columns = [
    {
      key: "event",
      header: t("audit.col.event", "Event"),
      width: "48%",
      render: (item: AuditEventItem) => (
        <span data-testid="audit-summary" style={{ fontSize: "0.86rem", lineHeight: 1.5 }}>
          {eventSummary(item, t)}
        </span>
      ),
    },
    {
      key: "record",
      header: t("audit.col.record", "Record state"),
      width: "27%",
      render: (item: AuditEventItem) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span data-testid="audit-signature" style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
            {item.signature.signed
              ? `${t("audit.signed", "signed")} · ${item.signature.algorithm ?? t("auditAlgUnknown", "algorithm unknown")}${item.signature.keyId ? ` · ${item.signature.keyId}` : ""}`
              : t("audit.unsigned", "unsigned")}
          </span>
          <span
            data-testid="audit-integrity"
            data-digest={item.digestMatches === null ? "unmeasured" : item.digestMatches ? "matches" : "broken"}
            style={{
              fontSize: "0.75rem",
              fontWeight: item.digestMatches === false ? 700 : 400,
              color:
                item.digestMatches === false
                  ? "var(--color-danger)"
                  : item.digestMatches === true
                    ? "var(--color-success)"
                    : "var(--color-text-muted)",
            }}
          >
            {item.digestMatches === true
              ? t("audit.intact", "intact — the body matches the recorded hash")
              : item.digestMatches === false
                ? t("audit.tampered", "tampered — the body differs from the recorded hash")
                : t("audit.unmeasured", "integrity not measured")}
          </span>
        </div>
      ),
    },
    {
      key: "original",
      header: t("audit.col.original", "Original record"),
      width: "25%",
      render: (item: AuditEventItem) => {
        const isExpanded = expanded.has(item.id);
        // **`!item.redacted` is defence, and it is deliberately unplanted.**
        // `redacted` is derived from what the server actually sent, and since
        // T-041 the server withholds a body exactly when the reader lacks
        // `audit.read.content` — so a session that can read content sees
        // nothing redacted, and the conjunct changes no outcome any fixture
        // here can produce. Measured: removing it left all 137 scenarios
        // green. It stays for the case the derivation exists for — a payload
        // recorded elsewhere that already carries the withheld marker — and
        // the manifest holds no entry for it, because an entry nothing can
        // catch is an entry that checks nothing.
        const canRevealOriginal = !item.containsContent || (canReadContent && !item.redacted);
        const panelId = `audit-original-${item.id}`;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => toggleOriginal(item.id)}
              aria-expanded={isExpanded}
              aria-controls={panelId}
            >
              {isExpanded
                ? t("audit.original.hide", "Hide original JSON")
                : t("audit.original.show", "View original JSON")}
            </Button>
            {isExpanded && (
              <div id={panelId} style={{ width: "100%" }}>
                {canRevealOriginal ? (
                  <pre
                    data-testid="audit-raw-json"
                    style={{
                      margin: 0,
                      maxWidth: 480,
                      maxHeight: 280,
                      overflow: "auto",
                      whiteSpace: "pre",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                      lineHeight: 1.45,
                      color: "var(--color-text-secondary)",
                      background: "var(--color-bg-surface-sub)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "var(--radius-sm)",
                      padding: 10,
                    }}
                  >
                    {prettyJson(item.rawPayload)}
                  </pre>
                ) : (
                  <span
                    data-testid="audit-withheld"
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--color-warning)",
                      background: "var(--status-warning-bg)",
                      padding: "2px 6px",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    {t("audit.held", "Content hidden because this account cannot read message bodies")}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        title={t("audit.title", "Audit events")}
        subtitle={t("audit.subtitle", "Each event is summarized in plain language; open the original JSON only when you need it")}
        actions={
          <Button variant="secondary" size="sm" onClick={loadAuditEvents}>
            {t("audit.refreshBtn", "↻ Refresh Audit Logs")}
          </Button>
        }
      />

      <div
        style={{
          padding: "12px 16px",
          background: canReadContent ? "var(--status-success-bg)" : "var(--status-warning-bg)",
          border: `1px solid ${canReadContent ? "var(--status-success-br)" : "var(--status-warning-br)"}`,
          borderRadius: "var(--radius-md)",
          fontSize: "0.82rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>
          {t("audit.status.label", "What this account can read")}: {" "}
          <strong>
            {canReadContent
              ? t("audit.status.has", "✓ Original records can include message bodies. Each content read is recorded")
              : t("audit.status.none", "⚠️ Event summaries remain visible; message bodies stay hidden")}
          </strong>
        </span>
      </div>

      <DataTable
        columns={columns}
        data={events}
        keyExtractor={(item) => item.id}
        isLoading={isLoading}
        isError={isError}
        errorMessage={
          failure === "refused"
            ? refusedText(t, missing)
            : t("audit.error", "Could not read the audit log (the server did not answer).")
        }
        emptyMessage={t("audit.empty", "No audit entries are recorded.")}
      />
    </div>
  );
}
