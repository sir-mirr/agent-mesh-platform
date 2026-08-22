import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  StatusBadge,
  Button,
} from "@/components/index.ts";
import { useRbac } from "@/contexts/RbacContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";


import { fetchAuditEvents, type AuditEventItem } from "@/api/audit.ts";

export function AuditLogsPage() {
  const { t } = useI18n();
  const { hasCapability } = useRbac();
  const [events, setEvents] = useState<AuditEventItem[]>([]);
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

  // Load real audit events on mount
  React.useEffect(() => {
    loadAuditEvents();
  }, []);

  const columns = [
    {
      key: "timestamp",
      header: t("audit.col.time", "타임스탬프"),
      render: (item: AuditEventItem) => (
        <span style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
          {item.timestamp}
        </span>
      ),
    },
    {
      key: "route",
      header: t("audit.col.route", "송수신 경로"),
      render: (item: AuditEventItem) => (
        <span style={{ fontSize: "0.82rem" }}>
          <code>{item.sender}</code> → <code>{item.recipient}</code>
          {item.sentBy && item.sentBy !== item.sender && (
            <span style={{ marginLeft: 6, fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
              {" "}(carried by <code>{item.sentBy}</code>)
            </span>
          )}
        </span>
      ),
    },
    {
      key: "contentLength",
      header: t("audit.col.length", "길이 (Bytes)"),
      render: (item: AuditEventItem) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
          {item.contentLength} B
        </span>
      ),
    },
    {
      key: "content",
      header: t("audit.col.content", "메시지 본문"),
      render: (item: AuditEventItem) => {
        if (!canReadContent || item.redacted) {
          return (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.75rem",
                color: "var(--color-warning)",
                background: "var(--status-warning-bg)",
                padding: "2px 6px",
                borderRadius: "var(--radius-sm)",
              }}
              data-testid="audit-withheld"
            >
              {t("audit.held", "본문을 볼 권한이 없어 숨겼습니다")}
            </span>
          );
        }
        return (
          <code
            data-testid="audit-body"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              background: "var(--color-bg-surface-sub)",
              padding: "2px 6px",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {typeof item.rawContent === "string" ? item.rawContent : JSON.stringify(item.rawContent)}
          </code>
        );
      },
    },
    {
      key: "signatureInfo",
      header: t("audit.col.signature", "서명 · 무결성"),
      render: (item: AuditEventItem) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {/* Arrival, which is measured. Nothing about verification, which is not. */}
          <span data-testid="audit-signature" style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
            {item.signature.signed
              ? `${t("audit.signed", "서명 있음")} · ${item.signature.algorithm ?? t("auditAlgUnknown", "알고리즘 미상")}${item.signature.keyId ? ` · ${item.signature.keyId}` : ""}`
              : t("audit.unsigned", "미서명")}
          </span>
          {/* `digest_matches` is computed when the response is built, so this one
              is a reading. A false is tampering and takes the colour that says so. */}
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
              ? t("audit.intact", "무결 — 본문이 기록된 해시와 일치")
              : item.digestMatches === false
              ? t("audit.tampered", "변조 — 본문이 기록된 해시와 다름")
              : t("audit.unmeasured", "무결성 미측정")}
          </span>
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        title={t("audit.title", "참가자 본문 감사 스트림")}
        subtitle={t("audit.subtitle", "본문 열람 권한이 있으면 메시지 내용을 보여주고, 없으면 내용만 숨깁니다")}
        actions={
          <Button variant="secondary" size="sm" onClick={loadAuditEvents}>
            {t("audit.refreshBtn", "↻ 감사 로그 갱신")}
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
          {t("audit.status.label", "현재 권한 상태")}:{" "}
          <strong>
            {canReadContent
              ? t("audit.status.has", "✓ 메시지 본문을 볼 수 있습니다. 열람 기록은 감사 로그에 남습니다")
              : t("audit.status.none", "⚠️ 메시지 본문은 숨기고 시간·경로·길이만 표시합니다")}
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
          // "연결 실패 **또는** 권한 오류" — 둘 다 적어두면 사람은 어느 쪽인지 모른다.
          // 서버는 이미 갈라서 답했고, `ApiError.refused` 가 그것을 들고 있다.
          failure === "refused"
            ? refusedText(t, missing)
            : t("audit.error", "감사 로그를 불러오지 못했습니다 (서버가 답하지 않았습니다).")
        }
        emptyMessage={t("audit.empty", "현재 기록된 감사 로그 데이터가 없습니다.")}
      />
    </div>
  );
}
