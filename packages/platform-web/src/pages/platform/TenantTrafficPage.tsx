import React from "react";
import {
  PageHeader,
  Breadcrumbs,
  DataTable,
  StatusBadge,
} from "@/components/index.ts";

export function TenantTrafficPage() {

  const tenants = [
    {
      id: "tenant_acme",
      name: "Acme Corporation",
      agentCount: 8,
      routingCount24h: "940건",
      storageUsage: "48.2 MB",
      status: "Active",
    },
    {
      id: "tenant_globex",
      name: "Globex Logistics",
      agentCount: 3,
      routingCount24h: "380건",
      storageUsage: "18.4 MB",
      status: "Active",
    },
    {
      id: "tenant_initech",
      name: "Initech Analytics",
      agentCount: 1,
      routingCount24h: "100건",
      storageUsage: "4.1 MB",
      status: "Active",
    },
  ];

  const columns = [
    {
      key: "name",
      header: "테넌트 조직 명 / ID",
      render: (item: typeof tenants[0]) => (
        <div>
          <div style={{ fontWeight: 700 }}>{item.name}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
            {item.id}
          </div>
        </div>
      ),
    },
    {
      key: "agentCount",
      header: "소유 에이전트 수",
      render: (item: typeof tenants[0]) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>
          {item.agentCount}개
        </span>
      ),
    },
    {
      key: "routingCount24h",
      header: "24h 메시지 라우팅 건수",
      render: (item: typeof tenants[0]) => (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--color-primary)" }}>
          {item.routingCount24h}
        </span>
      ),
    },
    {
      key: "storageUsage",
      header: "스토리지 점유율",
      render: (item: typeof tenants[0]) => (
        <span style={{ fontSize: "0.82rem" }}>
          {item.storageUsage}
        </span>
      ),
    },
    {
      key: "status",
      header: "조직 격리 상태",
      render: (item: typeof tenants[0]) => (
        <StatusBadge label="ACTIVE" status="online" size="sm" />
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
        title="테넌트 라우팅 처리량 분석"
        subtitle="테넌트별 메시지 라우팅 처리 건수(Routing Count), SQLite 스토리지 점유율 및 소유 에이전트 수 분석"
      />

      <DataTable
        columns={columns}
        data={tenants}
        keyExtractor={(item) => item.id}
      />
    </div>
  );
}
