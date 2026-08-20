import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
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
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);

  const loadPlatformTelemetry = () => {
    setIsLoading(true);
    setIsError(false);
    fetchTelemetry()
      .then((data) => {
        setTelemetry(data);
      })
      .catch((err) => {
        console.warn("[PlatformOverview] error:", err);
        setIsError(true);
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
        setTelemetry(null);
      })
      .finally(() => setIsLoading(false));
  };

  React.useEffect(() => {
    loadPlatformTelemetry();
  }, []);

  const isOnline = !isError && telemetry !== null;

  const isHealthy = telemetry?.health_status === "ok";
  const uptimeLabel = telemetry?.server_uptime_seconds != null
    ? `${Math.floor(telemetry.server_uptime_seconds / 60)}${t("agents.unit.minute", "분")} ${telemetry.server_uptime_seconds % 60}${t("agents.unit.second", "초")}`
    : (isOnline ? t("overview.up", "정상 가동 중") : t("overview.down", "통신 불가"));

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
          endpoint: "/ws",
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
          <div style={{ fontWeight: 700, color: "var(--color-primary)" }}>{item.id}</div>
          <div style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
            {item.role}
          </div>
        </div>
      ),
    },
    {
      key: "endpoint",
      header: t("server.col.endpoint", "엔드포인트 경로"),
      render: (item: typeof serverNodes[0]) => (
        <code style={{ fontSize: "0.82rem", color: "var(--color-text-primary)" }}>
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
          {item.activeSockets}
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
          <Button variant="secondary" size="sm" onClick={loadPlatformTelemetry}>
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
          value={isOnline ? String(telemetry?.active_sockets ?? 0) : "—"}
          subValue={isOnline ? t("server.kpi.socketsSub", "WebSocket 활성") : t("common.disconnected", "통신 불가")}
          color="var(--color-primary)"
          icon="⚡"
        />
        <KpiCard
          label={t("server.kpi.throughput", "전체 초당 처리량")}
          value={isOnline ? `${telemetry?.total_messages ?? 0} msg` : "—"}
          subValue={isOnline ? t("server.kpi.throughputSub", "실시간 메시지") : t("common.disconnected", "통신 불가")}
          color="var(--color-leased)"
          icon="📡"
        />
      </div>

        {/* **CPU, RSS and p95 are gone, not hidden.** They read
            `/api/v1/admin/ai-usage`, which answers AI account usage; no producer
            in this repository writes machine telemetry and there is no plan to
            add it, so those guards could never be true. Each card drew `—` at 0%
            beside a caption that read like a healthy reading. The measured
            counterpart is `GET /api/v1/admin/telemetry/behaviour`, where every
            value carries its own `unavailable`. */}

      <div style={{ marginTop: 8 }}>
        <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: 12 }}>
          🖥️ {t("overview.nodes", "가동 중인 서비스 노드")}
        </h3>
        {/* **거절과 무응답을 갈라 말한다.** 이 화면은 `failureKind` 와
            `refusedCapability` 를 둘 다 계산해 상태에 넣어두고 **렌더에서 한 번도
            안 읽었다** — 모든 실패가 `통신 오류` 로 나갔고, `usage.read` 가 없는
            사람은 멀쩡한 네트워크를 확인하러 갔다. 아무도 그에게 이름을 안 댔다.
            옆 화면(`/platform/telemetry`)이 같은 결함으로 `I-061` 이었다. */}
        {(failure === "refused" || (telemetry?.refused.length ?? 0) > 0) && (
          <div
            data-testid="overview-refused"
            style={{ marginBottom: 10, padding: "10px 12px", fontSize: "0.82rem", color: "var(--color-danger)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-md)" }}
          >
            {failure === "refused"
              ? refusedText(t, missing)
              : `${t("overview.partial", "일부는 볼 권한이 없습니다")} — ${(telemetry?.refused ?? []).map((r) => `${r.panel} (${r.capability})`).join(" · ")}`}
          </div>
        )}
        <DataTable
          columns={columns}
          data={serverNodes}
          keyExtractor={(item) => item.id}
          isLoading={isLoading}
          isError={isError && failure !== "refused"}
          errorMessage={t("overview.error", "서버 인프라 상태를 조회할 수 없습니다 (통신 오류).")}
        />
      </div>
    </div>
  );
}
