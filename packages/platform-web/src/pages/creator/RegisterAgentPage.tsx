import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PageHeader,
  Button,
  Input,
  SubNavPills,
  CodeBlock,
  Toast,
} from "@/components/index.ts";

export function RegisterAgentPage() {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("grp_support");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const subNavItems = [
    { label: "내 에이전트", href: "/creator", icon: "🤖" },
    { label: "스웜 그룹 관리", href: "/creator/groups", icon: "👥" },
    { label: "스웜 토폴로지", href: "/creator/topology", icon: "🌐" },
    { label: "메시지 테스트", href: "/creator/playground", icon: "💬" },
    { label: "소켓리스 큐", href: "/creator/lease-queue", icon: "📥" },
    { label: "에이전트 등록", href: "/creator/register", icon: "➕" },
  ];

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId || !publicKey) return;

    setToastMessage(`에이전트 [${agentId}] 등록 요청이 성공적으로 완료되었습니다.`);
    setTimeout(() => {
      navigate("/creator");
    }, 1200);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SubNavPills items={subNavItems} />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="46"
        title="신규 에이전트 등록 & 키 제안"
        subtitle="신원 등록 및 Ed25519 공개키 제안 (SPEC § 9.1 3대 409 신원 충돌 방어)"
      />

      {toastMessage && (
        <Toast
          type="success"
          message={toastMessage}
          onClose={() => setToastMessage(null)}
        />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 24 }}>
        {/* Form */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: 24,
          }}
        >
          <form onSubmit={handleRegister} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Input
              label="에이전트 고유 식별자 (Agent ID)"
              placeholder="예: agt_settlement_04"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              helperText="소문자, 숫자, 밑줄(_)만 허용됩니다. 등록 후 변경할 수 없습니다."
              required
            />

            <Input
              label="에이전트 표시 이름"
              placeholder="예: Automated Settlement Agent"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              required
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--color-text-secondary)" }}>
                초기 배속 스웜 그룹
              </label>
              <select
                value={selectedGroup}
                onChange={(e) => setSelectedGroup(e.target.value)}
                style={{
                  padding: "9px 12px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-surface)",
                  fontSize: "0.88rem",
                  outline: "none",
                }}
              >
                <option value="grp_support">Support Swarm (고객 지원)</option>
                <option value="grp_billing">Billing Core (정산)</option>
                <option value="grp_analytics">Analytics Swarm (분석)</option>
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--color-text-secondary)" }}>
                Ed25519 공개키 (Base64-URL Encoded)
              </label>
              <textarea
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder="43자리 Ed25519 원시 공개키 문자열을 입력하세요"
                rows={3}
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.82rem",
                  background: "var(--color-bg-surface-sub)",
                  outline: "none",
                }}
                required
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
              <Button variant="secondary" size="md" type="button" onClick={() => navigate("/creator")}>
                취소
              </Button>
              <Button variant="primary" size="md" type="submit">
                에이전트 등록하기
              </Button>
            </div>
          </form>
        </div>

        {/* CLI Example Guide */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-xl)",
              padding: 20,
            }}
          >
            <h4 style={{ fontSize: "0.92rem", fontWeight: 700, marginBottom: 8 }}>
              💡 터미널 CLI로 키 생성 및 등록하기
            </h4>
            <p style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
              로컬에서 에이전트 키를 직접 생성하고 서명 표면을 프로비저닝할 수 있습니다:
            </p>

            <CodeBlock
              title="CLI 프로비저닝"
              language="bash"
              code={`# 1. Ed25519 키쌍 생성
bun run ops/bin/generate-keypair.ts

# 2. 에이전트 신원 등록
curl -X POST http://localhost:3100/api/v1/agents/provision \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id": "${agentId || "agt_sample"}", "public_key": "..."}'`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
