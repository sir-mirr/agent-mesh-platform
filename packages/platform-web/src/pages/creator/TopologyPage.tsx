import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
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

const MINIMAP_W = 200;
const MINIMAP_H = 110;

export function TopologyPage() {
  const [simStage, setSimStage] = useState<number>(10);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeFilterGroup, setActiveFilterGroup] = useState<string>("all");
  const [quickMsg, setQuickMsg] = useState<string>("Ping from Agent Mesh Console");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Pan / Zoom Transformation State
  const [panX, setPanX] = useState<number>(40);
  const [panY, setPanY] = useState<number>(20);
  const [scale, setScale] = useState<number>(0.38);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Synchronous ref for high-precision cursor-centered zoom & mouse events
  const transformRef = useRef<{ panX: number; panY: number; scale: number }>({ panX: 40, panY: 20, scale: 0.38 });
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({ x: 0, y: 0, panX: 40, panY: 20 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<SVGSVGElement | null>(null);

  // Keep transformRef in sync
  useEffect(() => {
    transformRef.current = { panX, panY, scale };
  }, [panX, panY, scale]);

  const subNavItems = [
    { label: "내 에이전트", href: "/creator", icon: "🤖" },
    { label: "스웜 그룹 관리", href: "/creator/groups", icon: "👥" },
    { label: "에이전트 토폴로지", href: "/creator/topology", icon: "🌐" },
    { label: "메시지 테스트", href: "/creator/playground", icon: "💬" },
    { label: "소켓리스 큐", href: "/creator/lease-queue", icon: "📥" },
    { label: "에이전트 등록", href: "/creator/register", icon: "➕" },
  ];

  // 1. Build Topology Data Graph dynamically based on Stage (1 ~ 10)
  const { clusters, nodes, edges, totalAgentCount, bounds } = useMemo(() => {
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

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    rawClusters.forEach((cfg) => {
      agentSum += cfg.count;

      // Track bounding box of cluster orbital circle & header badge
      minX = Math.min(minX, cfg.cx - cfg.r - 20);
      maxX = Math.max(maxX, cfg.cx + cfg.r + 20);
      minY = Math.min(minY, cfg.cy - cfg.r - 45);
      maxY = Math.max(maxY, cfg.cy + cfg.r + 20);

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

      minX = Math.min(minX, cfg.gw.x - 30);
      maxX = Math.max(maxX, cfg.gw.x + 30);
      minY = Math.min(minY, cfg.gw.y - 30);
      maxY = Math.max(maxY, cfg.gw.y + 50);

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

        const roundX = Math.round(nx);
        const roundY = Math.round(ny);

        nodeDict[name] = {
          identity: name,
          group: cfg.id,
          groupName: cfg.name,
          type,
          status,
          desc: `Active autonomous member node in ${cfg.name} galaxy.`,
          key: `sha256:${cfg.id}_${name}_${(i * 991).toString(16)}`,
          x: roundX,
          y: roundY,
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

    // Exact 5% Margin Bounding Box Calculation around all drawn entities (User requested 5%)
    const entityW = Math.max(maxX - minX, 600);
    const entityH = Math.max(maxY - minY, 400);
    const marginX = entityW * 0.05; // 5% margin
    const marginY = entityH * 0.05; // 5% margin

    const worldMinX = minX - marginX;
    const worldMaxX = maxX + marginX;
    const worldMinY = minY - marginY;
    const worldMaxY = maxY + marginY;
    const worldW = worldMaxX - worldMinX;
    const worldH = worldMaxY - worldMinY;
    const entityCX = (minX + maxX) / 2;
    const entityCY = (minY + maxY) / 2;

    return {
      clusters: rawClusters,
      nodes: nodeDict,
      edges: edgeList,
      totalAgentCount: agentSum,
      bounds: {
        minX,
        maxX,
        minY,
        maxY,
        entityW,
        entityH,
        entityCX,
        entityCY,
        worldMinX,
        worldMaxX,
        worldMinY,
        worldMaxY,
        worldW,
        worldH,
      },
    };
  }, [simStage]);

  // Selected Node Object
  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : null;

  // Filtered nodes
  const filteredNodeIds = useMemo(() => {
    let result = Object.keys(nodes);
    if (activeFilterGroup !== "all") {
      result = result.filter((id) => nodes[id]?.group === activeFilterGroup);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((id) => {
        const n = nodes[id];
        if (!n) return false;
        return (
          id.toLowerCase().includes(q) ||
          n.displayName.toLowerCase().includes(q) ||
          n.groupName.toLowerCase().includes(q)
        );
      });
    }
    return result;
  }, [nodes, activeFilterGroup, searchQuery]);

  // Boundary Clamping Function (Constrain panning inside world bounds)
  const clampPan = useCallback(
    (targetPanX: number, targetPanY: number, targetScale: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return { x: targetPanX, y: targetPanY };
      const rect = viewport.getBoundingClientRect();
      const vw = rect.width;
      const vh = rect.height;

      const maxPanX = -bounds.worldMinX * targetScale;
      const minPanX = vw - bounds.worldMaxX * targetScale;
      const maxPanY = -bounds.worldMinY * targetScale;
      const minPanY = vh - bounds.worldMaxY * targetScale;

      let clampedX = targetPanX;
      let clampedY = targetPanY;

      if (minPanX > maxPanX) {
        clampedX = (vw - (bounds.worldMinX + bounds.worldMaxX) * targetScale) / 2;
      } else {
        clampedX = Math.min(Math.max(targetPanX, minPanX), maxPanX);
      }

      if (minPanY > maxPanY) {
        clampedY = (vh - (bounds.worldMinY + bounds.worldMaxY) * targetScale) / 2;
      } else {
        clampedY = Math.min(Math.max(targetPanY, minPanY), maxPanY);
      }

      return { x: clampedX, y: clampedY };
    },
    [bounds]
  );

  // 2. FIT-TO-SCREEN (Fits all drawn entities with exact 5% margin)
  const fitToScreen = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const vw = rect.width || 1200;
    const vh = rect.height || 640;

    // Scale to fit world bounds (with 5% margin)
    const scaleX = (vw - 32) / bounds.worldW;
    const scaleY = (vh - 32) / bounds.worldH;
    const fitScale = Math.min(scaleX, scaleY);
    const nextScale = Math.min(Math.max(fitScale, 0.15), 1.8);

    const targetPanX = vw / 2 - bounds.entityCX * nextScale;
    const targetPanY = vh / 2 - bounds.entityCY * nextScale;
    const clamped = clampPan(targetPanX, targetPanY, nextScale);

    transformRef.current = { panX: clamped.x, panY: clamped.y, scale: nextScale };
    setScale(nextScale);
    setPanX(clamped.x);
    setPanY(clamped.y);
  }, [bounds, clampPan]);

  // Auto-fit to screen when simStage changes or initially mounted
  useEffect(() => {
    fitToScreen();
  }, [simStage, fitToScreen]);

  // 3. MATHEMATICAL CURSOR-CENTERED ZOOM ISOLATED TO CANVAS ONLY
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const { panX: curPanX, panY: curPanY, scale: curScale } = transformRef.current;
      const zoomFactor = e.deltaY < 0 ? 1.14 : 0.88;
      const rect = el.getBoundingClientRect();

      // Mouse coordinate relative to viewport container
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // World coordinate under cursor before zoom
      const worldX = (mouseX - curPanX) / curScale;
      const worldY = (mouseY - curPanY) / curScale;

      const nextScale = Math.min(Math.max(curScale * zoomFactor, 0.15), 2.5);

      // Keep world coordinate stationary under the same mouse position
      const targetPanX = mouseX - worldX * nextScale;
      const targetPanY = mouseY - worldY * nextScale;
      const clamped = clampPan(targetPanX, targetPanY, nextScale);

      transformRef.current = { panX: clamped.x, panY: clamped.y, scale: nextScale };
      setScale(nextScale);
      setPanX(clamped.x);
      setPanY(clamped.y);
    };

    el.addEventListener("wheel", onWheelHandler, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheelHandler);
    };
  }, [clampPan]);

  // Canvas Drag Pan Handlers with Boundary Clamping
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".node-clickable")) return;
    if ((e.target as HTMLElement).closest(".minimap-container")) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, panX, panY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    const targetPanX = dragStartRef.current.panX + dx;
    const targetPanY = dragStartRef.current.panY + dy;
    const clamped = clampPan(targetPanX, targetPanY, transformRef.current.scale);

    transformRef.current.panX = clamped.x;
    transformRef.current.panY = clamped.y;
    setPanX(clamped.x);
    setPanY(clamped.y);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // 4. INTERACTIVE MINIMAP CLICK & DRAG NAVIGATION
  const isMinimapDraggingRef = useRef(false);

  const navigateFromMinimap = useCallback(
    (clientX: number, clientY: number) => {
      const miniSvg = minimapRef.current;
      const viewport = viewportRef.current;
      if (!miniSvg || !viewport) return;

      const miniRect = miniSvg.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(clientX - miniRect.left, MINIMAP_W));
      const clickY = Math.max(0, Math.min(clientY - miniRect.top, MINIMAP_H));

      // Target world center point clicked on minimap
      const targetWorldX = bounds.worldMinX + (clickX / MINIMAP_W) * bounds.worldW;
      const targetWorldY = bounds.worldMinY + (clickY / MINIMAP_H) * bounds.worldH;

      const vpRect = viewport.getBoundingClientRect();
      const curScale = transformRef.current.scale;

      // Center viewport at this world position
      const targetPanX = vpRect.width / 2 - targetWorldX * curScale;
      const targetPanY = vpRect.height / 2 - targetWorldY * curScale;
      const clamped = clampPan(targetPanX, targetPanY, curScale);

      transformRef.current.panX = clamped.x;
      transformRef.current.panY = clamped.y;
      setPanX(clamped.x);
      setPanY(clamped.y);
    },
    [bounds, clampPan]
  );

  const handleMinimapMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    isMinimapDraggingRef.current = true;
    navigateFromMinimap(e.clientX, e.clientY);
  };

  useEffect(() => {
    const onWindowMouseMove = (e: MouseEvent) => {
      if (isMinimapDraggingRef.current) {
        navigateFromMinimap(e.clientX, e.clientY);
      }
    };
    const onWindowMouseUp = () => {
      isMinimapDraggingRef.current = false;
    };
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
  }, [navigateFromMinimap]);

  // Global ESC key listener to deselect node and hide overlay
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedNodeId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const zoomIn = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width || 1000;
    const vh = rect?.height || 600;
    const curScale = transformRef.current.scale;
    const nextScale = Math.min(curScale * 1.25, 2.5);

    const worldCenterX = (vw / 2 - transformRef.current.panX) / curScale;
    const worldCenterY = (vh / 2 - transformRef.current.panY) / curScale;

    const targetPanX = vw / 2 - worldCenterX * nextScale;
    const targetPanY = vh / 2 - worldCenterY * nextScale;
    const clamped = clampPan(targetPanX, targetPanY, nextScale);

    transformRef.current = { panX: clamped.x, panY: clamped.y, scale: nextScale };
    setScale(nextScale);
    setPanX(clamped.x);
    setPanY(clamped.y);
  };

  const zoomOut = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width || 1000;
    const vh = rect?.height || 600;
    const curScale = transformRef.current.scale;
    const nextScale = Math.max(curScale * 0.8, 0.15);

    const worldCenterX = (vw / 2 - transformRef.current.panX) / curScale;
    const worldCenterY = (vh / 2 - transformRef.current.panY) / curScale;

    const targetPanX = vw / 2 - worldCenterX * nextScale;
    const targetPanY = vh / 2 - worldCenterY * nextScale;
    const clamped = clampPan(targetPanX, targetPanY, nextScale);

    transformRef.current = { panX: clamped.x, panY: clamped.y, scale: nextScale };
    setScale(nextScale);
    setPanX(clamped.x);
    setPanY(clamped.y);
  };

  const focusNode = (node: TopoNode) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width || 1000;
    const vh = rect?.height || 600;
    const targetScale = 0.95;
    const targetPanX = vw / 2 - node.x * targetScale;
    const targetPanY = vh / 2 - node.y * targetScale;
    const clamped = clampPan(targetPanX, targetPanY, targetScale);

    transformRef.current = { panX: clamped.x, panY: clamped.y, scale: targetScale };
    setScale(targetScale);
    setPanX(clamped.x);
    setPanY(clamped.y);
  };

  const handleSendQuickMessage = () => {
    if (!selectedNode) return;
    setToastMsg(`'${selectedNode.displayName}' 에이전트로 메시지가 성공적으로 전송되었습니다! (Seq #1042)`);
    setTimeout(() => setToastMsg(null), 3500);
  };

  // Minimap Viewport indicator rectangle coordinates with STRICT mathematical boundary containment
  const minimapViewRect = useMemo(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width || 1000;
    const vh = rect?.height || 600;

    const miniScaleX = MINIMAP_W / bounds.worldW;
    const miniScaleY = MINIMAP_H / bounds.worldH;

    const rawLeft = (-panX / scale - bounds.worldMinX) * miniScaleX;
    const rawTop = (-panY / scale - bounds.worldMinY) * miniScaleY;
    const rawWidth = (vw / scale) * miniScaleX;
    const rawHeight = (vh / scale) * miniScaleY;

    // Strictly clamp left, right, top, bottom within [0, MINIMAP_W] and [0, MINIMAP_H]
    const left = Math.max(0, Math.min(rawLeft, MINIMAP_W));
    const top = Math.max(0, Math.min(rawTop, MINIMAP_H));
    const right = Math.max(0, Math.min(rawLeft + rawWidth, MINIMAP_W));
    const bottom = Math.max(0, Math.min(rawTop + rawHeight, MINIMAP_H));

    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    return {
      x: left,
      y: top,
      width,
      height,
    };
  }, [panX, panY, scale, bounds]);

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
            <Button variant="secondary" size="sm" onClick={fitToScreen}>
              Fit (5% 여백)
            </Button>
            <Button variant="primary" size="sm" onClick={() => setSimStage(10)}>
              ⚡ 10-스웜 풀 로드 (139노드)
            </Button>
          </div>
        }
      />

      {/* Control Toolbar Card: Scale Slider & Galaxy Filter Pills */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "var(--shadow-xs)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
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
              <button onClick={() => setSimStage(1)} style={presetBtnStyle(simStage === 1)}>
                1. 단일(5)
              </button>
              <button onClick={() => setSimStage(3)} style={presetBtnStyle(simStage === 3)}>
                3. 트리플(43)
              </button>
              <button onClick={() => setSimStage(5)} style={presetBtnStyle(simStage === 5)}>
                5. 상단덱(67)
              </button>
              <button onClick={() => setSimStage(10)} style={presetBtnStyle(simStage === 10)}>
                10. 풀갤럭시(139)
              </button>
            </div>
          </div>

          {/* Search Input */}
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
          </div>
        </div>

        {/* Galaxy Filter Pills */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
          <button
            onClick={() => setActiveFilterGroup("all")}
            style={filterPillStyle(activeFilterGroup === "all")}
          >
            전체 스웜 ({clusters.length})
          </button>
          {clusters.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveFilterGroup(c.id)}
              style={filterPillStyle(activeFilterGroup === c.id)}
            >
              {c.name} ({c.count})
            </button>
          ))}
        </div>
      </div>

      {/* Main Interactive Topology SVG Viewport Container (Original Light Canvas Theme) */}
      <div
        ref={viewportRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{
          height: 640,
          background: "#F8FAFC",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--color-border)",
          position: "relative",
          overflow: "hidden",
          cursor: isDragging ? "grabbing" : "grab",
          userSelect: "none",
          boxShadow: "var(--shadow-sm)",
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
            background: "rgba(255, 255, 255, 0.94)",
            backdropFilter: "blur(8px)",
            padding: "6px 14px",
            borderRadius: "var(--radius-full)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-primary)",
            fontSize: "0.78rem",
            fontWeight: 700,
            boxShadow: "var(--shadow-xs)",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#10B981", display: "inline-block" }} />
          <span>Active Swarms: {clusters.length} Galaxies</span>
          <span style={{ color: "var(--color-text-muted)" }}>·</span>
          <span>Total Nodes: {totalAgentCount + clusters.length}</span>
          <span style={{ color: "var(--color-text-muted)" }}>·</span>
          <span style={{ color: "var(--color-primary)" }}>SPEC § 12 Egress Active</span>
        </div>

        {/* ── Scalable & Pannable SVG World Layer ── */}
        <svg
          style={{
            width: "100%",
            height: "100%",
            overflow: "visible",
            display: "block",
          }}
        >
          <defs>
            <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#0F172A" floodOpacity="0.1" />
            </filter>
            <filter id="gatewayGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#7C3AED" floodOpacity="0.4" />
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
                  strokeWidth={2.5}
                  fillOpacity={0.92}
                />
                {/* Galaxy Name Header Pill */}
                <rect
                  x={c.cx - 120}
                  y={c.cy - c.r - 28}
                  width={240}
                  height={26}
                  rx={13}
                  fill="#FFFFFF"
                  stroke={c.stroke}
                  strokeWidth={1.8}
                  style={{ filter: "drop-shadow(0 2px 8px rgba(15, 23, 42, 0.1))" }}
                />
                <text
                  x={c.cx}
                  y={c.cy - c.r - 11}
                  textAnchor="middle"
                  fill={c.textColor}
                  fontSize={12}
                  fontWeight={800}
                  fontFamily="inherit"
                  letterSpacing="-0.01em"
                >
                  {c.name} ({c.count})
                </text>
              </g>
            ))}

            {/* 2. Connection Edges */}
            {edges.map((e) => {
              const isHighlighted =
                selectedNode &&
                (e.from === selectedNode.identity || e.to === selectedNode.identity);
              const isHighway = e.type === "highway-edge";

              let strokeColor = "#64748B";
              let strokeWidth = 1.8;
              let dashArray = e.type === "gw-link" ? "4 4" : "none";

              if (isHighway) {
                strokeColor = isHighlighted ? "#7C3AED" : "#818CF8";
                strokeWidth = 2.2;
                dashArray = "5 4";
              } else if (isHighlighted) {
                strokeColor = "#0284C7";
                strokeWidth = 4.5;
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
                  strokeLinecap="round"
                  opacity={selectedNode && !isHighlighted ? 0.35 : 0.75}
                  style={{
                    transition: "stroke 0.2s, stroke-width 0.2s, opacity 0.2s",
                    filter: isHighlighted ? "drop-shadow(0 0 8px rgba(2, 132, 199, 0.8))" : "none",
                  }}
                />
              );
            })}

            {/* 3. Render Nodes */}
            {Object.values(nodes).map((node) => {
              const isSelected = selectedNode?.identity === node.identity;
              const isPeer = selectedNode?.directPeers.includes(node.identity);
              const isMatch = filteredNodeIds.includes(node.identity);
              const isOnline = node.status === "Online";

              if (node.type === "gateway-bridge") {
                return (
                  <g
                    key={node.identity}
                    className="node-clickable"
                    onClick={() => setSelectedNodeId(node.identity)}
                    style={{ cursor: "pointer", opacity: isMatch ? 1 : 0.2 }}
                  >
                    <circle cx={node.x} cy={node.y} r={40} fill="transparent" />
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={24}
                      fill="#FAF5FF"
                      stroke={isSelected ? "#7C3AED" : "#A855F7"}
                      strokeWidth={isSelected ? 4 : 3}
                      filter="url(#gatewayGlow)"
                    />
                    <circle cx={node.x + 18} cy={node.y - 18} r={5} fill="#7C3AED" stroke="#FFFFFF" strokeWidth={1.5} />
                    <text
                      x={node.x}
                      y={node.y + 5}
                      fontSize={14}
                      textAnchor="middle"
                      fill="#7C3AED"
                    >
                      🌐
                    </text>
                    <text
                      x={node.x}
                      y={node.y + 40}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={800}
                      fill="#7C3AED"
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
                  style={{
                    cursor: "pointer",
                    opacity: isMatch ? 1 : 0.2,
                    transform: isSelected ? "scale(1.3)" : isPeer ? "scale(1.15)" : "scale(1)",
                    transformOrigin: `${node.x}px ${node.y}px`,
                    transition: "transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                >
                  <circle cx={node.x} cy={node.y} r={36} fill="transparent" />

                  {/* Character Avatar Node (핀둥이, 핀자, 아름이) */}
                  {node.avatarImg ? (
                    <>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={18}
                        fill="#FFFFFF"
                        stroke={isSelected ? "#0284C7" : isPeer ? "#059669" : "#334155"}
                        strokeWidth={isSelected ? 4 : isPeer ? 3 : 2.2}
                        filter="url(#nodeShadow)"
                      />
                      <defs>
                        <clipPath id={`clip-${node.identity}`}>
                          <circle cx={node.x} cy={node.y} r={15} />
                        </clipPath>
                      </defs>
                      <image
                        href={node.avatarImg}
                        x={node.x - 15}
                        y={node.y - 15}
                        width={30}
                        height={30}
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
                        fill="#FFFFFF"
                        stroke={isSelected ? "#0284C7" : isPeer ? "#059669" : "#334155"}
                        strokeWidth={isSelected ? 4 : isPeer ? 3 : 2.4}
                        filter="url(#nodeShadow)"
                      />
                      <text
                        x={node.x}
                        y={node.y + 4}
                        fontSize={10}
                        textAnchor="middle"
                        fill="#0F172A"
                      >
                        {node.icon}
                      </text>
                    </>
                  )}

                  {/* Online / Leased Status Indicator Dot */}
                  <circle
                    cx={node.x + 13}
                    cy={node.y - 13}
                    r={3.8}
                    fill={isOnline ? "#059669" : "#0284C7"}
                    stroke="#FFFFFF"
                    strokeWidth={1.5}
                  />

                  {/* Node Title */}
                  <text
                    x={node.x}
                    y={node.y + 28}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={isSelected ? 900 : 700}
                    fill={isSelected ? "#0369A1" : isPeer ? "#065F46" : "#0F172A"}
                    style={{
                      paintOrder: "stroke fill",
                      stroke: "rgba(255, 255, 255, 0.95)",
                      strokeWidth: "3px",
                      strokeLinejoin: "round",
                    }}
                  >
                    {node.displayName}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* ── Floating Zoom HUD Controls (Bottom-Right) ── */}
        <div
          style={{
            position: "absolute",
            bottom: 20,
            right: 20,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "rgba(255, 255, 255, 0.95)",
            backdropFilter: "blur(8px)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            padding: "4px 8px",
            boxShadow: "var(--shadow-md)",
            zIndex: 40,
          }}
        >
          <button onClick={zoomIn} style={hudBtnStyle} title="확대 (+)">➕</button>
          <span style={{ fontSize: "0.75rem", fontWeight: 700, minWidth: 44, textAlign: "center", color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>
            {Math.round(scale * 100)}%
          </span>
          <button onClick={zoomOut} style={hudBtnStyle} title="축소 (-)">➖</button>
          <button
            onClick={fitToScreen}
            style={{
              ...hudBtnStyle,
              fontWeight: 800,
              fontSize: "0.76rem",
              color: "var(--color-primary)",
              padding: "4px 8px",
              background: "var(--color-primary-light)",
              borderRadius: "var(--radius-sm)",
            }}
            title="화면 맞춤 (Fit - 5% 여백)"
          >
            Fit
          </button>
        </div>

        {/* ── Interactive Mini-Map with Drag/Click Navigation (Bottom-Left) ── */}
        <div
          className="minimap-container"
          style={{
            position: "absolute",
            bottom: 20,
            left: 20,
            width: MINIMAP_W,
            height: MINIMAP_H,
            background: "rgba(255, 255, 255, 0.96)",
            backdropFilter: "blur(10px)",
            border: "1.5px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.14)",
            overflow: "hidden", // Prevents indicator from exceeding container
            zIndex: 40,
            cursor: "crosshair",
          }}
          onMouseDown={handleMinimapMouseDown}
          title="미니맵: 클릭 또는 드래그하여 해당 구역으로 즉시 이동"
        >
          <svg
            ref={minimapRef}
            style={{ width: "100%", height: "100%", display: "block" }}
            viewBox={`${bounds.worldMinX} ${bounds.worldMinY} ${bounds.worldW} ${bounds.worldH}`}
          >
            {/* Cluster Mini Circles */}
            {clusters.map((c) => (
              <circle
                key={c.id}
                cx={c.cx}
                cy={c.cy}
                r={c.r}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth={6}
              />
            ))}
          </svg>

          {/* Interactive Viewport Indicator Blue Rectangle (Strictly Box-Bounded) */}
          <div
            style={{
              position: "absolute",
              left: minimapViewRect.x,
              top: minimapViewRect.y,
              width: minimapViewRect.width,
              height: minimapViewRect.height,
              border: "2px solid #2563EB",
              background: "rgba(37, 99, 235, 0.2)",
              borderRadius: 3,
              boxShadow: "0 0 6px rgba(37, 99, 235, 0.5)",
              pointerEvents: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* ── Slide-out Node Inspector Drawer (Right Side) ── */}
        {selectedNode && (
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              width: 320,
              background: "rgba(255, 255, 255, 0.96)",
              backdropFilter: "blur(12px)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-lg)",
              padding: 20,
              boxShadow: "0 10px 25px -5px rgba(15, 23, 42, 0.12), 0 8px 10px -6px rgba(15, 23, 42, 0.04)",
              zIndex: 50,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {selectedNode.avatarImg ? (
                  <img
                    src={selectedNode.avatarImg}
                    alt={selectedNode.identity}
                    style={{ width: 44, height: 44, borderRadius: "50%", background: "white", padding: 2, border: "2px solid #2563EB" }}
                  />
                ) : (
                  <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--color-bg-surface-sub)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}>
                    {selectedNode.icon}
                  </div>
                )}
                <div>
                  <h3 style={{ fontSize: "1.05rem", fontWeight: 800, color: "var(--color-text-primary)", letterSpacing: "-0.02em" }}>
                    {selectedNode.displayName}
                  </h3>
                  <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)", fontWeight: 600 }}>
                    {selectedNode.groupName}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setSelectedNodeId(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--color-text-secondary)",
                  cursor: "pointer",
                  fontSize: "1rem",
                  padding: 4,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "var(--radius-full)", background: selectedNode.status === "Online" ? "#ECFDF5" : "#EFF6FF", color: selectedNode.status === "Online" ? "#059669" : "#2563EB", fontWeight: 700 }}>
                ● {selectedNode.status}
              </span>
              <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "var(--radius-full)", background: "var(--color-bg-surface-sub)", color: "var(--color-text-secondary)", fontWeight: 600 }}>
                Type: {selectedNode.type}
              </span>
            </div>

            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              {selectedNode.desc}
            </p>

            <div style={{ background: "var(--color-bg-surface-sub)", padding: "8px 10px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Key: {selectedNode.key}
            </div>

            {/* Quick Message Box */}
            <div style={{ background: "var(--color-bg-surface-sub)", padding: 12, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--color-text-secondary)" }}>
                ✉ 메시지 즉시 발송 테스트
              </label>
              <input
                type="text"
                value={quickMsg}
                onChange={(e) => setQuickMsg(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border-strong)",
                  background: "#FFFFFF",
                  color: "var(--color-text-primary)",
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
              <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: 6 }}>
                연결된 피어 목록 ({selectedNode.directPeers.length}):
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 90, overflowY: "auto" }}>
                {selectedNode.directPeers.map((peer) => (
                  <button
                    key={peer}
                    onClick={() => setSelectedNodeId(peer)}
                    style={{
                      background: "var(--color-bg-surface-sub)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-primary)",
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

function filterPillStyle(isActive: boolean): React.CSSProperties {
  return {
    background: isActive ? "var(--color-primary)" : "var(--color-bg-surface-sub)",
    border: `1px solid ${isActive ? "var(--color-primary)" : "var(--color-border)"}`,
    color: isActive ? "#FFFFFF" : "var(--color-text-secondary)",
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "var(--radius-full)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "all 0.15s ease",
  };
}

const hudBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  fontSize: "0.85rem",
  padding: "4px 6px",
  borderRadius: "var(--radius-sm)",
};
