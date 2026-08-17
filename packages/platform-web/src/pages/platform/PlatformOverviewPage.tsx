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

  const serverNodes = isOnline
    ? [
        {
          id: "node_http_api",
          role: "Hono REST API Gateway (Admin & Auth)",
          port: 3000,
          status: "online" as const,
          statusLabel: "HEALTHY",
          activeSockets: telemetry?.active_sockets ?? 0,
          uptime: "정상 가동 중",
        },
        {
          id: "node_hub_primary",
          role: "WebSocket Hub Master (Mesh Runtime)",
          port: 3100,
          status: "online" as const,
          statusLabel: "HEALTHY",
          activeSockets: telemetry?.active_sockets ?? 0,
          uptime: "정상 가동 중",
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
      key: "port",
      header: t("server.col.port", "포트"),
      render: (item: typeof serverNodes[0]) => (
        <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
          :{item.port}
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
          value={isOnline ? `${telemetry?.p99_latency_ms || 0} ms` : "-"}
          subValue={isOnline ? t("server.kpi.p99Sub", "최근 p99 측정치") : t("common.disconnected", "통신 불가")}
          color="#6366F1"
          icon="⏱️"
        />
      </div>

      {isOnline && telemetry && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <TelemetryCard
            label="허브 프로세스 CPU"
            currentValue={`${telemetry.cpu_usage_pct}%`}
            percentage={telemetry.cpu_usage_pct}
            barColor="var(--color-success)"
            statusText="정상 부하 범위"
          />
          <TelemetryCard
            label="허브 메모리 점유"
            currentValue={`${telemetry.memory_used_mb} MB`}
            maxLabel={`${telemetry.memory_total_mb || 1024} MB`}
            percentage={(telemetry.memory_used_mb / (telemetry.memory_total_mb || 1024)) * 100}
            barColor="var(--color-primary)"
            statusText="메모리 모니터링"
          />
        </div>
      )}

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
