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
        background: "radial-gradient(ellipse at 50% 40%, #FFFFFF 0%, #F8FAFC 60%, #EEF2F6 100%)",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      {/* ── 3D Geometric Constellation & Flowing Animated Mesh ── */}
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
              <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.6" />
            </linearGradient>
            <linearGradient id="lineGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#10B981" stopOpacity="0.7" />
            </linearGradient>
            <linearGradient id="lineGrad3" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#10B981" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.75" />
            </linearGradient>
            <linearGradient id="lineGrad4" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#F59E0B" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#EC4899" stopOpacity="0.6" />
            </linearGradient>

            {/* Ambient Radial Glow Polygons */}
            <radialGradient id="glowTriadLeft" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="glowTriadRight" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#10B981" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#10B981" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Volumetric Center Polygons */}
          <polygon points="210,210 340,110 240,460" fill="url(#glowTriadLeft)" />
          <polygon points="1180,180 1310,320 1140,520" fill="url(#glowTriadRight)" />
          <polygon points="240,460 380,680 140,720" fill="url(#glowTriadLeft)" />

          {/* Animated Flowing SVG Dashed Lines */}
          <line
            x1="210" y1="210" x2="340" y2="110"
            stroke="url(#lineGrad1)" strokeWidth="2" strokeDasharray="6 6"
            style={{ animation: "meshDash 14s linear infinite" }}
          />
          <line
            x1="340" y1="110" x2="240" y2="460"
            stroke="url(#lineGrad2)" strokeWidth="2" strokeDasharray="6 6"
            style={{ animation: "meshDash 18s linear infinite reverse" }}
          />
          <line
            x1="240" y1="460" x2="210" y2="210"
            stroke="url(#lineGrad3)" strokeWidth="2" strokeDasharray="6 6"
            style={{ animation: "meshDash 16s linear infinite" }}
          />
          <line
            x1="240" y1="460" x2="380" y2="680"
            stroke="url(#lineGrad1)" strokeWidth="1.8" strokeDasharray="5 5"
            style={{ animation: "meshDash 20s linear infinite" }}
          />
          <line
            x1="380" y1="680" x2="140" y2="720"
            stroke="url(#lineGrad2)" strokeWidth="1.8" strokeDasharray="5 5"
            style={{ animation: "meshDash 15s linear infinite reverse" }}
          />
          <line
            x1="140" y1="720" x2="240" y2="460"
            stroke="url(#lineGrad3)" strokeWidth="1.8" strokeDasharray="5 5"
            style={{ animation: "meshDash 17s linear infinite" }}
          />

          {/* Right Flank Lines */}
          <line
            x1="1180" y1="180" x2="1310" y2="320"
            stroke="url(#lineGrad1)" strokeWidth="2" strokeDasharray="6 6"
            style={{ animation: "meshDash 14s linear infinite" }}
          />
          <line
            x1="1310" y1="320" x2="1140" y2="520"
            stroke="url(#lineGrad2)" strokeWidth="2" strokeDasharray="6 6"
            style={{ animation: "meshDash 19s linear infinite reverse" }}
          />
          <line
            x1="1140" y1="520" x2="1180" y2="180"
            stroke="url(#lineGrad3)" strokeWidth="2" strokeDasharray="6 6"
            style={{ animation: "meshDash 16s linear infinite" }}
          />
          <line
            x1="1140" y1="520" x2="1280" y2="710"
            stroke="url(#lineGrad4)" strokeWidth="1.8" strokeDasharray="5 5"
            style={{ animation: "meshDash 21s linear infinite" }}
          />
          <line
            x1="1280" y1="710" x2="1010" y2="670"
            stroke="url(#lineGrad2)" strokeWidth="1.8" strokeDasharray="5 5"
            style={{ animation: "meshDash 13s linear infinite reverse" }}
          />
          <line
            x1="1010" y1="670" x2="1140" y2="520"
            stroke="url(#lineGrad1)" strokeWidth="1.8" strokeDasharray="5 5"
            style={{ animation: "meshDash 18s linear infinite" }}
          />

          {/* Cross Galaxy Link Lines */}
          <line x1="340" y1="110" x2="1180" y2="180" stroke="url(#lineGrad1)" strokeWidth="1" strokeDasharray="4 8" opacity="0.35" />
          <line x1="380" y1="680" x2="1010" y2="670" stroke="url(#lineGrad3)" strokeWidth="1" strokeDasharray="4 8" opacity="0.35" />

          {/* Luminous Pulsing Particles */}
          <circle cx="210" cy="210" r="4" fill="#3B82F6" style={{ animation: "pulseDot 3s ease-in-out infinite" }} />
          <circle cx="340" cy="110" r="4.5" fill="#8B5CF6" style={{ animation: "pulseDot 3.5s ease-in-out infinite 0.5s" }} />
          <circle cx="240" cy="460" r="5" fill="#10B981" style={{ animation: "pulseDot 4s ease-in-out infinite 1s" }} />
          <circle cx="1180" cy="180" r="5" fill="#8B5CF6" style={{ animation: "pulseDot 3.2s ease-in-out infinite 0.3s" }} />
          <circle cx="1310" cy="320" r="4.5" fill="#10B981" style={{ animation: "pulseDot 3.8s ease-in-out infinite 0.8s" }} />
          <circle cx="1140" cy="520" r="5" fill="#3B82F6" style={{ animation: "pulseDot 4.2s ease-in-out infinite 1.2s" }} />
        </svg>

        {/* ── 3D Avatar Profile Agent Nodes with Natural Floating ── */}

        {/* 1. 핀둥이 (Fin둥이 - Shiba Financial Lead) */}
        <Agent3DNode
          x={210}
          y={210}
          imageSrc="/assets/agent-fin.png"
          name="핀둥이"
          role="Billing Swarm Lead"
          badgeColor="#2563EB"
          animationClass="floatSlow1"
          animDuration="6.8s"
        />

        {/* 2. 핀자 (Support Specialist) */}
        <Agent3DNode
          x={1180}
          y={180}
          imageSrc="/assets/agent-support.png"
          name="핀자"
          role="Support Swarm"
          badgeColor="#8B5CF6"
          animationClass="floatSlow2"
          animDuration="7.4s"
        />

        {/* 3. 아름이 (Swarm Assistant / Orchestrator) */}
        <Agent3DNode
          x={240}
          y={460}
          imageSrc="/assets/agent-assistant.png"
          name="아름이"
          role="Swarm Orchestrator"
          badgeColor="#10B981"
          animationClass="floatSlow3"
          animDuration="8.2s"
        />

        {/* 4. Secondary Node: Security Key Attestor */}
        <GeometricSatelliteNode
          x={340}
          y={110}
          icon="🔑"
          name="Key Attestor"
          role="Ed25519 CA"
          color="#7C3AED"
          animName="floatSlow2"
          animDuration="6.2s"
        />

        {/* 5. Secondary Node: Socketless Lease Worker */}
        <GeometricSatelliteNode
          x={1310}
          y={320}
          icon="📥"
          name="Lease Worker"
          role="300s TTL Queue"
          color="#059669"
          animName="floatSlow1"
          animDuration="7.0s"
        />

        {/* 6. Secondary Node: Mesh Primary Hub */}
        <GeometricSatelliteNode
          x={1140}
          y={520}
          icon="🌐"
          name="Mesh Hub"
          role="Primary Fabric"
          color="#2563EB"
          animName="floatSlow3"
          animDuration="8.0s"
        />

        {/* 7. Secondary Node: Audit Forensic Engine */}
        <GeometricSatelliteNode
          x={380}
          y={680}
          icon="📊"
          name="Audit Forensic"
          role="SPEC § 11.0"
          color="#0284C7"
          animName="floatSlow1"
          animDuration="6.5s"
        />
      </div>

      {/* ── Center Login Box (현재 가운데 박스 100% 유지) ── */}
      <div
        style={{
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(16px)",
          border: "1px solid rgba(226, 232, 240, 0.8)",
          borderRadius: "var(--radius-xl)",
          padding: "40px 36px",
          width: "100%",
          maxWidth: 440,
          boxShadow: "0 25px 50px -12px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(255, 255, 255, 0.8) inset",
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
            boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
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
 * 3D Avatar Profile Node (핀둥이, 핀자, 아름이)
 */
function Agent3DNode({
  x,
  y,
  imageSrc,
  name,
  role,
  badgeColor,
  animationClass,
  animDuration,
}: {
  x: number;
  y: number;
  imageSrc: string;
  name: string;
  role: string;
  badgeColor: string;
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
        gap: 8,
        userSelect: "none",
        animation: `${animationClass} ${animDuration} ease-in-out infinite`,
        perspective: 1000,
        zIndex: 2,
      }}
    >
      {/* Avatar with Volumetric Glowing Ring */}
      <div
        style={{
          position: "relative",
          width: 64,
          height: 64,
          borderRadius: "50%",
          padding: 3,
          background: `linear-gradient(135deg, ${badgeColor}, #FFFFFF)`,
          boxShadow: `0 8px 24px ${badgeColor}35, 0 0 20px ${badgeColor}25`,
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
            background: "#FFFFFF",
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
            onError={(e) => {
              // Fallback to cute robot if image is missing
              (e.target as HTMLElement).style.display = "none";
            }}
          />
        </div>

        {/* Live Active Dot */}
        <span
          style={{
            position: "absolute",
            bottom: 2,
            right: 2,
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#10B981",
            border: "2px solid #FFFFFF",
            boxShadow: "0 0 6px #10B981",
          }}
        />
      </div>

      {/* Glassmorphic Node Badge */}
      <div
        style={{
          background: "rgba(255, 255, 255, 0.94)",
          backdropFilter: "blur(8px)",
          border: `1px solid ${badgeColor}35`,
          borderRadius: "var(--radius-full)",
          padding: "3px 12px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          boxShadow: "0 4px 14px rgba(15, 23, 42, 0.08)",
          whiteSpace: "nowrap",
        }}
      >
        <strong style={{ fontSize: "0.78rem", color: "var(--color-text-primary)" }}>
          {name}
        </strong>
        <span style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", fontWeight: 500 }}>
          · {role}
        </span>
      </div>
    </div>
  );
}

/**
 * Geometric Supporting Satellite Node
 */
function GeometricSatelliteNode({
  x,
  y,
  icon,
  name,
  role,
  color,
  animName,
  animDuration,
}: {
  x: number;
  y: number;
  icon: string;
  name: string;
  role: string;
  color: string;
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
        gap: 6,
        userSelect: "none",
        animation: `${animName} ${animDuration} ease-in-out infinite`,
        opacity: 0.85,
        zIndex: 2,
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
          boxShadow: `0 6px 16px ${color}25`,
        }}
      >
        {icon}
      </div>

      <div
        style={{
          background: "rgba(255, 255, 255, 0.90)",
          backdropFilter: "blur(6px)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-full)",
          padding: "2px 8px",
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: "0.68rem",
          fontWeight: 700,
          color: "var(--color-text-primary)",
          whiteSpace: "nowrap",
          boxShadow: "0 2px 8px rgba(15, 23, 42, 0.05)",
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
        <span style={{ color: "var(--color-text-muted)", fontSize: "0.62rem", fontWeight: 500 }}>
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
  boxShadow: "0 4px 12px rgba(37, 99, 235, 0.35)",
};
