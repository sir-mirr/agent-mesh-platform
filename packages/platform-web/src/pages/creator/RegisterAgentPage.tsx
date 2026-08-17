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

const MOCK_PENDING_QUEUE: PendingAgentRequest[] = [
  {
    id: "req_01",
    identity: "agt_settlement_04",
    name: "Automated Settlement Agent",
    groupName: "Billing Core",
    requestedAt: "1분 전",
    fingerprint: "sha256:4kvL9XzN81pQm6wY3vT8jKl19...",
    status: "pending",
  },
  {
    id: "req_02",
    identity: "agt_analyzer_05",
    name: "Realtime Log Analyzer",
    groupName: "Analytics Group",
    requestedAt: "5분 전",
    fingerprint: "sha256:9pxM1TaW72rKn4vE1aB8yUo42...",
    status: "pending",
  },
];

export function RegisterAgentPage() {
  const { t } = useI18n();
  const [targetIdentity, setTargetIdentity] = useState("agt_settlement_04");
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [ttl, setTtl] = useState<number>(300);
  const [copied, setCopied] = useState<boolean>(false);
  const [pendingList, setPendingList] = useState<PendingAgentRequest[]>(MOCK_PENDING_QUEUE);
  const [modalRequest, setModalRequest] = useState<PendingAgentRequest | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleGenerateCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetIdentity) return;
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const cleanId = targetIdentity.replace(/^agt_/, "").toUpperCase();
    const code = `PAIR-${randomSuffix}-${cleanId}`;
    setGeneratedCode(code);
    setTtl(300);
    setCopied(false);
    setToastMessage(`에이전트 [${targetIdentity}]용 페어링 코드가 발급되었습니다.`);
  };

  const handleCopy = () => {
    if (generatedCode) {
      navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleApproveFromModal = (fingerprint: string, identity: string, code: string) => {
    setPendingList((prev) =>
      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "approved" } : r))
    );
    setToastMessage(`에이전트 [${identity}] 승인 및 페어링(${code})이 완료되었습니다.`);
  };

  const handleDenyFromModal = (fingerprint: string, identity: string) => {
    setPendingList((prev) =>
      prev.map((r) => (r.fingerprint === fingerprint || r.identity === identity ? { ...r, status: "rejected" } : r))
    );
    setToastMessage(`에이전트 [${identity}] 등록 요청이 거절되었습니다.`);
  };

  const columns = [
    {
      key: "identity",
      header: "요청 에이전트 (Identity)",
      render: (item: PendingAgentRequest) => (
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.85rem" }}>🤖 {item.name}</div>
          <code style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>{item.identity}</code>
        </div>
      ),
    },
    {
      key: "groupName",
      header: "배속 희망 그룹",
      render: (item: PendingAgentRequest) => (
        <span style={{ fontWeight: 600, color: "var(--color-primary)", fontSize: "0.82rem" }}>
          {item.groupName}
        </span>
      ),
    },
    {
      key: "fingerprint",
      header: "제안된 Ed25519 공개키 지문",
      render: (item: PendingAgentRequest) => (
        <code style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)" }}>
          {item.fingerprint}
        </code>
      ),
    },
    {
      key: "status",
      header: "승인 상태",
      render: (item: PendingAgentRequest) => (
        <StatusBadge
          label={item.status === "pending" ? "대기 중" : item.status === "approved" ? "승인 완료" : "거절됨"}
          status={item.status === "pending" ? "pending" : item.status === "approved" ? "success" : "offline"}
          size="sm"
        />
      ),
    },
    {
      key: "actions",
      header: "인증 & 승인 액션",
      align: "right" as const,
      render: (item: PendingAgentRequest) => (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {item.status === "pending" ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setModalRequest(item)}
            >
              🔑 페어링 코드 발급 & 승인
            </Button>
          ) : (
            <span style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontStyle: "italic" }}>
              처리 완료
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
        subtitle="클라이언트 AI 에이전트의 자동 등록 요청 수신, 1회용 페어링 코드(Pairing Code) 발급 및 소유권 승인 (SPEC § 11.3)"
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
          🔄 클라이언트 주도 에이전트 등록 & 페어링 프로세스 (SPEC § 11.3)
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>1️⃣ AI 에이전트 요청</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              클라이언트 AI가 키쌍을 생성하고 <code>POST /api/v1/agents</code>로 신원 프로비저닝을 요청합니다.
            </p>
          </div>

          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>2️⃣ 실시간 사용자 알림</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              플랫폼에 로그인된 운영자에게 상단 🔔 알림으로 신규 에이전트 등록 요청이 도착합니다.
            </p>
          </div>

          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>3️⃣ 페어링 모달 & 코드 발급</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              알림 클릭 시 모달이 열리며 1회용 인증코드(<code>PAIR-XXXX</code>)를 발급받아 에이전트에 전달합니다.
            </p>
          </div>

          <div style={{ background: "var(--color-bg-surface-sub)", padding: 14, borderRadius: "var(--radius-lg)" }}>
            <div style={{ fontSize: "1.2rem", marginBottom: 6 }}>4️⃣ 소유권 확정 바인딩</div>
            <p style={{ fontSize: "0.78rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              에이전트가 코드를 <code>/pairing-codes/redeem</code>으로 제출하여 상호 검증 및 정식 활성화됩니다.
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
              🔑 즉시 페어링 코드(Pairing Code) 생성기
            </h3>
            <p style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginTop: 4 }}>
              특정 에이전트에 전달할 1회용 인증 토큰을 생성합니다 (<code>POST /api/v1/admin/pairing-codes</code>).
            </p>
          </div>

          <form onSubmit={handleGenerateCode} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input
              label="대상 에이전트 고유 식별자 (Agent Identity)"
              placeholder="예: agt_settlement_04"
              value={targetIdentity}
              onChange={(e) => setTargetIdentity(e.target.value)}
              helperText="에이전트가 연결할 정식 식별자를 입력하세요."
              required
            />

            <Button variant="primary" size="md" type="submit">
              ⚡ 1회용 페어링 코드 발급
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
                발급된 1회용 인증코드 (300s TTL)
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
                  {copied ? "✓ 복사됨" : "📋 코드 복사"}
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
            💻 클라이언트 에이전트 연동 명령어
          </h3>
          <p style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.4 }}>
            에이전트 호스트 환경에서 발급받은 코드를 제출하여 소유권을 확정합니다:
          </p>

          <CodeBlock
            title="에이전트 터미널 실행"
            language="bash"
            code={`# 발급받은 페어링 코드로 소유권 바인딩
curl -X POST http://localhost:3100/api/v1/pairing-codes/redeem \\
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
          📋 대기 중인 AI 에이전트 등록 요청 큐 ({pendingList.filter((p) => p.status === "pending").length}건 대기)
        </h3>
        <DataTable
          columns={columns}
          data={pendingList}
          keyExtractor={(item) => item.id}
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

