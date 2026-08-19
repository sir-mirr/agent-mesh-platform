import React, { useState, useEffect } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  StatusBadge,
  TelemetryCard,
  Button,
  Toast,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

interface AgentIdentity {
  id: string;
  name: string;
  group: string;
}

/**
 * **A mailbox, which is what the route returns.**
 *
 * This used to be a `LeaseItem` with a message id, a lease state, a TTL and an
 * enqueue time — none of which `GET /api/v1/admin/mailbox` carries. It answers
 * one row per *mailbox* with `pending`, `leased` and `oldest`, and the screen
 * turned each of those into one invented message: `msg_mb_1`, "Available",
 * `300s`, `new Date()`. Measured with eleven messages queued for one agent, the
 * page said **"Available 1건"** and drew a single row.
 *
 * `I-062` is the same shape a screen away. What the server did not send is not
 * drawn, and the counts are the server's sums rather than a row count.
 */
interface MailboxRow {
  identity: string;
  pending: number;
  leased: number;
  oldest: string | null;
}

import { fetchAdminMailbox } from "@/api/mailbox.ts";

export function LeaseQueuePage() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<MailboxRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load real admin mailbox metrics on mount
  useEffect(() => {
    setIsLoading(true);
    setIsError(false);
      setFailure(null);
    fetchAdminMailbox()
      .then((res) => {
        setQueue(
          (res?.mailboxes ?? []).map((m: any) => ({
            identity: String(m.identity ?? m.agentId ?? ""),
            pending: Number(m.pending ?? 0),
            leased: Number(m.leased ?? 0),
            oldest: m.oldest ?? null,
          })),
        );
      })
      .catch((err: unknown) => {
        setIsError(true);
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
        setQueue([]);
      })
      .finally(() => setIsLoading(false));
  }, []);

  /**
   * The countdown ticker is gone with the fake rows.
   *
   * It decremented a `ttlRemaining` this screen had invented, once a second,
   * on rows that stood for mailboxes rather than messages — a clock counting
   * down something the server never started. Anything the mesh actually leases
   * is timed by the hub (SPEC § 9); a console that draws its own countdown is
   * telling the operator a number no one else holds.
   */




  // The server's sums, not a count of rows. Eleven messages in one mailbox is
  // eleven, and it used to be one.
  const leasedCount = queue.reduce((n, m) => n + m.leased, 0);
  const availableCount = queue.reduce((n, m) => n + m.pending, 0);

  /**
   * **Four columns, all of them the route's.**
   *
   * The table used to carry a message id, a `from → to` route, a lease state
   * badge and a 300-second countdown bar — none of which the server sends. It
   * also carried three buttons (Lease 획득 · ACK 승인 · NACK 반환) that called no
   * route at all: each one edited local state, so the row changed and the mesh
   * did not. Measured with eleven queued messages, the screen said "Available
   * 1건" and offered to lease a message that does not exist as a row anywhere.
   *
   * They are gone rather than disabled, and the reason is written here so the
   * next person does not restore them from the shape of the file: leasing is
   * something a worker does over the agent transport (SPEC § 9), not something
   * an operator console can do on that worker's behalf.
   */
  const columns = [
    {
      key: "identity",
      header: t("lease.col.identity", "메일함"),
      render: (item: MailboxRow) => (
        <span data-testid={`mailbox-${item.identity}`} style={{ fontWeight: 700, fontSize: "0.85rem" }}>
          📥 {item.identity}
        </span>
      ),
    },
    {
      key: "pending",
      header: t("lease.col.pending", "대기"),
      render: (item: MailboxRow) => (
        <span data-testid={`pending-${item.identity}`} style={{ fontFamily: "var(--font-mono)" }}>
          {item.pending}
        </span>
      ),
    },
    {
      key: "leased",
      header: t("lease.col.leased", "임대 중"),
      render: (item: MailboxRow) => (
        <span style={{ fontFamily: "var(--font-mono)" }}>{item.leased}</span>
      ),
    },
    {
      key: "oldest",
      header: t("lease.col.oldest", "가장 오래된 것"),
      render: (item: MailboxRow) => (
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
          {item.oldest ?? t("common.unmeasured", "— 미측정")}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="42"
        title={t("lease.title", "에이전트 메일함 리스 큐 & 300초 리스 감시")}
        subtitle={t("lease.subtitle", "At-Least-Once 보증 메일함 리스 상태머신 (Available → Leased → Acked) 실시간 감시 (SPEC § 9)")}
      />

      {toastMessage && (
        <Toast
          type="info"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      {/* Guide Banner: Explaining Lease & 300s TTL Architecture */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: "16px 20px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>⏱️</div>
          <div>
            <strong style={{ fontSize: "0.88rem", color: "var(--color-text-primary)" }}>
              {t("lease.what.title", "What a lease is")}
            </strong>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginTop: 4, lineHeight: 1.4 }}>
              {t("lease.what.body", "When an asynchronous or serverless worker takes a message it is not deleted straight away — it is locked for a time so no other worker processes it twice.")}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>🛡️</div>
          <div>
            <strong style={{ fontSize: "0.88rem", color: "var(--color-text-primary)" }}>
              {t("lease.ttl.title", "300s TTL (the at-least-once safeguard)")}
            </strong>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginTop: 4, lineHeight: 1.4 }}>
              {t("lease.ttl.body", "An ACK from a worker that finished releases it for good. If the worker dies and nothing answers for 300 seconds the message returns to Available and is processed again rather than lost.")}
            </p>
          </div>
        </div>
      </div>

      {/* Telemetry row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <TelemetryCard
          label={t("lease.kpi.leased", "임대 중인 메시지")}
          currentValue={isError ? t("common.unmeasurable", "측정 불가") : String(leasedCount)}
          maxLabel={t("lease.total", "총 적체")}
          percentage={isError ? 0 : (leasedCount / Math.max(1, queue.length)) * 100}
          barColor="var(--color-leased)"
          statusText={isError ? (failure === "refused" ? t("common.refused", "권한 없음") : t("lease.down", "서버 연결 불가")) : t("lease.working", "워커가 처리 중 (300s TTL 카운트다운)")}
        />
        <TelemetryCard
          label={t("lease.kpi.available", "대기 중인 메시지")}
          currentValue={isError ? t("common.unmeasurable", "측정 불가") : String(availableCount)}
          valueTestId="lease-available"
          maxLabel={t("lease.total", "총 적체")}
          percentage={isError ? 0 : (availableCount / Math.max(1, queue.length)) * 100}
          barColor="var(--color-warning)"
          statusText={isError ? t("lease.down", "서버 연결 불가") : t("lease.ready", "워커가 가져갈 수 있는 상태")}
        />
      </div>

      <DataTable
        columns={columns}
        data={queue}
        keyExtractor={(item: MailboxRow) => item.identity}
        isLoading={isLoading}
        isError={isError}
        errorMessage={
          failure === "refused"
            ? refusedText(t, missing)
            : t("lease.error", "메일함 리스 큐를 불러오지 못했습니다 (서버가 답하지 않았습니다).")
        }
        emptyMessage={t("lease.empty", "대기 중인 메일함이 없습니다.")}
      />
    </div>
  );
}
