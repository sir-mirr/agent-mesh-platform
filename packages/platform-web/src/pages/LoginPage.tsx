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
        background: "radial-gradient(circle at 30% 30%, #075985 0%, #0C4A6E 35%, #0F172A 75%, #020617 100%)",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      {/* ── Futuristic Monochromatic Geometric Mesh with Path-following Data Bullets ── */}
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
            {/* Ambient Monochromatic Cyan-Sky Glow */}
            <radialGradient id="meshAmbientGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
            </radialGradient>

            {/* Glowing Bullet Filter */}
            <filter id="bulletGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* ── Explicit SVG Paths for Precise Motion Tracking ── */}
            {/* Left Triad Edges */}
            <path id="path_fin_to_pinja" d="M 180,180 L 320,310" />
            <path id="path_pinja_to_areum" d="M 320,310 L 160,460" />
            <path id="path_areum_to_fin" d="M 160,460 L 180,180" />
            <path id="path_fin_to_codex" d="M 180,180 L 380,110" />
            <path id="path_areum_to_claude" d="M 160,460 L 240,640" />
            <path id="path_claude_to_sentinel" d="M 240,640 L 390,720" />

            {/* Right Lattice Edges */}
            <path id="path_hub_to_workerA" d="M 1120,160 L 1260,260" />
            <path id="path_workerA_to_audit" d="M 1260,260 L 1180,440" />
            <path id="path_audit_to_relay" d="M 1180,440 L 1020,320" />
            <path id="path_relay_to_hub" d="M 1020,320 L 1120,160" />
            <path id="path_audit_to_workerB" d="M 1180,440 L 1340,560" />
            <path id="path_workerB_to_gateway" d="M 1340,560 L 1140,710" />
            <path id="path_gateway_to_vault" d="M 1140,710 L 1060,590" />
            <path id="path_vault_to_audit" d="M 1060,590 L 1180,440" />
            <path id="path_workerA_to_attestor" d="M 1260,260 L 1380,380" />
            <path id="path_attestor_to_workerB" d="M 1380,380 L 1340,560" />

            {/* Cross Galaxy Backbone Lines */}
            <path id="path_codex_to_hub" d="M 380,110 L 1120,160" />
            <path id="path_sentinel_to_vault" d="M 390,720 L 1060,590" />
          </defs>

          {/* Clean 3D Geometric Facets */}
          <polygon points="180,180 320,310 160,460" fill="url(#meshAmbientGlow)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.25" />
          <polygon points="1120,160 1260,260 1180,440" fill="url(#meshAmbientGlow)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.25" />
          <polygon points="1180,440 1340,560 1140,710" fill="url(#meshAmbientGlow)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.2" />

          {/* ── Render Monochromatic Connection Lines ── */}
          <use href="#path_fin_to_pinja" stroke="#38BDF8" strokeWidth="1.6" strokeDasharray="5 5" strokeOpacity="0.5" />
          <use href="#path_pinja_to_areum" stroke="#38BDF8" strokeWidth="1.6" strokeDasharray="5 5" strokeOpacity="0.5" />
          <use href="#path_areum_to_fin" stroke="#38BDF8" strokeWidth="1.6" strokeDasharray="5 5" strokeOpacity="0.5" />
          <use href="#path_fin_to_codex" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="4 4" strokeOpacity="0.4" />
          <use href="#path_areum_to_claude" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="4 4" strokeOpacity="0.4" />
          <use href="#path_claude_to_sentinel" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="4 4" strokeOpacity="0.4" />

          <use href="#path_hub_to_workerA" stroke="#38BDF8" strokeWidth="1.4" strokeDasharray="5 5" strokeOpacity="0.45" />
          <use href="#path_workerA_to_audit" stroke="#38BDF8" strokeWidth="1.6" strokeDasharray="5 5" strokeOpacity="0.5" />
          <use href="#path_audit_to_relay" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="4 4" strokeOpacity="0.4" />
          <use href="#path_relay_to_hub" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="4 4" strokeOpacity="0.4" />
          <use href="#path_audit_to_workerB" stroke="#38BDF8" strokeWidth="1.4" strokeDasharray="5 5" strokeOpacity="0.45" />
          <use href="#path_workerB_to_gateway" stroke="#38BDF8" strokeWidth="1.4" strokeDasharray="5 5" strokeOpacity="0.45" />
          <use href="#path_gateway_to_vault" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="4 4" strokeOpacity="0.4" />
          <use href="#path_vault_to_audit" stroke="#38BDF8" strokeWidth="1.2" strokeDasharray="4 4" strokeOpacity="0.4" />
          <use href="#path_workerA_to_attestor" stroke="#38BDF8" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.35" />
          <use href="#path_attestor_to_workerB" stroke="#38BDF8" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.35" />

          <use href="#path_codex_to_hub" stroke="#38BDF8" strokeWidth="0.8" strokeDasharray="4 8" strokeOpacity="0.25" />
          <use href="#path_sentinel_to_vault" stroke="#38BDF8" strokeWidth="0.8" strokeDasharray="4 8" strokeOpacity="0.25" />

          {/* ── Precise Path-Following Moving Data Bullets (<animateMotion>) ── */}
          {/* Left Circuit Bullets */}
          <circle r="3.5" fill="#38BDF8" filter="url(#bulletGlow)">
            <animateMotion dur="3.8s" repeatCount="indefinite">
              <mpath href="#path_fin_to_pinja" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#38BDF8" filter="url(#bulletGlow)">
            <animateMotion dur="4.2s" repeatCount="indefinite">
              <mpath href="#path_pinja_to_areum" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#38BDF8" filter="url(#bulletGlow)">
            <animateMotion dur="4.6s" repeatCount="indefinite">
              <mpath href="#path_areum_to_fin" />
            </animateMotion>
          </circle>
          <circle r="3" fill="#38BDF8" opacity="0.85">
            <animateMotion dur="5.2s" repeatCount="indefinite">
              <mpath href="#path_areum_to_claude" />
            </animateMotion>
          </circle>

          {/* Right Circuit Bullets */}
          <circle r="3.5" fill="#38BDF8" filter="url(#bulletGlow)">
            <animateMotion dur="4.0s" repeatCount="indefinite">
              <mpath href="#path_hub_to_workerA" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#38BDF8" filter="url(#bulletGlow)">
            <animateMotion dur="4.5s" repeatCount="indefinite">
              <mpath href="#path_workerA_to_audit" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#38BDF8" filter="url(#bulletGlow)">
            <animateMotion dur="4.8s" repeatCount="indefinite">
              <mpath href="#path_audit_to_workerB" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#38BDF8" filter="url(#bulletGlow)">
            <animateMotion dur="5.0s" repeatCount="indefinite">
              <mpath href="#path_workerB_to_gateway" />
            </animateMotion>
          </circle>
          <circle r="3" fill="#38BDF8" opacity="0.85">
            <animateMotion dur="4.4s" repeatCount="indefinite">
              <mpath href="#path_gateway_to_vault" />
            </animateMotion>
          </circle>

          {/* Cross Galaxy Bullets */}
          <circle r="3" fill="#BAE6FD" opacity="0.9">
            <animateMotion dur="8.5s" repeatCount="indefinite">
              <mpath href="#path_codex_to_hub" />
            </animateMotion>
          </circle>
          <circle r="3" fill="#BAE6FD" opacity="0.9">
            <animateMotion dur="9.2s" repeatCount="indefinite">
              <mpath href="#path_sentinel_to_vault" />
            </animateMotion>
          </circle>
        </svg>

        {/* ── LEFT FLANK: 3 Main Character Profile Avatars (Clean Monochromatic Name Tag) ── */}

        {/* 1. 핀둥이 (Top-Left) */}
        <CleanMainAgentNode
          x={180}
          y={180}
          imageSrc="/assets/agent-fin.png"
          name="핀둥이"
          animationClass="floatSlow1"
          animDuration="6.8s"
        />

        {/* 2. 핀자 (Middle-Left) */}
        <CleanMainAgentNode
          x={320}
          y={310}
          imageSrc="/assets/agent-support.png"
          name="핀자"
          animationClass="floatSlow2"
          animDuration="7.4s"
        />

        {/* 3. 아름이 (Bottom-Left) */}
        <CleanMainAgentNode
          x={160}
          y={460}
          imageSrc="/assets/agent-assistant.png"
          name="아름이"
          animationClass="floatSlow3"
          animDuration="8.2s"
        />

        {/* ── Left Ambient Monochromatic Small Circle Nodes (Name Only) ── */}
        <CleanSmallCircleNode
          x={380}
          y={110}
          name="Codex"
          size={16}
          animName="floatSlow2"
          animDuration="6.2s"
        />
        <CleanSmallCircleNode
          x={240}
          y={640}
          name="Claude"
          size={18}
          animName="floatSlow1"
          animDuration="7.0s"
        />
        <CleanSmallCircleNode
          x={390}
          y={720}
          name="Sentinel"
          size={14}
          animName="floatSlow3"
          animDuration="8.5s"
        />

        {/* ── RIGHT FLANK: Monochromatic Small Circle Nodes (Name Only, Varied Size) ── */}
        <CleanSmallCircleNode
          x={1120}
          y={160}
          name="Hub-01"
          size={22}
          animName="floatSlow2"
          animDuration="6.6s"
        />
        <CleanSmallCircleNode
          x={1260}
          y={260}
          name="Worker-A"
          size={18}
          animName="floatSlow1"
          animDuration="7.2s"
        />
        <CleanSmallCircleNode
          x={1020}
          y={320}
          name="Relay"
          size={14}
          animName="floatSlow3"
          animDuration="8.0s"
        />
        <CleanSmallCircleNode
          x={1180}
          y={440}
          name="Audit"
          size={24}
          animName="floatSlow2"
          animDuration="7.6s"
        />
        <CleanSmallCircleNode
          x={1380}
          y={380}
          name="Attestor"
          size={14}
          animName="floatSlow1"
          animDuration="6.4s"
        />
        <CleanSmallCircleNode
          x={1340}
          y={560}
          name="Worker-B"
          size={18}
          animName="floatSlow3"
          animDuration="7.8s"
        />
        <CleanSmallCircleNode
          x={1060}
          y={590}
          name="Vault"
          size={16}
          animName="floatSlow1"
          animDuration="6.9s"
        />
        <CleanSmallCircleNode
          x={1140}
          y={710}
          name="Gateway"
          size={20}
          animName="floatSlow2"
          animDuration="8.4s"
        />
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
          boxShadow: "0 25px 60px -15px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.9) inset",
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

