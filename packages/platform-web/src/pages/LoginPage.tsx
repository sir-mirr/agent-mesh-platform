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
        background: "radial-gradient(ellipse at 30% 30%, #075985 0%, #0C4A6E 35%, #0F172A 70%, #020617 100%)",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      {/* ── LEFT FLANK: Original Mockup 3-Agent Animated Constellation Triad ── */}
      <div
        className="hero-agents-constellation"
        style={{
          left: "max(5%, calc(50% - 580px))",
          top: "50%",
          transform: "translateY(-50%)",
        }}
      >
        {/* Constellation SVG Overlay with Flowing Packets */}
        <svg className="constellation-svg" viewBox="0 0 260 240">
          <defs>
            <linearGradient id="lineGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#34D399" stopOpacity="0.9" />
            </linearGradient>
            <linearGradient id="lineGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#34D399" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#C084FC" stopOpacity="0.9" />
            </linearGradient>
            <linearGradient id="lineGrad3" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#C084FC" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.9" />
            </linearGradient>
            <radialGradient id="meshCenterGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Center Glow Polygon */}
          <polygon points="48,40 200,70 120,180" fill="url(#meshCenterGlow)" />

          {/* Connecting Dashed Lines */}
          <line className="constellation-line" x1="48" y1="40" x2="200" y2="70" stroke="url(#lineGrad1)" />
          <line className="constellation-line" x1="200" y1="70" x2="120" y2="180" stroke="url(#lineGrad2)" />
          <line className="constellation-line" x1="120" y1="180" x2="48" y2="40" stroke="url(#lineGrad3)" />

          {/* Flowing Data Pulses (Mesh Packets) */}
          <circle className="mesh-packet packet-1" r="3.5" fill="#38BDF8" />
          <circle className="mesh-packet packet-2" r="3.5" fill="#34D399" />
          <circle className="mesh-packet packet-3" r="3.5" fill="#C084FC" />
        </svg>

        {/* 1. 핀둥이 (Top-Left) */}
        <div className="hero-agent-node agent-node-1" title="핀둥이 Agent">
          <div className="agent-glow-ring ring-blue" />
          <div className="agent-avatar-frame">
            <img src="/assets/agent-fin.png" alt="핀둥이" className="agent-avatar-img" />
          </div>
          <div className="agent-node-badge badge-blue">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#38BDF8", display: "inline-block" }} />
            핀둥이
          </div>
        </div>

        {/* 2. 핀자 (Top-Right) */}
        <div className="hero-agent-node agent-node-2" title="핀자 Agent">
          <div className="agent-glow-ring ring-emerald" />
          <div className="agent-avatar-frame">
            <img src="/assets/agent-support.png" alt="핀자" className="agent-avatar-img" />
          </div>
          <div className="agent-node-badge badge-emerald">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34D399", display: "inline-block" }} />
            핀자
          </div>
        </div>

        {/* 3. 아름이 (Bottom) */}
        <div className="hero-agent-node agent-node-3" title="아름이 Agent">
          <div className="agent-glow-ring ring-purple" />
          <div className="agent-avatar-frame">
            <img src="/assets/agent-assistant.png" alt="아름이" className="agent-avatar-img" />
          </div>
          <div className="agent-node-badge badge-purple">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#C084FC", display: "inline-block" }} />
            아름이
          </div>
        </div>
      </div>

      {/* ── RIGHT FLANK: Clean Monochromatic Geometric Satellite Mesh ── */}
      <div
        style={{
          position: "absolute",
          right: "max(4%, calc(50% - 600px))",
          top: "50%",
          transform: "translateY(-50%)",
          width: 280,
          height: 320,
          pointerEvents: "none",
        }}
      >
        <svg style={{ width: "100%", height: "100%", overflow: "visible" }} viewBox="0 0 280 320">
          <defs>
            <linearGradient id="rightLineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.2" />
            </linearGradient>
            <path id="right_path1" d="M 40,40 L 160,30" />
            <path id="right_path2" d="M 160,30 L 230,130" />
            <path id="right_path3" d="M 230,130 L 130,200" />
            <path id="right_path4" d="M 130,200 L 40,40" />
            <path id="right_path5" d="M 130,200 L 210,290" />
            <path id="right_path6" d="M 210,290 L 60,270" />
            <path id="right_path7" d="M 60,270 L 130,200" />
          </defs>

          {/* Geometric Wireframe Facets */}
          <polygon points="40,40 160,30 230,130 130,200" fill="rgba(56, 189, 248, 0.04)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.3" />
          <polygon points="130,200 210,290 60,270" fill="rgba(56, 189, 248, 0.04)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.3" />

          {/* Lines */}
          <use href="#right_path1" stroke="url(#rightLineGrad)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#right_path2" stroke="url(#rightLineGrad)" strokeWidth="1.4" strokeDasharray="4 4" />
          <use href="#right_path3" stroke="url(#rightLineGrad)" strokeWidth="1.4" strokeDasharray="4 4" />
          <use href="#right_path4" stroke="url(#rightLineGrad)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#right_path5" stroke="url(#rightLineGrad)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#right_path6" stroke="url(#rightLineGrad)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#right_path7" stroke="url(#rightLineGrad)" strokeWidth="1.2" strokeDasharray="4 4" />

          {/* Flowing Packets along Right Paths */}
          <circle r="3" fill="#38BDF8" opacity="0.9">
            <animateMotion dur="4.5s" repeatCount="indefinite">
              <mpath href="#right_path2" />
            </animateMotion>
          </circle>
          <circle r="3" fill="#38BDF8" opacity="0.9">
            <animateMotion dur="5.0s" repeatCount="indefinite">
              <mpath href="#right_path3" />
            </animateMotion>
          </circle>
          <circle r="3" fill="#38BDF8" opacity="0.8">
            <animateMotion dur="4.2s" repeatCount="indefinite">
              <mpath href="#right_path5" />
            </animateMotion>
          </circle>
        </svg>

        {/* Small Satellite Circles (Name Only) */}
        <RightSmallNode x={40} y={40} name="Hub-01" size={20} />
        <RightSmallNode x={160} y={30} name="Relay" size={15} />
        <RightSmallNode x={230} y={130} name="Audit" size={22} />
        <RightSmallNode x={130} y={200} name="Worker-A" size={17} />
        <RightSmallNode x={210} y={290} name="Gateway" size={19} />
        <RightSmallNode x={60} y={270} name="Vault" size={16} />
      </div>

      {/* ── Center Login Box (현재 가운데 박스 100% 유지) ── */}
      <div
        style={{
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(255, 255, 255, 0.7)",
          borderRadius: "var(--radius-xl)",
          padding: "40px 36px",
          width: "100%",
          maxWidth: 440,
          boxShadow: "0 25px 60px -15px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.9) inset",
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
              boxShadow: "0 6px 16px rgba(37, 99, 235, 0.35)",
            }}
          >
            M
          </div>
          <h1
            style={{
              fontSize: "1.4rem",
              fontWeight: 800,
              letterSpacing: "-0.03em",
              color: "var(--color-text-primary)",
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
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
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

function RightSmallNode({
  x,
  y,
  name,
  size,
}: {
  x: number;
  y: number;
  name: string;
  size: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 3,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "#38BDF8",
          boxShadow: "0 0 10px rgba(56, 189, 248, 0.6)",
          border: "1.5px solid rgba(255, 255, 255, 0.85)",
        }}
      />
      <span
        style={{
          fontSize: "0.68rem",
          fontWeight: 600,
          color: "#E2E8F0",
          textShadow: "0 1px 3px rgba(0, 0, 0, 0.8)",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
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
  boxShadow: "0 4px 12px rgba(37, 99, 235, 0.35)",
};
