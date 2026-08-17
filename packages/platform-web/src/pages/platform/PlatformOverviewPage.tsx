import React from "react";
import {
  PageHeader,
  KpiCard,
  TelemetryCard,
  DataTable,
  StatusBadge,
  SubNavPills,
  Button,
} from "@/components/index.ts";

export function PlatformOverviewPage() {
  const subNavItems = [
    { label: "서버 인프라 현황", href: "/platform", icon: "⚡" },
    { label: "노드 텔레메트리", href: "/platform/telemetry", icon: "📈" },
    { label: "테넌트 라우팅 분석", href: "/platform/tenants", icon: "🏢" },
  ];

  const serverNodes = [
    {
      id: "node_hub_primary",
      role: "WebSocket Hub Master",
      port: 3000,
      status: "online" as const,
      activeSockets: 8,
      uptime: "3일 14시간",
    },
    {
      id: "node_http_api",
      role: "Hono REST API Gateway",
      port: 3100,
      status: "online" as const,
      activeSockets: 0,
      uptime: "3일 14시간",
    },
  ];

  const columns = [
    {
      key: "id",
      header: "노드 ID / 역할",
      render: (item: typeof serverNodes[0]) => (
        <div>
          <div style={{ fontWeight: 700 }}>{item.id}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
            {item.role}
          </div>
        </div>
      ),
    },
    {
      key: "port",
      header: "포트",
      render: (item: typeof serverNodes[0]) => (
        <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
          :{item.port}
        </code>
      ),
    },
    {
      key: "status",
      header: "헬스 상태 (/health)",
      render: (item: typeof serverNodes[0]) => (
        <StatusBadge label="HEALTHY" status="online" size="sm" />
      ),
    },
    {
      key: "activeSockets",
      header: "온라인 소켓",
      render: (item: typeof serverNodes[0]) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>
          {item.activeSockets}개
        </span>
      ),
    },
    {
      key: "uptime",
      header: "가동 시간 (Uptime)",
      render: (item: typeof serverNodes[0]) => (
        <span style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
          {item.uptime}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SubNavPills items={subNavItems} />

      <PageHeader
        suiteTag="PLATFORM OPERATOR"
        suiteBadgeColor="leased"
        screenId="09"
        title="실시간 서버 인프라 현황판"
        subtitle="현재 가동 중인 메시 허브 및 HTTP 서버의 실시간 헬스(/health), 활성 소켓 및 프로세스 모니터링"
        actions={
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            ↻ 메트릭 새로고침
          </Button>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard label="허브 헬스체크" value="200 OK" color="var(--color-success)" icon="💓" />
        <KpiCard label="총 온라인 소켓" value="8" subValue="WebSocket 활성" color="var(--color-primary)" icon="⚡" />
        <KpiCard label="활성 테넌트 파티션" value="3" subValue="조직 격리됨" color="#6366F1" icon="🏢" />
        <KpiCard label="24h 메시지 라우팅" value="1,420" subValue="건 처리 완료" color="var(--color-text-primary)" icon="📊" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <TelemetryCard
          label="허브 프로세스 CPU"
          currentValue="12.4%"
          percentage={12.4}
          barColor="var(--color-success)"
          statusText="정상 부하 범위"
        />
        <TelemetryCard
          label="허브 메모리 점유"
          currentValue="142 MB"
          maxLabel="2,048 MB"
          percentage={6.9}
          barColor="var(--color-primary)"
          statusText="메모리 안정"
        />
      </div>

      <div style={{ marginTop: 8 }}>
        <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: 12 }}>
          🖥️ 가동 중인 서비스 노드
        </h3>
        <DataTable
          columns={columns}
          data={serverNodes}
          keyExtractor={(item) => item.id}
        />
      </div>
    </div>
  );
}