/**
 * Monochromatic Clean Main Agent Node on Left Flank (핀둥이, 핀자, 아름이)
 */
function CleanMainAgentNode({
  x,
  y,
  imageSrc,
  name,
  animationClass,
  animDuration,
}: {
  x: number;
  y: number;
  imageSrc: string;
  name: string;
  animationClass: string;
  animDuration: string;
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
        animation: `${animationClass} ${animDuration} ease-in-out infinite`,
        zIndex: 2,
      }}
    >
      {/* Clean Monochromatic Avatar Frame */}
      <div
        style={{
          position: "relative",
          width: 58,
          height: 58,
          borderRadius: "50%",
          padding: 2.5,
          background: "#38BDF8",
          boxShadow: "0 0 16px rgba(56, 189, 248, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: "50%",
            overflow: "hidden",
            background: "#0F172A",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <img
            src={imageSrc}
            alt={name}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        </div>

        {/* Monochromatic Live Dot */}
        <span
          style={{
            position: "absolute",
            bottom: 2,
            right: 2,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#38BDF8",
            border: "2px solid #0F172A",
            boxShadow: "0 0 6px #38BDF8",
          }}
        />
      </div>

      {/* Clean Monochromatic Name Tag */}
      <span
        style={{
          fontSize: "0.78rem",
          fontWeight: 700,
          color: "#F8FAFC",
          background: "rgba(15, 23, 42, 0.8)",
          padding: "2px 8px",
          borderRadius: "var(--radius-full)",
          border: "1px solid rgba(56, 189, 248, 0.35)",
          whiteSpace: "nowrap",
          textShadow: "0 1px 3px rgba(0,0,0,0.6)",
        }}
      >
        {name}
      </span>
    </div>
  );
}

/**
 * Clean Monochromatic Small Circle Node (Name Only)
 */
function CleanSmallCircleNode({
  x,
  y,
  name,
  size = 18,
  animName,
  animDuration,
}: {
  x: number;
  y: number;
  name: string;
  size?: number;
  animName: string;
  animDuration: string;
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
        gap: 3,
        userSelect: "none",
        animation: `${animName} ${animDuration} ease-in-out infinite`,
        opacity: 0.92,
        zIndex: 2,
      }}
    >
      {/* Monochromatic Clean Circle */}
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

      {/* Name Only Label */}
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
