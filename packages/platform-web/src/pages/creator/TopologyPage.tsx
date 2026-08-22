import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import { PageHeader, Breadcrumbs, Button, Toast } from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { sendMessageApi } from "@/api/messages.ts";
import { fetchGroups, type GroupItem } from "@/api/groups.ts";
import { agentRegistryEntries, fetchAgents, type RegistryAgent, hasBeenSeen } from "@/api/agents.ts";

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
  /** Measured presence, not health. `Seen` = the mesh has a record; `NoRecord` = it does not. */
  status: "Seen" | "NoRecord" | "Gateway";
  badgeClass?: string | undefined;
  desc: string;
  /**
   * `null` for a node that has none — a synthesised gateway, or an agent whose
   * fingerprint this route does not carry.
   *
   * Both used to be filled: the gateway with `sha256:gw_${id}_…` and the agent
   * with `sha256:${identity}`. An identity is not a digest, and a drawn
   * backbone is not a key holder.
   */
  key: string | null;
  x: number;
  y: number;
  /**
   * D-745: the live `RegistryAgent` contract has no `avatarImg` field, and
   * every `TopoNode` producer therefore supplies only this icon. The old image
   * branches belonged to identity-specific demo data removed by the live-data
   * transition. Reintroduce `avatarImg` rendering only with a real avatar
   * contract, a producer, and coverage for the resulting nodes.
   */
  icon: string;
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

const PALETTE = [
  { fill: "#EFF6FF", stroke: "#93C5FD", textColor: "#1E40AF" },
  { fill: "#ECFDF5", stroke: "#A7F3D0", textColor: "#065F46" },
  { fill: "#F5F3FF", stroke: "#DDD6FE", textColor: "#5B21B6" },
  { fill: "#FEF2F2", stroke: "#FECACA", textColor: "#991B1B" },
  { fill: "#FFFBEB", stroke: "#FDE68A", textColor: "#92400E" },
  { fill: "#F0F9FF", stroke: "#BAE6FD", textColor: "#075985" },
];

const ICONS_PALETTE = ["🤖", "🔬", "💻", "⚡", "📦", "🛡️", "📜", "🔑", "📊", "🧠", "💡", "📝", "🏆", "🚀", "💬", "🔍", "⚙️", "👁️", "🔐"];

const MINIMAP_W = 200;
const MINIMAP_H = 110;

