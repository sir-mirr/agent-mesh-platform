import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import { Link } from "react-router-dom";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  StatusBadge,
  FingerprintBox,
  Button,
  ConfirmDialog,
  Toast,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";
import { fetchAdminMailbox } from "@/api/mailbox.ts";

interface AgentItem {
  id: string;
  name: string;
  groupName: string;
  /**
   * `null` when the list did not report one.
   *
   * `GET /api/v1/agents` does not carry a status, and this used to collapse the
   * absence to `"offline"` — a report of health on a screen whose job is to
   * show which agents are not healthy. Unknown and down are different answers
   * and only one of them is true here.
   */
  /** A measured timestamp, no record, or a value the client cannot parse. */
  lastSeenKind: "ago" | "never" | "invalid";
  fingerprint: string | null;
  /**
   * `null` — this list has never carried it.
   *
   * It was a literal `0` in a column headed "메일함 적체". Zero backlog is the
   * answer an operator is hoping for, so the one value that could not be
   * checked was also the one nobody would question.
   */
  inboxDepth: number | null;
  /** When, in words. "본 적 없음" when the mesh has no record. */
  lastSeen: string;
  /** Lifecycle comes only from `deleted_at`; presence is not a substitute. */
  lifecycle: "live" | "deleted" | "unknown";
  deletedAt: string | null;
}

interface TeardownNotice {
  testId: `teardown-result-${TeardownAction | "failed"}`;
  type: "success" | "info" | "warning" | "error";
  message: string;
}

import {
  agentRegistryEntries,
  fetchAgents,
  teardownAgentApi,
  isoUtcMillis,
  lastSeen,
  lastSeenText,
  type TeardownAction,
  type TeardownResponse,
} from "@/api/agents.ts";

