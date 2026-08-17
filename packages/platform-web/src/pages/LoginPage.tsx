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
        background: "radial-gradient(circle at 25% 30%, #0369A1 0%, #075985 30%, #0F172A 70%, #020617 100%)",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      {/* ── Futuristic 3D Geometric Mesh & Multi-layered Constellation ── */}
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
            {/* Holographic Glowing Gradients */}
            <linearGradient id="meshBlueCyan" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#818CF8" stopOpacity="0.4" />
            </linearGradient>
            <linearGradient id="meshCyanEmerald" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.5" />
            </linearGradient>
            <linearGradient id="meshPurpleBlue" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#A855F7" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.4" />
            </linearGradient>
            <linearGradient id="meshAmberCyan" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FBBF24" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.35" />
            </linearGradient>

            {/* Futuristic 3D Faceted Glow Polygons */}
            <radialGradient id="polyFacetLeft" cx="40%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.22" />
              <stop offset="60%" stopColor="#0284C7" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#0F172A" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="polyFacetRight" cx="60%" cy="50%" r="55%">
              <stop offset="0%" stopColor="#818CF8" stopOpacity="0.18" />
              <stop offset="60%" stopColor="#0369A1" stopOpacity="0.06" />
              <stop offset="100%" stopColor="#020617" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* 3D Wireframe / Tessellation Polygons */}
          <polygon points="180,180 320,310 160,460" fill="url(#polyFacetLeft)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.25" />
          <polygon points="160,460 320,310 240,640" fill="url(#polyFacetLeft)" stroke="#818CF8" strokeWidth="0.8" strokeOpacity="0.25" />
          <polygon points="180,180 380,110 320,310" fill="url(#polyFacetLeft)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.2" />

          {/* Right Wireframe Lattice */}
          <polygon points="1120,160 1260,260 1180,440" fill="url(#polyFacetRight)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.2" />
          <polygon points="1180,440 1340,560 1140,710" fill="url(#polyFacetRight)" stroke="#2DD4BF" strokeWidth="0.8" strokeOpacity="0.25" />
          <polygon points="1020,320 1180,440 1060,590" fill="url(#polyFacetRight)" stroke="#818CF8" strokeWidth="0.8" strokeOpacity="0.2" />
          <polygon points="1260,260 1380,380 1180,440" fill="url(#polyFacetRight)" stroke="#38BDF8" strokeWidth="0.8" strokeOpacity="0.15" />

          {/* Left Flank Primary Agent Connecting Lines (핀둥이 - 핀자 - 아름이 Triad) */}
          <line
            x1="180" y1="180" x2="320" y2="310"
            stroke="url(#meshBlueCyan)" strokeWidth="2.2" strokeDasharray="6 6"
            style={{ animation: "meshDash 12s linear infinite" }}
          />
          <line
            x1="320" y1="310" x2="160" y2="460"
            stroke="url(#meshCyanEmerald)" strokeWidth="2.2" strokeDasharray="6 6"
            style={{ animation: "meshDash 15s linear infinite reverse" }}
          />
          <line
            x1="160" y1="460" x2="180" y2="180"
            stroke="url(#meshPurpleBlue)" strokeWidth="2" strokeDasharray="6 6"
            style={{ animation: "meshDash 18s linear infinite" }}
          />

          {/* Left Secondary Satellite Web Lines */}
          <line x1="180" y1="180" x2="380" y2="110" stroke="url(#meshBlueCyan)" strokeWidth="1.2" strokeDasharray="4 4" style={{ animation: "meshDash 20s linear infinite" }} />
          <line x1="380" y1="110" x2="320" y2="310" stroke="url(#meshAmberCyan)" strokeWidth="1" strokeDasharray="4 4" />
          <line x1="160" y1="460" x2="240" y2="640" stroke="url(#meshCyanEmerald)" strokeWidth="1.4" strokeDasharray="5 5" style={{ animation: "meshDash 14s linear infinite" }} />
          <line x1="240" y1="640" x2="390" y2="720" stroke="url(#meshBlueCyan)" strokeWidth="1.2" strokeDasharray="4 4" />
          <line x1="320" y1="310" x2="240" y2="640" stroke="url(#meshPurpleBlue)" strokeWidth="1.2" strokeDasharray="5 5" opacity="0.6" />

          {/* Right Flank Satellite Mesh Lines */}
          <line
            x1="1120" y1="160" x2="1260" y2="260"
            stroke="url(#meshBlueCyan)" strokeWidth="1.6" strokeDasharray="5 5"
            style={{ animation: "meshDash 14s linear infinite" }}
          />
          <line
            x1="1260" y1="260" x2="1180" y2="440"
            stroke="url(#meshCyanEmerald)" strokeWidth="1.8" strokeDasharray="5 5"
            style={{ animation: "meshDash 17s linear infinite reverse" }}
          />
          <line
            x1="1180" y1="440" x2="1020" y2="320"
            stroke="url(#meshPurpleBlue)" strokeWidth="1.4" strokeDasharray="4 4"
            style={{ animation: "meshDash 19s linear infinite" }}
          />
          <line
            x1="1020" y1="320" x2="1120" y2="160"
            stroke="url(#meshBlueCyan)" strokeWidth="1.2" strokeDasharray="4 4"
          />
          <line
            x1="1180" y1="440" x2="1340" y2="560"
            stroke="url(#meshAmberCyan)" strokeWidth="1.6" strokeDasharray="5 5"
            style={{ animation: "meshDash 16s linear infinite" }}
          />
          <line
            x1="1340" y1="560" x2="1140" y2="710"
            stroke="url(#meshCyanEmerald)" strokeWidth="1.4" strokeDasharray="4 4"
            style={{ animation: "meshDash 13s linear infinite reverse" }}
          />
          <line
            x1="1140" y1="710" x2="1060" y2="590"
            stroke="url(#meshPurpleBlue)" strokeWidth="1.4" strokeDasharray="5 5"
            style={{ animation: "meshDash 18s linear infinite" }}
          />
          <line
            x1="1060" y1="590" x2="1180" y2="440"
            stroke="url(#meshBlueCyan)" strokeWidth="1.2" strokeDasharray="4 4"
          />
          <line x1="1260" y1="260" x2="1380" y2="380" stroke="url(#meshBlueCyan)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
          <line x1="1380" y1="380" x2="1340" y2="560" stroke="url(#meshAmberCyan)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />

          {/* Across Center Ambient Bridge Lines (Under Login Card) */}
          <line x1="380" y1="110" x2="1120" y2="160" stroke="url(#meshBlueCyan)" strokeWidth="0.8" strokeDasharray="4 8" opacity="0.3" />
          <line x1="320" y1="310" x2="1020" y2="320" stroke="url(#meshCyanEmerald)" strokeWidth="0.8" strokeDasharray="4 8" opacity="0.25" />
          <line x1="390" y1="720" x2="1060" y2="590" stroke="url(#meshPurpleBlue)" strokeWidth="0.8" strokeDasharray="4 8" opacity="0.3" />

          {/* Glowing Shimmering Mesh Particles */}
          <circle cx="180" cy="180" r="3.5" fill="#38BDF8" style={{ animation: "pulseDot 3s ease-in-out infinite" }} />
          <circle cx="320" cy="310" r="4" fill="#818CF8" style={{ animation: "pulseDot 3.6s ease-in-out infinite 0.4s" }} />
          <circle cx="160" cy="460" r="4" fill="#2DD4BF" style={{ animation: "pulseDot 4s ease-in-out infinite 0.8s" }} />
          <circle cx="380" cy="110" r="2.5" fill="#38BDF8" style={{ animation: "pulseDot 2.8s ease-in-out infinite 1.2s" }} />
          <circle cx="240" cy="640" r="3" fill="#A855F7" style={{ animation: "pulseDot 3.2s ease-in-out infinite 0.6s" }} />
          <circle cx="1120" cy="160" r="3" fill="#38BDF8" style={{ animation: "pulseDot 3.4s ease-in-out infinite 0.3s" }} />
          <circle cx="1260" cy="260" r="3.5" fill="#2DD4BF" style={{ animation: "pulseDot 3.8s ease-in-out infinite 0.9s" }} />
          <circle cx="1180" cy="440" r="4" fill="#818CF8" style={{ animation: "pulseDot 4.2s ease-in-out infinite 1.5s" }} />
          <circle cx="1340" cy="560" r="3" fill="#FBBF24" style={{ animation: "pulseDot 3s ease-in-out infinite 0.7s" }} />
          <circle cx="1140" cy="710" r="3.5" fill="#2DD4BF" style={{ animation: "pulseDot 3.5s ease-in-out infinite 1.1s" }} />
        </svg>

        {/* ── LEFT FLANK: 3 Main Character Profile Avatars (Name Only) ── */}

        {/* 1. 핀둥이 (Top-Left) */}
        <MainAgent3DNode
          x={180}
          y={180}
          imageSrc="/assets/agent-fin.png"
          name="핀둥이"
          ringColor="#38BDF8"
          animationClass="floatSlow1"
          animDuration="6.8s"
        />

        {/* 2. 핀자 (Middle-Left) */}
        <MainAgent3DNode
          x={320}
          y={310}
          imageSrc="/assets/agent-support.png"
          name="핀자"
          ringColor="#818CF8"
          animationClass="floatSlow2"
          animDuration="7.4s"
        />

        {/* 3. 아름이 (Bottom-Left) */}
        <MainAgent3DNode
          x={160}
          y={460}
          imageSrc="/assets/agent-assistant.png"
          name="아름이"
          ringColor="#2DD4BF"
          animationClass="floatSlow3"
          animDuration="8.2s"
        />

        {/* ── Left Ambient Small Circle Nodes (Name Only) ── */}
        <SmallMeshCircleNode
          x={380}
          y={110}
          name="Codex"
          size={18}
          color="#38BDF8"
          animName="floatSlow2"
          animDuration="6.2s"
        />
        <SmallMeshCircleNode
          x={240}
          y={640}
          name="Claude"
          size={20}
          color="#A855F7"
          animName="floatSlow1"
          animDuration="7.0s"
        />
        <SmallMeshCircleNode
          x={390}
          y={720}
          name="Sentinel"
          size={16}
          color="#38BDF8"
          animName="floatSlow3"
          animDuration="8.5s"
        />

        {/* ── RIGHT FLANK: Ambient Small Circle Nodes (Name Only, Varied Sizes) ── */}
        <SmallMeshCircleNode
          x={1120}
          y={160}
          name="Hub-01"
          size={22}
          color="#38BDF8"
          animName="floatSlow2"
          animDuration="6.6s"
        />
        <SmallMeshCircleNode
          x={1260}
          y={260}
          name="Worker-A"
          size={18}
          color="#2DD4BF"
          animName="floatSlow1"
          animDuration="7.2s"
        />
        <SmallMeshCircleNode
          x={1020}
          y={320}
          name="Relay"
          size={16}
          color="#818CF8"
          animName="floatSlow3"
          animDuration="8.0s"
        />
        <SmallMeshCircleNode
          x={1180}
          y={440}
          name="Audit"
          size={24}
          color="#38BDF8"
          animName="floatSlow2"
          animDuration="7.6s"
        />
        <SmallMeshCircleNode
          x={1380}
          y={380}
          name="Attestor"
          size={14}
          color="#38BDF8"
          animName="floatSlow1"
          animDuration="6.4s"
        />
        <SmallMeshCircleNode
          x={1340}
          y={560}
          name="Worker-B"
          size={20}
          color="#FBBF24"
          animName="floatSlow3"
          animDuration="7.8s"
        />
        <SmallMeshCircleNode
          x={1060}
          y={590}
          name="Vault"
          size={18}
          color="#A855F7"
          animName="floatSlow1"
          animDuration="6.9s"
        />
        <SmallMeshCircleNode
          x={1140}
          y={710}
          name="Gateway"
          size={22}
          color="#2DD4BF"
          animName="floatSlow2"
          animDuration="8.4s"
        />
      </div>

      {/* ── Center Login Box (현재 가운데 박스 100% 유지) ── */}
      <div
        style={{
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(255, 255, 255, 0.6)",
          borderRadius: "var(--radius-xl)",
          padding: "40px 36px",
          width: "100%",
          maxWidth: 440,
          boxShadow: "0 25px 60px -15px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.9) inset",
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
 * 3D Main Avatar Profile Node on Left Flank (핀둥이, 핀자, 아름이) — Name Only
 */
function MainAgent3DNode({
  x,
  y,
  imageSrc,
  name,
  ringColor,
  animationClass,
  animDuration,
}: {
  x: number;
  y: number;
  imageSrc: string;
  name: string;
  ringColor: string;
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
      {/* Avatar with Volumetric Glowing Ring */}
      <div
        style={{
          position: "relative",
          width: 62,
          height: 62,
          borderRadius: "50%",
          padding: 3,
          background: `linear-gradient(135deg, ${ringColor}, #FFFFFF)`,
          boxShadow: `0 8px 24px ${ringColor}60, 0 0 24px ${ringColor}45`,
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
            boxShadow: "0 0 8px #10B981",
          }}
        />
      </div>

      {/* Name Only Pill Badge */}
      <div
        style={{
          background: "rgba(15, 23, 42, 0.75)",
          backdropFilter: "blur(8px)",
          border: `1px solid ${ringColor}60`,
          borderRadius: "var(--radius-full)",
          padding: "2px 10px",
          display: "flex",
          alignItems: "center",
          gap: 4,
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: ringColor,
            display: "inline-block",
            boxShadow: `0 0 6px ${ringColor}`,
          }}
        />
        <strong style={{ fontSize: "0.78rem", color: "#F8FAFC", fontWeight: 700 }}>
          {name}
        </strong>
      </div>
    </div>
  );
}

/**
 * Small Geometric Circle Node (Name Only, Varied Size)
 */
function SmallMeshCircleNode({
  x,
  y,
  name,
  size = 18,
  color,
  animName,
  animDuration,
}: {
  x: number;
  y: number;
  name: string;
  size?: number;
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
        gap: 4,
        userSelect: "none",
        animation: `${animName} ${animDuration} ease-in-out infinite`,
        opacity: 0.9,
        zIndex: 2,
      }}
    >
      {/* Small Glowing Circle */}
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: `radial-gradient(circle at 35% 35%, #FFFFFF 0%, ${color} 70%)`,
          boxShadow: `0 0 14px ${color}90, 0 0 6px ${color}`,
          border: "1.5px solid rgba(255, 255, 255, 0.7)",
        }}
      />

      {/* Name Only Label */}
      <span
        style={{
          fontSize: "0.68rem",
          fontWeight: 700,
          color: "rgba(241, 245, 249, 0.85)",
          textShadow: "0 1px 4px rgba(0, 0, 0, 0.6)",
          whiteSpace: "nowrap",
          letterSpacing: "0.02em",
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
