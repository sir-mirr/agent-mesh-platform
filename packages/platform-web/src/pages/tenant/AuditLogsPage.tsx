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
import { useAuth } from "@/contexts/AuthContext.tsx";

import {
  fetchAuditEvents,
  type AuditEventFilters,
  type AuditEventItem,
  type AuditRecorderKind,
} from "@/api/audit.ts";

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
  const measuredTime = item.eventType === "mesh.identity.audit_read" ? item.storedAt : item.timestamp;
  const when = measuredTime === "—"
    ? t("audit.event.timeMissing", "time not recorded")
    : measuredTime;

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

function scopeValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * One content-read record answers four operator questions without folding the
 * service into the person. `change.query` is drawn as labelled scope rather
 * than raw JSON: this is what was requested, while `change.read` is what the
 * request reached.
 */
function AccessEventSummary({ item, t }: { item: AuditEventItem; t: Translate }) {
  const query = Object.entries(item.readQuery ?? {});
  const isList = item.readTarget === "list";
  const scope: Array<[string, unknown]> = isList
    ? query.length > 0
      ? query
      : [[
        t("audit.access.scopeAllKey", "scope"),
        t("audit.access.scopeAll", "all audit events"),
      ]]
    : [[t("audit.access.eventId", "event id"), item.readTarget ?? "—"]];

  return (
    <div data-testid="audit-summary" style={{ display: "grid", gap: 5, fontSize: "0.82rem", lineHeight: 1.45 }}>
      <strong>{eventSummary(item, t)}</strong>
      <span data-testid="audit-access-reader">
        {t("audit.access.reader", "Reader")}: {item.identity ?? "—"}
      </span>
      <span data-testid="audit-access-recorder">
        {t("audit.access.recorder", "Reading service")}: {item.recordedByIdentity ?? "—"}
        {item.recordedByKind ? ` (${item.recordedByKind})` : ""}
      </span>
      <span data-testid="audit-access-target">
        {t("audit.access.target", "Reached")}: {isList
          ? t("audit.access.list", "audit list")
          : `${t("audit.access.one", "single audit event")}: ${item.readTarget ?? "—"}`}
      </span>
      <span
        data-testid="audit-access-scope"
        style={{ display: "grid", gap: 2 }}
      >
        <span>{t("audit.access.scope", "Requested scope")}:</span>
        {scope.map(([key, value]) => (
          <span key={key} style={{ paddingLeft: 12, fontFamily: "var(--font-mono)", fontSize: "0.76rem" }}>
            {key} = {scopeValue(value)}
          </span>
        ))}
      </span>
      <span data-testid="audit-access-stored-at">
        {t("audit.access.storedAt", "Stored at")}: {item.storedAt}
      </span>
    </div>
  );
}

function prettyJson(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  return rendered === undefined ? "null" : rendered;
}

export function AuditLogsPage() {
  const { t, language } = useI18n();
  const { user } = useAuth();
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
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [recorderKindFilter, setRecorderKindFilter] = useState<"" | AuditRecorderKind>("");
  const didInitialRead = React.useRef(false);

  const selectedFilters = (): AuditEventFilters => {
    const filters: AuditEventFilters = {};
    if (eventTypeFilter) filters.eventType = eventTypeFilter;
    if (recorderKindFilter) filters.recordedByKind = recorderKindFilter;
    return filters;
  };

  const loadAuditEvents = (filters: AuditEventFilters = selectedFilters()) => {
    setIsLoading(true);
    setIsError(false);
    setFailure(null);
    setExpanded(new Set());
    fetchAuditEvents(filters)
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
    // Development StrictMode deliberately replays mount effects. This GET is
    // itself audit-recorded, so replaying it creates two access records a few
    // milliseconds apart and lets the screen manufacture the noise it then
    // displays. A ref survives that replay and still resets on a real remount.
    if (didInitialRead.current) return;
    didInitialRead.current = true;
    loadAuditEvents({});
  }, []);

  const toggleOriginal = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const ownAccesses = events.filter((item) =>
    item.eventType === "mesh.identity.audit_read" && item.identity === user?.name);
  const visibleEvents = events.filter((item) =>
    item.eventType !== "mesh.identity.audit_read" || item.identity !== user?.name);

  const columns = [
    {
      key: "event",
      header: t("audit.col.event", "Event"),
      width: "48%",
      render: (item: AuditEventItem) => (
        item.eventType === "mesh.identity.audit_read"
          ? <AccessEventSummary item={item} t={t} />
          : (
            <span data-testid="audit-summary" style={{ fontSize: "0.86rem", lineHeight: 1.5 }}>
              {eventSummary(item, t)}
            </span>
          )
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
          <Button variant="secondary" size="sm" onClick={() => loadAuditEvents()}>
            {t("audit.refreshBtn", "↻ Refresh Audit Logs")}
          </Button>
        }
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          loadAuditEvents();
        }}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "end",
          gap: 12,
          padding: "12px 16px",
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 230, fontSize: "0.78rem", fontWeight: 700 }}>
          {t("audit.filter.event", "이벤트 종류")}
          <select
            data-testid="audit-event-type-filter"
            value={eventTypeFilter}
            onChange={(event) => setEventTypeFilter(event.target.value)}
            style={{ padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "#FFFFFF" }}
          >
            <option value="">{t("filters.eventsAny", "모든 이벤트")}</option>
            <option value="mesh.identity.audit_read">
              {t("audit.filter.auditReads", "감사 목록 열람 기록")}
            </option>
            <option value="channel.message.received">
              {t("audit.filter.messageReceived", "메시지 수신 기록")}
            </option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 190, fontSize: "0.78rem", fontWeight: 700 }}>
          {t("audit.filter.recorder", "기록 주체")}
          <select
            data-testid="audit-recorder-kind-filter"
            value={recorderKindFilter}
            onChange={(event) => setRecorderKindFilter(event.target.value as "" | AuditRecorderKind)}
            style={{ padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "#FFFFFF" }}
          >
            <option value="">{t("filters.recordersAny", "모든 기록 주체")}</option>
            <option value="hub">hub</option>
            <option value="adapter">adapter</option>
            <option value="http">http</option>
          </select>
        </label>
        <Button type="submit" variant="secondary" size="sm" data-testid="audit-filter-apply">
          {t("audit.filter.apply", "필터 적용")}
        </Button>
      </form>

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

      {!isError && !isLoading && ownAccesses.length > 0 && (
        <details
          data-testid="audit-own-accesses"
          style={{
            padding: "12px 16px",
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>
            {t("audit.access.mine", "My accesses")} {ownAccesses.length}
            {language === "ko"
              ? t("audit.access.count", "건")
              : ""}
          </summary>
          <div style={{ display: "grid", gap: 12, paddingTop: 12 }}>
            {ownAccesses.map((item) => (
              <div
                key={item.id}
                data-testid="audit-own-access"
                style={{ padding: 12, background: "var(--color-bg-surface-sub)", borderRadius: "var(--radius-sm)" }}
              >
                <AccessEventSummary item={item} t={t} />
              </div>
            ))}
          </div>
        </details>
      )}

      <DataTable
        columns={columns}
        data={visibleEvents}
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
