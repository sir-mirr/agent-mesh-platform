import React, { useState, useRef, useMemo, useCallback } from "react";
import { PageHeader, SubNavPills, Button, Toast } from "@/components/index.ts";

interface ClusterConfig {
  id: string;
  name: string;
  count: number;
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke: string;
  textColor: string;
  gw: { id: string; x: number; y: number };
}

interface TopoNode {
  identity: string;
  group: string;
  groupName: string;
  type: string;
  status: "Online" | "Socketless" | "Gateway";
  badgeClass?: string | undefined;
  desc: string;
  key: string;
  x: number;
  y: number;
  icon: string;
  avatarImg?: string | undefined;
  displayName: string;
  directPeers: string[];
}

interface TopoEdge {
  id: string;
  from: string;
  to: string;
  d: string;
  type: "member-edge" | "gw-link" | "highway-edge";
}

const MASTER_CLUSTERS_CONFIG: ClusterConfig[] = [
  // ROW 1: TOP DECK
  { id: "core", name: "Core Platform Hub", count: 5, cx: 360, cy: 380, r: 160, fill: "#EFF6FF", stroke: "#93C5FD", textColor: "#1E40AF", gw: { id: "gw-core", x: 360, y: 700 } },
  { id: "research", name: "Research & Reasoning Swarm", count: 24, cx: 1080, cy: 380, r: 300, fill: "#ECFDF5", stroke: "#A7F3D0", textColor: "#065F46", gw: { id: "gw-research", x: 1080, y: 700 } },
  { id: "delivery", name: "Execution & Delivery Mesh", count: 14, cx: 1780, cy: 380, r: 230, fill: "#F5F3FF", stroke: "#DDD6FE", textColor: "#5B21B6", gw: { id: "gw-delivery", x: 1780, y: 700 } },
  { id: "security", name: "Security & Sentinel Ring", count: 8, cx: 2420, cy: 380, r: 180, fill: "#FEF2F2", stroke: "#FECACA", textColor: "#991B1B", gw: { id: "gw-security", x: 2420, y: 700 } },
  { id: "data", name: "Data & ETL Pipeline Swarm", count: 16, cx: 3100, cy: 380, r: 250, fill: "#F0F9FF", stroke: "#BAE6FD", textColor: "#075985", gw: { id: "gw-data", x: 3100, y: 700 } },

  // ROW 2: BOTTOM DECK
  { id: "edge", name: "Edge & IoT Micro-Agents", count: 20, cx: 480, cy: 1300, r: 260, fill: "#FFFBEB", stroke: "#FDE68A", textColor: "#92400E", gw: { id: "gw-edge", x: 480, y: 840 } },
  { id: "human", name: "Human Operator Guild", count: 4, cx: 1140, cy: 1300, r: 150, fill: "#EFF6FF", stroke: "#BFDBFE", textColor: "#1D4ED8", gw: { id: "gw-human", x: 1140, y: 840 } },
  { id: "refactor", name: "Autonomous Code Refactor", count: 12, cx: 1740, cy: 1300, r: 210, fill: "#F5F3FF", stroke: "#C4B5FD", textColor: "#6D28D9", gw: { id: "gw-refactor", x: 1740, y: 840 } },
  { id: "vision", name: "Multi-Modal Vision & Audio", count: 9, cx: 2360, cy: 1300, r: 190, fill: "#ECFDF5", stroke: "#6EE7B7", textColor: "#047857", gw: { id: "gw-vision", x: 2360, y: 840 } },
  { id: "audit", name: "Compliance & Audit Hive", count: 7, cx: 3000, cy: 1300, r: 170, fill: "#F8FAFC", stroke: "#CBD5E1", textColor: "#334155", gw: { id: "gw-audit", x: 3000, y: 840 } },
];

const ICONS_PALETTE = ["🤖", "🔬", "💻", "⚡", "📦", "🛡️", "📜", "🔑", "📊", "🧠", "💡", "📝", "🏆", "🚀", "💬", "🔍", "⚙️", "👁️", "🔐"];

