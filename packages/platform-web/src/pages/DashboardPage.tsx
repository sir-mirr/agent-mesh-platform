import React from "react";
import { Link } from "react-router-dom";
import { PageHeader, KpiCard, TelemetryCard, EmptyState, Button } from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";

/**
 * DashboardPage — Phase 1 MVP 대시보드.
 */
export function DashboardPage() {
  const { t } = useI18n();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <PageHeader
        suiteTag="PHASE 1 MVP"
        suiteBadgeColor="leased"
        screenId="DASH-01"
        title={t("dash.title", "통합 운영 대시보드")}
        subtitle={t("dash.subtitle", "단일 패브릭 에이전트 플릿 요약, 실시간 허브 헬스 및 인박스 적체 모니터링")}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.location.reload()}
            >
              ↻ {t("common.refresh", "새로고침")}
            </Button>
            <Link to="/creator/register">
              <Button variant="primary" size="sm">
                {t("nav.register", "➕ 신규 에이전트 등록")}
              </Button>
            </Link>
          </>
        }
      />

      {/* Top KPI Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <KpiCard
          label={t("dash.kpi.agents", "소유 에이전트")}
          value="12"
          subValue={t("dash.kpi.agentsSub", "개 등록됨")}
          color="var(--color-primary)"
          icon="🤖"
        />
        <KpiCard
          label={t("dash.kpi.sockets", "온라인 소켓")}
          value="8"
          subValue={t("dash.kpi.socketsSub", "연결 활성")}
          color="var(--color-success)"
          icon="⚡"
          trend={{ value: "+2", isPositive: true }}
        />
        <KpiCard
          label={t("dash.kpi.inbox", "인박스 적체 큐")}
          value="3"
          subValue={t("dash.kpi.inboxSub", "건 대기 중")}
          color="var(--color-warning)"
          icon="📥"
        />
        <KpiCard
          label={t("dash.kpi.latency", "평균 디스패치 지연")}
          value="24ms"
          subValue={t("dash.kpi.latencySub", "p99 기준")}
          color="#6366F1"
          icon="🔄"
        />
      </div>

      {/* Telemetry / Live Resource Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        <TelemetryCard
          label="서버 CPU 부하"
          currentValue="14.2%"
          maxLabel="100%"
          percentage={14.2}
          barColor="var(--color-success)"
          statusText="정상 가동 중"
        />
        <TelemetryCard
          label="프로세스 메모리 (RAM)"
          currentValue="148 MB"
          maxLabel="1,024 MB"
          percentage={14.5}
          barColor="var(--color-primary)"
          statusText="여유 공간 충분"
        />
        <TelemetryCard
          label="소켓리스 리스 TTL (300s)"
          currentValue="248s"
          maxLabel="300s"
          percentage={82.6}
          barColor="var(--color-leased)"
          statusText="리스 임대 활성"
        />
      </div>

      {/* Fleet & Recent Activity Panel */}
      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: 24,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <div>
            <h3
              style={{
                fontSize: "1.05rem",
                fontWeight: 700,
                color: "var(--color-text-primary)",
              }}
            >
              최근 에이전트 플릿 상태
            </h3>
            <p style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
              SPEC § 8.11 관측 출처 및 실시간 프레임 상태
            </p>
          </div>
          <Button variant="ghost" size="sm">
            전체 보기 →
          </Button>
        </div>

        <EmptyState
          icon="🤖"
          title="에이전트 목록을 불러오는 중이거나 등록된 에이전트가 없습니다"
          description="에이전트 운영 스튜디오에서 신규 에이전트를 등록하거나 CLI 러너로 연결하세요."
          actionLabel="에이전트 등록하기"
          onAction={() => {}}
        />
      </div>
    </div>
  );
}