export function TopologyPage() {
  const { t } = useI18n();
  const [liveGroups, setLiveGroups] = useState<GroupItem[]>([]);
  const [liveAgents, setLiveAgents] = useState<RegistryAgent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeFilterGroup, setActiveFilterGroup] = useState<string>("all");
  const [quickMsg, setQuickMsg] = useState<string>("Ping from Agent Mesh Console");
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Load real groups and agents on mount
  useEffect(() => {
    setIsLoading(true);
    setIsError(false);
      setFailure(null);
    Promise.all([fetchGroups(), fetchAgents()])
      .then(([groups, agents]) => {
        setLiveGroups(groups || []);
        setLiveAgents(agentRegistryEntries(agents || []));
      })
      .catch((err) => {
        console.warn("[Topology] API load error:", err);
        setIsError(true);
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Search state & suggestion box
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);

  // Viewport dimensions
  const [viewportDim, setViewportDim] = useState<{ width: number; height: number }>({ width: 1200, height: 700 });

  // Pan / Zoom Transformation State
  const [panX, setPanX] = useState<number>(0);
  const [panY, setPanY] = useState<number>(0);
  const [scale, setScale] = useState<number>(0.38);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Synchronous ref for high-precision cursor-centered zoom & mouse events
  const transformRef = useRef<{ panX: number; panY: number; scale: number }>({ panX: 0, panY: 0, scale: 0.38 });
  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({ x: 0, y: 0, panX: 0, panY: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const searchWrapRef = useRef<HTMLDivElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Keep transformRef in sync
  useEffect(() => {
    transformRef.current = { panX, panY, scale };
  }, [panX, panY, scale]);

  // Update viewport dimensions on resize
  useEffect(() => {
    const updateDim = () => {
      if (viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect();
        setViewportDim({ width: rect.width, height: rect.height });
      }
    };
    updateDim();
    window.addEventListener("resize", updateDim);
    return () => window.removeEventListener("resize", updateDim);
  }, []);

  // 1. Build Topology Data Graph dynamically based on real liveGroups and liveAgents
  const { clusters, nodes, edges, totalAgentCount, bounds } = useMemo(() => {
    if (liveGroups.length === 0 && liveAgents.length === 0) {
      return {
        clusters: [],
        nodes: {},
        edges: [],
        totalAgentCount: 0,
        bounds: {
          minX: 0,
          maxX: 1200,
          minY: 0,
          maxY: 700,
          entityW: 1200,
          entityH: 700,
          entityCX: 600,
          entityCY: 350,
          worldMinX: -60,
          worldMaxX: 1260,
          worldMinY: -35,
          worldMaxY: 735,
          worldW: 1320,
          worldH: 770,
        },
      };
    }

    const agentIds = new Set(liveAgents.map((agent) => agent.identity));
    const effectiveGroups: GroupItem[] = liveGroups.length > 0
      ? liveGroups.map((group) => ({
          ...group,
          // Group membership shares the unified identity namespace. Only an
          // identity that the filtered agent registry confirms may become an
          // agent node or contribute to an agent-labelled cluster count.
          members: (group.members ?? []).filter((identity) => agentIds.has(identity)),
        }))
      : [
          {
            id: "default",
            // Named for what it is — a placeholder the screen drew because the
            // server reported no groups — rather than "Default Group", which
            // reads as a group the mesh has.
            name: t("topo.noGroup", "(그룹 없음)"),
            member_count: liveAgents.length,
            members: liveAgents.map((a) => a.identity),
          },
        ];

    const rawClusters: ClusterConfig[] = effectiveGroups.map((g, idx) => {
      const col = idx % 4;
      const row = Math.floor(idx / 4);
      const cx = 380 + col * 720;
      const cy = 380 + row * 850;
      // No fallback by `type`. That is the kind of agent, not what it belongs
      // to — the same layer confusion the agent list carried until `71afcdb`,
      // still alive here. An empty membership is an empty membership.
      const members = g.members ?? [];
      // **`|| 1` turned a known 0 into a 1.** `member_count` is not a field
      // this route sends, so the fallback always ran and an empty group drew as
      // holding one member. The mirror image of the empty-state defects removed
      // elsewhere this week: there an unknown became `0`, here a known `0`
      // became `1`.
      const memberCount = members.length;
      const r = Math.max(160, 120 + memberCount * 25);
      const pal = PALETTE[idx % PALETTE.length] ?? { fill: "#EFF6FF", stroke: "#93C5FD", textColor: "#1E40AF" };
      return {
        id: g.id,
        name: g.name,
        count: memberCount,
        cx,
        cy,
        r,
        fill: pal.fill,
        stroke: pal.stroke,
        textColor: pal.textColor,
        gw: { id: `gw-${g.id}`, x: cx, y: cy + r + 50 },
      };
    });

    const nodeDict: Record<string, TopoNode> = {};
    const edgeList: TopoEdge[] = [];

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    rawClusters.forEach((cfg) => {
      // Track bounding box of cluster orbital circle & header badge
      minX = Math.min(minX, cfg.cx - cfg.r);
      maxX = Math.max(maxX, cfg.cx + cfg.r);
      minY = Math.min(minY, cfg.cy - cfg.r - 35);
      maxY = Math.max(maxY, cfg.cy + cfg.r);

      // Gateway node
      nodeDict[cfg.gw.id] = {
        identity: cfg.gw.id,
        group: cfg.id,
        groupName: `${cfg.name} (Gateway)`,
        type: "gateway-bridge",
        status: "Gateway",
        desc: `${cfg.name} — ${t("topo.gateway", "그룹 사이의 메시지 전송 규칙을 적용하는 서버")}`,
        // A drawn gateway holds no key. It used to carry `sha256:gw_…`, which
        // put a synthesised node in the same list as real agents wearing the
        // same kind of value.
        key: null,
        x: cfg.gw.x,
        y: cfg.gw.y,
        icon: "🌐",
        displayName: `${cfg.id}-gw`,
        directPeers: [],
      };

      minX = Math.min(minX, cfg.gw.x - 24);
      maxX = Math.max(maxX, cfg.gw.x + 24);
      minY = Math.min(minY, cfg.gw.y - 24);
      maxY = Math.max(maxY, cfg.gw.y + 40);

      const groupData = effectiveGroups.find((g) => g.id === cfg.id);
      const memberList: string[] = groupData?.members ?? [];

      // **An empty membership is an empty membership**, which the cluster sizing
      // above already says in those words. What stood here contradicted it
      // seventy lines later: when a group held nobody, every live agent was
      // pushed into it — no condition, no `type` match, all of them. So an empty
      // group drew as holding the whole mesh, and it drew them again for the
      // next empty group.
      //
      // `SC-CONSIST-01` cannot see this. It compares the heading against the
      // canvas, and both read the same inflated list — two views of one wrong
      // answer agree. `SC-SCR05-03` asks the different question: a group the
      // server says is empty draws nobody.
      const count = memberList.length;

      const memberIds: string[] = [];

      for (let i = 0; i < count; i++) {
        const agentIdentity = memberList[i] || `${cfg.id}-agent-${i + 1}`;
        const agentObj = liveAgents.find((a) => a.identity === agentIdentity);
        const icon = ICONS_PALETTE[(i + cfg.name.length) % ICONS_PALETTE.length] || "🤖";
        const type = agentObj?.type || "runtime";
        // **Measured, not judged.** This read `agentObj.status`, a key the route
        // does not send (SPEC § 9.1), so every node came out "Online" — the
        // topology said the whole mesh was up regardless of what the mesh knew.
        // `last_seen_at` is what it does know: seen at some point, or no record.
        const status: "Seen" | "NoRecord" = hasBeenSeen(agentObj ?? {}) ? "Seen" : "NoRecord";
        const displayName = agentObj?.description || agentIdentity;
        const desc = `${agentIdentity} — ${cfg.name}`;

        // Radial orbital layout coordinates
        let nx = cfg.cx;
        let ny = cfg.cy;

        if (count <= 6) {
          if (i > 0) {
            const angle = ((i - 1) / (count - 1)) * 2 * Math.PI - Math.PI / 2;
            const dist = cfg.r * 0.65;
            nx = cfg.cx + Math.cos(angle) * dist;
            ny = cfg.cy + Math.sin(angle) * dist;
          }
        } else {
          const orbitIndex = i % 3;
          const distMap = [cfg.r * 0.38, cfg.r * 0.68, cfg.r * 0.88];
          const orbitDist = distMap[orbitIndex] ?? cfg.r * 0.5;
          const angle = (i / count) * 2 * Math.PI;
          nx = cfg.cx + Math.cos(angle) * orbitDist;
          ny = cfg.cy + Math.sin(angle) * orbitDist;
        }

        const roundX = Math.round(nx);
        const roundY = Math.round(ny);

        nodeDict[agentIdentity] = {
          identity: agentIdentity,
          group: cfg.id,
          groupName: cfg.name,
          type,
          status,
          desc,
          // Not `sha256:${identity}`. An identity is a name and a digest is a
          // measurement; dressing the first as the second is what `I-062`
          // removed from the agent list. **The shape rule in
          // `test/greppable.test.ts` cannot catch this form** — after its
          // placeholders are stripped nothing non-hex is left — so it is fixed
          // here and the limit is recorded there.
          key: agentObj?.fingerprint ?? null,
          x: roundX,
          y: roundY,
          icon,
          displayName,
          directPeers: [],
        };
        memberIds.push(agentIdentity);
      }

      // Member internal loop edges (only for 2+ members)
      if (memberIds.length > 1) {
        for (let i = 0; i < memberIds.length; i++) {
          const nextIdx = (i + 1) % memberIds.length;
          const fromId = memberIds[i] ?? "";
          const toId = memberIds[nextIdx] ?? "";
          const nA = nodeDict[fromId];
          const nB = nodeDict[toId];
          if (nA && nB && fromId && toId && fromId !== toId) {
            edgeList.push({
              id: `edge-${cfg.id}-${fromId}-${toId}-${i}`,
              from: fromId,
              to: toId,
              d: `M ${nA.x},${nA.y} L ${nB.x},${nB.y}`,
              type: "member-edge",
            });
            nA.directPeers.push(toId);
            nB.directPeers.push(fromId);
          }
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

    // Exact 5% Margin Bounding Box Calculation around all drawn entities
    const entityW = Math.max(maxX - minX, 400);
    const entityH = Math.max(maxY - minY, 300);
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
      // **Counted from what was drawn, not accumulated while drawing.**
      //
      // It was `agentSum`, added to twice in the same pass — once from the
      // group's declared `member_count` and once from the member list actually
      // used — so every cluster contributed twice. And even one of those counts
      // memberships while `nodeDict` is keyed by identity, so an agent placed in
      // two clusters was two in the heading and one on the canvas.
      //
      // Measured: the heading said `6개 에이전트` over a canvas holding two, on a
      // mesh with two agents. `I-064` was the same fact told three ways; this is
      // the half of it that survived the fix, because nothing compared the
      // heading against the drawing. `SC-CONSIST-01` does.
      totalAgentCount: Object.values(nodeDict).filter((n) => n.type !== "gateway-bridge").length,
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
  }, [liveGroups, liveAgents]);

  // Selected Node Object
  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : null;

  // Search Results List (Autosuggest)
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return Object.values(nodes)
      .filter((n) => {
        return (
          n.identity.toLowerCase().includes(q) ||
          n.displayName.toLowerCase().includes(q) ||
          n.groupName.toLowerCase().includes(q)
        );
      })
      .slice(0, 8);
  }, [nodes, searchQuery]);

  // Filtered nodes
  const filteredNodeIds = useMemo(() => {
    let result = Object.keys(nodes);
    if (activeFilterGroup !== "all") {
      result = result.filter((id) => nodes[id]?.group === activeFilterGroup);
    }
    return result;
  }, [nodes, activeFilterGroup]);

  // Calculate the Fit Scale for the current viewport (with exact 5% margin)
  const getFitTransform = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return { scale: 0.38, panX: 0, panY: 0, fitScale: 0.38 };
    const rect = viewport.getBoundingClientRect();
    const vw = rect.width || 1200;
    const vh = rect.height || 700;

    // Scale to fit world bounds (with 5% margin) perfectly into viewport
    const scaleX = vw / bounds.worldW;
    const scaleY = vh / bounds.worldH;
    const fitScale = Math.min(scaleX, scaleY);

    const panX = vw / 2 - bounds.entityCX * fitScale;
    const panY = vh / 2 - bounds.entityCY * fitScale;

    return { scale: fitScale, panX, panY, fitScale, vw, vh };
  }, [bounds]);

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

      if (minPanX >= maxPanX) {
        clampedX = (vw - (bounds.worldMinX + bounds.worldMaxX) * targetScale) / 2;
      } else {
        clampedX = Math.min(Math.max(targetPanX, minPanX), maxPanX);
      }

      if (minPanY >= maxPanY) {
        clampedY = (vh - (bounds.worldMinY + bounds.worldMaxY) * targetScale) / 2;
      } else {
        clampedY = Math.min(Math.max(targetPanY, minPanY), maxPanY);
      }

      return { x: clampedX, y: clampedY };
    },
    [bounds]
  );

  // 2. SMOOTH FLIGHT ANIMATION TO CAMERA TARGET (Cubic Ease-Out Interpolation)
  const animateCameraTo = useCallback(
    (targetPanX: number, targetPanY: number, targetScale: number, duration: number = 420) => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }

      const clamped = clampPan(targetPanX, targetPanY, targetScale);
      const startPanX = transformRef.current.panX;
      const startPanY = transformRef.current.panY;
      const startScale = transformRef.current.scale;

      const endPanX = clamped.x;
      const endPanY = clamped.y;
      const endScale = targetScale;

      const startTime = performance.now();

      const step = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - progress, 3);

        const curPanX = startPanX + (endPanX - startPanX) * ease;
        const curPanY = startPanY + (endPanY - startPanY) * ease;
        const curScale = startScale + (endScale - startScale) * ease;

        transformRef.current = { panX: curPanX, panY: curPanY, scale: curScale };
        setPanX(curPanX);
        setPanY(curPanY);
        setScale(curScale);

        if (progress < 1) {
          animFrameRef.current = requestAnimationFrame(step);
        } else {
          animFrameRef.current = null;
        }
      };

      animFrameRef.current = requestAnimationFrame(step);
    },
    [clampPan]
  );

  // Focus and Center Camera on Node (Positioned slightly left of center so right drawer doesn't obstruct it)
  const focusAndFlyToNode = useCallback(
    (node: TopoNode) => {
      const viewport = viewportRef.current;
      const vw = viewport?.getBoundingClientRect().width || 1200;
      const vh = viewport?.getBoundingClientRect().height || 700;

      const targetScale = Math.max(transformRef.current.scale, 0.95);
      const targetPanX = vw * 0.42 - node.x * targetScale;
      const targetPanY = vh * 0.5 - node.y * targetScale;

      // Ensure activeFilterGroup does not hide the focused node
      setActiveFilterGroup("all");
      setSelectedNodeId(node.identity);
      setIsSearchOpen(false);

      animateCameraTo(targetPanX, targetPanY, targetScale, 450);
    },
    [animateCameraTo]
  );

  // Instant Search Pick & Fly Handler
  const handleSelectSearchResult = useCallback(
    (node: TopoNode) => {
      focusAndFlyToNode(node);
      setSearchQuery("");
      setIsSearchOpen(false);
    },
    [focusAndFlyToNode]
  );

  // Enter key press in search bar
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && searchResults.length > 0) {
      const firstMatch = searchResults[0];
      if (firstMatch) {
        handleSelectSearchResult(firstMatch);
      }
    } else if (e.key === "Escape") {
      setIsSearchOpen(false);
    }
  };

  // Close search suggestions on click outside
  useEffect(() => {
    const onOutsideClick = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
    };
    window.addEventListener("mousedown", onOutsideClick);
    return () => window.removeEventListener("mousedown", onOutsideClick);
  }, []);

  // Click handler for Connected Peer badge: Selects peer and animates camera
  const handleSelectPeer = useCallback(
    (peerId: string, e?: React.MouseEvent) => {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      const peerNode = nodes[peerId];
      if (peerNode) {
        focusAndFlyToNode(peerNode);
      } else {
        setSelectedNodeId(peerId);
      }
    },
    [nodes, focusAndFlyToNode]
  );

  // FIT-TO-SCREEN (Fits all drawn entities with exact 5% margin smoothly)
  const fitToScreen = useCallback(() => {
    const { scale: nextScale, panX: targetPanX, panY: targetPanY } = getFitTransform();
    animateCameraTo(targetPanX, targetPanY, nextScale, 400);
  }, [getFitTransform, animateCameraTo]);

  // Auto-fit to screen when live topology data updates
  useEffect(() => {
    const { scale: nextScale, panX: targetPanX, panY: targetPanY } = getFitTransform();
    const clamped = clampPan(targetPanX, targetPanY, nextScale);
    transformRef.current = { panX: clamped.x, panY: clamped.y, scale: nextScale };
    setScale(nextScale);
    setPanX(clamped.x);
    setPanY(clamped.y);
  }, [liveGroups, liveAgents, getFitTransform, clampPan]);

  // 3. MATHEMATICAL CURSOR-CENTERED ZOOM
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

      const { panX: curPanX, panY: curPanY, scale: curScale } = transformRef.current;
      const zoomFactor = e.deltaY < 0 ? 1.14 : 0.88;
      const rect = el.getBoundingClientRect();

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const worldX = (mouseX - curPanX) / curScale;
      const worldY = (mouseY - curPanY) / curScale;

      const { fitScale } = getFitTransform();
      const minScale = fitScale * 0.99;
      const maxScale = 2.5;

      const nextScale = Math.min(Math.max(curScale * zoomFactor, minScale), maxScale);

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
  }, [clampPan, getFitTransform]);

  // 4. GLOBAL DRAG PAN WITH POINTER CAPTURE
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".node-clickable")) return;
    if ((e.target as HTMLElement).closest(".minimap-container")) return;
    if ((e.target as HTMLElement).closest(".node-side-overlay")) return;
    if ((e.target as HTMLElement).closest(".canvas-hud-interactive")) return;

    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    e.preventDefault();

    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: transformRef.current.panX,
      panY: transformRef.current.panY,
    };

    if (viewportRef.current) {
      viewportRef.current.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    e.preventDefault();

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

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDragging(false);
      try {
        if (viewportRef.current && viewportRef.current.hasPointerCapture(e.pointerId)) {
          viewportRef.current.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Safe fallback
      }
    }
  };

  // Global window mouseup safety net
  useEffect(() => {
    const onGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
      }
    };
    window.addEventListener("mouseup", onGlobalMouseUp);
    window.addEventListener("pointerup", onGlobalMouseUp);
    return () => {
      window.removeEventListener("mouseup", onGlobalMouseUp);
      window.removeEventListener("pointerup", onGlobalMouseUp);
    };
  }, []);

  // 5. INTERACTIVE MINIMAP CLICK & DRAG NAVIGATION
  const isMinimapDraggingRef = useRef(false);

  const navigateFromMinimap = useCallback(
    (clientX: number, clientY: number, smooth: boolean = false) => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      const miniEl = document.querySelector(".minimap-container");
      if (!miniEl) return;
      const miniRect = miniEl.getBoundingClientRect();

      const clickX = Math.max(0, Math.min(clientX - miniRect.left, MINIMAP_W));
      const clickY = Math.max(0, Math.min(clientY - miniRect.top, MINIMAP_H));

      const aspectWorld = bounds.worldW / bounds.worldH;
      const aspectBox = MINIMAP_W / MINIMAP_H;

      let renderW = MINIMAP_W;
      let renderH = MINIMAP_H;
      let offsetX = 0;
      let offsetY = 0;

      if (aspectWorld > aspectBox) {
        renderW = MINIMAP_W;
        renderH = MINIMAP_W / aspectWorld;
        offsetY = (MINIMAP_H - renderH) / 2;
      } else {
        renderH = MINIMAP_H;
        renderW = MINIMAP_H * aspectWorld;
        offsetX = (MINIMAP_W - renderW) / 2;
      }

      const relX = Math.max(0, Math.min(clickX - offsetX, renderW)) / renderW;
      const relY = Math.max(0, Math.min(clickY - offsetY, renderH)) / renderH;

      const targetWorldX = bounds.worldMinX + relX * bounds.worldW;
      const targetWorldY = bounds.worldMinY + relY * bounds.worldH;

      const vpRect = viewport.getBoundingClientRect();
      const curScale = transformRef.current.scale;

      const targetPanX = vpRect.width / 2 - targetWorldX * curScale;
      const targetPanY = vpRect.height / 2 - targetWorldY * curScale;

      if (smooth) {
        animateCameraTo(targetPanX, targetPanY, curScale, 300);
      } else {
        const clamped = clampPan(targetPanX, targetPanY, curScale);
        transformRef.current.panX = clamped.x;
        transformRef.current.panY = clamped.y;
        setPanX(clamped.x);
        setPanY(clamped.y);
      }
    },
    [bounds, clampPan, animateCameraTo]
  );

  const handleMinimapMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    isMinimapDraggingRef.current = true;
    navigateFromMinimap(e.clientX, e.clientY, true);
  };

  useEffect(() => {
    const onWindowMouseMove = (e: MouseEvent) => {
      if (isMinimapDraggingRef.current) {
        navigateFromMinimap(e.clientX, e.clientY, false);
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
        setIsSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const zoomIn = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width || 1000;
    const vh = rect?.height || 700;
    const curScale = transformRef.current.scale;
    const nextScale = Math.min(curScale * 1.25, 2.5);

    const worldCenterX = (vw / 2 - transformRef.current.panX) / curScale;
    const worldCenterY = (vh / 2 - transformRef.current.panY) / curScale;

    const targetPanX = vw / 2 - worldCenterX * nextScale;
    const targetPanY = vh / 2 - worldCenterY * nextScale;

    animateCameraTo(targetPanX, targetPanY, nextScale, 260);
  };

  const zoomOut = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const vw = rect?.width || 1000;
    const vh = rect?.height || 700;
    const curScale = transformRef.current.scale;

    const { fitScale } = getFitTransform();
    const minScale = fitScale * 0.99;
    const nextScale = Math.max(curScale * 0.8, minScale);

    const worldCenterX = (vw / 2 - transformRef.current.panX) / curScale;
    const worldCenterY = (vh / 2 - transformRef.current.panY) / curScale;

    const targetPanX = vw / 2 - worldCenterX * nextScale;
    const targetPanY = vh / 2 - worldCenterY * nextScale;

    animateCameraTo(targetPanX, targetPanY, nextScale, 260);
  };

  const handleSendQuickMessage = async () => {
    if (!selectedNode) return;
    try {
      // `201` is not delivery. The server writes `failed` into this same
      // response when the hub refuses the message, and this toast used to say
      // "성공적으로 전송되었습니다" over that word — a refusal reported as a
      // success, in green, with nothing else on the screen to contradict it.
      const receipt = await sendMessageApi({
        to: selectedNode.identity,
        text: quickMsg,
      });
      setToastMsg(
        receipt.status === "failed"
          ? `${t("topo.send.refused", "허브가 거절했습니다")}: ${selectedNode.displayName} (${receipt.id})`
          : `${t("topo.send.accepted", "허브가 접수했습니다")}: ${selectedNode.displayName} (${receipt.id})`
      );
    } catch (err: any) {
      console.warn("[Topology] Quick send error:", err.message);
      setToastMsg(`${t("topo.send.failed", "전송 실패")}: ${selectedNode.displayName} — ${err.message || t("common.errorLoad", "불러오지 못함")}`);
    }
    setTimeout(() => setToastMsg(null), 3500);
  };

  // HTML Floating Lens Overlay Coordinates on Top of Minimap
  const minimapOverlayLens = useMemo(() => {
    const vw = viewportDim.width;
    const vh = viewportDim.height;

    const { fitScale } = getFitTransform();
    const isZoomedIn = scale > fitScale * 1.04;

    const aspectWorld = bounds.worldW / bounds.worldH;
    const aspectBox = MINIMAP_W / MINIMAP_H;

    let renderW = MINIMAP_W;
    let renderH = MINIMAP_H;
    let offsetX = 0;
    let offsetY = 0;

    if (aspectWorld > aspectBox) {
      renderW = MINIMAP_W;
      renderH = MINIMAP_W / aspectWorld;
      offsetY = (MINIMAP_H - renderH) / 2;
    } else {
      renderH = MINIMAP_H;
      renderW = MINIMAP_H * aspectWorld;
      offsetX = (MINIMAP_W - renderW) / 2;
    }

    const scaleX = renderW / bounds.worldW;
    const scaleY = renderH / bounds.worldH;

    const worldLeft = -panX / scale;
    const worldTop = -panY / scale;
    const worldWidth = vw / scale;
    const worldHeight = vh / scale;

    const rawLeft = offsetX + (worldLeft - bounds.worldMinX) * scaleX;
    const rawTop = offsetY + (worldTop - bounds.worldMinY) * scaleY;
    const rawW = worldWidth * scaleX;
    const rawH = worldHeight * scaleY;

    const left = Math.max(offsetX, Math.min(rawLeft, offsetX + renderW));
    const top = Math.max(offsetY, Math.min(rawTop, offsetY + renderH));
    const right = Math.max(offsetX, Math.min(rawLeft + rawW, offsetX + renderW));
    const bottom = Math.max(offsetY, Math.min(rawTop + rawH, offsetY + renderH));

    return {
      left,
      top,
      width: Math.max(4, right - left),
      height: Math.max(4, bottom - top),
      visible: isZoomedIn,
    };
  }, [panX, panY, scale, bounds, viewportDim, getFitTransform]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      {/* Clean Production Page Header */}
      <PageHeader
        title={t("topo.title", "에이전트 토폴로지")}
        subtitle={
          isLoading
            ? t("topology.loading", "Loading topology…")
            : isError
            ? t("common.loadError", "토폴로지 데이터를 불러오지 못했습니다.")
            : t("topo.subtitle", `실시간 연결된 ${clusters.length}개 그룹 네트워크 및 ${totalAgentCount}개 에이전트 라우팅 토폴로지`)
                .replace("{groups}", String(clusters.length))
                // Gateways are drawn, not connected. Adding them here made the
                // heading disagree with the counter beside it.
                .replace("{agents}", String(totalAgentCount))
        }
      />

      {/* Main Interactive Topology Viewport Container */}
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          height: 680,
          background: "#F8FAFC",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--color-border)",
          position: "relative",
          overflow: "hidden",
          cursor: isDragging ? "grabbing" : "grab",
          userSelect: "none",
          WebkitUserSelect: "none",
          touchAction: "none",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        {/* Top Left Clean Status HUD */}
        <div
          style={{
            position: "absolute",
            top: 14,
            left: 16,
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(255, 255, 255, 0.95)",
            backdropFilter: "blur(10px)",
            padding: "7px 16px",
            borderRadius: "var(--radius-full)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-primary)",
            fontSize: "0.8rem",
            fontWeight: 700,
            boxShadow: "0 2px 8px rgba(15, 23, 42, 0.06)",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: isLoading ? "#F59E0B" : (isError ? "#EF4444" : "#10B981"), display: "inline-block", boxShadow: "0 0 6px #10B981" }} />
          {isLoading ? (
            <span>{t("topology.loadingShort", "Loading topology…")}</span>
          ) : isError ? (
            <span style={{ color: "var(--color-danger)" }}>{t("common.disconnected", "통신 불가")}</span>
          ) : (
            <>
              <span>{t("topo.hud.groups", "Groups")}: {clusters.length}</span>
              <span style={{ color: "var(--color-text-muted)" }}>·</span>
              <span>{t("topo.hud.agents", "Agents")}: {totalAgentCount}</span>
              <span style={{ color: "var(--color-text-muted)" }}>·</span>
              <span>{t("topo.hud.gateways", "Gateways")}: {clusters.length}</span>
              <span style={{ color: "var(--color-text-muted)" }}>·</span>
              <span style={{ color: "var(--color-primary)", fontWeight: 800 }} title={t("topo.egressTitle", "그룹 간 메시지 전송 규칙이 적용 중입니다")}>
                {t("topo.hud.egress", "그룹 간 전송 규칙")}: {t("topo.hud.active", "적용 중")}
              </span>
            </>
          )}
        </div>

        {totalAgentCount === 0 && (
          <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", padding: "20px 32px", background: "rgba(255,255,255,0.96)", border: `1px solid ${isError ? "var(--color-danger)" : "var(--color-border)"}`, borderRadius: "var(--radius-lg)", color: isError ? "var(--color-danger)" : "var(--color-text-muted)", fontSize: "0.88rem", zIndex: 40, boxShadow: "0 10px 25px rgba(0,0,0,0.08)", textAlign: "center", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
            {isLoading ? (
              <span>{t("topo.loading", "토폴로지를 불러오는 중입니다...")}</span>
            ) : isError ? (
              <>
                <span>⚠️ {failure === "refused" ? refusedText(t, missing) : t("topo.error", "토폴로지를 불러오지 못했습니다 (서버가 답하지 않았습니다).")}</span>
                <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>↻ {t("common.retry", "재시도")}</Button>
              </>
            ) : (
              <span>{t("topo.empty", "토폴로지에 그릴 에이전트가 없습니다.")}</span>
            )}
          </div>
        )}

        {/* Top Right Compact Filter & Search Tool with Interactive Autocomplete Dropdown */}
        <div
          className="canvas-hud-interactive"
          style={{
            position: "absolute",
            top: 14,
            right: 16,
            zIndex: 30,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <select
            value={activeFilterGroup}
            onChange={(e) => setActiveFilterGroup(e.target.value)}
            style={{
              padding: "7px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--color-border)",
              background: "rgba(255, 255, 255, 0.95)",
              backdropFilter: "blur(10px)",
              fontSize: "0.8rem",
              fontWeight: 700,
              color: "var(--color-text-primary)",
              outline: "none",
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(15, 23, 42, 0.06)",
            }}
          >
            <option value="all">
              {t("topo.filter.all", `전체 그룹 보기 (${clusters.length})`).replace("{count}", String(clusters.length))}
            </option>
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>

          {/* Search Input Box with Autocomplete Fly-to Popup */}
          <div ref={searchWrapRef} style={{ position: "relative" }}>
            <input
              type="text"
              placeholder={t("topo.search.placeholder", "에이전트 검색 (핀둥이, claude)...")}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsSearchOpen(true);
              }}
              onFocus={() => setIsSearchOpen(true)}
              onKeyDown={handleSearchKeyDown}
              style={{
                padding: "7px 14px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
                background: "rgba(255, 255, 255, 0.95)",
                backdropFilter: "blur(10px)",
                fontSize: "0.8rem",
                color: "var(--color-text-primary)",
                outline: "none",
                width: 220,
                boxShadow: "0 2px 8px rgba(15, 23, 42, 0.06)",
              }}
            />

            {/* Suggestions Dropdown Box */}
            {isSearchOpen && searchResults.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  width: 260,
                  background: "#FFFFFF",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  boxShadow: "0 10px 25px -5px rgba(15, 23, 42, 0.15)",
                  overflow: "hidden",
                  zIndex: 100,
                  maxHeight: 280,
                  overflowY: "auto",
                }}
              >
                <div style={{ padding: "6px 10px", fontSize: "0.7rem", fontWeight: 800, color: "var(--color-text-muted)", background: "var(--color-bg-surface-sub)", borderBottom: "1px solid var(--color-border)" }}>
                  {t("topo.results", "검색 결과")} ({searchResults.length})
                </div>
                {searchResults.map((node) => (
                  <div
                    key={node.identity}
                    onClick={() => handleSelectSearchResult(node)}
                    style={{
                      padding: "8px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      cursor: "pointer",
                      borderBottom: "1px solid var(--color-border)",
                      transition: "background 0.15s ease",
                    }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#EFF6FF")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                  >
                    <span style={{ fontSize: "1rem" }}>{node.icon}</span>
                    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                      <span style={{ fontSize: "0.8rem", fontWeight: 800, color: "var(--color-text-primary)", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
                        {node.displayName}
                      </span>
                      <span style={{ fontSize: "0.68rem", color: "var(--color-text-muted)" }}>
                        {node.groupName}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Scalable & Pannable SVG World Layer ── */}
        <svg
          style={{
            width: "100%",
            height: "100%",
            overflow: "visible",
            display: "block",
            pointerEvents: isDragging ? "none" : "auto",
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
              /* `data-testid` so a scenario can count what is drawn rather than
                 re-deriving it. The heading states these counts, and the two
                 disagreeing is what `I-064` was. */
              <g key={c.id} data-testid="topology-cluster">
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
              const isOnline = node.status === "Seen";

              if (node.type === "gateway-bridge") {
                return (
                  <g
                    key={node.identity}
                    /* Gateways are drawn and are **not** in `totalAgentCount` —
                       the heading says so. Named apart so a scenario counting
                       agents cannot pick them up by accident. */
                    data-testid="topology-gateway"
                    className="node-clickable"
                    onClick={() => focusAndFlyToNode(node)}
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
                  data-testid="topology-agent"
                  className="node-clickable"
                  onClick={() => focusAndFlyToNode(node)}
                  style={{
                    cursor: "pointer",
                    opacity: isMatch ? 1 : 0.2,
                    transform: isSelected ? "scale(1.3)" : isPeer ? "scale(1.15)" : "scale(1)",
                    transformOrigin: `${node.x}px ${node.y}px`,
                    transition: "transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                >
                  <circle cx={node.x} cy={node.y} r={36} fill="transparent" />

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
          <button onClick={zoomIn} style={hudBtnStyle} title={t("topo.zoomIn", "확대")}>➕</button>
          <span style={{ fontSize: "0.75rem", fontWeight: 700, minWidth: 44, textAlign: "center", color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>
            {Math.round(scale * 100)}%
          </span>
          <button onClick={zoomOut} style={hudBtnStyle} title={t("topo.zoomOut", "축소")}>➖</button>
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
            title={t("topo.fit", "화면 맞춤")}
          >
            Fit
          </button>
        </div>

        {/* ── Interactive Mini-Map (Bottom-Left) with Clean Floating Viewport Lens Overlay ── */}
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
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 4px 14px rgba(15, 23, 42, 0.1)",
            overflow: "hidden",
            zIndex: 40,
            cursor: "crosshair",
            userSelect: "none",
          }}
          onMouseDown={handleMinimapMouseDown}
          title={t("topo.minimap", "미니맵 — 클릭하거나 끌어서 이동")}
        >
          {/* Static Background Cluster Map */}
          <svg
            style={{ width: "100%", height: "100%", display: "block" }}
            viewBox={`${bounds.worldMinX} ${bounds.worldMinY} ${bounds.worldW} ${bounds.worldH}`}
            preserveAspectRatio="xMidYMid meet"
          >
            {clusters.map((c) => (
              <circle
                key={c.id}
                cx={c.cx}
                cy={c.cy}
                r={c.r}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth={bounds.worldW / 350}
              />
            ))}
          </svg>

          {/* Floating Viewport Lens Overlay (Clean, ONLY visible when zoomed in) */}
          {minimapOverlayLens.visible && (
            <div
              style={{
                position: "absolute",
                left: minimapOverlayLens.left,
                top: minimapOverlayLens.top,
                width: minimapOverlayLens.width,
                height: minimapOverlayLens.height,
                background: "rgba(37, 99, 235, 0.18)",
                border: "1.5px solid #2563EB",
                borderRadius: 4,
                boxShadow: "0 0 6px rgba(37, 99, 235, 0.35)",
                pointerEvents: "none",
                boxSizing: "border-box",
                transition: "all 0.05s ease-out",
              }}
            />
          )}
        </div>

        {/* ── Slide-out Node Inspector Drawer (Right Side) ── */}
        {selectedNode && (
          <div
            className="node-side-overlay"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
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
              userSelect: "text",
              WebkitUserSelect: "text",
              cursor: "default",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--color-bg-surface-sub)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}>
                  {selectedNode.icon}
                </div>
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
              <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "var(--radius-full)", background: selectedNode.status === "Seen" ? "#ECFDF5" : "#EFF6FF", color: selectedNode.status === "Seen" ? "#059669" : "#2563EB", fontWeight: 700 }}>
                ● {selectedNode.status === "Seen" ? t("dash.op.seen", "접속 기록 있음") : t("dash.op.neverSeen", "접속 기록 없음")}
              </span>
              <span style={{ fontSize: "0.7rem", padding: "2px 8px", borderRadius: "var(--radius-full)", background: "var(--color-bg-surface-sub)", color: "var(--color-text-secondary)", fontWeight: 600 }}>
                Type: {selectedNode.type}
              </span>
            </div>

            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
              {selectedNode.desc}
            </p>

            {/* Quick Message Box */}
            <div style={{ background: "var(--color-bg-surface-sub)", padding: 12, borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--color-text-secondary)" }}>
                ✉ {t("topo.send", "메시지 보내보기")}
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
                {t("topo.peers", "연결된 피어")} ({selectedNode.directPeers.length}):
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 120, overflowY: "auto" }}>
                {selectedNode.directPeers.map((peer) => (
                  <button
                    key={peer}
                    onClick={(e) => handleSelectPeer(peer, e)}
                    style={{
                      background: "var(--color-bg-surface-sub)",
                      border: "1.5px solid var(--color-primary)",
                      color: "var(--color-primary)",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      padding: "4px 10px",
                      borderRadius: "var(--radius-full)",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      transition: "all 0.15s ease",
                      boxShadow: "0 1px 3px rgba(37, 99, 235, 0.15)",
                    }}
                    title={peer}
                  >
                    🔗 {peer}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {toastMsg && <Toast message={toastMsg} type="success" onClose={() => setToastMsg(null)} />}
    </div>
  );
}

const hudBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  fontSize: "0.85rem",
  padding: "4px 6px",
  borderRadius: "var(--radius-sm)",
};