export function TopologyPage() {
  const [simStage, setSimStage] = useState<number>(10);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [quickMsg, setQuickMsg] = useState<string>("Ping from Agent Mesh Console");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Pan / Zoom Transformation State
  const [panX, setPanX] = useState<number>(40);
  const [panY, setPanY] = useState<number>(20);
  const [scale, setScale] = useState<number>(0.38);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({ x: 0, y: 0, panX: 40, panY: 20 });
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const subNavItems = [
    { label: "내 에이전트", href: "/creator", icon: "🤖" },
    { label: "스웜 그룹 관리", href: "/creator/groups", icon: "👥" },
    { label: "에이전트 토폴로지", href: "/creator/topology", icon: "🌐" },
    { label: "메시지 테스트", href: "/creator/playground", icon: "💬" },
    { label: "소켓리스 큐", href: "/creator/lease-queue", icon: "📥" },
    { label: "에이전트 등록", href: "/creator/register", icon: "➕" },
  ];

  // Build Topology Data Graph dynamically based on Stage (1 ~ 10)
  const { clusters, nodes, edges, totalAgentCount } = useMemo(() => {
    const rawClusters = MASTER_CLUSTERS_CONFIG.slice(0, simStage).map((c) => ({
      ...c,
      gw: { ...c.gw },
    }));

    if (rawClusters.length >= 1 && simStage === 1) {
      const c0 = rawClusters[0];
      if (c0) {
        c0.cx = 500;
        c0.cy = 400;
        c0.gw.x = 500;
        c0.gw.y = 650;
      }
    } else if (rawClusters.length >= 2 && simStage === 2) {
      const c0 = rawClusters[0];
      const c1 = rawClusters[1];
      if (c0 && c1) {
        c0.cx = 400;
        c0.cy = 400;
        c1.cx = 1200;
        c1.cy = 400;
        c0.gw.x = 640;
        c0.gw.y = 400;
        c1.gw.x = 960;
        c1.gw.y = 400;
      }
    }

    const nodeDict: Record<string, TopoNode> = {};
    const edgeList: TopoEdge[] = [];
    let agentSum = 0;

    rawClusters.forEach((cfg) => {
      agentSum += cfg.count;

      // Gateway node
      nodeDict[cfg.gw.id] = {
        identity: cfg.gw.id,
        group: cfg.id,
        groupName: `${cfg.name} (Gateway)`,
        type: "gateway-bridge",
        status: "Gateway",
        desc: `Inter-Galaxy Routing Gateway for ${cfg.name}.`,
        key: `sha256:gw_${cfg.id}_${cfg.gw.id.slice(-4)}`,
        x: cfg.gw.x,
        y: cfg.gw.y,
        icon: "🌐",
        displayName: `${cfg.id}-gw`,
        directPeers: [],
      };

      const memberIds: string[] = [];

      for (let i = 0; i < cfg.count; i++) {
        let name = "";
        const icon = ICONS_PALETTE[(i + cfg.name.length) % ICONS_PALETTE.length] || "🤖";
        let type = "runtime";
        let status: "Online" | "Socketless" = "Online";
        let avatarImg: string | undefined = undefined;
        let displayName = "";

        if (i === 0) {
          name = `${cfg.id}-lead`;
          type = "ai-claude";
          if (cfg.id === "core") {
            avatarImg = "/assets/agent-fin.png";
            displayName = "core-lead (핀둥이)";
          }
        } else if (i === 1 && cfg.id === "core") {
          name = "fe-antigravity";
          type = "admin";
        } else {
          name = `${cfg.id}-agent-${i + 1}`;
          if (i % 3 === 0) status = "Socketless";
          if (cfg.id === "core" && i === 2) {
            avatarImg = "/assets/agent-support.png";
            displayName = "core-agent-3 (핀자)";
          } else if (cfg.id === "core" && i === 4) {
            avatarImg = "/assets/agent-assistant.png";
            displayName = "core-agent-5 (아름이)";
          }
        }
        if (!displayName) displayName = name;

        // Radial orbital layout coordinates
        let nx = cfg.cx;
        let ny = cfg.cy;

        if (cfg.count <= 6) {
          if (i > 0) {
            const angle = ((i - 1) / (cfg.count - 1)) * 2 * Math.PI - Math.PI / 2;
            const dist = cfg.r * 0.65;
            nx = cfg.cx + Math.cos(angle) * dist;
            ny = cfg.cy + Math.sin(angle) * dist;
          }
        } else {
          const orbitIndex = i % 3;
          const distMap = [cfg.r * 0.38, cfg.r * 0.68, cfg.r * 0.88];
          const orbitDist = distMap[orbitIndex] ?? cfg.r * 0.5;
          const angle = (i / cfg.count) * 2 * Math.PI;
          nx = cfg.cx + Math.cos(angle) * orbitDist;
          ny = cfg.cy + Math.sin(angle) * orbitDist;
        }

        nodeDict[name] = {
          identity: name,
          group: cfg.id,
          groupName: cfg.name,
          type,
          status,
          desc: `Active autonomous member node in ${cfg.name} galaxy.`,
          key: `sha256:${cfg.id}_${name}_${(i * 991).toString(16)}`,
          x: Math.round(nx),
          y: Math.round(ny),
          icon,
          avatarImg,
          displayName,
          directPeers: [],
        };
        memberIds.push(name);
      }

      // Member internal loop edges
      for (let i = 0; i < memberIds.length; i++) {
        const nextIdx = (i + 1) % memberIds.length;
        const fromId = memberIds[i] ?? "";
        const toId = memberIds[nextIdx] ?? "";
        const nA = nodeDict[fromId];
        const nB = nodeDict[toId];
        if (nA && nB && fromId && toId) {
          edgeList.push({
            id: `edge-${fromId}-${toId}`,
            from: fromId,
            to: toId,
            d: `M ${nA.x},${nA.y} L ${nB.x},${nB.y}`,
            type: "member-edge",
          });
          nA.directPeers.push(toId);
          nB.directPeers.push(fromId);
        }
      }

      // Gateway link to galaxy lead
      if (memberIds.length > 0) {
        const leadId = memberIds[0] ?? "";
        const leadNode = nodeDict[leadId];
        const gwNode = nodeDict[cfg.gw.id];
        if (leadNode && gwNode && leadId) {
          edgeList.push({
            id: `edge-gw-${cfg.id}`,
            from: cfg.gw.id,
            to: leadId,
            d: `M ${gwNode.x},${gwNode.y} L ${leadNode.x},${leadNode.y}`,
            type: "gw-link",
          });
          gwNode.directPeers.push(leadId);
          leadNode.directPeers.push(cfg.gw.id);
        }
      }
    });

    // Inter-Gateway Highway Backbone edges
    for (let i = 0; i < rawClusters.length - 1; i++) {
      const cA = rawClusters[i];
      const cB = rawClusters[i + 1];
      if (cA && cB) {
        const gwA = nodeDict[cA.gw.id];
        const gwB = nodeDict[cB.gw.id];
        if (gwA && gwB) {
          edgeList.push({
            id: `highway-${gwA.identity}-${gwB.identity}`,
            from: gwA.identity,
            to: gwB.identity,
            d: `M ${gwA.x},${gwA.y} L ${gwB.x},${gwB.y}`,
            type: "highway-edge",
          });
          gwA.directPeers.push(gwB.identity);
          gwB.directPeers.push(gwA.identity);
        }
      }
    }

    return { clusters: rawClusters, nodes: nodeDict, edges: edgeList, totalAgentCount: agentSum };
  }, [simStage]);

  // Selected Node Object
  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : null;

  // Filtered nodes
  const filteredNodeIds = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    return Object.keys(nodes).filter((id) => {
      const n = nodes[id];
      if (!n) return false;
      return (
        id.toLowerCase().includes(q) ||
        n.displayName.toLowerCase().includes(q) ||
        n.groupName.toLowerCase().includes(q)
      );
    });
  }, [nodes, searchQuery]);

  // Pan and Zoom Event Handlers
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setScale((prevScale) => {
      const nextScale = Math.min(Math.max(prevScale * zoomFactor, 0.15), 1.8);
      setPanX((prevPanX) => mouseX - (mouseX - prevPanX) * (nextScale / prevScale));
      setPanY((prevPanY) => mouseY - (mouseY - prevPanY) * (nextScale / prevScale));
      return nextScale;
    });
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".node-clickable")) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, panX, panY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPanX(dragStartRef.current.panX + dx);
    setPanY(dragStartRef.current.panY + dy);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const resetView = () => {
    setPanX(40);
    setPanY(20);
    setScale(0.38);
  };

  const zoomIn = () => {
    setScale((s) => Math.min(s * 1.25, 1.8));
  };

  const zoomOut = () => {
    setScale((s) => Math.max(s * 0.8, 0.15));
  };

  const focusNode = (node: TopoNode) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width || 1000;
    const vh = rect?.height || 600;
    const targetScale = 0.85;
    setScale(targetScale);
    setPanX(vw / 2 - node.x * targetScale);
    setPanY(vh / 2 - node.y * targetScale);
  };

  const handleSendQuickMessage = () => {
    if (!selectedNode) return;
    setToastMsg(`'${selectedNode.displayName}' 에이전트로 메시지가 성공적으로 전송되었습니다! (Seq #1042)`);
    setTimeout(() => setToastMsg(null), 3500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SubNavPills items={subNavItems} />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="38"
        title="에이전트 토폴로지"
        subtitle="10단계 스케일 시뮬레이션 및 원형 오비탈 노드-엣지 인터랙티브 제어기 (139 Connected Agent Nodes)"
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Button variant="secondary" size="sm" onClick={resetView}>
              🎯 100% 핏-투-스크린
            </Button>
            <Button variant="primary" size="sm" onClick={() => setSimStage(10)}>
              ⚡ 10-스웜 풀 로드 (139노드)
            </Button>
          </div>
        }
      />

      {/* Control Toolbar Card */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 16,
          boxShadow: "var(--shadow-xs)",
        }}
      >
        {/* Scale Slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 800, color: "var(--color-text-primary)" }}>
            스웜 스케일 단계:
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min="1"
              max="10"
              value={simStage}
              onChange={(e) => setSimStage(Number(e.target.value))}
              style={{ width: 140, accentColor: "var(--color-primary)", cursor: "pointer" }}
            />
            <span
              style={{
                fontSize: "0.82rem",
                fontWeight: 800,
                padding: "2px 8px",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-primary-light)",
                color: "var(--color-primary)",
                minWidth: 70,
                textAlign: "center",
              }}
            >
              Stage {simStage} / 10
            </span>
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => setSimStage(1)}
              style={presetBtnStyle(simStage === 1)}
            >
              1. 단일(5)
            </button>
            <button
              onClick={() => setSimStage(3)}
              style={presetBtnStyle(simStage === 3)}
            >
              3. 트리플(43)
            </button>
            <button
              onClick={() => setSimStage(5)}
              style={presetBtnStyle(simStage === 5)}
            >
              5. 상단덱(67)
            </button>
            <button
              onClick={() => setSimStage(10)}
              style={presetBtnStyle(simStage === 10)}
            >
              10. 풀갤럭시(139)
            </button>
          </div>
        </div>

        {/* Search & View Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="text"
            placeholder="에이전트 검색 (핀둥이, claude)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--color-border-strong)",
              fontSize: "0.82rem",
              background: "var(--color-bg-surface-sub)",
              outline: "none",
              width: 220,
            }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--color-bg-surface-sub)", padding: 3, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)" }}>
            <button onClick={zoomIn} style={iconBtnStyle} title="확대 (+)">➕</button>
            <span style={{ fontSize: "0.75rem", fontWeight: 700, minWidth: 44, textAlign: "center", color: "var(--color-text-secondary)" }}>
              {Math.round(scale * 100)}%
            </span>
            <button onClick={zoomOut} style={iconBtnStyle} title="축소 (-)">➖</button>
            <button onClick={resetView} style={iconBtnStyle} title="뷰 리셋">🎯</button>
          </div>
        </div>
      </div>

      {/* Main Interactive Topology SVG Viewport Container */}
      <div
        ref={viewportRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{
          height: 640,
          background: "radial-gradient(ellipse at center, #1E293B 0%, #0F172A 70%, #020617 100%)",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--color-border)",
          position: "relative",
          overflow: "hidden",
          cursor: isDragging ? "grabbing" : "grab",
          userSelect: "none",
          boxShadow: "0 20px 40px -15px rgba(0,0,0,0.5)",
        }}
      >
        {/* Top Floating HUD Info */}
        <div
          style={{
            position: "absolute",
            top: 14,
            left: 16,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(15, 23, 42, 0.85)",
            backdropFilter: "blur(8px)",
            padding: "6px 14px",
            borderRadius: "var(--radius-full)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            color: "#F8FAFC",
            fontSize: "0.78rem",
            fontWeight: 700,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#10B981", display: "inline-block", boxShadow: "0 0 8px #10B981" }} />
          <span>Active Swarms: {clusters.length} Galaxies</span>
          <span style={{ color: "#94A3B8" }}>·</span>
          <span>Total Nodes: {totalAgentCount + clusters.length}</span>
          <span style={{ color: "#94A3B8" }}>·</span>
          <span style={{ color: "#38BDF8" }}>SPEC § 12 Egress Active</span>
        </div>

        {/* ── Scalable & Pannable SVG World Layer ── */}
        <svg
          style={{
            width: "100%",
            height: "100%",
            overflow: "visible",
          }}
        >
          <defs>
            <filter id="nodeGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="gatewayGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#7C3AED" floodOpacity="0.6" />
            </filter>
          </defs>

          <g transform={`translate(${panX}, ${panY}) scale(${scale})`}>
            {/* 1. Galaxy Orbital Background Circles */}
            {clusters.map((c) => (
              <g key={c.id}>
                <circle
                  cx={c.cx}
                  cy={c.cy}
                  r={c.r}
                  fill={c.fill}
                  stroke={c.stroke}
                  strokeWidth={2}
                  strokeDasharray="6 6"
                  opacity={0.35}
                />
                {/* Galaxy Name Header Pill */}
                <rect
                  x={c.cx - 130}
                  y={c.cy - c.r - 30}
                  width={260}
                  height={28}
                  rx={14}
                  fill="rgba(15, 23, 42, 0.9)"
                  stroke={c.stroke}
                  strokeWidth={1.5}
                />
                <text
                  x={c.cx}
                  y={c.cy - c.r - 12}
                  textAnchor="middle"
                  fill={c.textColor}
                  fontSize={13}
                  fontWeight={800}
                  fontFamily="inherit"
                >
                  {c.name} ({c.count} Agents)
                </text>
              </g>
            ))}

            {/* 2. Connection Edges */}
            {edges.map((e) => {
              const isHighlighted =
                selectedNode &&
                (e.from === selectedNode.identity || e.to === selectedNode.identity);
              const isHighway = e.type === "highway-edge";

              let strokeColor = "rgba(56, 189, 248, 0.25)";
              let strokeWidth = 1.2;
              let dashArray = "4 4";

              if (isHighway) {
                strokeColor = isHighlighted ? "#A855F7" : "rgba(168, 85, 247, 0.4)";
                strokeWidth = 2.5;
                dashArray = "8 6";
              } else if (isHighlighted) {
                strokeColor = "#38BDF8";
                strokeWidth = 2.8;
                dashArray = "none";
              }

              return (
                <path
                  key={e.id}
                  d={e.d}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                  opacity={selectedNode && !isHighlighted ? 0.15 : 0.85}
                  style={{ transition: "stroke 0.2s, stroke-width 0.2s" }}
                />
              );
            })}

            {/* 3. Render Nodes */}
            {Object.values(nodes).map((node) => {
              const isSelected = selectedNode?.identity === node.identity;
              const isMatch = filteredNodeIds === null || filteredNodeIds.includes(node.identity);
              const isOnline = node.status === "Online";

              if (node.type === "gateway-bridge") {
                return (
                  <g
                    key={node.identity}
                    className="node-clickable"
                    onClick={() => setSelectedNodeId(node.identity)}
                    style={{ cursor: "pointer", opacity: isMatch ? 1 : 0.2 }}
                  >
                    {/* Hit target */}
                    <circle cx={node.x} cy={node.y} r={40} fill="transparent" />
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={24}
                      fill="#1E1B4B"
                      stroke={isSelected ? "#C084FC" : "#7C3AED"}
                      strokeWidth={isSelected ? 3.5 : 2}
                      filter="url(#gatewayGlow)"
                    />
                    <text
                      x={node.x}
                      y={node.y + 5}
                      fontSize={14}
                      textAnchor="middle"
                      fill="#FFFFFF"
                    >
                      🌐
                    </text>
                    <text
                      x={node.x}
                      y={node.y + 40}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={800}
                      fill="#C084FC"
                    >
                      {node.displayName}
                    </text>
                  </g>
                );
              }

              return (
                <g
                  key={node.identity}
                  className="node-clickable"
                  onClick={() => setSelectedNodeId(node.identity)}
                  style={{ cursor: "pointer", opacity: isMatch ? 1 : 0.2 }}
                >
                  {/* Hit Target */}
                  <circle cx={node.x} cy={node.y} r={34} fill="transparent" />

                  {/* Character Avatar Node (핀둥이, 핀자, 아름이) */}
                  {node.avatarImg ? (
                    <>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={20}
                        fill="#FFFFFF"
                        stroke={isSelected ? "#38BDF8" : "#E2E8F0"}
                        strokeWidth={isSelected ? 3.5 : 2}
                        filter="url(#nodeGlow)"
                      />
                      <defs>
                        <clipPath id={`clip-${node.identity}`}>
                          <circle cx={node.x} cy={node.y} r={17} />
                        </clipPath>
                      </defs>
                      <image
                        href={node.avatarImg}
                        x={node.x - 17}
                        y={node.y - 17}
                        width={34}
                        height={34}
                        clipPath={`url(#clip-${node.identity})`}
                        preserveAspectRatio="xMidYMid meet"
                      />
                    </>
                  ) : (
                    /* Standard Circle Node */
                    <>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={16}
                        fill="#0F172A"
                        stroke={isSelected ? "#38BDF8" : "#334155"}
                        strokeWidth={isSelected ? 3 : 1.5}
                        filter="url(#nodeGlow)"
                      />
                      <text
                        x={node.x}
                        y={node.y + 4}
                        fontSize={10}
                        textAnchor="middle"
                        fill="#FFFFFF"
                      >
                        {node.icon}
                      </text>
                    </>
                  )}

                  {/* Online / Leased Status Indicator Dot */}
                  <circle
                    cx={node.x + 13}
                    cy={node.y - 13}
                    r={4}
                    fill={isOnline ? "#10B981" : "#F59E0B"}
                    stroke="#0F172A"
                    strokeWidth={1.5}
                  />

                  {/* Node Label */}
                  <text
                    x={node.x}
                    y={node.y + 28}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={700}
                    fill={isSelected ? "#38BDF8" : "#E2E8F0"}
                    style={{ textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}
                  >
                    {node.displayName}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* ── Slide-out Node Inspector Drawer ── */}
        {selectedNode && (
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              width: 330,
              background: "rgba(15, 23, 42, 0.95)",
              backdropFilter: "blur(16px)",
              border: "1px solid rgba(56, 189, 248, 0.4)",
              borderRadius: "var(--radius-lg)",
              padding: "20px 18px",
              boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6)",
              color: "#F8FAFC",
              zIndex: 30,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {selectedNode.avatarImg ? (
                  <img
                    src={selectedNode.avatarImg}
                    alt={selectedNode.identity}
                    style={{ width: 44, height: 44, borderRadius: "50%", background: "white", padding: 2, border: "2px solid #38BDF8" }}
                  />
                ) : (
                  <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#1E293B", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}>
                    {selectedNode.icon}
                  </div>
                )}
                <div>
                  <h3 style={{ fontSize: "1.05rem", fontWeight: 800, color: "#FFFFFF", letterSpacing: "-0.02em" }}>
                    {selectedNode.displayName}
                  </h3>
                  <div style={{ fontSize: "0.75rem", color: "#94A3B8", fontWeight: 600 }}>
                    {selectedNode.groupName}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setSelectedNodeId(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#94A3B8",
                  cursor: "pointer",
                  fontSize: "1rem",
                  padding: 4,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "var(--radius-full)", background: selectedNode.status === "Online" ? "#064E3B" : "#78350F", color: selectedNode.status === "Online" ? "#34D399" : "#FDE68A", fontWeight: 700 }}>
                ● {selectedNode.status}
              </span>
              <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "var(--radius-full)", background: "#1E293B", color: "#94A3B8", fontWeight: 600 }}>
                Type: {selectedNode.type}
              </span>
            </div>

            <div style={{ background: "#0B0F19", padding: "8px 10px", borderRadius: "var(--radius-sm)", border: "1px solid #1E293B", fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "#38BDF8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Key: {selectedNode.key}
            </div>

            {/* Quick Message Box */}
            <div style={{ background: "rgba(30, 41, 59, 0.7)", padding: 12, borderRadius: "var(--radius-md)", border: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "#E2E8F0" }}>
                ✉ 메시지 즉시 발송 테스트
              </label>
              <input
                type="text"
                value={quickMsg}
                onChange={(e) => setQuickMsg(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid #334155",
                  background: "#0F172A",
                  color: "#FFFFFF",
                  fontSize: "0.8rem",
                  outline: "none",
                }}
              />
              <Button size="sm" variant="primary" onClick={handleSendQuickMessage}>
                Send Message ✈
              </Button>
            </div>

            {/* Connected Peers */}
            <div>
              <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#94A3B8", marginBottom: 6 }}>
                연결된 피어 목록 ({selectedNode.directPeers.length}):
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 100, overflowY: "auto" }}>
                {selectedNode.directPeers.map((peer) => (
                  <button
                    key={peer}
                    onClick={() => setSelectedNodeId(peer)}
                    style={{
                      background: "#1E293B",
                      border: "1px solid #334155",
                      color: "#38BDF8",
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                    }}
                  >
                    {peer}
                  </button>
                ))}
              </div>
            </div>

            <Button
              size="sm"
              variant="secondary"
              onClick={() => focusNode(selectedNode)}
              style={{ width: "100%", marginTop: 4 }}
            >
              🎯 노드 클러스터 포커스
            </Button>
          </div>
        )}
      </div>

      {toastMsg && <Toast message={toastMsg} type="success" onClose={() => setToastMsg(null)} />}
    </div>
  );
}

function presetBtnStyle(isActive: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: "var(--radius-sm)",
    border: `1px solid ${isActive ? "var(--color-primary)" : "var(--color-border)"}`,
    background: isActive ? "var(--color-primary)" : "var(--color-bg-surface)",
    color: isActive ? "#FFFFFF" : "var(--color-text-secondary)",
    fontSize: "0.76rem",
    fontWeight: 700,
    cursor: "pointer",
    transition: "all 0.15s ease",
  };
}

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: "0.82rem",
  padding: "4px 6px",
  borderRadius: "var(--radius-sm)",
};
