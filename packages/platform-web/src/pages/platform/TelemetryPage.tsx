import React, { useState } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  KpiCard,
  Button,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

import { fetchTelemetry, type SystemTelemetry } from "@/api/telemetry.ts";

export function formatElapsed(milliseconds: number, language: "ko" | "en"): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 1) return language === "ko" ? "1초 미만" : "less than 1s";
  if (seconds < 60) return language === "ko" ? `${seconds}초` : `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return language === "ko" ? `${minutes}분` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return language === "ko"
      ? `${hours}시간${remainingMinutes ? ` ${remainingMinutes}분` : ""}`
      : `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return language === "ko"
    ? `${days}일${remainingHours ? ` ${remainingHours}시간` : ""}`
    : `${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
}

export function TelemetryPage() {
  const { t, language } = useI18n();
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);

  const loadTelemetry = () => {
    setIsLoading(true);
    setIsError(false);
      setFailure(null);
    fetchTelemetry()
      .then((data) => {
        setTelemetry(data);
      })
      .catch((err) => {
        console.warn("[Telemetry] fetch error:", err);
        setIsError(true);
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
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
        title={t("telem.title", "운영 동작 지표")}
        subtitle={t("telem.subtitle", "등록 대기, 거절, 수락, 메시지 적체와 서버 가동 상태를 보여줍니다")}
        actions={
          <Button variant="secondary" size="sm" onClick={loadTelemetry}>
            {t("telem.refreshBtn", "↻ 실시간 갱신")}
          </Button>
        }
      />

      {isLoading ? (
        <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-muted)" }}>
          {t("tel.loading", "운영 지표를 불러오는 중입니다...")}
        </div>
      ) : isError || !telemetry ? (
        <div style={{ padding: "30px", background: "var(--color-bg-surface)", border: "1px solid var(--color-danger)", borderRadius: "var(--radius-lg)", color: "var(--color-danger)", textAlign: "center" }}>
          ⚠️ {failure === "refused" ? refusedText(t, missing) : t("tel.error", "운영 지표를 불러오지 못했습니다 (서버가 답하지 않았습니다).")}
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
              {t("tel.partial", "일부 지표는 볼 권한이 없습니다")} ({telemetry.refused.length}).{" "}
              {t("tel.partial.note", "아래가 비어 있는 것은 데이터가 없어서가 아닙니다.")}
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
                    ? `${t("tel.since", "거절 집계 시작")}: ${new Date(telemetry.behaviour.counting_since).toLocaleString()} (${t("tel.since.note", "서버가 다시 시작되면 0부터")})`
                    : t("tel.since.unknown", "집계 시작 시각을 모른다 — 아래 거절 수치는 읽을 수 없다")}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
                {([
                  [t("tel.m.pending", "등록 대기"), telemetry.behaviour.pending_keys, false],
                  [t("tel.m.oldest", "가장 오래 기다린 시간"), telemetry.behaviour.oldest_pending_ms, true],
                  [t("tel.m.sig", "서명 확인 실패"), telemetry.behaviour.signature_refusals, false],
                  [t("tel.m.rate", "요청 제한"), telemetry.behaviour.rate_limited, false],
                  [t("tel.m.egress", "전송 규칙으로 차단"), telemetry.behaviour.egress_refusals, false],
                  [t("tel.m.accepted", "수락한 작업"), telemetry.behaviour.accepted, false],
                ] as const).map(([label, metric, isElapsed]) => (
                  <div
                    key={label}
                    style={{ padding: "12px 14px", background: "var(--color-bg-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}
                  >
                    <div style={{ fontSize: "0.75rem", color: "var(--color-text-secondary)" }}>{label}</div>
                    {metric.value === null ? (
                      <div data-testid="metric-unmeasured" style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }} title={metric.unavailable}>
                        {t("common.unmeasured", "— 미측정")}
                      </div>
                    ) : (
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "1.15rem", fontWeight: 700 }}>
                        {isElapsed ? formatElapsed(metric.value, language) : metric.value}
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
              <KpiCard
                label={t("tel.sockets", "웹 채널 등록 신원")}
                value={telemetry.web_channel_identities != null ? String(telemetry.web_channel_identities) : t("common.unmeasured", "— 미측정")}
                subValue={t("tel.sockets.ok", "신원 목록에서 web 채널")}
                color="var(--color-success)"
                icon="🌐"
              />
            </div>
        </>
      )}
    </div>
  );
}
