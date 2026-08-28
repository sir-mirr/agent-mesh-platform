import React from "react";
import { CAPABILITY, HTTP_ADMIN_ERROR } from "@agent-mesh/contracts";

import {
  ApiError,
  failureKind,
  type FailureKind,
  refusedCapability,
  refusedText,
} from "@/api/client.ts";
import {
  decideOverdueReminder,
  fetchOverdueReminders,
  type HeldOverdueReminder,
  type OverdueDecisionRecord,
  type OverdueReminderState,
  type ReminderDecision,
} from "@/api/reminders.ts";
import { Breadcrumbs, Button, DataTable, PageHeader } from "@/components/index.ts";
import { DICTIONARY, useI18n, type Language } from "@/contexts/I18nContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";

const slotKey = (row: HeldOverdueReminder) => `${row.reminder_id}\u0000${row.scheduled_at}`;
const hasSubstantiveApproval = (value: string) => /^APPROVED:\s*\S/.test(value);

export function formatOverdue(milliseconds: number | null, language: Language): string {
  const words = DICTIONARY[language];
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return words["overdue.duration.unmeasured"]!;
  }

  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    days ? `${days}${words["agents.unit.day"]}` : "",
    hours ? `${hours}${words["agents.unit.hour"]}` : "",
    minutes || (!days && !hours) ? `${minutes}${words["agents.unit.minute"]}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

export function ReminderOverduePage() {
  const { t, language } = useI18n();
  const { hasCapability } = useRbac();
  const [state, setState] = React.useState<OverdueReminderState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failure, setFailure] = React.useState<FailureKind | null>(null);
  const [missing, setMissing] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busySlot, setBusySlot] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [decisionRefused, setDecisionRefused] = React.useState(false);
  const submitting = React.useRef<string | null>(null);
  const didInitialRead = React.useRef(false);

  const load = React.useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setFailure(null);
    setMissing(null);
    try {
      setState(await fetchOverdueReminders());
    } catch (error) {
      setFailure(failureKind(error));
      setMissing(refusedCapability(error));
      setState(null);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (didInitialRead.current) return;
    didInitialRead.current = true;
    void load();
  }, [load]);

  const canDecide = hasCapability(CAPABILITY.REMINDER_DECIDE) && !decisionRefused;

  const submit = async (row: HeldOverdueReminder, decision: ReminderDecision) => {
    const key = slotKey(row);
    if (submitting.current !== null) return;
    const approvalRef = drafts[key] ?? "";
    if (!hasSubstantiveApproval(approvalRef)) {
      setActionError(
        t(
          "overdue.approval.required",
          "APPROVED: 뒤에 판단 근거를 입력하십시오.",
        ),
      );
      return;
    }

    submitting.current = key;
    setBusySlot(key);
    setActionError(null);
    try {
      await decideOverdueReminder(row.reminder_id, {
        // This is a key, not display text. It must be the byte-for-byte value
        // from the row the operator chose; deriving a new date targets a slot
        // they did not inspect.
        scheduled_at: row.scheduled_at,
        decision,
        approval_ref: approvalRef,
      });
      setDrafts((current) => ({ ...current, [key]: "" }));
      await load(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === HTTP_ADMIN_ERROR.EMPTY_APPROVAL_REF) {
        setActionError(
          t(
            "overdue.approval.serverRefused",
            "서버가 실질적인 판단 근거가 없다고 거절했습니다.",
          ),
        );
      } else if (error instanceof ApiError && error.code === HTTP_ADMIN_ERROR.NO_SUCH_HOLD) {
        setActionError(
          t(
            "overdue.slot.stale",
            "이 슬롯은 더 이상 억류 중이 아닙니다. 목록을 다시 불러왔습니다.",
          ),
        );
        await load(false);
      } else if (error instanceof ApiError && error.status === 403) {
        // The capability list can age between sign-in and this click. The
        // server's refusal is authoritative, so remove the actions now rather
        // than leaving buttons that can only repeat the refusal.
        setDecisionRefused(true);
        setActionError(
          t(
            "overdue.decision.refused",
            "서버가 이 계정의 결정 권한을 거절했습니다.",
          ),
        );
      } else if (error instanceof ApiError && error.status === null) {
        setActionError(
          t(
            "overdue.decision.unreachable",
            "서버가 답하지 않아 결정을 기록하지 못했습니다.",
          ),
        );
      } else {
        setActionError(
          t(
            "overdue.decision.failed",
            "결정을 기록하지 못했습니다.",
          ),
        );
      }
    } finally {
      submitting.current = null;
      setBusySlot(null);
    }
  };

  const heldColumns = [
    {
      key: "reminder",
      header: t("overdue.col.reminder", "리마인더"),
      render: (row: HeldOverdueReminder) => (
        <div style={{ display: "grid", gap: 3 }}>
          <strong data-testid="overdue-reminder-id">{row.reminder_id}</strong>
          <span style={{ color: "var(--color-text-muted)", fontSize: "0.76rem" }}>
            {t("overdue.agent", "수신 에이전트")}: {row.agent_id || "—"}
          </span>
          <span style={{ color: "var(--color-text-muted)", fontSize: "0.76rem" }}>
            {t("overdue.status", "현재 상태")}: {row.status ?? "—"}
          </span>
        </div>
      ),
    },
    {
      key: "slot",
      header: t("overdue.col.slot", "억류 슬롯"),
      render: (row: HeldOverdueReminder) => (
        <div style={{ display: "grid", gap: 4, fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
          <span data-testid="overdue-slot">{row.scheduled_at}</span>
          <span style={{ color: "var(--color-text-muted)" }}>
            {t("overdue.heldSince", "억류 시작")}: {row.held_since}
          </span>
        </div>
      ),
    },
    {
      key: "late",
      header: t("overdue.col.late", "지연 시간"),
      render: (row: HeldOverdueReminder) => (
        <strong data-testid="overdue-duration">{formatOverdue(row.overdue_ms, language)}</strong>
      ),
    },
    {
      key: "action",
      header: t("overdue.col.action", "결정"),
      width: "34%",
      render: (row: HeldOverdueReminder) => {
        const key = slotKey(row);
        if (!canDecide) {
          return (
            <span data-testid="overdue-decision-unavailable" style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
              {t(
                "overdue.decision.unavailable",
                "이 계정은 억류 목록을 볼 수 있지만 replay 또는 skip을 결정할 수 없습니다.",
              )}
            </span>
          );
        }
        return (
          <div data-testid="overdue-decision-controls" style={{ display: "grid", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, fontSize: "0.76rem", color: "var(--color-text-secondary)" }}>
              {t("overdue.approval", "판단 근거")}
              <input
                aria-label={`${t("overdue.approval", "판단 근거")} ${row.reminder_id}`}
                value={drafts[key] ?? ""}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [key]: event.target.value }));
                  setActionError(null);
                }}
                placeholder={t("overdue.approval.placeholder", "APPROVED: ticket 또는 설명")}
                disabled={busySlot !== null}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 9px",
                  border: "1px solid var(--color-border-strong)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--color-bg-surface)",
                  color: "var(--color-text-primary)",
                }}
              />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                size="sm"
                onClick={() => void submit(row, "replay")}
                isLoading={busySlot === key}
                disabled={busySlot !== null}
              >
                {t("overdue.replay", "Replay")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void submit(row, "skip")}
                isLoading={busySlot === key}
                disabled={busySlot !== null}
              >
                {t("overdue.skip", "Skip")}
              </Button>
            </div>
          </div>
        );
      },
    },
  ];

  const decisionColumns = [
    {
      key: "reminder",
      header: t("overdue.col.reminder", "리마인더"),
      render: (row: OverdueDecisionRecord) => (
        <div style={{ display: "grid", gap: 3 }}>
          <strong>{row.reminder_id}</strong>
          <span data-testid="overdue-decision-slot" style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem" }}>
            {row.scheduled_at}
          </span>
        </div>
      ),
    },
    {
      key: "decision",
      header: t("overdue.col.decision", "결정"),
      render: (row: OverdueDecisionRecord) => (
        <strong data-testid="overdue-recorded-decision" data-decision={row.decision}>
          {row.decision === "replay"
            ? t("overdue.replay", "Replay")
            : row.decision === "skip"
              ? t("overdue.skip", "Skip")
              : row.decision}
        </strong>
      ),
    },
    {
      key: "approval",
      header: t("overdue.col.approval", "판단 근거"),
      render: (row: OverdueDecisionRecord) => (
        <span data-testid="overdue-recorded-approval">{row.approval_ref}</span>
      ),
    },
    {
      key: "decider",
      header: t("overdue.col.decider", "결정자와 시각"),
      render: (row: OverdueDecisionRecord) => (
        <div style={{ display: "grid", gap: 3 }}>
          <strong data-testid="overdue-recorded-decider">
            {row.decided_by ?? t("overdue.decider.unknown", "결정자 미기록")}
          </strong>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", color: "var(--color-text-muted)" }}>
            {row.decided_at}
          </span>
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />
      <PageHeader
        title={t("overdue.title", "지연 리마인더 결정")}
        subtitle={t(
          "overdue.subtitle",
          "스케줄러가 억류한 일회성 슬롯과 이미 내려진 결정을 함께 보여줍니다.",
        )}
        actions={(
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading || busySlot !== null}>
            {t("overdue.refresh", "↻ 목록 갱신")}
          </Button>
        )}
      />

      {loading ? (
        <div data-testid="overdue-loading" style={{ padding: 40, textAlign: "center", color: "var(--color-text-muted)" }}>
          {t("overdue.loading", "억류된 리마인더를 확인하는 중입니다...")}
        </div>
      ) : failure !== null || state === null ? (
        <div
          data-testid={failure === "refused" ? "overdue-refused" : "overdue-unreachable"}
          style={{ padding: 30, textAlign: "center", color: "var(--color-danger)", background: "var(--color-bg-surface)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-lg)" }}
        >
          {failure === "refused"
            ? refusedText(t, missing)
            : t("overdue.readFailed", "서버가 답하지 않아 억류 목록을 읽지 못했습니다.")}
        </div>
      ) : (
        <>
          {actionError && (
            <div data-testid="overdue-action-error" role="alert" style={{ padding: "12px 16px", color: "var(--color-danger)", background: "var(--status-danger-bg)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-md)" }}>
              {actionError}
            </div>
          )}

          <section data-testid="overdue-held-list" style={{ display: "grid", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: "1rem" }}>{t("overdue.held.title", "결정을 기다리는 억류")}</h2>
            <DataTable
              columns={heldColumns}
              data={state.reminders}
              keyExtractor={(row) => slotKey(row)}
              emptyMessage={t("overdue.held.empty", "현재 결정을 기다리는 억류 슬롯이 없습니다.")}
            />
          </section>

          <section data-testid="overdue-decision-history" style={{ display: "grid", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: "1rem" }}>{t("overdue.history.title", "기록된 결정")}</h2>
            <DataTable
              columns={decisionColumns}
              data={state.decisions}
              keyExtractor={(row) => `${row.reminder_id}\u0000${row.scheduled_at}`}
              emptyMessage={t("overdue.history.empty", "아직 기록된 replay 또는 skip 결정이 없습니다.")}
            />
          </section>
        </>
      )}
    </div>
  );
}
