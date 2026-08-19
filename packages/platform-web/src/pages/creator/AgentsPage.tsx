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
  /** Whether the mesh has ever seen this identity. Measured; not "online". */
  seen: boolean;
  fingerprint: string | null;
  /**
   * `null` — this list has never carried it.
   *
   * It was a literal `0` in a column headed "메일함 적체". Zero backlog is the
   * answer an operator is hoping for, so the one value that could not be
   * checked was also the one nobody would question.
   */
  inboxDepth: number | null;
  /** When, in words. "접속 기록 없음" when the mesh has no record. */
  lastSeen: string;
}

import { fetchAgents, teardownAgentApi, lastSeenLabel, hasBeenSeen } from "@/api/agents.ts";

export function AgentsPage() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const [teardownTarget, setTeardownTarget] = useState<AgentItem | null>(null);
  const [isTeardownOpen, setIsTeardownOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const loadAgents = async () => {
    setIsLoading(true);
    setIsError(false);
      setFailure(null);
    try {
      const list = await fetchAgents();
      setAgents(
        (list || []).map((a) => ({
          id: a.identity,
          name: a.description || a.identity,
          groupName: a.type ?? "—",
          // `status` is gone from the route on purpose (SPEC § 9.1). What the mesh
          // measured is when it last saw the identity.
          lastSeen: lastSeenLabel(a.last_seen_at),
          seen: hasBeenSeen(a),
          // Absent, not invented — see `fetchAgents`.
          fingerprint: a.fingerprint ?? null,
          // `GET /api/v1/agents` does not report queue depth. See the type.
          inboxDepth: null,
        }))
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
    loadAgents();
  }, []);

  const handleTeardownConfirm = async () => {
    if (!teardownTarget) return;
    try {
      await teardownAgentApi(teardownTarget.id);
      setIsTeardownOpen(false);
      const targetId = teardownTarget.id;
      setTeardownTarget(null);
      setToastMessage(`에이전트 [${targetId}]이(가) 성공적으로 영구 삭제(Teardown)되었습니다.`);
      await loadAgents();
    } catch (err: any) {
      setIsTeardownOpen(false);
      setTeardownTarget(null);
      setToastMessage(`에이전트 삭제 실패: ${err.message || "서버 통신 오류"}`);
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
      key: "seen",
      header: t("agents.col.lastSeen", "마지막 접속"),
      render: (item: AgentItem) =>
        item.seen ? (
          <span data-testid="last-seen" style={{ fontSize: "0.8rem", color: "var(--color-text-primary)" }}>
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
      header: t("agents.col.fingerprint", "Ed25519 공개키 지문"),
      render: (item: AgentItem) => (
        <FingerprintBox fingerprint={item.fingerprint} showCopy={true} />
      ),
    },
    {
      key: "inboxDepth",
      header: t("agents.col.inbox", "메일함 적체"),
      render: (item: AgentItem) =>
        item.inboxDepth === null ? (
          // Not `0`. Zero backlog is the answer an operator hopes for, so
          // printing it for an unknown makes the one unverifiable cell the one
          // nobody questions.
          <span data-testid="inbox-unknown" style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
            — 미보고
          </span>
        ) : (
          <span
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
          <Link to="/creator/playground">
            <Button variant="secondary" size="sm">
              {t("nav.playground", "메시지 테스트")}
            </Button>
          </Link>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setTeardownTarget(item);
              setIsTeardownOpen(true);
            }}
          >
            {t("agents.teardownBtn", "Teardown")}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="37"
        title={t("agents.title", "소유 에이전트 운영 스튜디오")}
        subtitle={t("agents.subtitle", "등록된 자율 에이전트 플릿 관리, 실시간 온라인 웹소켓 상태 및 암호학적 지문 검증")}
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
        emptyMessage="현재 등록된 에이전트 데이터가 없습니다."
      />

      {teardownTarget && (
        <ConfirmDialog
          isOpen={isTeardownOpen}
          onClose={() => setIsTeardownOpen(false)}
          onConfirm={handleTeardownConfirm}
          title={`에이전트 영구 Teardown (§ 9.3)`}
          description={`에이전트 [${teardownTarget.name}] (${teardownTarget.id})의 신원을 영구 파괴합니다. 승인된 공개키는 침해 보관소로 이동하며, 동일 ID로의 재등록이 영구 차단(409)됩니다.`}
          confirmLabel="영구 Teardown 실행"
          isDestructive={true}
          confirmPromptMatch={teardownTarget.id}
        />
      )}

      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
    </div>
  );
}