export function AgentsPage() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const { hasCapability } = useRbac();
  const canTeardown = hasCapability("agent.teardown");
  const canReadMailboxDepth = hasCapability("mailbox.read.depth");
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const [teardownTarget, setTeardownTarget] = useState<AgentItem | null>(null);
  const [isTeardownOpen, setIsTeardownOpen] = useState(false);
  const [isTeardownPending, setIsTeardownPending] = useState(false);
  const teardownInFlight = React.useRef(false);
  const [teardownNotice, setTeardownNotice] = useState<TeardownNotice | null>(null);

  const loadAgents = async () => {
    setIsLoading(true);
    setIsError(false);
      setFailure(null);
    try {
      // Queue depth has its own protected producer. A refusal or failed depth
      // read must not turn an honestly loaded registry into a failed table;
      // it leaves only that cell unreported. Waiting for auth below prevents
      // an unprivileged probe before the session's capabilities are known.
      const mailboxRead = canReadMailboxDepth
        ? fetchAdminMailbox().catch(() => null)
        : Promise.resolve(null);
      const [agentResponse, mailbox] = await Promise.all([fetchAgents(), mailboxRead]);
      const list = agentRegistryEntries(agentResponse);
      const inboxDepthByIdentity = new Map<string, number>(
        (mailbox?.mailboxes ?? []).map((row) => [row.identity, row.pending]),
      );
      setAgents(
        (list || []).map((a) => {
          const seen = lastSeen(a.last_seen_at);
          // Keep a malformed old response separate from live. `null` is the
          // contract's positive fact that teardown has not happened; an
          // omitted field cannot be promoted to that fact.
          const deletedAt = (a as { deleted_at?: string | null }).deleted_at;
          return {
            id: a.identity,
            name: a.description || a.identity,
            groupName: a.type ?? "—",
            // `status` is gone from the route on purpose (SPEC § 9.1). What the mesh
            // measured is when it last saw the identity.
            lastSeen: lastSeenText(t, a.last_seen_at),
            lastSeenKind: seen.kind,
            lifecycle:
              deletedAt === null ? "live"
              : typeof deletedAt === "string" ? "deleted"
              : "unknown",
            deletedAt: typeof deletedAt === "string" ? deletedAt : null,
            // Absent, not invented — see `fetchAgents`.
            fingerprint: a.fingerprint ?? null,
            // Kept absent when the protected mailbox read did not answer, was
            // refused, or did not name this identity. Zero is retained when
            // the producer really measured zero.
            inboxDepth: inboxDepthByIdentity.get(a.identity) ?? null,
          };
        })
      );
    } catch (err: unknown) {
      setIsError(true);
      setFailure(failureKind(err));
        setMissing(refusedCapability(err));
      setAgents([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Load real agents from backend
  React.useEffect(() => {
    if (!isAuthLoading) void loadAgents();
  }, [isAuthLoading, canReadMailboxDepth]);

  /**
   * Preserve the wire's three timestamp facts instead of defaulting them.
   *
   * An absent key is the normal `not-found` answer: there was no identity and
   * therefore no deletion time. `null` is a different answer carried by a row,
   * while a string is the measured time. Inventing one fallback for all three
   * would tell an operator that a never-existing identity was deleted.
   */
  const teardownTimeText = (result: TeardownResponse): string => {
    if (!Object.prototype.hasOwnProperty.call(result, "deleted_at")) {
      return t("agents.teardown.deletedAtAbsent", "삭제 시각 필드 없음");
    }
    if (result.deleted_at === null) {
      return t("agents.teardown.deletedAtNull", "삭제 시각 미기록 (null)");
    }
    return `${t("agents.teardown.deletedAt", "삭제 시각")}: ${result.deleted_at}`;
  };

  const handleTeardownConfirm = async () => {
    if (!teardownTarget || teardownInFlight.current) return;
    teardownInFlight.current = true;
    setIsTeardownPending(true);
    const targetId = teardownTarget.id;
    try {
      const result = await teardownAgentApi(targetId);
      let notice: TeardownNotice;
      switch (result.action) {
        case "soft-deleted":
          notice = {
            testId: "teardown-result-soft-deleted",
            type: "success",
            message: `${t("agents.teardown.done", "영구 삭제 완료")}: ${targetId} · ${teardownTimeText(result)}`,
          };
          break;
        case "already-deleted":
          notice = {
            testId: "teardown-result-already-deleted",
            type: "info",
            message: `${t("agents.teardown.alreadyDeleted", "이미 삭제되어 이번 요청에서 변경 없음")}: ${targetId} · ${teardownTimeText(result)}`,
          };
          break;
        case "not-found":
          notice = {
            testId: "teardown-result-not-found",
            type: "warning",
            message: `${t("agents.teardown.notFound", "등록된 에이전트가 없어 삭제하지 않음")}: ${targetId} · ${teardownTimeText(result)}`,
          };
          break;
        default: {
          const unknownAction: never = result.action;
          throw new Error(`unknown teardown action: ${unknownAction}`);
        }
      }
      setIsTeardownOpen(false);
      setTeardownTarget(null);
      setTeardownNotice(notice);
      await loadAgents();
    } catch (err: any) {
      setIsTeardownOpen(false);
      setTeardownTarget(null);
      setTeardownNotice({
        testId: "teardown-result-failed",
        type: "error",
        message: `${t("agents.teardown.failed", "삭제 실패")}: ${err.message || t("agents.error", "에이전트 목록을 불러오지 못했습니다 (서버가 답하지 않았습니다).")}`,
      });
    } finally {
      teardownInFlight.current = false;
      setIsTeardownPending(false);
    }
  };

  const columns = [
    {
      key: "name",
      header: t("agents.col.name", "에이전트 명 / ID"),
      render: (item: AgentItem) => (
        <div>
          <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>
            {item.name}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--color-text-muted)",
            }}
          >
            {item.id}
          </div>
        </div>
      ),
    },
    {
      key: "groupName",
      // **Renamed rather than defaulted.** The value here is `a.type` — what
      // kind of agent this is — and the column called it the group it belongs
      // to, with `"Default Group"` invented whenever type was absent. Two
      // different facts, one of which the server does send. Naming it for what
      // it holds keeps the information and drops the claim; a membership column
      // needs a membership field, and there is not one on this route.
      header: t("agents.col.type", "종류"),
      render: (item: AgentItem) => (
        <span
          style={{
            padding: "3px 8px",
            background: "var(--color-bg-surface-sub)",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.78rem",
            fontWeight: 600,
          }}
        >
          {item.groupName}
        </span>
      ),
    },
    {
      key: "lifecycle",
      header: t("agents.col.lifecycle", "신원 상태"),
      render: (item: AgentItem) =>
        item.lifecycle === "deleted" ? (
          <div
            data-testid="agent-lifecycle-deleted"
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}
          >
            <StatusBadge
              status="danger"
              size="sm"
              label={t("agents.state.deleted", "철거됨")}
            />
            <span style={{ color: "var(--color-text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
              {item.deletedAt !== null && isoUtcMillis(item.deletedAt) !== null
                ? item.deletedAt
                : t("agents.state.deletedAtInvalid", "철거 시각 형식 오류")}
            </span>
          </div>
        ) : item.lifecycle === "live" ? (
          <span data-testid="agent-lifecycle-live">
            <StatusBadge
              status="neutral"
              size="sm"
              label={t("agents.state.live", "철거되지 않음")}
            />
          </span>
        ) : (
          <span data-testid="agent-lifecycle-unknown">
            <StatusBadge
              status="warning"
              size="sm"
              label={t("agents.state.unknown", "상태 미보고")}
            />
          </span>
        ),
    },
    {
      key: "lastSeenKind",
      header: t("agents.col.lastSeen", "마지막 접속"),
      render: (item: AgentItem) =>
        item.lastSeenKind === "ago" ? (
          <span data-testid="last-seen" style={{ fontSize: "0.8rem", color: "var(--color-text-primary)" }}>
            {item.lastSeen}
          </span>
        ) : item.lastSeenKind === "invalid" ? (
          <span data-testid="invalid-last-seen" style={{ color: "var(--color-warning)", fontSize: "0.8rem" }}>
            {item.lastSeen}
          </span>
        ) : (
          // Not "offline". SPEC § 9.1: `last_seen_at: null` means the mesh holds
          // no presence record, and calling that offline is a judgement this
          // screen is not entitled to make.
          <span data-testid="never-seen" style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
            {item.lastSeen}
          </span>
        ),
    },
    {
      key: "fingerprint",
      header: t("agents.col.fingerprint", "공개키 지문"),
      render: (item: AgentItem) => (
        <FingerprintBox fingerprint={item.fingerprint} showCopy={true} />
      ),
    },
    {
      key: "inboxDepth",
      header: t("agents.col.inbox", "메일함 적체"),
      // D-745: keep the numeric branch for the existing admin-mailbox
      // producer. A session with `mailbox.read.depth` can compose each
      // identity's `pending` count into this row; a refused or failed request
      // stays `null` and must never be collapsed to a reassuring zero.
      render: (item: AgentItem) =>
        item.inboxDepth === null ? (
          // Not `0`. Zero backlog is the answer an operator hopes for, so
          // printing it for an unknown makes the one unverifiable cell the one
          // nobody questions.
          <span data-testid="inbox-unknown" style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
            {t("agents.notReported", "— 미보고")}
          </span>
        ) : (
          <span
            data-testid={`inbox-depth-${item.id}`}
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              color: item.inboxDepth > 0 ? "var(--color-warning)" : "var(--color-text-muted)",
            }}
          >
            {item.inboxDepth}
          </span>
        ),
    },
    {
      key: "actions",
      header: t("agents.col.actions", "작업"),
      align: "right" as const,
      render: (item: AgentItem) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {item.lifecycle === "live" && (
            <Link to="/creator/playground">
              <Button variant="secondary" size="sm">
                {t("nav.playground", "메시지 테스트")}
              </Button>
            </Link>
          )}
          {/*
            **Shown only to a session the server gave `agent.teardown`.**
            Measured with a member holding nothing: the button was there, the
            modal opened on the `admin` identity, the confirmation accepted the
            typed name, and the server refused at the last step. The screen
            reported that honestly — and every other write control on this
            console is hidden without its capability, so this one walked a
            person through an irreversible flow that could not have worked.

            `hasCapability` reads what `/auth/me` granted, not a role.
          */}
          {/* Filtering `type: user` removes the normal self row. Keep identity
              equality as a second, independent guard: a malformed or migrated
              registry row must never offer the signed-in person a control that
              destroys their own identity from an agent-management screen. */}
          {canTeardown && item.lifecycle === "live" && item.id !== user?.name && (
            <Button
              variant="danger"
              size="sm"
              data-testid={`teardown-${item.id}`}
              onClick={() => {
                setTeardownTarget(item);
                setIsTeardownOpen(true);
              }}
            >
              {t("agents.teardownBtn", "Teardown")}
            </Button>
          )}
          {item.lifecycle !== "live" && (
            <span style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>
              {t("agents.state.noActions", "사용 가능한 작업 없음")}
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        title={t("agents.title", "소유 에이전트 운영 스튜디오")}
        subtitle={t("agents.subtitle", "등록된 에이전트의 공개키 지문과 마지막 접속 기록을 보여줍니다. 사람 계정은 로컬 계정에서 관리합니다")}
        actions={
          <Link to="/creator/register">
            <Button variant="primary" size="sm">
              {t("dash.registerLink", "➕ Register an agent")}
            </Button>
          </Link>
        }
      />

      <DataTable
        columns={columns}
        data={agents}
        keyExtractor={(item) => item.id}
        isLoading={isLoading}
        isError={isError}
        errorMessage={
          failure === "refused"
            ? refusedText(t, missing)
            : t("agents.error", "에이전트 목록을 불러오지 못했습니다 (서버가 답하지 않았습니다).")
        }
        emptyMessage={t("agents.empty", "등록된 에이전트가 없습니다.")}
      />

      {teardownTarget && (
        <ConfirmDialog
          isOpen={isTeardownOpen}
          onClose={() => setIsTeardownOpen(false)}
          onConfirm={handleTeardownConfirm}
          title={t("agents.teardown.title", "에이전트 영구 삭제")}
          description={`${teardownTarget.name} (${teardownTarget.id}) — ${t("agents.teardown.body", "이 신원을 영구히 파괴합니다. 승인된 공개키는 침해 보관소로 옮겨지고, 같은 ID 로는 다시 등록할 수 없습니다 (409).")}`}
          confirmLabel={t("agents.teardown.confirm", "영구 삭제")}
          isDestructive={true}
          isLoading={isTeardownPending}
          confirmPromptMatch={teardownTarget.id}
        />
      )}

      {teardownNotice && (
        <div data-testid={teardownNotice.testId}>
          <Toast
            type={teardownNotice.type}
            message={teardownNotice.message}
            onClose={() => setTeardownNotice(null)}
          />
        </div>
      )}
    </div>
  );
}
