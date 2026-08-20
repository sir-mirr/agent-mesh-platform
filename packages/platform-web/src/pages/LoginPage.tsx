import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@/api/client.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";

interface NodeDef {
  id: string;
  baseX: number;
  baseY: number;
  type: "character" | "dot" | "isolated";
  name?: string;
  avatar?: string;
  color?: string;
  size: number;
  speed: number;
  ampX: number;
  ampY: number;
  phase: number;
}

interface EdgeDef {
  from: string;
  to: string;
  color?: string;
}

interface PacketDef {
  from: string;
  to: string;
  color: string;
  progress: number;
  speed: number;
}

export function LoginPage() {
  const navigate = useNavigate();
  const { loginWithLocal, loginWithGitHub } = useAuth();
  const { language, setLanguage, t } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  // **Empty, because this screen is served to a real server's operators.**
  //
  // They arrived as `useState("admin")` — the form came up with a working
  // credential already typed, and one click signed anybody who reached the page
  // in as the platform administrator. In a lab that is convenience; on a
  // deployment it is the account name and the password printed on the login
  // screen. It is the other half of the 시뮬레이션 역할 picker removed alongside
  // it: neither raised a privilege, and both handed out an identity nobody
  // proved they had.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // **The throw used to leave through here.** `loginWithLocal` rejects when the
  // server refuses *and* when there is no server, the exception escaped the
  // handler, `navigate` never ran, and the form sat there having said nothing.
  // On a deployment with the backend down that is the only screen reachable,
  // and pressing the button on it did nothing at all, silently.
  const [loginError, setLoginError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      await loginWithLocal(username, password);
    } catch (err: any) {
      setLoginError(
        err instanceof ApiError && !err.refused
          ? t("login.unreachable", "서버에 연결할 수 없습니다 — 아이디·비밀번호 문제가 아닙니다.")
          : err?.message || t("login.failed", "로그인에 실패했습니다."),
      );
      return;
    }
    navigate("/dashboard");
  };

  const handleGitHubLogin = () => {
    loginWithGitHub();
    navigate("/dashboard");
  };

  // Core character and network nodes
  const nodesRef = useRef<NodeDef[]>([
    // 3 Main Characters
    { id: "fin", baseX: 220, baseY: 300, type: "character", name: t("login.demo.fin", "Fin둥이"), avatar: "/assets/agent-fin.png", color: "#38BDF8", size: 54, speed: 0.8, ampX: 10, ampY: 14, phase: 0 },
    { id: "pinja", baseX: 400, baseY: 420, type: "character", name: t("login.demo.pinja", "Fin자"), avatar: "/assets/agent-support.png", color: "#34D399", size: 54, speed: 0.7, ampX: 12, ampY: 10, phase: 2.1 },
    { id: "areum", baseX: 260, baseY: 620, type: "character", name: t("login.demo.areum", "아름이"), avatar: "/assets/agent-assistant.png", color: "#C084FC", size: 54, speed: 0.75, ampX: 14, ampY: 12, phase: 4.2 },

    // Left Wing Connected Nodes
    { id: "n1", baseX: 100, baseY: 160, type: "dot", size: 14, speed: 0.9, ampX: 8, ampY: 10, phase: 1.0 },
    { id: "n2", baseX: 340, baseY: 150, type: "dot", size: 16, speed: 0.85, ampX: 10, ampY: 8, phase: 3.2 },
    { id: "n3", baseX: 500, baseY: 220, type: "dot", size: 17, speed: 0.7, ampX: 9, ampY: 11, phase: 5.1 },
    { id: "n4", baseX: 110, baseY: 460, type: "dot", size: 14, speed: 0.8, ampX: 11, ampY: 9, phase: 2.7 },
    { id: "n5", baseX: 480, baseY: 500, type: "dot", size: 18, speed: 0.75, ampX: 10, ampY: 12, phase: 0.8 },
    { id: "n6", baseX: 160, baseY: 760, type: "dot", size: 15, speed: 0.65, ampX: 9, ampY: 8, phase: 4.5 },
    { id: "n7", baseX: 400, baseY: 770, type: "dot", size: 16, speed: 0.7, ampX: 10, ampY: 11, phase: 1.8 },

    // Center Interconnect Nodes
    { id: "n8", baseX: 640, baseY: 280, type: "dot", size: 18, speed: 0.8, ampX: 11, ampY: 13, phase: 3.6 },
    { id: "n9", baseX: 740, baseY: 460, type: "dot", size: 20, speed: 0.65, ampX: 8, ampY: 10, phase: 2.2 },
    { id: "n10", baseX: 610, baseY: 640, type: "dot", size: 16, speed: 0.75, ampX: 12, ampY: 9, phase: 5.4 },
    { id: "n11", baseX: 820, baseY: 230, type: "dot", size: 17, speed: 0.85, ampX: 10, ampY: 11, phase: 0.5 },
    { id: "n12", baseX: 900, baseY: 400, type: "dot", size: 19, speed: 0.7, ampX: 9, ampY: 12, phase: 4.1 },
    { id: "n13", baseX: 770, baseY: 680, type: "dot", size: 17, speed: 0.8, ampX: 11, ampY: 8, phase: 1.9 },
    { id: "n14", baseX: 970, baseY: 590, type: "dot", size: 18, speed: 0.75, ampX: 10, ampY: 10, phase: 3.3 },

    // Right Wing Connected Nodes
    { id: "n15", baseX: 1000, baseY: 170, type: "dot", size: 16, speed: 0.9, ampX: 8, ampY: 12, phase: 2.8 },
    { id: "n16", baseX: 1180, baseY: 130, type: "dot", size: 18, speed: 0.75, ampX: 11, ampY: 9, phase: 5.0 },
    { id: "n17", baseX: 1340, baseY: 210, type: "dot", size: 15, speed: 0.85, ampX: 9, ampY: 11, phase: 1.4 },
    { id: "n18", baseX: 1160, baseY: 340, type: "dot", size: 20, speed: 0.7, ampX: 12, ampY: 10, phase: 3.9 },
    { id: "n19", baseX: 1300, baseY: 420, type: "dot", size: 17, speed: 0.8, ampX: 10, ampY: 13, phase: 0.3 },
    { id: "n20", baseX: 1400, baseY: 530, type: "dot", size: 15, speed: 0.75, ampX: 8, ampY: 9, phase: 4.7 },
    { id: "n21", baseX: 1140, baseY: 570, type: "dot", size: 19, speed: 0.7, ampX: 11, ampY: 11, phase: 2.5 },
    { id: "n22", baseX: 1280, baseY: 690, type: "dot", size: 16, speed: 0.85, ampX: 9, ampY: 12, phase: 5.8 },
    { id: "n23", baseX: 1060, baseY: 750, type: "dot", size: 18, speed: 0.65, ampX: 10, ampY: 8, phase: 1.2 },

    // Isolated Standalone Stars (Only 4)
    { id: "iso1", baseX: 560, baseY: 110, type: "isolated", size: 8, speed: 0.5, ampX: 6, ampY: 6, phase: 0 },
    { id: "iso2", baseX: 1400, baseY: 100, type: "isolated", size: 7, speed: 0.6, ampX: 5, ampY: 7, phase: 1.5 },
    { id: "iso3", baseX: 50, baseY: 640, type: "isolated", size: 7, speed: 0.55, ampX: 6, ampY: 5, phase: 3.0 },
    { id: "iso4", baseX: 910, baseY: 790, type: "isolated", size: 8, speed: 0.5, ampX: 5, ampY: 6, phase: 4.8 },
  ]);

  // Edges connecting nodes
  const edgesRef = useRef<EdgeDef[]>([
    // Character Triad Loop
    { from: "fin", to: "pinja", color: "#38BDF8" },
    { from: "pinja", to: "areum", color: "#34D399" },
    { from: "areum", to: "fin", color: "#C084FC" },

    // Left Wing Connections
    { from: "n1", to: "fin" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "fin" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "pinja" },
    { from: "n4", to: "fin" },
    { from: "n4", to: "areum" },
    { from: "areum", to: "n5" },
    { from: "pinja", to: "n5" },
    { from: "areum", to: "n6" },
    { from: "areum", to: "n7" },
    { from: "n6", to: "n7" },
    { from: "n5", to: "n7" },

    // Center Crossings
    { from: "n3", to: "n8", color: "#38BDF8" },
    { from: "n8", to: "n9" },
    { from: "n5", to: "n9", color: "#34D399" },
    { from: "n5", to: "n10" },
    { from: "n9", to: "n10" },
    { from: "n7", to: "n10" },
    { from: "n8", to: "n11" },
    { from: "n11", to: "n12" },
    { from: "n9", to: "n12", color: "#C084FC" },
    { from: "n9", to: "n13" },
    { from: "n10", to: "n13" },
    { from: "n12", to: "n14", color: "#38BDF8" },
    { from: "n13", to: "n14" },

    // Right Wing Connections
    { from: "n11", to: "n15" },
    { from: "n15", to: "n16" },
    { from: "n16", to: "n17" },
    { from: "n15", to: "n18", color: "#38BDF8" },
    { from: "n16", to: "n18" },
    { from: "n17", to: "n19" },
    { from: "n18", to: "n19", color: "#34D399" },
    { from: "n12", to: "n18" },
    { from: "n14", to: "n21" },
    { from: "n18", to: "n21", color: "#C084FC" },
    { from: "n19", to: "n20" },
    { from: "n20", to: "n22" },
    { from: "n21", to: "n22", color: "#38BDF8" },
    { from: "n14", to: "n23" },
    { from: "n21", to: "n23" },
    { from: "n22", to: "n23" },
    { from: "n13", to: "n23" },
  ]);

  // Packets that travel strictly along edges
  const packetsRef = useRef<PacketDef[]>([
    { from: "fin", to: "pinja", color: "#38BDF8", progress: 0.1, speed: 0.006 },
    { from: "pinja", to: "areum", color: "#34D399", progress: 0.4, speed: 0.0055 },
    { from: "areum", to: "fin", color: "#C084FC", progress: 0.7, speed: 0.005 },
    { from: "n1", to: "fin", color: "#38BDF8", progress: 0.3, speed: 0.0045 },
    { from: "areum", to: "n7", color: "#34D399", progress: 0.6, speed: 0.0048 },
    { from: "n3", to: "n8", color: "#38BDF8", progress: 0.2, speed: 0.0042 },
    { from: "n5", to: "n9", color: "#34D399", progress: 0.5, speed: 0.0047 },
    { from: "n9", to: "n12", color: "#C084FC", progress: 0.8, speed: 0.0043 },
    { from: "n9", to: "n13", color: "#38BDF8", progress: 0.15, speed: 0.0046 },
    { from: "n15", to: "n18", color: "#38BDF8", progress: 0.35, speed: 0.005 },
    { from: "n18", to: "n19", color: "#34D399", progress: 0.65, speed: 0.0048 },
    { from: "n18", to: "n21", color: "#C084FC", progress: 0.9, speed: 0.0045 },
    { from: "n21", to: "n22", color: "#38BDF8", progress: 0.25, speed: 0.0052 },
    { from: "n13", to: "n23", color: "#34D399", progress: 0.55, speed: 0.0044 },
  ]);

  // Character positions for HTML avatar overlay
  const [characterPos, setCharacterPos] = useState<Record<string, { x: number; y: number }>>({
    fin: { x: 220, y: 300 },
    pinja: { x: 400, y: 420 },
    areum: { x: 260, y: 620 },
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let startTime = performance.now();

    const render = (time: number) => {
      const t = (time - startTime) * 0.001; // in seconds

      // Handle canvas resolution
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.clearRect(0, 0, width, height);

      // Coordinate scaling based on 1440 x 900 design
      const scaleX = width / 1440;
      const scaleY = height / 900;
      const scale = Math.min(scaleX, scaleY);
      const offsetX = (width - 1440 * scale) / 2;
      const offsetY = (height - 900 * scale) / 2;

      // 1. Compute dynamic positions for all nodes
      const posMap: Record<string, { x: number; y: number; node: NodeDef }> = {};
      const nextCharPos: Record<string, { x: number; y: number }> = {};

      nodesRef.current.forEach((node) => {
        const currentBaseX = node.baseX * scale + offsetX;
        const currentBaseY = node.baseY * scale + offsetY;
        const dynX = currentBaseX + Math.sin(t * node.speed + node.phase) * (node.ampX * scale);
        const dynY = currentBaseY + Math.cos(t * node.speed * 0.85 + node.phase) * (node.ampY * scale);

        posMap[node.id] = { x: dynX, y: dynY, node };

        if (node.type === "character") {
          nextCharPos[node.id] = { x: dynX, y: dynY };
        }
      });

      // 2. Draw Translucent Glow Polygons (Wireframe Facets)
      const facetTriangles: [string, string, string][] = [
        ["fin", "pinja", "areum"],
        ["n1", "n2", "fin"],
        ["n2", "n3", "pinja"],
        ["n4", "fin", "areum"],
        ["areum", "n6", "n7"],
        ["areum", "pinja", "n5"],
        ["n3", "n8", "n9"],
        ["n5", "n9", "n10"],
        ["n8", "n11", "n12"],
        ["n9", "n12", "n14"],
        ["n9", "n10", "n13"],
        ["n11", "n15", "n18"],
        ["n16", "n17", "n19"],
        ["n15", "n18", "n16"],
        ["n18", "n19", "n21"],
        ["n19", "n20", "n22"],
        ["n21", "n22", "n23"],
        ["n14", "n21", "n23"],
      ];

      facetTriangles.forEach(([idA, idB, idC]) => {
        const pA = posMap[idA];
        const pB = posMap[idB];
        const pC = posMap[idC];
        if (pA && pB && pC) {
          ctx.beginPath();
          ctx.moveTo(pA.x, pA.y);
          ctx.lineTo(pB.x, pB.y);
          ctx.lineTo(pC.x, pC.y);
          ctx.closePath();
          ctx.fillStyle = "rgba(56, 189, 248, 0.035)";
          ctx.fill();
        }
      });

      // 3. Draw All Dynamic Interconnection Lines (Edges that STAY ATTACHED to Moving Nodes)
      edgesRef.current.forEach((edge) => {
        const pA = posMap[edge.from];
        const pB = posMap[edge.to];
        if (!pA || !pB) return;

        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);

        ctx.save();
        ctx.setLineDash([5 * scale, 5 * scale]);
        ctx.lineDashOffset = -t * 24;

        if (edge.color) {
          ctx.strokeStyle = edge.color;
          ctx.globalAlpha = 0.65;
          ctx.lineWidth = 1.8 * scale;
        } else {
          ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 1.2 * scale;
        }

        ctx.stroke();
        ctx.restore();
      });

      // 4. Update and Draw Moving Data Packets (Mathematically Locked Strictly on Dynamic Lines)
      packetsRef.current.forEach((packet) => {
        packet.progress = (packet.progress + packet.speed) % 1.0;

        const pA = posMap[packet.from];
        const pB = posMap[packet.to];
        if (!pA || !pB) return;

        // Current position linearly interpolated between dynamic moving endpoints
        const px = pA.x + (pB.x - pA.x) * packet.progress;
        const py = pA.y + (pB.y - pA.y) * packet.progress;

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, 3.8 * scale, 0, Math.PI * 2);
        ctx.fillStyle = packet.color;
        ctx.shadowColor = packet.color;
        ctx.shadowBlur = 10 * scale;
        ctx.fill();
        ctx.restore();
      });

      // 5. Draw All Connected Secondary Dots and Isolated Dots
      nodesRef.current.forEach((node) => {
        if (node.type === "character") return;

        const p = posMap[node.id];
        if (!p) return;

        ctx.save();
        ctx.beginPath();
        const r = (node.size / 2) * scale;
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);

        if (node.type === "isolated") {
          ctx.fillStyle = "rgba(186, 230, 253, 0.6)";
          ctx.shadowColor = "#BAE6FD";
          ctx.shadowBlur = 8 * scale;
          ctx.fill();
        } else {
          ctx.fillStyle = "#38BDF8";
          ctx.shadowColor = "#38BDF8";
          ctx.shadowBlur = 12 * scale;
          ctx.fill();

          // Crisp White Border
          ctx.lineWidth = 1.5 * scale;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
          ctx.stroke();
        }

        ctx.restore();
      });

      // Update character HTML overlay coordinates in sync
      setCharacterPos(nextCharPos);

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, []);

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
        padding: 24,
      }}
    >
      {/* **The only control on this page that is not the form.** The switcher
          otherwise lives in the sidebar, and the sidebar is behind the login —
          so a visitor who cannot read this screen could not reach the thing
          that would translate it.

          A combo rather than two flags side by side: the sidebar already picks
          languages this way (trigger, panel, a check on the active one), and a
          screen that invents a second idiom for the same job teaches the reader
          that they are different jobs. */}
      <div data-testid="lang-toggle" style={{ position: "absolute", top: 16, right: 20, zIndex: 50 }}>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={langOpen}
          aria-label={t("login.lang.aria", "언어: 한국어")}
          data-testid="lang-trigger"
          onClick={() => setLangOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.25)",
            background: "rgba(255,255,255,0.10)",
            color: "#E2E8F0",
            fontSize: "0.82rem",
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: "1.05rem", lineHeight: 1 }}>{language === "en" ? "\u{1F1FA}\u{1F1F8}" : "\u{1F1F0}\u{1F1F7}"}</span>
          <span>{language === "en" ? "English" : "\ud55c\uad6d\uc5b4"}</span>
          <span style={{ fontSize: "0.7rem", opacity: 0.75 }}>{langOpen ? "\u25B2" : "\u25BC"}</span>
        </button>

        {langOpen && (
          <div
            role="listbox"
            data-testid="lang-menu"
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              minWidth: 160,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "#0F172A",
              boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
              overflow: "hidden",
            }}
          >
            {(["en", "ko"] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                role="option"
                aria-selected={language === lang}
                data-lang={lang}
                data-active={language === lang ? "yes" : "no"}
                onClick={() => {
                  setLanguage(lang);
                  setLangOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  gap: 10,
                  padding: "9px 12px",
                  border: "none",
                  background: language === lang ? "rgba(56,189,248,0.16)" : "transparent",
                  color: "#E2E8F0",
                  fontSize: "0.85rem",
                  fontFamily: "inherit",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: "1.05rem", lineHeight: 1 }}>{lang === "en" ? "\u{1F1FA}\u{1F1F8}" : "\u{1F1F0}\u{1F1F7}"}</span>
                  <span>{lang === "en" ? "English" : "\ud55c\uad6d\uc5b4"}</span>
                </span>
                {language === lang && <span style={{ fontSize: "0.8rem", fontWeight: 800 }}>{"\u2713"}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* ── Softly Blurred Dynamic Ambient Background (Canvas + Character Overlay) ── */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          filter: "blur(1.75px)",
          opacity: 0.92,
          pointerEvents: "none",
          zIndex: 1,
          transform: "scale(1.015)", // Prevents blur edge artifacts
        }}
      >
        {/* Dynamic 60fps Physics Canvas */}
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "block",
          }}
        />

        {/* 1. 핀둥이 */}
        {characterPos.fin && (
          <div
            style={{
              position: "absolute",
              left: characterPos.fin.x,
              top: characterPos.fin.y,
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              userSelect: "none",
            }}
          >
            <div style={{ position: "relative", width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div className="agent-glow-ring ring-blue" />
              <div className="agent-avatar-frame">
                <img src="/assets/agent-fin.png" alt={t("login.demo.fin", "Fin둥이")} className="agent-avatar-img" />
              </div>
            </div>
            <span
              style={{
                marginTop: 6,
                fontSize: "0.82rem",
                fontWeight: 750,
                color: "#FFFFFF",
                textShadow: "0 1px 4px rgba(0, 0, 0, 0.9), 0 0 10px rgba(56, 189, 248, 0.7)",
                whiteSpace: "nowrap",
              }}
            >
              {t("login.demo.fin", "Fin둥이")}
            </span>
          </div>
        )}

        {/* 2. 핀자 */}
        {characterPos.pinja && (
          <div
            style={{
              position: "absolute",
              left: characterPos.pinja.x,
              top: characterPos.pinja.y,
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              userSelect: "none",
            }}
          >
            <div style={{ position: "relative", width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div className="agent-glow-ring ring-emerald" />
              <div className="agent-avatar-frame">
                <img src="/assets/agent-support.png" alt={t("login.demo.pinja", "Fin자")} className="agent-avatar-img" />
              </div>
            </div>
            <span
              style={{
                marginTop: 6,
                fontSize: "0.82rem",
                fontWeight: 750,
                color: "#FFFFFF",
                textShadow: "0 1px 4px rgba(0, 0, 0, 0.9), 0 0 10px rgba(52, 211, 153, 0.7)",
                whiteSpace: "nowrap",
              }}
            >
              {t("login.demo.pinja", "Fin자")}
            </span>
          </div>
        )}

        {/* 3. 아름이 */}
        {characterPos.areum && (
          <div
            style={{
              position: "absolute",
              left: characterPos.areum.x,
              top: characterPos.areum.y,
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              userSelect: "none",
            }}
          >
            <div style={{ position: "relative", width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div className="agent-glow-ring ring-purple" />
              <div className="agent-avatar-frame">
                <img src="/assets/agent-assistant.png" alt={t("login.demo.areum", "아름이")} className="agent-avatar-img" />
              </div>
            </div>
            <span
              style={{
                marginTop: 6,
                fontSize: "0.82rem",
                fontWeight: 750,
                color: "#FFFFFF",
                textShadow: "0 1px 4px rgba(0, 0, 0, 0.9), 0 0 10px rgba(192, 132, 252, 0.7)",
                whiteSpace: "nowrap",
              }}
            >
              {t("login.demo.areum", "아름이")}
            </span>
          </div>
        )}
      </div>

      {/* ── Foreground Crystal-Sharp Center Login Box (중앙 박스 복원) ── */}
      <div
        style={{
          background: "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(24px)",
          border: "1px solid rgba(255, 255, 255, 0.8)",
          borderRadius: "var(--radius-xl)",
          padding: "40px 36px",
          width: "100%",
          maxWidth: 440,
          boxShadow: "0 25px 60px -15px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.9) inset",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          position: "relative",
          zIndex: 20,
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
            {t("login.subtitle", "Single sign-on and RBAC administration gateway")}
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
          {t("login.github", "Continue with GitHub")}
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
          {t("login.or", "or a local account")}
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
            <label style={labelStyle}>{t("login.id", "Username")}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("login.idPlaceholder", "username")}
              autoComplete="username"
              style={inputStyle}
              required
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={labelStyle}>{t("login.password", "Password")}</label>
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

          {loginError && (
            <div
              data-testid="login-error"
              style={{
                border: "1px solid var(--color-danger, #EF4444)",
                borderRadius: "var(--radius-md)",
                padding: "10px 12px",
                fontSize: "0.85rem",
                color: "var(--color-danger, #EF4444)",
              }}
            >
              {loginError}
            </div>
          )}

          <button type="submit" style={btnPrimaryStyle}>
            {t("login.submit", "Sign in")}
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
          {t("login.capNote", "The sidebar shows what the server granted this account. The screen does not choose it.")}
        </p>
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
