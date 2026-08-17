import React, { useState } from "react";
import {
  PageHeader,
  Breadcrumbs,
  KpiCard,
  TelemetryCard,
  DataTable,
  StatusBadge,
  Button,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

import { fetchTelemetry, type SystemTelemetry } from "@/api/telemetry.ts";

export function PlatformOverviewPage() {
  const { t } = useI18n();
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);

  React.useEffect(() => {
    setIsLoading(true);
    setIsError(false);
    fetchTelemetry()
      .then((data) => {
        setTelemetry(data);
      })
      .catch((err) => {
        console.warn("[PlatformOverview] error:", err);
        setIsError(true);
        setTelemetry(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const isOnline = !isError && telemetry !== null;

  const portNumber = typeof window !== "undefined" && window.location.port ? Number(window.location.port) : 3005;
  const isHealthy = telemetry?.health_status === "ok";
  const uptimeLabel = telemetry?.server_uptime_seconds != null
    ? `${Math.floor(telemetry.server_uptime_seconds / 60)}분 ${telemetry.server_uptime_seconds % 60}초`
    : "정상 가동 중";

  const serverNodes = isOnline
    ? [
        {
          id: "node_http_api",
          role: "Hono REST API Gateway (Admin & Auth)",
          endpoint: "/api/v1/*",
          status: isHealthy ? ("online" as const) : ("warning" as const),
          statusLabel: isHealthy ? "HEALTHY" : "DEGRADED",
          activeSockets: telemetry?.active_sockets ?? 0,
          uptime: uptimeLabel,
        },
        {
          id: "node_hub_primary",
          role: "WebSocket Hub Master (Mesh Runtime)",
          endpoint: "ws://mesh/v1",
          status: isHealthy ? ("online" as const) : ("warning" as const),
          statusLabel: isHealthy ? "HEALTHY" : "DEGRADED",
          activeSockets: telemetry?.active_sockets ?? 0,
          uptime: uptimeLabel,
        },
      ]
    : [];

  const columns = [
    {
      key: "id",
      header: t("server.col.node", "노드 ID / 역할"),
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
      key: "endpoint",
      header: t("server.col.endpoint", "엔드포인트 경로"),
      render: (item: typeof serverNodes[0]) => (
        <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
          {item.endpoint}
        </code>
      ),
    },
    {
      key: "status",
      header: t("server.col.status", "헬스 상태 (/health)"),
      render: (item: typeof serverNodes[0]) => (
        <StatusBadge label={item.statusLabel} status={item.status} size="sm" />
      ),
    },
    {
      key: "activeSockets",
      header: t("server.col.sockets", "온라인 소켓"),
      render: (item: typeof serverNodes[0]) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>
          {item.activeSockets}개
        </span>
      ),
    },
    {
      key: "uptime",
      header: t("server.col.uptime", "가동 시간 (Uptime)"),
      render: (item: typeof serverNodes[0]) => (
        <span style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
          {item.uptime}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="PLATFORM OPERATOR"
        suiteBadgeColor="leased"
        screenId="09"
        title={t("server.title", "실시간 서버 인프라 현황판")}
        subtitle={t("server.subtitle", "현재 가동 중인 메시 허브 및 HTTP 서버의 실시간 헬스(/health), 활성 소켓 및 프로세스 모니터링")}
        actions={
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            {t("server.refreshBtn", "↻ 메트릭 새로고침")}
          </Button>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("server.kpi.health", "허브 헬스체크")}
          value={isOnline ? "200 OK" : "OFFLINE"}
          color={isOnline ? "var(--color-success)" : "var(--color-danger)"}
          icon={isOnline ? "💓" : "⚠️"}
        />
        <KpiCard
          label={t("server.kpi.sockets", "총 온라인 소켓")}
          value={String(telemetry?.active_sockets ?? 0)}
          subValue={isOnline ? t("server.kpi.socketsSub", "WebSocket 활성") : "단절됨"}
          color="var(--color-primary)"
          icon="⚡"
        />
        <KpiCard
          label={t("server.kpi.throughput", "전체 초당 처리량")}
          value={`${telemetry?.total_messages ?? 0} msg`}
          subValue={isOnline ? t("server.kpi.throughputSub", "실시간 메시지") : "단절됨"}
          color="var(--color-leased)"
          icon="📡"
        />
        <KpiCard
          label={t("server.kpi.latency", "허브 지연 (p95)")}
          value={isOnline ? (telemetry?.p99_latency_ms != null ? `${telemetry.p99_latency_ms} ms` : "—") : "-"}
          subValue={isOnline ? (telemetry?.p99_latency_ms != null ? t("server.kpi.latencySub", "정상 응답 속도") : "미측정") : t("common.disconnected", "통신 불가")}
          color="var(--color-warning)"
          icon="⏱️"
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <TelemetryCard
          label={t("server.chart.cpu", "CPU 사용률")}
          currentValue={isOnline && telemetry?.cpu_usage_pct != null ? `${telemetry.cpu_usage_pct.toFixed(1)}%` : "—"}
          percentage={telemetry?.cpu_usage_pct ?? 0}
          barColor="var(--color-success)"
          statusText={isOnline && telemetry?.cpu_usage_pct != null ? "정상 부하 범위" : (isOnline ? "서버 미측정 (D-1 행동 기반 지표 전환)" : "연결 불가")}
        />
        <TelemetryCard
          label={t("server.chart.memory", "메모리 점유 (RSS)")}
          currentValue={isOnline && telemetry?.memory_used_mb != null ? `${telemetry.memory_used_mb} MB` : "—"}
          maxLabel={telemetry?.memory_total_mb != null ? `${telemetry.memory_total_mb} MB` : undefined}
          percentage={telemetry?.memory_used_mb != null && telemetry?.memory_total_mb ? (telemetry.memory_used_mb / telemetry.memory_total_mb) * 100 : 0}
          barColor="var(--color-primary)"
          statusText={isOnline && telemetry?.memory_used_mb != null ? "메모리 모니터링" : (isOnline ? "서버 미측정 (D-1 행동 기반 지표 전환)" : "연결 불가")}
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
          isLoading={isLoading}
          isError={isError}
          errorMessage="서버 인프라 상태를 조회할 수 없습니다 (통신 오류)."
        />
      </div>
    </div>
  );
}
