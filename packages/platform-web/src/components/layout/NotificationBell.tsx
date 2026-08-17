import React, { useState, useRef, useEffect } from "react";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { AgentPairingModal, type PendingAgentRequest } from "@/components/feedback/AgentPairingModal.tsx";

const INITIAL_REQUESTS: PendingAgentRequest[] = [
  {
    id: "req_01",
    identity: "agt_settlement_04",
    name: "Automated Settlement Agent",
    groupName: "Billing Core",
    requestedAt: "방금 전",
    fingerprint: "sha256:4kvL9XzN81pQm6wY3vT...",
    status: "pending",
  },
  {
    id: "req_02",
    identity: "agt_analyzer_05",
    name: "Realtime Log Analyzer",
    groupName: "Analytics Group",
    requestedAt: "2분 전",
    fingerprint: "sha256:9pxM1TaW72rKn4vE1aB...",
    status: "pending",
  },
];

import { fetchPendingKeys, approveKeyProposal, denyKeyProposal } from "@/api/agents.ts";

export function NotificationBell() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<PendingAgentRequest[]>(INITIAL_REQUESTS);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<PendingAgentRequest | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 1. Initial pending keys fetch & SSE Stream subscription
  useEffect(() => {
    // Initial fetch
    fetchPendingKeys().then((proposals) => {
      if (proposals && proposals.length > 0) {
        setRequests(
          proposals.map((p) => ({
            id: `req_${p.fingerprint.slice(0, 10)}`,
            identity: p.identity,
            name: `${p.identity} (Agent)`,
            groupName: p.type ?? "General",
            requestedAt: p.proposed_at ? new Date(p.proposed_at).toLocaleTimeString() : "방금 전",
            fingerprint: p.fingerprint,
            status: "pending",
          }))
        );
      }
    });

    // Subscribe to SSE /api/v1/admin/keys/stream
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/v1/admin/keys/stream", { withCredentials: true });

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
                requestedAt: p.proposed_at ? new Date(p.proposed_at).toLocaleTimeString() : "대기 중",
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
            requestedAt: "방금 전",
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

  const handleApprove = async (fingerprint: string, identity: string) => {
    try {
      await approveKeyProposal(fingerprint);
    } catch (err: any) {
      console.warn("[Approve] Error approving key proposal:", err.message);
    }
    setRequests((prev) =>
      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "approved" } : r))
    );
  };

  const handleDeny = async (fingerprint: string, identity: string) => {
    try {
      await denyKeyProposal(fingerprint);
    } catch (err: any) {
      console.warn("[Deny] Error denying key proposal:", err.message);
    }
    setRequests((prev) =>
      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "rejected" } : r))
    );
  };

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
        title="에이전트 등록 요청 알림"
      >
        🔔
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
              🔔 신규 에이전트 등록 알림
            </strong>
            <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
              대기 {pendingCount}건
            </span>
          </div>

          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {requests.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.8rem" }}>
                대기 중인 등록 요청이 없습니다.
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
                    식별자: <code>{req.identity}</code>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-primary)", fontWeight: 600 }}>
                      소속: {req.groupName}
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
                        인증코드 발급 ➔
                      </span>
                    ) : (
                      <span style={{ fontSize: "0.72rem", color: "var(--color-success)", fontWeight: 600 }}>
                        {req.status === "approved" ? "✓ 승인됨" : "✕ 거절됨"}
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
