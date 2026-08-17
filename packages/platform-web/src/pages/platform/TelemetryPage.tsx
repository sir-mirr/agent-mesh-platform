import React, { useState } from "react";
import {
  PageHeader,
  Breadcrumbs,
  TelemetryCard,
  Button,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

import { fetchTelemetry, type SystemTelemetry } from "@/api/telemetry.ts";

export function TelemetryPage() {
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
        console.warn("[Telemetry] fetch error:", err);
        setIsError(true);
        setTelemetry(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Breadcrumbs />

      <PageHeader
        suiteTag="PLATFORM OPERATOR"
        suiteBadgeColor="leased"
        screenId="13"
        title={t("telem.title", "노드 텔레메트리 모니터링")}
        subtitle={t("telem.subtitle", "서버 프로세스 CPU, RAM, 이벤트 루프 지연율 및 실시간 웹소켓 연결 헬스 메트릭")}
        actions={
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            {t("telem.refreshBtn", "↻ 실시간 갱신")}
          </Button>
        }
      />

      {isLoading ? (
        <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-muted)" }}>
          서버 텔레메트리 메트릭을 수집 중입니다...
        </div>
      ) : isError || !telemetry ? (
        <div style={{ padding: "30px", background: "var(--color-bg-surface)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-lg)", color: "var(--color-danger)", textAlign: "center" }}>
          ⚠️ 텔레메트리 서버와 연결할 수 없습니다 (오류 발생).
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
            <TelemetryCard
              label={t("telem.cpu", "CPU 사용률 (Process)")}
              currentValue={`${telemetry.cpu_usage_pct}%`}
              maxLabel="100%"
              percentage={telemetry.cpu_usage_pct}
              barColor="var(--color-success)"
              statusText={t("telem.cpuStatus", "정상 (안정적)")}
            />
            <TelemetryCard
              label={t("telem.rss", "RSS 메모리 (Resident Set)")}
              currentValue={`${telemetry.memory_used_mb} MB`}
              maxLabel={`${telemetry.memory_total_mb || 1024} MB`}
              percentage={(telemetry.memory_used_mb / (telemetry.memory_total_mb || 1024)) * 100}
              barColor="var(--color-primary)"
              statusText={`Active Sockets: ${telemetry.active_sockets}`}
            />
            <TelemetryCard
              label="활성 소켓 연결 수"
              currentValue={`${telemetry.active_sockets}`}
              maxLabel="Max 500"
              percentage={(telemetry.active_sockets / 500) * 100}
              barColor="var(--color-success)"
              statusText="웹소켓 정상 세션"
            />
            <TelemetryCard
              label="허브 p99 지연 시간"
              currentValue={`${telemetry.p99_latency_ms} ms`}
              maxLabel="50 ms"
              percentage={Math.min(100, (telemetry.p99_latency_ms / 50) * 100)}
              barColor="#8B5CF6"
              statusText="초저지연 라우팅"
            />
          </div>

          <div
            style={{
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-xl)",
              padding: 24,
              marginTop: 8,
            }}
          >
            <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: 8 }}>
              {t("telem.logTitle", "📊 텔레메트리 진단 로그")}
            </h3>
            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)", marginBottom: 16 }}>
              {t("telem.logSub", "서버가 수집하는 핵심 런타임 지표 스트림")}
            </p>

            <div
              style={{
                background: "#0F172A",
                color: "#38BDF8",
                fontFamily: "var(--font-mono)",
                fontSize: "0.8rem",
                padding: 16,
                borderRadius: "var(--radius-md)",
                lineHeight: 1.6,
              }}
            >
              <div>[INFO telemetry.tick] cpu={telemetry.cpu_usage_pct}% rss_mb={telemetry.memory_used_mb} active_sockets={telemetry.active_sockets} total_agents={telemetry.total_agents} p99_latency_ms={telemetry.p99_latency_ms}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
