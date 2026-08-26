import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  KpiCard,
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

  const serverNodes = telemetry?.health_status
    ? [
        {
          id: "server_health",
          role: t("server.healthRow", "서버 상태 확인 응답"),
          endpoint: "/api/v1/health",
          status: isHealthy ? ("online" as const) : ("warning" as const),
          statusLabel: telemetry.health_status,
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
        title={t("server.title", "서버 상태와 메시지 적체")}
        subtitle={t("server.subtitle", "서버 응답, 웹 채널 등록 신원, 메일함 대기 수, 가동 시간을 보여줍니다")}
        actions={
          <Button variant="secondary" size="sm" onClick={loadPlatformTelemetry}>
            {t("server.refreshBtn", "↻ 메트릭 새로고침")}
          </Button>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <KpiCard
          label={t("server.kpi.health", "허브 헬스체크")}
          // Named, because the only other way to reach this card is its label,
          // and the label is translated: a scenario keyed on the copy asserts
          // whatever the dictionary last said.
          valueTestId="platform-health-status"
          value={telemetry?.health_status ?? (isOnline ? t("common.unmeasured", "— 미측정") : "OFFLINE")}
          color={isHealthy ? "var(--color-success)" : "var(--color-danger)"}
          icon={isHealthy ? "💓" : "⚠️"}
        />
        <KpiCard
          label={t("server.kpi.sockets", "웹 채널 등록 신원")}
          value={isOnline ? (telemetry?.web_channel_identities != null ? String(telemetry.web_channel_identities) : t("common.unmeasured", "— 미측정")) : "—"}
          subValue={isOnline ? t("server.kpi.socketsSub", "신원 목록에서 web 채널") : t("common.disconnected", "통신 불가")}
          color="var(--color-primary)"
          icon="⚡"
        />
        <KpiCard
          label={t("server.kpi.throughput", "대기 중 메시지")}
          value={isOnline ? (telemetry?.total_messages != null ? String(telemetry.total_messages) : t("common.unmeasured", "— 미측정")) : "—"}
          subValue={isOnline ? t("server.kpi.throughputSub", "메일함 전체 적체") : t("common.disconnected", "통신 불가")}
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
          🖥️ {t("overview.nodes", "서버 상태 응답")}
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
              : `${t("overview.partial", "이 계정이 볼 수 없는 항목이 있습니다")} (${telemetry?.refused.length ?? 0})`}
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
