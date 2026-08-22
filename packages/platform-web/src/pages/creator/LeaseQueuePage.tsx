import React, { useState, useEffect } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  KpiCard,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

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
      header: t("lease.col.leased", "처리 중"),
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
        title={t("lease.title", "에이전트 메일함 처리 현황")}
        subtitle={t("lease.subtitle", "메일함별 대기 수, 처리 중 수, 가장 오래 기다린 메시지를 보여줍니다")}
      />

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
              {t("lease.what.title", "메시지가 처리 중일 때")}
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
              {t("lease.ttl.title", "처리가 끝나지 않으면 다시 배달됩니다")}
            </strong>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", marginTop: 4, lineHeight: 1.4 }}>
              {t("lease.ttl.body", "작업자가 처리를 완료하면 메시지는 대기 목록에서 사라집니다. 응답 없이 5분이 지나면 메시지가 다시 대기 상태로 돌아와 다른 작업자가 처리할 수 있습니다.")}
            </p>
          </div>
        </div>
      </div>

      {/* Telemetry row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <KpiCard
          label={t("lease.kpi.leased", "처리 중인 메시지")}
          value={isLoading ? "..." : isError ? t("common.unmeasured", "— 미측정") : String(leasedCount)}
          subValue={isError ? (failure === "refused" ? t("common.refused", "권한 없음") : t("lease.down", "서버 연결 불가")) : t("lease.working", "작업자가 처리 중이며, 끝나지 않으면 5분 뒤 다시 배달됩니다")}
          color="var(--color-leased)"
          icon="⚙️"
        />
        <KpiCard
          label={t("lease.kpi.available", "대기 중인 메시지")}
          value={isLoading ? "..." : isError ? t("common.unmeasured", "— 미측정") : String(availableCount)}
          valueTestId="lease-available"
          subValue={isError ? t("lease.down", "서버 연결 불가") : t("lease.ready", "작업자가 가져갈 수 있는 상태")}
          color="var(--color-warning)"
          icon="📥"
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
            : t("lease.error", "메일함 처리 현황을 불러오지 못했습니다 (서버가 답하지 않았습니다).")
        }
        emptyMessage={t("lease.empty", "대기 중인 메일함이 없습니다.")}
      />
    </div>
  );
}
