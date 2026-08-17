import React from "react";
import { Link, useLocation } from "react-router-dom";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps {
  items?: BreadcrumbItem[];
}

const ROUTE_BREADCRUMB_MAP: Record<string, BreadcrumbItem[]> = {
  "/": [{ label: "홈", href: "/" }, { label: "대시보드" }],
  "/creator": [{ label: "홈", href: "/" }, { label: "에이전트 운영 스튜디오", href: "/creator" }, { label: "소유 에이전트" }],
  "/creator/groups": [{ label: "홈", href: "/" }, { label: "에이전트 운영 스튜디오", href: "/creator" }, { label: "스웜 그룹 관리" }],
  "/creator/topology": [{ label: "홈", href: "/" }, { label: "에이전트 운영 스튜디오", href: "/creator" }, { label: "에이전트 토폴로지" }],
  "/creator/playground": [{ label: "홈", href: "/" }, { label: "에이전트 운영 스튜디오", href: "/creator" }, { label: "메시지 플레이그라운드" }],
  "/creator/lease-queue": [{ label: "홈", href: "/" }, { label: "에이전트 운영 스튜디오", href: "/creator" }, { label: "소켓리스 큐" }],
  "/creator/register": [{ label: "홈", href: "/" }, { label: "에이전트 운영 스튜디오", href: "/creator" }, { label: "신규 에이전트 등록" }],

  "/platform": [{ label: "홈", href: "/" }, { label: "실시간 서버 모니터링", href: "/platform" }, { label: "서버 인프라 현황" }],
  "/platform/telemetry": [{ label: "홈", href: "/" }, { label: "실시간 서버 모니터링", href: "/platform" }, { label: "노드 텔레메트리" }],
  "/platform/tenants": [{ label: "홈", href: "/" }, { label: "플랫폼 거버넌스", href: "/platform/tenants" }, { label: "테넌트 트래픽 격리" }],

  "/tenant/groups": [{ label: "홈", href: "/" }, { label: "플랫폼 거버넌스", href: "/tenant/groups" }, { label: "스웜 그룹 거버넌스" }],
  "/tenant/egress": [{ label: "홈", href: "/" }, { label: "플랫폼 거버넌스", href: "/tenant/groups" }, { label: "Egress ACL 매트릭스" }],
  "/tenant/audit": [{ label: "홈", href: "/" }, { label: "플랫폼 거버넌스", href: "/tenant/groups" }, { label: "보안 감사 로그" }],
  "/tenant/rbac": [{ label: "홈", href: "/" }, { label: "플랫폼 거버넌스", href: "/tenant/groups" }, { label: "RBAC 권한 관리" }],
};

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  const location = useLocation();

  const breadcrumbs = items || ROUTE_BREADCRUMB_MAP[location.pathname] || [
    { label: "홈", href: "/" },
    { label: location.pathname.slice(1) || "대시보드" },
  ];

  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 16,
        fontSize: "0.78rem",
        color: "var(--color-text-muted)",
        fontWeight: 600,
        userSelect: "none",
      }}
    >
      {breadcrumbs.map((item, index) => {
        const isLast = index === breadcrumbs.length - 1;

        return (
          <React.Fragment key={index}>
            {index > 0 && (
              <span style={{ color: "var(--color-border-strong)", fontSize: "0.72rem", margin: "0 2px" }}>
                /
              </span>
            )}
            {item.href && !isLast ? (
              <Link
                to={item.href}
                style={{
                  color: "var(--color-text-secondary)",
                  textDecoration: "none",
                  transition: "color 0.15s ease",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "var(--color-primary)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "var(--color-text-secondary)")}
              >
                {item.label}
              </Link>
            ) : (
              <span style={{ color: isLast ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontWeight: isLast ? 700 : 600 }}>
                {item.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
