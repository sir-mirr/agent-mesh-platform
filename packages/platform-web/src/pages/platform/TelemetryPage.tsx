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

  React.useEffect(() => {
    fetchTelemetry().then(setTelemetry);
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
        <TelemetryCard
          label={t("telem.cpu", "CPU 사용률 (Process)")}
          currentValue={`${telemetry?.cpu_usage_pct ?? 14.8}%`}
          maxLabel="100%"
          percentage={telemetry?.cpu_usage_pct ?? 14.8}
          barColor="var(--color-success)"
          statusText={t("telem.cpuStatus", "정상 (안정적)")}
        />
        <TelemetryCard
          label={t("telem.rss", "RSS 메모리 (Resident Set)")}
          currentValue={`${telemetry?.memory_used_mb ?? 164} MB`}
          maxLabel="1,024 MB"
          percentage={((telemetry?.memory_used_mb ?? 164) / 1024) * 100}
          barColor="var(--color-primary)"
          statusText={`Heap: ${Math.round((telemetry?.memory_used_mb ?? 164) * 0.6)} MB`}
        />
        <TelemetryCard
          label={t("telem.lag", "이벤트 루프 지연율 (Lag)")}
          currentValue="1.4 ms"
          maxLabel="50 ms"
          percentage={2.8}
          barColor="var(--color-success)"
          statusText={t("telem.lagStatus", "초저지연 응답")}
        />
        <TelemetryCard
          label={t("telem.msgPerSec", "초당 메시지 디스패치 (Msg/s)")}
          currentValue="48.2"
          maxLabel="1,000"
          percentage={4.8}
          barColor="#8B5CF6"
          statusText={t("telem.msgPerSecStatus", "처리 용량 여유")}
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
          {t("telem.logSub", "서버가 10초 주기로 수집하는 핵심 런타임 지표 스트림")}
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
          <div>[2026-08-17 13:40:00] INFO telemetry.tick: cpu=14.8% rss_mb=164 active_ws=8 lag_ms=1.4</div>
          <div>[2026-08-17 13:40:10] INFO telemetry.tick: cpu=14.2% rss_mb=164 active_ws=8 lag_ms=1.2</div>
          <div>[2026-08-17 13:40:20] INFO telemetry.tick: cpu=15.1% rss_mb=165 active_ws=8 lag_ms=1.5</div>
          <div>[2026-08-17 13:40:30] INFO telemetry.tick: cpu=14.5% rss_mb=164 active_ws=8 lag_ms=1.3</div>
        </div>
      </div>
    </div>
  );
}
