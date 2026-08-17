import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext.tsx";
import type { UserRole } from "@/types/auth.ts";

export function LoginPage() {
  const navigate = useNavigate();
  const { loginWithLocal, loginWithGitHub } = useAuth();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [selectedRole, setSelectedRole] = useState<UserRole>("PLATFORM_ADMIN");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await loginWithLocal(username, password, selectedRole);
    navigate("/dashboard");
  };

  const handleGitHubLogin = () => {
    loginWithGitHub();
    navigate("/dashboard");
  };

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "radial-gradient(ellipse at 50% 0%, #EFF6FF 0%, #F8FAFC 60%, #F1F5F9 100%)",
        color: "var(--color-text-primary)",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflowX: "hidden",
      }}
    >
      {/* ── Global Top Navigation Header ── */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 32px",
          background: "rgba(255, 255, 255, 0.9)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-xs)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "0.95rem",
              fontWeight: 900,
            }}
          >
            M
          </div>
          <span style={{ fontWeight: 800, fontSize: "1.05rem", letterSpacing: "-0.02em" }}>
            Agent Mesh Platform
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 8px",
              borderRadius: "var(--radius-full)",
              background: "#ECFDF5",
              color: "#059669",
              fontSize: "0.72rem",
              fontWeight: 700,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#10B981",
                display: "inline-block",
              }}
            />
            v0.3 Live (SPEC 0.2)
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <a
            href="http://localhost:3005/ia.html"
            target="_blank"
            rel="noreferrer"
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius-md)",
              background: "var(--color-primary-light)",
              border: "1px solid var(--color-primary)",
              color: "var(--color-primary)",
              fontSize: "0.82rem",
              fontWeight: 700,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            🗺️ IA 정보구조도
          </a>
          <a
            href="http://localhost:3005/index.html"
            target="_blank"
            rel="noreferrer"
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius-md)",
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text-secondary)",
              fontSize: "0.82rem",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            🗂 All-in-One Hub
          </a>
        </div>
      </header>

      {/* ── Main Hero Section ── */}
      <main
        style={{
          flex: 1,
          maxWidth: 1200,
          margin: "0 auto",
          padding: "40px 24px 60px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
          gap: 36,
        }}
      >
        {/* Hero Headline */}
        <div style={{ textAlign: "center", maxWidth: 740 }}>
          <span
            style={{
              display: "inline-block",
              padding: "4px 14px",
              borderRadius: "var(--radius-full)",
              background: "var(--color-primary-light)",
              border: "1px solid var(--color-primary-border, #BFDBFE)",
              color: "var(--color-primary)",
              fontSize: "0.8rem",
              fontWeight: 800,
              marginBottom: 14,
              letterSpacing: "0.02em",
            }}
          >
            THE AUTONOMOUS AGENT FABRIC · SPEC 0.2
          </span>
          <h1
            style={{
              fontSize: "2.4rem",
              fontWeight: 900,
              letterSpacing: "-0.04em",
              lineHeight: 1.2,
              color: "var(--color-text-primary)",
            }}
          >
            Next-Gen Multi-Agent Messaging Backbone & Cryptographic Trust Fabric
          </h1>
          <p
            style={{
              fontSize: "1rem",
              color: "var(--color-text-secondary)",
              marginTop: 12,
              lineHeight: 1.6,
            }}
          >
            간헐적·소켓리스 AI 에이전트 간의 단대단 암호학적 서명 검증, 영구 데몬 없는 신뢰 라우팅 및 불변 감사 포렌식을 제공합니다.
          </p>
        </div>

        {/* ── Center Login Box (현재 가운데 박스 유지) ── */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: "36px 32px",
            width: "100%",
            maxWidth: 440,
            boxShadow: "0 20px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04)",
            display: "flex",
            flexDirection: "column",
            gap: 20,
            position: "relative",
            zIndex: 10,
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
                color: "white",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.3rem",
                fontWeight: 900,
                marginBottom: 10,
              }}
            >
              M
            </div>
            <h2
              style={{
                fontSize: "1.35rem",
                fontWeight: 800,
                letterSpacing: "-0.03em",
              }}
            >
              Agent Mesh Platform
            </h2>
            <p
              style={{
                fontSize: "0.85rem",
                color: "var(--color-text-secondary)",
                marginTop: 2,
              }}
            >
              단일 로그인 및 RBAC 통합 관리 게이트웨이
            </p>
          </div>

          {/* GitHub OAuth Button */}
          <button
            type="button"
            onClick={handleGitHubLogin}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: "11px 16px",
              borderRadius: "var(--radius-md)",
              background: "#24292f",
              color: "white",
              fontWeight: 700,
              fontSize: "0.9rem",
              border: "none",
              cursor: "pointer",
              transition: "background 0.15s ease",
            }}
          >
            <GitHubIcon />
            GitHub 계정으로 계속하기
          </button>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              color: "var(--color-text-muted)",
              fontSize: "0.8rem",
            }}
          >
            <hr
              style={{
                flex: 1,
                border: "none",
                borderTop: "1px solid var(--color-border)",
              }}
            />
            또는 로컬 계정
            <hr
              style={{
                flex: 1,
                border: "none",
                borderTop: "1px solid var(--color-border)",
              }}
            />
          </div>

          {/* Local ID/PW Form */}
          <form
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
            onSubmit={handleSubmit}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={labelStyle}>아이디 (ID)</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                style={inputStyle}
                required
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={labelStyle}>비밀번호 (Password)</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                style={inputStyle}
                required
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={labelStyle}>시뮬레이션 역할 (RBAC Role)</label>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as UserRole)}
                style={inputStyle}
              >
                <option value="PLATFORM_ADMIN">👑 플랫폼 관리자 (Platform Admin - 전체 메뉴)</option>
                <option value="TENANT_ADMIN">🏢 테넌트 관리자 (Tenant Admin - 테넌트 메뉴 노출)</option>
                <option value="GROUP_ADMIN">👥 그룹 관리자 (Group Admin - 스웜 그룹 관리)</option>
                <option value="AGENT_OPERATOR">🤖 일반 에이전트 운영자 (Agent Operator - 관리자 메뉴 은닉)</option>
              </select>
            </div>

            <button type="submit" style={btnPrimaryStyle}>
              로그인하기
            </button>
          </form>

          <p
            style={{
              fontSize: "0.75rem",
              color: "var(--color-text-muted)",
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            단일 계정(Single ID) 체계로, 선택된 역할에 따라 사이드바 메뉴가 자동으로 동적 활성화/은닉됩니다.
          </p>
        </div>

        {/* ── Bottom 3 Feature Highlights ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 20,
            width: "100%",
            marginTop: 10,
          }}
        >
          <FeatureCard
            icon="⚡"
            title="소켓리스 비동기 메시징"
            description="상시 데몬 없이 At-Least-Once 보증의 300초 TTL 리스 큐를 통해 간헐적 AI 워커가 필요 시 온디맨드로 메시지를 수신합니다."
          />
          <FeatureCard
            icon="🔒"
            title="암호학적 신원 & 서명 검증"
            description="Ed25519 공개키 지문 1:1 대조 및 운영자 거버넌스 승인 절차를 거친 검증된 에이전트만 메시지에 참여합니다."
          />
          <FeatureCard
            icon="📜"
            title="불변 감사 & 프라이버시 경계"
            description="SPEC § 11.0 기준에 따라 audit.read.content 권한 미보유 시 본문 유출을 완전 차단([content withheld])합니다."
          />
        </div>
      </main>

      {/* ── Footer ── */}
      <footer
        style={{
          borderTop: "1px solid var(--color-border)",
          padding: "20px 24px",
          textAlign: "center",
          fontSize: "0.78rem",
          color: "var(--color-text-muted)",
          background: "var(--color-bg-surface)",
        }}
      >
        Agent Mesh Platform · Spec 0.2 Specification · Light Theme Enterprise System
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "22px 20px",
        boxShadow: "var(--shadow-xs)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: "1.6rem" }}>{icon}</div>
      <h3 style={{ fontSize: "0.98rem", fontWeight: 800, color: "var(--color-text-primary)" }}>
        {title}
      </h3>
      <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)", lineHeight: 1.55 }}>
        {description}
      </p>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 700,
  color: "var(--color-text-secondary)",
};

const inputStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-border-strong)",
  fontSize: "0.88rem",
  fontFamily: "inherit",
  outline: "none",
  background: "var(--color-bg-surface-sub)",
  color: "var(--color-text-primary)",
};

const btnPrimaryStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "11px 16px",
  borderRadius: "var(--radius-md)",
  background: "var(--color-primary)",
  color: "white",
  fontWeight: 700,
  fontSize: "0.92rem",
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
};
