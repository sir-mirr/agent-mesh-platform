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
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-bg-page)",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      {/* ── Background Geometric Constellation & Connected Agent Network ── */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
          overflow: "hidden",
        }}
        aria-hidden="true"
      >
        <svg
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            top: 0,
            left: 0,
          }}
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            {/* Gradients */}
            <linearGradient id="lineGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#2563EB" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.3" />
            </linearGradient>
            <linearGradient id="lineGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#7C3AED" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#059669" stopOpacity="0.4" />
            </linearGradient>
            <linearGradient id="lineGrad3" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#059669" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#2563EB" stopOpacity="0.45" />
            </linearGradient>
            <linearGradient id="lineGrad4" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#2563EB" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#0284C7" stopOpacity="0.3" />
            </linearGradient>

            {/* Ambient center polygon glows */}
            <radialGradient id="meshGlowLeft" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="meshGlowRight" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Polygons */}
          <polygon points="180,220 320,120 280,380" fill="url(#meshGlowLeft)" />
          <polygon points="1120,160 1280,280 1180,480" fill="url(#meshGlowRight)" />
          <polygon points="280,380 440,540 180,680" fill="url(#meshGlowLeft)" />
          <polygon points="1180,480 1320,680 1020,640" fill="url(#meshGlowRight)" />

          {/* Left Flank Constellation Lines */}
          <line x1="180" y1="220" x2="320" y2="120" stroke="url(#lineGrad1)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="320" y1="120" x2="280" y2="380" stroke="url(#lineGrad2)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="280" y1="380" x2="180" y2="220" stroke="url(#lineGrad3)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="280" y1="380" x2="440" y2="540" stroke="url(#lineGrad1)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="440" y1="540" x2="180" y2="680" stroke="url(#lineGrad2)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="180" y1="680" x2="280" y2="380" stroke="url(#lineGrad3)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="440" y1="540" x2="490" y2="450" stroke="url(#lineGrad4)" strokeWidth="1" strokeDasharray="4 4" />

          {/* Right Flank Constellation Lines */}
          <line x1="1120" y1="160" x2="1280" y2="280" stroke="url(#lineGrad1)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="1280" y1="280" x2="1180" y2="480" stroke="url(#lineGrad2)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="1180" y1="480" x2="1120" y2="160" stroke="url(#lineGrad3)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="1180" y1="480" x2="1320" y2="680" stroke="url(#lineGrad1)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="1320" y1="680" x2="1020" y2="640" stroke="url(#lineGrad2)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="1020" y1="640" x2="1180" y2="480" stroke="url(#lineGrad3)" strokeWidth="1.5" strokeDasharray="6 5" />
          <line x1="1020" y1="640" x2="950" y2="450" stroke="url(#lineGrad4)" strokeWidth="1" strokeDasharray="4 4" />

          {/* Cross Mesh Links */}
          <line x1="320" y1="120" x2="1120" y2="160" stroke="url(#lineGrad4)" strokeWidth="1" strokeDasharray="4 8" opacity="0.4" />
          <line x1="440" y1="540" x2="1020" y2="640" stroke="url(#lineGrad4)" strokeWidth="1" strokeDasharray="4 8" opacity="0.4" />

          {/* Glowing Geometric Pulse Dots */}
          <circle cx="180" cy="220" r="4" fill="#2563EB" opacity="0.9" />
          <circle cx="320" cy="120" r="5" fill="#7C3AED" opacity="0.9" />
          <circle cx="280" cy="380" r="4" fill="#059669" opacity="0.9" />
          <circle cx="440" cy="540" r="4.5" fill="#2563EB" opacity="0.8" />
          <circle cx="180" cy="680" r="4" fill="#0284C7" opacity="0.8" />

          <circle cx="1120" cy="160" r="4.5" fill="#7C3AED" opacity="0.9" />
          <circle cx="1280" cy="280" r="4" fill="#059669" opacity="0.9" />
          <circle cx="1180" cy="480" r="5" fill="#2563EB" opacity="0.9" />
          <circle cx="1320" cy="680" r="4" fill="#7C3AED" opacity="0.8" />
          <circle cx="1020" cy="640" r="4.5" fill="#059669" opacity="0.8" />
        </svg>

        {/* ── Left Geometric Agent Nodes ── */}
        <AgentNode
          x={180}
          y={220}
          icon="🤖"
          name="Fin둥이"
          role="Billing Swarm"
          color="#2563EB"
        />
        <AgentNode
          x={320}
          y={120}
          icon="⚡"
          name="Support Bot"
          role="Support Swarm"
          color="#7C3AED"
        />
        <AgentNode
          x={280}
          y={380}
          icon="🔍"
          name="Analytics Lead"
          role="Market Swarm"
          color="#059669"
        />
        <AgentNode
          x={180}
          y={680}
          icon="🛡️"
          name="Security Hub"
          role="Trust Fabric"
          color="#0284C7"
        />

        {/* ── Right Geometric Agent Nodes ── */}
        <AgentNode
          x={1120}
          y={160}
          icon="🔑"
          name="Key Attestor"
          role="Ed25519 CA"
          color="#7C3AED"
        />
        <AgentNode
          x={1280}
          y={280}
          icon="📥"
          name="Lease Worker"
          role="Socketless 300s"
          color="#059669"
        />
        <AgentNode
          x={1180}
          y={480}
          icon="🌐"
          name="Mesh Hub"
          role="Cluster Primary"
          color="#2563EB"
        />
        <AgentNode
          x={1020}
          y={640}
          icon="📊"
          name="Audit Forensic"
          role="SPEC § 11.0"
          color="#059669"
        />
      </div>

      {/* ── Center Login Box (현재 가운데 박스 유지) ── */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: "40px 36px",
          width: "100%",
          maxWidth: 440,
          boxShadow: "0 20px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04)",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          position: "relative",
          zIndex: 10,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
              color: "white",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.4rem",
              fontWeight: 900,
              marginBottom: 12,
            }}
          >
            M
          </div>
          <h1
            style={{
              fontSize: "1.4rem",
              fontWeight: 800,
              letterSpacing: "-0.03em",
            }}
          >
            Agent Mesh Platform
          </h1>
          <p
            style={{
              fontSize: "0.85rem",
              color: "var(--color-text-secondary)",
              marginTop: 4,
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
    </div>
  );
}

function AgentNode({
  x,
  y,
  icon,
  name,
  role,
  color,
}: {
  x: number;
  y: number;
  icon: string;
  name: string;
  role: string;
  color: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${(x / 1440) * 100}%`,
        top: `${(y / 900) * 100}%`,
        transform: "translate(-50%, -50%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        userSelect: "none",
        opacity: 0.85,
        filter: "drop-shadow(0 4px 12px rgba(15, 23, 42, 0.08))",
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: "var(--color-bg-surface)",
          border: `2px solid ${color}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1.2rem",
          boxShadow: `0 0 16px ${color}25`,
        }}
      >
        {icon}
      </div>

      <div
        style={{
          background: "rgba(255, 255, 255, 0.92)",
          backdropFilter: "blur(4px)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-full)",
          padding: "2px 8px",
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: "0.7rem",
          fontWeight: 700,
          color: "var(--color-text-primary)",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: color,
            display: "inline-block",
          }}
        />
        <span>{name}</span>
        <span style={{ color: "var(--color-text-muted)", fontSize: "0.65rem", fontWeight: 500 }}>
          ({role})
        </span>
      </div>
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
