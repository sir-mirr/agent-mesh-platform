import React, { useState } from "react";
import { PageHeader, SubNavPills, Button, StatusBadge } from "@/components/index.ts";

export function TopologyPage() {
  const [selectedCluster, setSelectedCluster] = useState<string | null>("Support Swarm");

  const subNavItems = [
    { label: "내 에이전트", href: "/creator", icon: "🤖" },
    { label: "스웜 그룹 관리", href: "/creator/groups", icon: "👥" },
    { label: "스웜 토폴로지", href: "/creator/topology", icon: "🌐" },
    { label: "메시지 테스트", href: "/creator/playground", icon: "💬" },
    { label: "소켓리스 큐", href: "/creator/lease-queue", icon: "📥" },
    { label: "에이전트 등록", href: "/creator/register", icon: "➕" },
  ];

  const clusters = [
    { name: "Support Swarm", count: 2, status: "Active", color: "#2563EB" },
    { name: "Billing Core", count: 1, status: "Active", color: "#10B981" },
    { name: "Analytics Swarm", count: 1, status: "Idle", color: "#F59E0B" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SubNavPills items={subNavItems} />

      <PageHeader
        suiteTag="STUDIO SUITE"
        suiteBadgeColor="leased"
        screenId="38"
        title="스웜 갤럭시 토폴로지 & 엣지 채널"
        subtitle="원형 오비탈 노드-엣지 인터랙티브 시각화 및 클러스터 간 라우팅 채널 모니터링"
        actions={
          <Button variant="secondary" size="sm">
            🎯 포커스 뷰 전환
          </Button>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20 }}>
        {/* Visual Galaxy Canvas */}
        <div
          style={{
            background: "radial-gradient(circle at center, #1E293B 0%, #0F172A 100%)",
            borderRadius: "var(--radius-xl)",
            minHeight: 460,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
            color: "white",
            padding: 24,
          }}
        >
          {/* Orbital rings */}
          <div
            style={{
              position: "absolute",
              width: 320,
              height: 320,
              borderRadius: "50%",
              border: "1px dashed rgba(255,255,255,0.15)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              width: 200,
              height: 200,
              borderRadius: "50%",
              border: "1px dashed rgba(255,255,255,0.25)",
              pointerEvents: "none",
            }}
          />

          {/* Central Hub */}
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
              boxShadow: "0 0 30px rgba(37,99,235,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: "0.85rem",
              zIndex: 2,
            }}
          >
            HUB
          </div>

          {/* Satellite Clusters */}
          {clusters.map((c, idx) => {
            const angle = (idx * 2 * Math.PI) / clusters.length;
            const x = Math.cos(angle) * 110;
            const y = Math.sin(angle) * 110;
            const isSelected = selectedCluster === c.name;

            return (
              <div
                key={c.name}
                onClick={() => setSelectedCluster(c.name)}
                style={{
                  position: "absolute",
                  transform: `translate(${x}px, ${y}px)`,
                  width: 54,
                  height: 54,
                  borderRadius: "50%",
                  background: isSelected ? c.color : "#334155",
                  border: `2px solid ${c.color}`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  boxShadow: isSelected ? `0 0 20px ${c.color}` : "none",
                  transition: "all 0.2s ease",
                  zIndex: 3,
                }}
              >
                <span>{c.count}</span>
                <span style={{ fontSize: "0.6rem", opacity: 0.8 }}>Agts</span>
              </div>
            );
          })}
        </div>

        {/* Selected Cluster Info */}
        <div
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-xl)",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>
            🔍 클러스터 상세 정보
          </h3>

          {selectedCluster ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: "1.1rem" }}>{selectedCluster}</strong>
                <StatusBadge label="ACTIVE" status="online" size="sm" />
              </div>

              <div
                style={{
                  padding: 12,
                  background: "var(--color-bg-surface-sub)",
                  borderRadius: "var(--radius-md)",
                  fontSize: "0.82rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div>격리 정책: <strong>Deny-by-default (§12)</strong></div>
                <div>활성 라우팅 엣지: <strong>2개 방향</strong></div>
                <div>관측 소스: <strong>ws://localhost:3000</strong></div>
              </div>

              <Button variant="primary" size="sm" style={{ marginTop: 8 }}>
                클러스터 멤버 관리 →
              </Button>
            </div>
          ) : (
            <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
              토폴로지에서 클러스터 노드를 클릭하여 상세 정보를 확인하세요.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
