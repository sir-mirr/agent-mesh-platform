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
        background: "radial-gradient(circle at 25% 35%, #0369A1 0%, #075985 28%, #0F172A 70%, #020617 100%)",
        position: "relative",
        overflow: "hidden",
        padding: 24,
      }}
    >
      {/* ── Rich Futuristic Constellation Mesh Across Entire Screen ── */}
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
            {/* Glow Gradients */}
            <linearGradient id="edgeGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#34D399" stopOpacity="0.65" />
            </linearGradient>
            <linearGradient id="edgeGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#34D399" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#C084FC" stopOpacity="0.65" />
            </linearGradient>
            <linearGradient id="edgeGrad3" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#C084FC" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.65" />
            </linearGradient>
            <linearGradient id="edgeSubtle" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.15" />
            </linearGradient>

            <radialGradient id="meshPolygonGlow1" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="meshPolygonGlow2" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#34D399" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#34D399" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="meshPolygonGlow3" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#C084FC" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#C084FC" stopOpacity="0" />
            </radialGradient>

            {/* Glowing Motion Packet Filter */}
            <filter id="packetGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* ── Motion Paths for Flowing Data Packets ── */}
            {/* Left Core Triad (핀둥이 - 핀자 - 아름이) */}
            <path id="p_fin_pinja" d="M 180,260 L 330,360" />
            <path id="p_pinja_areum" d="M 330,360 L 220,530" />
            <path id="p_areum_fin" d="M 220,530 L 180,260" />

            {/* Left Satellite Edges */}
            <path id="p_top_fin" d="M 120,120 L 180,260" />
            <path id="p_top_pinja" d="M 290,140 L 330,360" />
            <path id="p_top1_top2" d="M 120,120 L 290,140" />
            <path id="p_fin_midleft" d="M 70,390 L 180,260" />
            <path id="p_midleft_areum" d="M 70,390 L 220,530" />
            <path id="p_areum_botleft" d="M 220,530 L 130,710" />
            <path id="p_areum_botmid" d="M 220,530 L 310,720" />
            <path id="p_botleft_botmid" d="M 130,710 L 310,720" />
            <path id="p_pinja_botmid" d="M 330,360 L 310,720" />

            {/* Right Web Edges */}
            <path id="p_r_top1_r_top2" d="M 1120,130 L 1280,180" />
            <path id="p_r_top2_r_midright" d="M 1280,180 L 1360,340" />
            <path id="p_r_top1_r_mid" d="M 1120,130 L 1210,320" />
            <path id="p_r_mid_r_midright" d="M 1210,320 L 1360,340" />
            <path id="p_r_mid_r_inner" d="M 1210,320 L 1080,410" />
            <path id="p_r_top1_r_inner" d="M 1120,130 L 1080,410" />
            <path id="p_r_inner_r_lowmid" d="M 1080,410 L 1180,560" />
            <path id="p_r_midright_r_lowright" d="M 1360,340 L 1310,540" />
            <path id="p_r_mid_r_lowright" d="M 1210,320 L 1310,540" />
            <path id="p_r_lowmid_r_lowright" d="M 1180,560 L 1310,540" />
            <path id="p_r_lowmid_r_bot1" d="M 1180,560 L 1090,720" />
            <path id="p_r_lowmid_r_bot2" d="M 1180,560 L 1260,730" />
            <path id="p_r_lowright_r_bot2" d="M 1310,540 L 1260,730" />
            <path id="p_r_bot1_r_bot2" d="M 1090,720 L 1260,730" />

            {/* Cross Screen Connecting Bridges (Behind Card) */}
            <path id="p_bridge_top" d="M 290,140 L 1120,130" />
            <path id="p_bridge_mid" d="M 330,360 L 1080,410" />
            <path id="p_bridge_low" d="M 310,720 L 1090,720" />
          </defs>

          {/* 3D Geometric Polygonal Meshes (Left Triad & Right Web) */}
          <polygon points="180,260 330,360 220,530" fill="url(#meshPolygonGlow1)" />
          <polygon points="120,120 290,140 180,260" fill="url(#meshPolygonGlow2)" />
          <polygon points="70,390 180,260 220,530" fill="url(#meshPolygonGlow1)" />
          <polygon points="220,530 130,710 310,720" fill="url(#meshPolygonGlow3)" />

          <polygon points="1120,130 1280,180 1210,320" fill="url(#meshPolygonGlow1)" />
          <polygon points="1280,180 1360,340 1210,320" fill="url(#meshPolygonGlow2)" />
          <polygon points="1120,130 1210,320 1080,410" fill="url(#meshPolygonGlow3)" />
          <polygon points="1080,410 1210,320 1180,560" fill="url(#meshPolygonGlow1)" />
          <polygon points="1210,320 1360,340 1310,540" fill="url(#meshPolygonGlow2)" />
          <polygon points="1180,560 1310,540 1260,730" fill="url(#meshPolygonGlow1)" />
          <polygon points="1080,410 1180,560 1090,720" fill="url(#meshPolygonGlow3)" />

          {/* ── Render Lines ── */}
          {/* Left Core Lines */}
          <use href="#p_fin_pinja" stroke="url(#edgeGrad1)" strokeWidth="1.8" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
          <use href="#p_pinja_areum" stroke="url(#edgeGrad2)" strokeWidth="1.8" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
          <use href="#p_areum_fin" stroke="url(#edgeGrad3)" strokeWidth="1.8" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />

          {/* Left Satellite Lines */}
          <use href="#p_top_fin" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_top_pinja" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_top1_top2" stroke="url(#edgeSubtle)" strokeWidth="1" strokeDasharray="4 4" />
          <use href="#p_fin_midleft" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_midleft_areum" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_areum_botleft" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_areum_botmid" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_botleft_botmid" stroke="url(#edgeSubtle)" strokeWidth="1" strokeDasharray="4 4" />
          <use href="#p_pinja_botmid" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />

          {/* Right Web Lines */}
          <use href="#p_r_top1_r_top2" stroke="url(#edgeSubtle)" strokeWidth="1.3" strokeDasharray="4 4" />
          <use href="#p_r_top2_r_midright" stroke="url(#edgeSubtle)" strokeWidth="1.3" strokeDasharray="4 4" />
          <use href="#p_r_top1_r_mid" stroke="url(#edgeGrad1)" strokeWidth="1.5" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
          <use href="#p_r_mid_r_midright" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_r_mid_r_inner" stroke="url(#edgeGrad2)" strokeWidth="1.5" strokeDasharray="5 4" style={{ animation: "constellationDash 18s linear infinite reverse" }} />
          <use href="#p_r_top1_r_inner" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_r_inner_r_lowmid" stroke="url(#edgeGrad3)" strokeWidth="1.5" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
          <use href="#p_r_midright_r_lowright" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_r_mid_r_lowright" stroke="url(#edgeSubtle)" strokeWidth="1.3" strokeDasharray="4 4" />
          <use href="#p_r_lowmid_r_lowright" stroke="url(#edgeSubtle)" strokeWidth="1.3" strokeDasharray="4 4" />
          <use href="#p_r_lowmid_r_bot1" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_r_lowmid_r_bot2" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_r_lowright_r_bot2" stroke="url(#edgeSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
          <use href="#p_r_bot1_r_bot2" stroke="url(#edgeSubtle)" strokeWidth="1" strokeDasharray="4 4" />

          {/* Cross Galaxy Bridge Lines */}
          <use href="#p_bridge_top" stroke="url(#edgeSubtle)" strokeWidth="0.8" strokeDasharray="4 8" opacity="0.3" />
          <use href="#p_bridge_mid" stroke="url(#edgeSubtle)" strokeWidth="0.8" strokeDasharray="4 8" opacity="0.3" />
          <use href="#p_bridge_low" stroke="url(#edgeSubtle)" strokeWidth="0.8" strokeDasharray="4 8" opacity="0.3" />

          {/* ── Flowing Data Packets Moving Strictly along Paths ── */}
          {/* Left Flow */}
          <circle r="3.5" fill="#38BDF8" filter="url(#packetGlow)">
            <animateMotion dur="3.8s" repeatCount="indefinite">
              <mpath href="#p_fin_pinja" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#34D399" filter="url(#packetGlow)">
            <animateMotion dur="4.2s" repeatCount="indefinite">
              <mpath href="#p_pinja_areum" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#C084FC" filter="url(#packetGlow)">
            <animateMotion dur="4.6s" repeatCount="indefinite">
              <mpath href="#p_areum_fin" />
            </animateMotion>
          </circle>
          <circle r="2.5" fill="#38BDF8" opacity="0.8">
            <animateMotion dur="5.5s" repeatCount="indefinite">
              <mpath href="#p_top_fin" />
            </animateMotion>
          </circle>
          <circle r="2.5" fill="#34D399" opacity="0.8">
            <animateMotion dur="5.0s" repeatCount="indefinite">
              <mpath href="#p_areum_botmid" />
            </animateMotion>
          </circle>

          {/* Right Flow */}
          <circle r="3.5" fill="#38BDF8" filter="url(#packetGlow)">
            <animateMotion dur="4.0s" repeatCount="indefinite">
              <mpath href="#p_r_top1_r_mid" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#34D399" filter="url(#packetGlow)">
            <animateMotion dur="4.5s" repeatCount="indefinite">
              <mpath href="#p_r_mid_r_inner" />
            </animateMotion>
          </circle>
          <circle r="3.5" fill="#C084FC" filter="url(#packetGlow)">
            <animateMotion dur="4.8s" repeatCount="indefinite">
              <mpath href="#p_r_inner_r_lowmid" />
            </animateMotion>
          </circle>
          <circle r="2.5" fill="#38BDF8" opacity="0.85">
            <animateMotion dur="5.2s" repeatCount="indefinite">
              <mpath href="#p_r_lowmid_r_bot2" />
            </animateMotion>
          </circle>

          {/* Bridge Flow */}
          <circle r="3" fill="#BAE6FD" opacity="0.9">
            <animateMotion dur="9.0s" repeatCount="indefinite">
              <mpath href="#p_bridge_mid" />
            </animateMotion>
          </circle>
        </svg>

        {/* ── LEFT FLANK: 3 Named Character Agents with Concentric Glowing Rings ── */}

        {/* 1. 핀둥이 (Top-Left) */}
        <div
          className="hero-agent-node"
          style={{
            left: 180,
            top: 260,
            transform: "translate(-50%, -50%)",
            animation: "floatNode1 6s ease-in-out infinite",
          }}
          title="핀둥이"
        >
          <div style={{ position: "relative", width: 54, height: 54, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div className="agent-glow-ring ring-blue" />
            <div className="agent-avatar-frame">
              <img src="/assets/agent-fin.png" alt="핀둥이" className="agent-avatar-img" />
            </div>
          </div>
          <div className="agent-node-badge badge-blue">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#38BDF8", display: "inline-block" }} />
            핀둥이
          </div>
        </div>

        {/* 2. 핀자 (Middle-Right of Left Flank) */}
        <div
          className="hero-agent-node"
          style={{
            left: 330,
            top: 360,
            transform: "translate(-50%, -50%)",
            animation: "floatNode2 6.8s ease-in-out infinite 0.9s",
          }}
          title="핀자"
        >
          <div style={{ position: "relative", width: 54, height: 54, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div className="agent-glow-ring ring-emerald" />
            <div className="agent-avatar-frame">
              <img src="/assets/agent-support.png" alt="핀자" className="agent-avatar-img" />
            </div>
          </div>
          <div className="agent-node-badge badge-emerald">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34D399", display: "inline-block" }} />
            핀자
          </div>
        </div>

        {/* 3. 아름이 (Bottom of Left Flank) */}
        <div
          className="hero-agent-node"
          style={{
            left: 220,
            top: 530,
            transform: "translate(-50%, -50%)",
            animation: "floatNode3 6.4s ease-in-out infinite 1.8s",
          }}
          title="아름이"
        >
          <div style={{ position: "relative", width: 54, height: 54, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div className="agent-glow-ring ring-purple" />
            <div className="agent-avatar-frame">
              <img src="/assets/agent-assistant.png" alt="아름이" className="agent-avatar-img" />
            </div>
          </div>
          <div className="agent-node-badge badge-purple">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#C084FC", display: "inline-block" }} />
            아름이
          </div>
        </div>

        {/* ── Ambient Geometric Nodes (Pure Small Dots - NO Names/Text) ── */}
        {/* Left Side Ambient Dots */}
        <PureDotNode x={120} y={120} size={14} color="#38BDF8" />
        <PureDotNode x={290} y={140} size={16} color="#38BDF8" />
        <PureDotNode x={70} y={390} size={12} color="#34D399" />
        <PureDotNode x={130} y={710} size={14} color="#38BDF8" />
        <PureDotNode x={310} y={720} size={16} color="#C084FC" />

        {/* Right Side Ambient Dots */}
        <PureDotNode x={1120} y={130} size={18} color="#38BDF8" />
        <PureDotNode x={1280} y={180} size={14} color="#38BDF8" />
        <PureDotNode x={1360} y={340} size={13} color="#34D399" />
        <PureDotNode x={1210} y={320} size={18} color="#38BDF8" />
        <PureDotNode x={1080} y={410} size={20} color="#38BDF8" />
        <PureDotNode x={1310} y={540} size={15} color="#34D399" />
        <PureDotNode x={1180} y={560} size={19} color="#C084FC" />
        <PureDotNode x={1090} y={720} size={16} color="#38BDF8" />
        <PureDotNode x={1260} y={730} size={15} color="#34D399" />
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

/**
 * Pure Minimalist Geometric Dot Node (NO text/names)
 */
function PureDotNode({
  x,
  y,
  size,
  color,
}: {
  x: number;
  y: number;
  size: number;
  color: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 ${size * 0.8}px ${color}`,
        border: "1.5px solid rgba(255, 255, 255, 0.85)",
        zIndex: 2,
      }}
    />
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
