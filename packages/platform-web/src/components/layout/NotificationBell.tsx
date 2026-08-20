import React, { useState, useRef, useEffect } from "react";
import { failureKind, type FailureKind } from "@/api/client.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { AgentPairingModal, type PendingAgentRequest } from "@/components/feedback/AgentPairingModal.tsx";

import { fetchPendingKeys, approveKeyProposal, denyKeyProposal } from "@/api/agents.ts";

export function NotificationBell() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<PendingAgentRequest[]>([]);
  /** What the last approve/deny did, when it did not go through. */
  const [decisionFailure, setDecisionFailure] = useState<FailureKind | null>(null);
  /**
   * **A live channel has a fourth state, and this had three.**
   *
   * The queue arrives twice: a fetch on mount and a stream that pushes what
   * comes after. If the stream drops, the fetch's answer stays on screen and
   * keeps looking current — a proposal that arrives afterwards never appears,
   * and nothing says so. The operator sitting on the page is exactly who this
   * component is for, and they are the only person who would never find out.
   *
   * `EventSource` retries on its own, so an error is not the same as gone.
   * `onopen` clears this; `onerror` sets it. What it means is *the last thing
   * you were told may be stale*, which is neither "nothing is waiting" nor "I
   * could not ask".
   */
  const [streamLost, setStreamLost] = useState(false);
  /**
   * `[]` and "could not ask" were the same value here.
   *
   * The fetch's `.catch` set the list to empty, and an empty list draws "there
   * are no requests waiting" — a sentence about the server's answer, produced
   * when there was no answer. Measured with only this one route failing and
   * everything else healthy: the bell was silent and identical to a quiet mesh,
   * while agents could be waiting to be admitted.
   */
  /**
   * **거절과 못 닿음을 여기서도 가른다.**
   *
   * `audit.read.metadata` 하나만 든 세션으로 걸어보니 벨이 `403` 을 받고 *물어보지
   * 못했습니다* 라고 말했다 — 서버는 답했고, 그 답은 *너는 이걸 볼 수 없다* 였다.
   * 열 화면에서 갈라둔 그 구분이 이 컴포넌트에는 안 들어와 있었다.
   */
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const unreachable = failure !== null;
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<PendingAgentRequest | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 1. Initial pending keys fetch & SSE Stream subscription
  useEffect(() => {
    // Initial fetch
    fetchPendingKeys()
      .then((proposals) => {
        setRequests(
          (proposals || []).map((p) => ({
            // A proposal with no fingerprint is still a proposal; identifying it
            // by one meant `undefined` in the key when the field was absent.
            id: `req_${p.fingerprint?.slice(0, 10) ?? p.identity}`,
            identity: p.identity,
            name: `${p.identity} (Agent)`,
            groupName: p.type ?? "General",
            requestedAt: p.proposed_at ? new Date(p.proposed_at).toLocaleTimeString() : t("bell.justNow", "방금 전"),
            fingerprint: p.fingerprint,
            status: "pending",
          }))
        );
      })
      .catch((e: unknown) => {
        setRequests([]);
        setFailure(failureKind(e));
      });

    // Subscribe to SSE /api/v1/admin/keys/stream
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/v1/admin/keys/stream", { withCredentials: true });

      es.onopen = () => setStreamLost(false);
      es.onerror = () => setStreamLost(true);

      es.addEventListener("snapshot", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const list = data.proposals || [];
          if (list.length > 0) {
            setRequests(
              list.map((p: any) => ({
                id: `req_${p.fingerprint.slice(0, 10)}`,
                identity: p.identity,
                name: `${p.identity} (Agent)`,
                groupName: p.type ?? "General",
                requestedAt: p.proposed_at ? new Date(p.proposed_at).toLocaleTimeString() : t("reg.pending", "대기 중"),
                fingerprint: p.fingerprint,
                status: "pending",
              }))
            );
          }
        } catch {}
      });

      es.addEventListener("key-proposed", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data);
          const newReq: PendingAgentRequest = {
            id: `req_${p.fingerprint?.slice(0, 10) || Date.now()}`,
            identity: p.identity,
            name: `${p.identity} (Agent)`,
            groupName: p.type ?? "General",
            requestedAt: t("bell.justNow", "방금 전"),
            fingerprint: p.fingerprint,
            status: "pending",
          };
          setRequests((prev) => [newReq, ...prev.filter((r) => r.fingerprint !== p.fingerprint)]);
        } catch {}
      });
    } catch {}

    return () => {
      es?.close();
    };
  }, []);

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleOpenRequest = (req: PendingAgentRequest) => {
    setSelectedRequest(req);
    setIsModalOpen(true);
    setIsOpen(false);
  };

  /**
   * **The row moves only when the server moved.**
   *
   * Both of these used to `catch` the error, log it to a console nobody has
   * open, and then mark the request `approved` or `rejected` anyway — the state
   * update sat *below* the `try`, so it ran on every path. With the write
   * blocked the bell said `거절됨` about a decision that never left the browser,
   * and the proposal was still pending on the server. An operator reading that
   * line has been told the key was decided.
   *
   * `SC-WRITE-10` is the entry, and this route had no scenario at all until the
   * write list was read against the suite rather than the screens.
   */
  const decide = async (
    call: (fingerprint: string) => Promise<unknown>,
    next: "approved" | "rejected",
    fingerprint: string,
    identity: string,
  ) => {
    setDecisionFailure(null);
    try {
      await call(fingerprint);
    } catch (err: unknown) {
      // Not `unreachable` for everything: a `403` is the server answering, and
      // saying "could not reach it" about a refusal sends the operator to check
      // the network for a permission they do not hold.
      setDecisionFailure(failureKind(err));
      return;
    }
    setRequests((prev) =>
      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: next } : r))
    );
  };

  const handleApprove = (fingerprint: string, identity: string) =>
    decide(approveKeyProposal, "approved", fingerprint, identity);

  const handleDeny = (fingerprint: string, identity: string) =>
    decide(denyKeyProposal, "rejected", fingerprint, identity);

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      {/* Bell Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          borderRadius: "var(--radius-full)",
          border: "1px solid var(--color-border)",
          background: isOpen ? "var(--color-bg-surface-sub)" : "var(--color-bg-surface)",
          cursor: "pointer",
          fontSize: "1.1rem",
          transition: "all 0.15s ease",
        }}
        data-testid="bell"
        title={t("bell.title", "에이전트 등록 요청 알림")}
      >
        🔔
        {pendingCount === 0 && unreachable && (
          <span
            data-testid="bell-unreachable"
            title={failure === "refused" ? t("bell.refused", "이 계정은 등록 요청을 볼 수 없습니다") : t("bell.unreachable", "등록 요청을 물어보지 못했습니다")}
            style={{
              position: "absolute",
              top: -3,
              right: -3,
              background: "var(--color-text-muted)",
              color: "var(--color-bg-surface)",
              fontSize: "0.68rem",
              fontWeight: 800,
              borderRadius: "var(--radius-full)",
              minWidth: 18,
              height: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
            }}
          >
            ?
          </span>
        )}
        {pendingCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: -3,
              right: -3,
              background: "var(--color-danger)",
              color: "#FFF",
              fontSize: "0.68rem",
              fontWeight: 800,
              borderRadius: "var(--radius-full)",
              minWidth: 18,
              height: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
              boxShadow: "0 2px 4px rgba(239, 68, 68, 0.4)",
            }}
          >
            {pendingCount}
          </span>
        )}
      </button>

      {/* Dropdown Popover */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            width: 340,
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            boxShadow: "var(--shadow-md)",
            zIndex: 50,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-bg-surface-sub)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <strong style={{ fontSize: "0.85rem", color: "var(--color-text-primary)" }}>
              🔔 {t("bell.title2", "에이전트 등록 요청")}
            </strong>
            <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
              {t("reg.queue.waiting", "대기")} {pendingCount}
            </span>
          </div>

          {streamLost && (
            <div
              data-testid="bell-stream-lost"
              style={{ padding: "8px 12px", fontSize: "0.76rem", color: "var(--color-warning, var(--color-danger))", borderBottom: "1px solid var(--color-border)" }}
            >
              {t("bell.streamLost", "실시간 갱신이 끊겼습니다 — 아래는 마지막으로 받은 것입니다")}
            </div>
          )}

          {decisionFailure && (
            <div
              data-testid="bell-decision-failed"
              style={{ padding: "8px 12px", fontSize: "0.76rem", color: "var(--color-danger)", borderBottom: "1px solid var(--color-border)" }}
            >
              {decisionFailure === "refused"
                ? t("bell.decideRefused", "이 계정은 등록 요청을 처리할 수 없습니다")
                : t("bell.decideUnreachable", "처리하지 못했습니다 — 요청이 서버에 닿지 않았습니다")}
            </div>
          )}

          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {requests.length === 0 ? (
              <div
                data-testid={failure === "refused" ? "bell-empty-refused" : unreachable ? "bell-empty-unreachable" : "bell-empty"}
                style={{ padding: 24, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.8rem" }}
              >
                {failure === "refused"
                  ? t("bell.refused", "이 계정은 등록 요청을 볼 수 없습니다")
                  : unreachable
                  ? t("bell.unreachable", "등록 요청을 물어보지 못했습니다")
                  : t("bell.empty", "대기 중인 등록 요청이 없습니다.")}
              </div>
            ) : (
              requests.map((req) => (
                <div
                  key={req.id}
                  onClick={() => req.status === "pending" && handleOpenRequest(req)}
                  style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--color-border)",
                    cursor: req.status === "pending" ? "pointer" : "default",
                    background: req.status === "pending" ? "transparent" : "var(--color-bg-surface-sub)",
                    opacity: req.status === "pending" ? 1 : 0.6,
                    transition: "background 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (req.status === "pending") {
                      (e.currentTarget as HTMLElement).style.background = "var(--color-bg-surface-sub)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (req.status === "pending") {
                      (e.currentTarget as HTMLElement).style.background = "transparent";
                    }
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <strong style={{ fontSize: "0.82rem", color: "var(--color-text-primary)" }}>
                      🤖 {req.name}
                    </strong>
                    <span style={{ fontSize: "0.7rem", color: "var(--color-text-muted)" }}>
                      {req.requestedAt}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>
                    {t("bell.identity", "식별자")}: <code>{req.identity}</code>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-primary)", fontWeight: 600 }}>
                      {t("bell.group", "소속")}: {req.groupName}
                    </span>
                    {req.status === "pending" ? (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--color-primary)",
                          fontWeight: 700,
                          background: "var(--color-primary-light)",
                          padding: "2px 6px",
                          borderRadius: "var(--radius-sm)",
                        }}
                      >
                        {t("bell.issue", "인증코드 발급")} ➔
                      </span>
                    ) : (
                      <span style={{ fontSize: "0.72rem", color: "var(--color-success)", fontWeight: 600 }}>
                        {req.status === "approved" ? `✓ ${t("bell.approved", "승인됨")}` : `✕ ${t("bell.denied", "거절됨")}`}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Agent Pairing Modal */}
      <AgentPairingModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        request={selectedRequest}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />
    </div>
  );
}
