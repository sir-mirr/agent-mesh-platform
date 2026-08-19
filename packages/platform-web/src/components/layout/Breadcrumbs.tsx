import React from "react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "@/contexts/I18nContext.tsx";

import { NotificationBell } from "./NotificationBell.tsx";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps {
  items?: BreadcrumbItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  const location = useLocation();
  const { t } = useI18n();

  const getRouteBreadcrumbs = (pathname: string): BreadcrumbItem[] => {
    switch (pathname) {
      case "/":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.dashboard", "대시보드") },
        ];
      case "/creator":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.studio", "에이전트 운영 스튜디오"), href: "/creator" },
          { label: t("bc.agents", "소유 에이전트") },
        ];
      case "/creator/groups":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.studio", "에이전트 운영 스튜디오"), href: "/creator" },
          { label: t("bc.groups", "그룹 관리") },
        ];
      case "/creator/topology":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.studio", "에이전트 운영 스튜디오"), href: "/creator" },
          { label: t("bc.topology", "에이전트 토폴로지") },
        ];
      case "/creator/playground":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.studio", "에이전트 운영 스튜디오"), href: "/creator" },
          { label: t("bc.playground", "메시지 플레이그라운드") },
        ];
      case "/creator/lease-queue":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.studio", "에이전트 운영 스튜디오"), href: "/creator" },
          { label: t("bc.mailbox", "에이전트 메일함") },
        ];
      case "/creator/register":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.studio", "에이전트 운영 스튜디오"), href: "/creator" },
          { label: t("bc.register", "신규 에이전트 등록") },
        ];
      case "/platform":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.platform", "실시간 서버 모니터링"), href: "/platform" },
          { label: t("bc.server", "서버 인프라 현황") },
        ];
      case "/platform/telemetry":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.platform", "실시간 서버 모니터링"), href: "/platform" },
          { label: t("bc.telemetry", "노드 텔레메트리") },
        ];
      case "/platform/tenants":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.governance", "플랫폼 거버넌스"), href: "/platform/tenants" },
          { label: t("bc.tenants", "테넌트 트래픽 격리") },
        ];
      case "/tenant/egress-acl":
      case "/tenant/egress":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.governance", "플랫폼 거버넌스"), href: "/tenant/egress-acl" },
          { label: t("bc.egress", "Egress ACL 매트릭스") },
        ];
      case "/tenant/audits":
      case "/tenant/audit":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.governance", "플랫폼 거버넌스"), href: "/tenant/audits" },
          { label: t("bc.audit", "보안 감사 로그") },
        ];
      case "/platform/users":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.governance", "플랫폼 거버넌스"), href: "/platform/users" },
          { label: t("bc.users", "로컬 계정") },
        ];
      case "/tenant/rbac":
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: t("bc.governance", "플랫폼 거버넌스"), href: "/tenant/rbac" },
          { label: t("bc.rbac", "RBAC 권한 관리") },
        ];
      default:
        return [
          { label: t("bc.home", "홈"), href: "/" },
          { label: pathname.slice(1) || t("bc.dashboard", "대시보드") },
        ];
    }
  };

  const breadcrumbs = items || getRouteBreadcrumbs(location.pathname);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 16,
      }}
    >
      <nav
        aria-label="Breadcrumb"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
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

      {/* Realtime Agent Registration Notification Bell */}
      <NotificationBell />
    </div>
  );
}
