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

  const loadTelemetry = () => {
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
  };

  React.useEffect(() => {
    loadTelemetry();
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
          <Button variant="secondary" size="sm" onClick={loadTelemetry}>
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
          {/*
            **A refused panel and an idle mesh used to render the same page.**
            Two of the four endpoints behind this screen are ungated, so they
            always answer and the error branch above was unreachable for a § 11
            refusal — the cells simply read `—`, which is what an empty mesh
            looks like. Naming the capability is the difference between "there
            is nothing here" and "you are not allowed to see this".
          */}
          {telemetry.refused.length > 0 && (
            <div
              data-testid="telemetry-refused"
              style={{ padding: "14px 18px", marginBottom: 16, background: "var(--color-bg-surface)", border: "1px solid var(--color-warning, var(--color-danger))", borderRadius: "var(--radius-lg)", color: "var(--color-text-secondary)" }}
            >
              일부 지표를 볼 권한이 없습니다 —{" "}
              {telemetry.refused.map((r) => `${r.panel} (${r.capability})`).join(" · ")}
              . 아래 값이 비어 있는 것은 데이터가 없어서가 아닙니다.
            </div>
          )}

          {/*
            § D-1 chose these over CPU and memory: a hub at 4% CPU refusing
            every signature is not healthy, and a process gauge cannot say so.

            **Four of the six read `0` when all is well**, which is what makes
            an unread source dangerous here — a zero drawn because nothing
            answered is the number an operator is hoping for and will not
            question. So `null` is drawn as "미측정", never as `0`, and the
            window the refusal counts were taken over travels with them: those
            counters are per-process and reset with the hub.
          */}
          {/*
            **A panel that cannot be drawn says so.** `behaviour` is `null` when
            that one route did not answer, and this used to render nothing at
            all: on a monitoring screen the six counters simply vanished, which
            is the moment an operator most needs to be told. Measured with only
            `/api/v1/admin/telemetry/behaviour` refusing and the rest healthy —
            eighteen fragments of the page disappeared and nothing replaced them.
          */}
          {!telemetry.behaviour && (
            <div data-testid="behaviour-unreachable" style={{ marginBottom: 16, fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
              {t("tel.behaviour", "행동 지표")}: {t("common.errorLoad", "불러오지 못함")}
            </div>
          )}
          {telemetry.behaviour && (
            <div data-testid="behaviour-metrics" style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>{t("tel.behaviour", "행동 지표")}</span>
                <span data-testid="counting-since" style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                  {telemetry.behaviour.counting_since
                    ? `거절 집계 기준: ${new Date(telemetry.behaviour.counting_since).toLocaleString()} 부터 (허브 재기동 시 초기화)`
                    : "집계 시작 시각 미상 — 아래 거절 수치는 읽을 수 없습니다"}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
                {([
                  ["대기 키", telemetry.behaviour.pending_keys, ""],
                  ["최고 경과", telemetry.behaviour.oldest_pending_ms, "ms"],
                  ["서명 거절", telemetry.behaviour.signature_refusals, ""],
                  ["rate limit", telemetry.behaviour.rate_limited, ""],
                  ["egress 거절", telemetry.behaviour.egress_refusals, ""],
                  ["수락 수", telemetry.behaviour.accepted, ""],
                ] as const).map(([label, metric, unit]) => (
                  <div
                    key={label}
                    style={{ padding: "12px 14px", background: "var(--color-bg-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}
                  >
                    <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>{label}</div>
                    {metric.value === null ? (
                      <div data-testid="metric-unmeasured" style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }} title={metric.unavailable}>
                        — 미측정
                      </div>
                    ) : (
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "1.15rem", fontWeight: 700 }}>
                        {metric.value}
                        {unit && <span style={{ fontSize: "0.75rem", fontWeight: 400 }}> {unit}</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

            {/* **Three of the four gauges here read fields nobody sends.** CPU, RSS
                and p99 came from `/api/v1/admin/ai-usage`, which answers AI account
                usage — no producer in this repository writes machine telemetry, and
                there is no plan to add it. Each card drew `—` with a bar at 0% and a
                caption that read like a measurement of a healthy machine.

                What is measured sits below: the behavioural metrics, where every
                value is `{value, unavailable}` and an unknown says so. */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
              <TelemetryCard
                label="활성 소켓 연결 수"
                currentValue={`${telemetry.active_sockets}`}
                maxLabel="Max 500"
                percentage={(telemetry.active_sockets / 500) * 100}
                barColor="var(--color-success)"
                statusText="웹소켓 정상 세션"
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
              <div>[INFO telemetry.tick] active_sockets={telemetry.active_sockets} total_agents={telemetry.total_agents ?? "— 미측정"}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
