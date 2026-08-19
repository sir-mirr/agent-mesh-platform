import React, { useState } from "react";
import {
  PageHeader,
  Breadcrumbs,
  Button,
  Input,
  CodeBlock,
  Toast,
  DataTable,
  StatusBadge,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { AgentPairingModal, type PendingAgentRequest } from "@/components/feedback/AgentPairingModal.tsx";

import { fetchPendingKeys, createPairingCodeApi, approveKeyProposal, denyKeyProposal } from "@/api/agents.ts";
import { publicApiOrigin } from "@/config/env.ts";

export function RegisterAgentPage() {
  const { t } = useI18n();
  const [targetIdentity, setTargetIdentity] = useState("");
  const [selectedTtl, setSelectedTtl] = useState(300);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [ttl, setTtl] = useState<number>(300);
  const [copied, setCopied] = useState<boolean>(false);
  const [pendingList, setPendingList] = useState<PendingAgentRequest[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [modalRequest, setModalRequest] = useState<PendingAgentRequest | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Fetch real pending proposals on mount
  React.useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    fetchPendingKeys()
      .then((proposals) => {
        setPendingList(
          (proposals || []).map((p) => ({
            // A proposal with no fingerprint is still a proposal; identifying it
            // by one meant `undefined` in the key when the field was absent.
            id: `req_${p.fingerprint?.slice(0, 10) ?? p.identity}`,
            identity: p.identity,
            name: `${p.identity} (Agent)`,
            groupName: p.type ?? "General",
            requestedAt: p.proposed_at ? new Date(p.proposed_at).toLocaleTimeString() : t("reg.pending", "대기 중"),
            fingerprint: p.fingerprint,
            status: "pending",
          }))
        );
      })
      .catch(() => {
        setIsError(true);
        setPendingList([]);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const handleGenerateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetIdentity) return;
    try {
      const res = await createPairingCodeApi(targetIdentity, selectedTtl);
      setGeneratedCode(res.code);
      setTtl(res.ttl_seconds || selectedTtl);
      setCopied(false);
      setToastMessage(`${t("reg.toast.issued", "페어링 코드 발급")}: ${targetIdentity} · ${selectedTtl / 60}${t("reg.minutes", "분")}`);
    } catch (err: any) {
      setGeneratedCode(null);
      setToastMessage(`${t("reg.toast.failed", "페어링 코드 발급 실패")}: ${err.message}`);
    }
  };

  const handleCopy = () => {
    if (generatedCode) {
      navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleApproveFromModal = async (fingerprint: string, identity: string, code: string) => {
    try {
      await approveKeyProposal(fingerprint);
    } catch (err: any) {
      console.warn("[Approve] API error:", err.message);
    }
    setPendingList((prev) =>
      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "approved" } : r))
    );
    setToastMessage(`${t("reg.toast.approved", "승인 및 페어링 완료")}: ${identity} · ${code}`);
  };

  const handleDenyFromModal = async (fingerprint: string, identity: string) => {
    try {
      await denyKeyProposal(fingerprint);
    } catch (err: any) {
      console.warn("[Deny] API error:", err.message);
    }
    setPendingList((prev) =>
      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "rejected" } : r))
    );
    setToastMessage(`${t("reg.toast.denied", "등록 요청 거절")}: ${identity}`);
  };

  const columns = [
    {
      key: "identity",
      header: t("reg.col.identity", "요청 에이전트 (Identity)"),
      render: (item: PendingAgentRequest) => (
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.85rem" }}>🤖 {item.name}</div>
          <code style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{item.identity}</code>
        </div>
      ),
    },
    {
      key: "groupName",
      header: t("reg.col.group", "배속 희망 그룹"),
      render: (item: PendingAgentRequest) => (
        <span style={{ fontWeight: 600, color: "var(--color-primary)", fontSize: "0.82rem" }}>
          {item.groupName}
        </span>
      ),
    },
    {
      key: "fingerprint",
      header: t("reg.col.fingerprint", "제안된 Ed25519 공개키 지문"),
      render: (item: PendingAgentRequest) => (
        <code style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)" }}>
          {item.fingerprint}
        </code>
      ),
    },
    {
      key: "status",
      header: t("reg.col.status", "승인 상태"),
      render: (item: PendingAgentRequest) => (
        <StatusBadge
          label={item.status === "pending" ? t("reg.status.pending", "대기 중") : item.status === "approved" ? t("reg.status.approved", "승인 완료") : t("reg.status.denied", "거절됨")}
          status={item.status === "pending" ? "pending" : item.status === "approved" ? "success" : "offline"}
          size="sm"
        />
      ),
    },
    {
      key: "actions",
      header: t("reg.col.actions", "인증 & 승인 액션"),
      align: "right" as const,
      render: (item: PendingAgentRequest) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {item.status === "pending" ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setModalRequest(item)}
            >
              🔑 {t("reg.action.pair", "페어링 코드 발급 & 승인")}
            </Button>
          ) : (
            <span style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontStyle: "italic" }}>
              {t("reg.action.done", "처리 완료")}
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="46"
        title={t("reg.title", "에이전트 신원 등록 & 페어링 허브")}
        subtitle={t("reg.subtitle", "클라이언트 AI 에이전트의 자동 등록 요청 수신, 1회용 페어링 코드(Pairing Code) 발급 및 소유권 승인 (SPEC § 11.3)")}
      />

      {toastMessage && (
        <Toast
          type="info"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      {/* Architecture Flow Guide */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: 20,
        }}
      >
        <h3 style={{ fontSize: "0.95rem", fontWeight: 700, marginBottom: 12 }}>
          🔄 {t("reg.flow.title", "클라이언트 주도 에이전트 등록 & 페어링 프로세스 (SPEC § 11.3)")}
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>1️⃣ {t("reg.flow.1", "AI 에이전트 요청")}</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              {t("reg.flow.1.body", "클라이언트 AI가 키쌍을 생성하고 POST /api/v1/agents 로 신원 프로비저닝을 요청합니다.")}
            </p>
          </div>

          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>2️⃣ {t("reg.flow.2", "실시간 사용자 알림")}</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              {t("reg.flow.2.body", "플랫폼에 로그인된 운영자에게 상단 알림으로 신규 에이전트 등록 요청이 도착합니다.")}
            </p>
          </div>

          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>3️⃣ {t("reg.flow.3", "페어링 모달 & 코드 발급")}</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              {t("reg.flow.3.body", "알림을 클릭하면 1회용 인증코드(PAIR-XXXX)를 발급받아 에이전트에 전달합니다.")}
            </p>
          </div>

          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>4️⃣ {t("reg.flow.4", "소유권 확정 바인딩")}</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              {t("reg.flow.4.body", "에이전트가 코드를 /pairing-codes/redeem 으로 제출해 상호 검증되고 정식 활성화됩니다.")}
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 20 }}>
        {/* On-Demand Code Generator */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
              🔑 {t("reg.gen.title", "즉시 페어링 코드(Pairing Code) 생성기")}
            </h3>
            <p style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginTop: 4 }}>
              {t("reg.gen.body", "특정 에이전트에 전달할 1회용 인증 토큰을 만듭니다 (POST /api/v1/admin/pairing-codes).")}
            </p>
          </div>

          <form onSubmit={handleGenerateCode} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input
              label={t("reg.field.identity", "대상 에이전트 고유 식별자 (Agent Identity)")}
              placeholder={t("reg.field.identity.ph", "예: agt_settlement_04")}
              value={targetIdentity}
              onChange={(e) => setTargetIdentity(e.target.value)}
              helperText={t("reg.field.identity.help", "에이전트가 연결할 정식 식별자를 입력하세요.")}
              required
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--color-text-secondary)" }}>
                ⏱️ {t("reg.ttl.label", "페어링 코드 유효기간 (TTL, 최대 1시간)")}
              </label>
              <select
                value={selectedTtl}
                onChange={(e) => setSelectedTtl(Number(e.target.value))}
                style={{
                  padding: "9px 12px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-surface)",
                  fontSize: "0.88rem",
                  outline: "none",
                }}
              >
                <option value={300}>{t("reg.ttl.300", "5분 (300초 - 기본 권장)")}</option>
                <option value={900}>{t("reg.ttl.900", "15분 (900초 - 서버 셋업용)")}</option>
                <option value={1800}>{t("reg.ttl.1800", "30분 (1,800초 - CI/CD 배포용)")}</option>
                <option value={3600}>{t("reg.ttl.3600", "1시간 (3,600초 - 최대 허용치)")}</option>
              </select>
            </div>

            <Button variant="primary" size="md" type="submit">
              ⚡ {t("reg.gen.submit", "1회용 페어링 코드 발급")}
            </Button>
          </form>

          {generatedCode && (
            <div
              style={{
                background: "#F8FAFC",
                border: "2px dashed var(--color-primary)",
                borderRadius: "var(--radius-lg)",
                padding: 16,
                textAlign: "center",
                marginTop: 8,
              }}
            >
              <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--color-text-muted)" }}>
                {t("reg.issued.label", "발급된 1회용 인증코드")} ({selectedTtl / 60} {t("reg.minutes", "분")})
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "1.4rem",
                  fontWeight: 800,
                  color: "var(--color-primary)",
                  letterSpacing: "0.06em",
                  margin: "8px 0",
                }}
              >
                {generatedCode}
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 8 }}>
                <Button variant="primary" size="sm" onClick={handleCopy}>
                  {copied ? `✓ ${t("reg.copied", "복사됨")}` : `📋 ${t("reg.copy", "코드 복사")}`}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* CLI Example Guide */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: 24,
          }}
        >
          <h3 style={{ fontSize: "0.95rem", fontWeight: 700, marginBottom: 8 }}>
            💻 {t("reg.cmd.title", "클라이언트 에이전트 연동 명령어")}
          </h3>
          <p style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.4 }}>
            {t("reg.cmd.body", "에이전트 호스트에서 발급받은 코드를 제출해 소유권을 확정합니다:")}
          </p>

          <CodeBlock
            title={t("reg.cmd.terminal", "에이전트 터미널 실행")}
            language="bash"
            code={`# ${t("reg.cmd.comment", "발급받은 페어링 코드로 소유권 바인딩")}
curl -X POST ${publicApiOrigin()}/api/v1/pairing-codes/redeem \\
  -H "Content-Type: application/json" \\
  -d '{
    "code": "${generatedCode || "PAIR-9412-SETTLEMENT"}",
    "owner": "admin"
  }'`}
          />
        </div>
      </div>

      {/* Pending Agent Requests Table */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
          📋 {t("reg.queue.title", "대기 중인 AI 에이전트 등록 요청 큐")} {isLoading ? `(${t("common.loading", "조회 중...")})` : isError ? t("common.unreachable", "(통신 불가)") : `(${pendingList.filter((p) => p.status === "pending").length}건 대기)`}
        </h3>
        <DataTable
          columns={columns}
          data={pendingList}
          keyExtractor={(item) => item.id}
          isLoading={isLoading}
          isError={isError}
          errorMessage={t("reg.queue.error", "대기 중인 등록 요청 큐를 불러올 수 없습니다 (서버 연결 실패).")}
          emptyMessage={t("reg.queue.empty", "현재 대기 중인 공개키 제안 데이터가 없습니다.")}
        />
      </div>

      {/* Modal */}
      <AgentPairingModal
        isOpen={!!modalRequest}
        onClose={() => setModalRequest(null)}
        request={modalRequest}
        onApprove={handleApproveFromModal}
        onDeny={handleDenyFromModal}
      />
    </div>
  );
}

