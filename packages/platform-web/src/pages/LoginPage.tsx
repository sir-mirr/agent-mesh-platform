import React from "react";

export function LoginPage() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        width: "100vw",
        background: "radial-gradient(circle at 30% 35%, #0369A1 0%, #075985 25%, #0F172A 65%, #020617 100%)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* ── Global Fullscreen Interactive Constellation Mesh ── */}
      <svg
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          top: 0,
          left: 0,
          pointerEvents: "none",
        }}
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* Gradients */}
          <linearGradient id="gBlueCyan" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#34D399" stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id="gCyanPurple" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#34D399" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#C084FC" stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id="gPurpleBlue" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#C084FC" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id="gSubtle" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.2" />
          </linearGradient>

          {/* Polygon Ambient Glow */}
          <radialGradient id="polyGlowBlue" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="polyGlowEmerald" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#34D399" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#34D399" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="polyGlowPurple" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#C084FC" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#C084FC" stopOpacity="0" />
          </radialGradient>

          {/* Glowing Filter for Traveling Message Packets */}
          <filter id="packetGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* ── Network Interconnect Path Definitions ── */}
          {/* Left Core Triad */}
          <path id="e_fin_pinja" d="M 200,280 L 360,400" />
          <path id="e_pinja_areum" d="M 360,400 L 240,580" />
          <path id="e_areum_fin" d="M 240,580 L 200,280" />

          {/* Left Wing Interconnections */}
          <path id="e_n4_fin" d="M 100,160 L 200,280" />
          <path id="e_n4_n5" d="M 100,160 L 320,160" />
          <path id="e_n5_fin" d="M 320,160 L 200,280" />
          <path id="e_n5_n6" d="M 320,160 L 480,220" />
          <path id="e_n6_pinja" d="M 480,220 L 360,400" />
          <path id="e_n7_fin" d="M 120,440 L 200,280" />
          <path id="e_n7_areum" d="M 120,440 L 240,580" />
          <path id="e_areum_n8" d="M 240,580 L 460,480" />
          <path id="e_pinja_n8" d="M 360,400 L 460,480" />
          <path id="e_areum_n25" d="M 240,580 L 160,740" />
          <path id="e_areum_n26" d="M 240,580 L 380,760" />
          <path id="e_n25_n26" d="M 160,740 L 380,760" />
          <path id="e_n8_n26" d="M 460,480 L 380,760" />

          {/* Center Mesh Interconnections */}
          <path id="e_n6_n9" d="M 480,220 L 620,280" />
          <path id="e_n9_n10" d="M 620,280 L 720,450" />
          <path id="e_n8_n10" d="M 460,480 L 720,450" />
          <path id="e_n8_n11" d="M 460,480 L 600,620" />
          <path id="e_n10_n11" d="M 720,450 L 600,620" />
          <path id="e_n26_n11" d="M 380,760 L 600,620" />
          <path id="e_n9_n12" d="M 620,280 L 800,240" />
          <path id="e_n12_n13" d="M 800,240 L 880,400" />
          <path id="e_n10_n13" d="M 720,450 L 880,400" />
          <path id="e_n10_n14" d="M 720,450 L 760,660" />
          <path id="e_n11_n14" d="M 600,620 L 760,660" />
          <path id="e_n13_n15" d="M 880,400 L 960,580" />
          <path id="e_n14_n15" d="M 760,660 L 960,580" />

          {/* Right Wing Interconnections */}
          <path id="e_n12_n16" d="M 800,240 L 980,180" />
          <path id="e_n16_n17" d="M 980,180 L 1160,140" />
          <path id="e_n17_n18" d="M 1160,140 L 1320,220" />
          <path id="e_n16_n19" d="M 980,180 L 1140,340" />
          <path id="e_n17_n19" d="M 1160,140 L 1140,340" />
          <path id="e_n18_n20" d="M 1320,220 L 1280,420" />
          <path id="e_n19_n20" d="M 1140,340 L 1280,420" />
          <path id="e_n13_n19" d="M 880,400 L 1140,340" />
          <path id="e_n15_n22" d="M 960,580 L 1120,560" />
          <path id="e_n19_n22" d="M 1140,340 L 1120,560" />
          <path id="e_n20_n21" d="M 1280,420 L 1380,520" />
          <path id="e_n21_n23" d="M 1380,520 L 1260,680" />
          <path id="e_n22_n23" d="M 1120,560 L 1260,680" />
          <path id="e_n15_n24" d="M 960,580 L 1040,740" />
          <path id="e_n22_n24" d="M 1120,560 L 1040,740" />
          <path id="e_n23_n24" d="M 1260,680 L 1040,740" />
          <path id="e_n14_n24" d="M 760,660 L 1040,740" />
        </defs>

        {/* ── Geometric Facet Polygons ── */}
        <polygon points="200,280 360,400 240,580" fill="url(#polyGlowBlue)" />
        <polygon points="100,160 320,160 200,280" fill="url(#polyGlowEmerald)" />
        <polygon points="320,160 480,220 360,400" fill="url(#polyGlowPurple)" />
        <polygon points="120,440 200,280 240,580" fill="url(#polyGlowBlue)" />
        <polygon points="240,580 360,400 460,480" fill="url(#polyGlowEmerald)" />
        <polygon points="240,580 160,740 380,760" fill="url(#polyGlowPurple)" />

        <polygon points="480,220 620,280 720,450 460,480" fill="url(#polyGlowBlue)" />
        <polygon points="460,480 720,450 600,620" fill="url(#polyGlowEmerald)" />
        <polygon points="620,280 800,240 880,400 720,450" fill="url(#polyGlowPurple)" />
        <polygon points="720,450 880,400 960,580 760,660" fill="url(#polyGlowBlue)" />
        <polygon points="600,620 720,450 760,660" fill="url(#polyGlowEmerald)" />

        <polygon points="800,240 980,180 1140,340 880,400" fill="url(#polyGlowBlue)" />
        <polygon points="980,180 1160,140 1140,340" fill="url(#polyGlowPurple)" />
        <polygon points="1160,140 1320,220 1280,420 1140,340" fill="url(#polyGlowEmerald)" />
        <polygon points="880,400 1140,340 1120,560 960,580" fill="url(#polyGlowBlue)" />
        <polygon points="1140,340 1280,420 1380,520 1260,680 1120,560" fill="url(#polyGlowEmerald)" />
        <polygon points="960,580 1120,560 1260,680 1040,740" fill="url(#polyGlowPurple)" />

        {/* ── Render Connected Lines ── */}
        {/* Left Primary Loop */}
        <use href="#e_fin_pinja" stroke="url(#gBlueCyan)" strokeWidth="1.8" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
        <use href="#e_pinja_areum" stroke="url(#gCyanPurple)" strokeWidth="1.8" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
        <use href="#e_areum_fin" stroke="url(#gPurpleBlue)" strokeWidth="1.8" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />

        {/* Left Network */}
        <use href="#e_n4_fin" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n4_n5" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n5_fin" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n5_n6" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n6_pinja" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n7_fin" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n7_areum" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_areum_n8" stroke="url(#gSubtle)" strokeWidth="1.4" strokeDasharray="4 4" />
        <use href="#e_pinja_n8" stroke="url(#gSubtle)" strokeWidth="1.4" strokeDasharray="4 4" />
        <use href="#e_areum_n25" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_areum_n26" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n25_n26" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n8_n26" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />

        {/* Center Network */}
        <use href="#e_n6_n9" stroke="url(#gBlueCyan)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 18s linear infinite" }} />
        <use href="#e_n9_n10" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n8_n10" stroke="url(#gCyanPurple)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 17s linear infinite reverse" }} />
        <use href="#e_n8_n11" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n10_n11" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n26_n11" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n9_n12" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n12_n13" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n10_n13" stroke="url(#gPurpleBlue)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
        <use href="#e_n10_n14" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n11_n14" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n13_n15" stroke="url(#gBlueCyan)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 19s linear infinite" }} />
        <use href="#e_n14_n15" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />

        {/* Right Network */}
        <use href="#e_n12_n16" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n16_n17" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n17_n18" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n16_n19" stroke="url(#gBlueCyan)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
        <use href="#e_n17_n19" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n18_n20" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n19_n20" stroke="url(#gCyanPurple)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 15s linear infinite" }} />
        <use href="#e_n13_n19" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n15_n22" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n19_n22" stroke="url(#gPurpleBlue)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 18s linear infinite reverse" }} />
        <use href="#e_n20_n21" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n21_n23" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n22_n23" stroke="url(#gBlueCyan)" strokeWidth="1.4" strokeDasharray="5 4" style={{ animation: "constellationDash 16s linear infinite" }} />
        <use href="#e_n15_n24" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n22_n24" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n23_n24" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />
        <use href="#e_n14_n24" stroke="url(#gSubtle)" strokeWidth="1.2" strokeDasharray="4 4" />

        {/* ── Traveling Message Packets Moving Strictly Along Lines ── */}
        {/* Left Core Bullets */}
        <circle r="3.5" fill="#38BDF8" filter="url(#packetGlow)">
          <animateMotion dur="3.8s" repeatCount="indefinite">
            <mpath href="#e_fin_pinja" />
          </animateMotion>
        </circle>
        <circle r="3.5" fill="#34D399" filter="url(#packetGlow)">
          <animateMotion dur="4.2s" repeatCount="indefinite">
            <mpath href="#e_pinja_areum" />
          </animateMotion>
        </circle>
        <circle r="3.5" fill="#C084FC" filter="url(#packetGlow)">
          <animateMotion dur="4.6s" repeatCount="indefinite">
            <mpath href="#e_areum_fin" />
          </animateMotion>
        </circle>
        <circle r="2.5" fill="#38BDF8" opacity="0.85">
          <animateMotion dur="5.0s" repeatCount="indefinite">
            <mpath href="#e_n4_fin" />
          </animateMotion>
        </circle>
        <circle r="2.5" fill="#34D399" opacity="0.85">
          <animateMotion dur="4.8s" repeatCount="indefinite">
            <mpath href="#e_areum_n26" />
          </animateMotion>
        </circle>

        {/* Center Bullets */}
        <circle r="3.2" fill="#38BDF8" filter="url(#packetGlow)">
          <animateMotion dur="5.5s" repeatCount="indefinite">
            <mpath href="#e_n6_n9" />
          </animateMotion>
        </circle>
        <circle r="3.2" fill="#34D399" filter="url(#packetGlow)">
          <animateMotion dur="4.4s" repeatCount="indefinite">
            <mpath href="#e_n8_n10" />
          </animateMotion>
        </circle>
        <circle r="3.2" fill="#C084FC" filter="url(#packetGlow)">
          <animateMotion dur="5.2s" repeatCount="indefinite">
            <mpath href="#e_n10_n13" />
          </animateMotion>
        </circle>
        <circle r="2.8" fill="#38BDF8" opacity="0.9">
          <animateMotion dur="4.6s" repeatCount="indefinite">
            <mpath href="#e_n10_n14" />
          </animateMotion>
        </circle>

        {/* Right Bullets */}
        <circle r="3.5" fill="#38BDF8" filter="url(#packetGlow)">
          <animateMotion dur="4.2s" repeatCount="indefinite">
            <mpath href="#e_n16_n19" />
          </animateMotion>
        </circle>
        <circle r="3.5" fill="#34D399" filter="url(#packetGlow)">
          <animateMotion dur="4.7s" repeatCount="indefinite">
            <mpath href="#e_n19_n20" />
          </animateMotion>
        </circle>
        <circle r="3.5" fill="#C084FC" filter="url(#packetGlow)">
          <animateMotion dur="4.9s" repeatCount="indefinite">
            <mpath href="#e_n19_n22" />
          </animateMotion>
        </circle>
        <circle r="3.0" fill="#38BDF8" filter="url(#packetGlow)">
          <animateMotion dur="4.5s" repeatCount="indefinite">
            <mpath href="#e_n22_n23" />
          </animateMotion>
        </circle>
        <circle r="2.5" fill="#34D399" opacity="0.85">
          <animateMotion dur="5.6s" repeatCount="indefinite">
            <mpath href="#e_n14_n24" />
          </animateMotion>
        </circle>
      </svg>

      {/* ── 3 Main Named Agents on Left Flank (핀둥이 · 핀자 · 아름이) ── */}

      {/* 1. 핀둥이 */}
      <div
        className="hero-agent-node"
        style={{
          position: "absolute",
          left: 200,
          top: 280,
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

      {/* 2. 핀자 */}
      <div
        className="hero-agent-node"
        style={{
          position: "absolute",
          left: 360,
          top: 400,
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

      {/* 3. 아름이 */}
      <div
        className="hero-agent-node"
        style={{
          position: "absolute",
          left: 240,
          top: 580,
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

      {/* ── Connected Ambient Dots (NO Names, Floating Animations) ── */}
      {/* Left Wing Connected Nodes */}
      <FloatingConnectedDot x={100} y={160} size={15} anim="floatNode1" dur="6.2s" />
      <FloatingConnectedDot x={320} y={160} size={17} anim="floatNode2" dur="6.8s" />
      <FloatingConnectedDot x={480} y={220} size={18} anim="floatNode3" dur="7.2s" />
      <FloatingConnectedDot x={120} y={440} size={14} anim="floatNode2" dur="6.5s" />
      <FloatingConnectedDot x={460} y={480} size={19} anim="floatNode1" dur="7.0s" />
      <FloatingConnectedDot x={160} y={740} size={15} anim="floatNode3" dur="8.0s" />
      <FloatingConnectedDot x={380} y={760} size={16} anim="floatNode2" dur="7.4s" />

      {/* Center Connected Nodes */}
      <FloatingConnectedDot x={620} y={280} size={18} anim="floatNode1" dur="6.7s" />
      <FloatingConnectedDot x={720} y={450} size={20} anim="floatNode3" dur="7.6s" />
      <FloatingConnectedDot x={600} y={620} size={16} anim="floatNode2" dur="6.9s" />
      <FloatingConnectedDot x={800} y={240} size={17} anim="floatNode2" dur="7.1s" />
      <FloatingConnectedDot x={880} y={400} size={19} anim="floatNode1" dur="6.8s" />
      <FloatingConnectedDot x={760} y={660} size={17} anim="floatNode3" dur="7.5s" />
      <FloatingConnectedDot x={960} y={580} size={18} anim="floatNode2" dur="7.2s" />

      {/* Right Wing Connected Nodes */}
      <FloatingConnectedDot x={980} y={180} size={16} anim="floatNode1" dur="6.4s" />
      <FloatingConnectedDot x={1160} y={140} size={18} anim="floatNode2" dur="6.6s" />
      <FloatingConnectedDot x={1320} y={220} size={15} anim="floatNode3" dur="7.8s" />
      <FloatingConnectedDot x={1140} y={340} size={20} anim="floatNode1" dur="7.0s" />
      <FloatingConnectedDot x={1280} y={420} size={17} anim="floatNode2" dur="6.9s" />
      <FloatingConnectedDot x={1380} y={520} size={14} anim="floatNode3" dur="7.7s" />
      <FloatingConnectedDot x={1120} y={560} size={19} anim="floatNode2" dur="7.3s" />
      <FloatingConnectedDot x={1260} y={680} size={16} anim="floatNode1" dur="6.5s" />
      <FloatingConnectedDot x={1040} y={740} size={18} anim="floatNode3" dur="8.1s" />

      {/* ── Isolated Unconnected Dots (Only 3~4 scattered dots across the edges) ── */}
      <IsolatedAmbientDot x={540} y={120} size={9} anim="floatNode2" dur="5.8s" />
      <IsolatedAmbientDot x={1380} y={110} size={8} anim="floatNode1" dur="6.2s" />
      <IsolatedAmbientDot x={60} y={620} size={8} anim="floatNode3" dur="7.0s" />
      <IsolatedAmbientDot x={890} y={780} size={9} anim="floatNode2" dur="6.7s" />
    </div>
  );
}

/**
 * Connected Active Dot (Pure Glowing Node with Float Physics)
 */
function FloatingConnectedDot({
  x,
  y,
  size,
  anim,
  dur,
}: {
  x: number;
  y: number;
  size: number;
  anim: string;
  dur: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        animation: `${anim} ${dur} ease-in-out infinite`,
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "#38BDF8",
          boxShadow: "0 0 12px rgba(56, 189, 248, 0.75), 0 0 4px #FFFFFF",
          border: "1.5px solid rgba(255, 255, 255, 0.9)",
        }}
      />
    </div>
  );
}

/**
 * Isolated Ambient Dot (Only a few subtle stars)
 */
function IsolatedAmbientDot({
  x,
  y,
  size,
  anim,
  dur,
}: {
  x: number;
  y: number;
  size: number;
  anim: string;
  dur: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        animation: `${anim} ${dur} ease-in-out infinite`,
        pointerEvents: "none",
        zIndex: 1,
        opacity: 0.6,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "#BAE6FD",
          boxShadow: "0 0 8px rgba(186, 230, 253, 0.6)",
        }}
      />
    </div>
  );
}
