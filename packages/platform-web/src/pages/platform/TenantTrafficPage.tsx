import React, { useState, useEffect } from "react";
import { failureKind, type FailureKind, refusedCapability, refusedText } from "@/api/client.ts";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
} from "@/components/index.ts";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { fetchTenantTraffic, type TenantTrafficItem } from "@/api/tenants.ts";

export function TenantTrafficPage() {
  const { t } = useI18n();
  const [tenants, setTenants] = useState<TenantTrafficItem[]>([]);
  const [hours, setHours] = useState<number>(24);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  /** 서버가 이름을 대면 그것을, 안 대면 `null`. 화면이 짐작하지 않는다. */
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setIsError(false);
      setFailure(null);
    fetchTenantTraffic()
      .then((res) => {
        setTenants(res.tenants || []);
        if (res.hours) setHours(res.hours);
      })
      .catch((err) => {
        console.warn("[TenantTraffic] error:", err);
        setIsError(true);
        setFailure(failureKind(err));
        setMissing(refusedCapability(err));
        setTenants([]);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const columns = [
    {
      key: "tenant",
      header: t("traffic.col.tenant", "테넌트 조직 명 / ID"),
      render: (item: TenantTrafficItem) => (
        <div>
          <div style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{item.tenant}</div>
        </div>
      ),
    },
    {
      key: "received",
      header: t("traffic.col.routes", `${hours}h 수신 메시지 건수`),
      render: (item: TenantTrafficItem) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--color-primary)" }}>
          {item.received}
        </span>
      ),
    },
    {
      key: "senders",
      header: t("tt.senders", "발신자"),
      render: (item: TenantTrafficItem) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
          {item.senders}
        </span>
      ),
    },
    {
      key: "recipients",
      header: t("tt.recipients", "수신자"),
      render: (item: TenantTrafficItem) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
          {item.recipients}
        </span>
      ),
    },
    {
      key: "via_mailbox",
      header: t("tt.viaMailbox", "메일함 경유"),
      render: (item: TenantTrafficItem) => (
        <span style={{ fontFamily: "var(--font-mono)", color: item.via_mailbox > 0 ? "var(--color-warning)" : "var(--color-text-muted)" }}>
          {item.via_mailbox}
        </span>
      ),
    },
    {
      key: "last_at",
      header: t("tt.lastAt", "마지막 전달"),
      render: (item: TenantTrafficItem) => (
        <span style={{ fontSize: "0.82rem", color: "var(--color-text-secondary)" }}>
          {item.last_at || "-"}
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
        screenId="12"
        title={t("traffic.title", "테넌트 라우팅 처리량 분석")}
        subtitle={t("tt.subtitle", "테넌트별 수신 건수 · 발신/수신 주체 수 · 메일함 경유 트래픽")}
      />

      <DataTable
        columns={columns}
        data={tenants}
        keyExtractor={(item) => item.tenant}
        isLoading={isLoading}
        isError={isError}
        errorMessage={
          failure === "refused"
            ? refusedText(t, missing)
            : t("tenants.error", "테넌트 통계를 불러오지 못했습니다 (서버가 답하지 않았습니다).")
        }
        emptyMessage={t("tt.empty", "트래픽을 낸 테넌트가 없습니다.")}
      />
    </div>
  );
}
