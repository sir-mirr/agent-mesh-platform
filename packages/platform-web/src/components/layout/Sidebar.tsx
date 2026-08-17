import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";

export interface NavItemDef {
  label: string;
  description: string;
  href: string;
  icon: string;
  requiredCapability?: string;
  badge?: string;
}

export interface NavSectionDef {
  title: string;
  items: NavItemDef[];
}

export interface SidebarProps {
  userCapabilities?: string[];
  userRole?: string;
  userName?: string;
  onLogout?: () => void;
}

export function Sidebar({
  userCapabilities = [],
  userRole = "에이전트 운영자",
  userName = "admin",
  onLogout,
}: SidebarProps) {
  const location = useLocation();

  // LNB 접기/펼치기 상태 관리 (localStorage 영속화)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("agent_mesh_sidebar_collapsed") === "true";
    } catch {
      return false;
    }
  });

  const toggleSidebar = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("agent_mesh_sidebar_collapsed", String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const sections: NavSectionDef[] = [
    {
      title: "핵심 개요",
      items: [
        {
          label: "대시보드",
          description: "통합 플릿 및 서버 현황 요약",
          href: "/dashboard",
          icon: "📊",
        },
      ],
    },
    {
      title: "에이전트 운영 스튜디오",
      items: [
        {
          label: "내 에이전트",
          description: "소유 에이전트 목록 및 연결 상태",
          href: "/creator",
          icon: "🤖",
        },
        {
          label: "스웜 그룹 관리",
          description: "그룹 생성 및 에이전트 배속/이동",
          href: "/creator/groups",
          icon: "👥",
        },
        {
          label: "에이전트 토폴로지",
          description: "원형 오비탈 노드-엣지 인터랙티브 제어",
          href: "/creator/topology",
          icon: "🌐",
        },
        {
          label: "메시지 플레이그라운드",
          description: "JWT 프록시 발송 및 실시간 영수증",
          href: "/creator/playground",
          icon: "💬",
        },
        {
          label: "소켓리스 리스 큐",
          description: "300s TTL 카운트다운 및 ACK/NACK",
          href: "/creator/lease-queue",
          icon: "📥",
        },
        {
          label: "신규 에이전트 등록",
          description: "신원 등록 및 Ed25519 키 제안",
          href: "/creator/register",
          icon: "➕",
        },
      ],
    },
    {
      title: "실시간 서버 모니터링",
      items: [
        {
          label: "서버 인프라 현황",
          description: "실시간 허브 헬스 및 온라인 소켓",
          href: "/platform",
          icon: "⚡",
          requiredCapability: "server.inspect",
        },
        {
          label: "노드 텔레메트리",
          description: "프로세스 CPU, RAM 및 소켓 지표",
          href: "/platform/telemetry",
          icon: "📈",
          requiredCapability: "server.inspect",
        },
        {
          label: "테넌트 라우팅 분석",
          description: "조직별 라우팅 처리량 및 스토리지",
          href: "/platform/tenants",
          icon: "🏢",
          requiredCapability: "server.inspect",
        },
      ],
    },
    {
      title: "테넌트 관리 콘솔",
      items: [
        {
          label: "이그레스 ACL 행렬",
          description: "그룹 간 통신 허용/차단 제어",
          href: "/tenant/egress-acl",
          icon: "🛡️",
          requiredCapability: "policy.send_restrict",
        },
        {
          label: "메시지 본문 감사",
          description: "audit.read.content 기반 열람",
          href: "/tenant/audits",
          icon: "🔍",
          requiredCapability: "audit.read_content",
        },
        {
          label: "조직 멤버 RBAC",
          description: "관리자별 9대 권한 부여/회수",
          href: "/tenant/rbac",
          icon: "🔑",
          requiredCapability: "role.assign",
        },
      ],
    },
  ];

  return (
    <aside
      style={{
        width: isCollapsed ? 68 : 280,
        minWidth: isCollapsed ? 68 : 280,
        background: "var(--color-bg-surface)",
        borderRight: "1px solid var(--color-border)",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        position: "sticky",
        top: 0,
        transition: "width 0.2s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
        overflowX: "hidden",
        zIndex: 40,
      }}
    >
      {/* Brand & Collapse Header */}
      <div
        style={{
          padding: isCollapsed ? "16px 0" : "18px 16px 14px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: isCollapsed ? "center" : "space-between",
          minHeight: 65,
        }}
      >
        {isCollapsed ? (
          <button
            type="button"
            onClick={toggleSidebar}
            title="LNB 메뉴 펼치기"
            style={{
              width: 36,
              height: 36,
              borderRadius: "var(--radius-md)",
              background: "var(--color-primary-light)",
              border: "1px solid var(--color-primary-border, #BFDBFE)",
              color: "var(--color-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: 800,
              padding: 0,
              transition: "transform 0.15s ease",
            }}
          >
            ▶
          </button>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                minWidth: 0,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  minWidth: 32,
                  borderRadius: 8,
                  background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.95rem",
                  fontWeight: 900,
                }}
                title="Agent Mesh Platform"
              >
                M
              </div>

              <div style={{ minWidth: 0, overflow: "hidden" }}>
                <div
                  style={{
                    fontSize: "0.95rem",
                    fontWeight: 800,
                    letterSpacing: "-0.02em",
                    color: "var(--color-text-primary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  Agent Mesh
                </div>
                <div
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--color-text-muted)",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  Phase 1 MVP · SPEC 0.2
                </div>
              </div>
            </div>

            {/* LNB 접기 버튼 */}
            <button
              type="button"
              onClick={toggleSidebar}
              title="LNB 메뉴 숨기기 (접기)"
              style={{
                background: "var(--color-bg-surface-sub)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                width: 26,
                height: 26,
                minWidth: 26,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                fontSize: "0.75rem",
                transition: "all 0.15s ease",
                padding: 0,
              }}
            >
              ◀
            </button>
          </>
        )}
      </div>

      {/* Navigation Tree */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: isCollapsed ? "14px 8px" : "16px 12px",
          display: "flex",
          flexDirection: "column",
          gap: isCollapsed ? 10 : 20,
        }}
      >
        {sections.map((section) => {
          const visibleItems = section.items.filter((item) => {
            if (!item.requiredCapability) return true;
            return (
              userCapabilities.includes(item.requiredCapability) ||
              userCapabilities.includes("admin.all")
            );
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={section.title}>
              {!isCollapsed ? (
                <div
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 700,
                    color: "var(--color-text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "0 8px 6px",
                  }}
                >
                  {section.title}
                </div>
              ) : (
                <div
                  style={{
                    height: 1,
                    background: "var(--color-border)",
                    margin: "4px auto 8px",
                    width: 32,
                  }}
                />
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: isCollapsed ? 6 : 2 }}>
                {visibleItems.map((item) => {
                  const isActive = location.pathname === item.href;

                  if (isCollapsed) {
                    return (
                      <Link
                        key={item.href}
                        to={item.href}
                        title={`${item.label}\n${item.description}`}
                        style={{
                          width: 44,
                          height: 44,
                          margin: "0 auto",
                          borderRadius: "var(--radius-md)",
                          background: isActive
                            ? "var(--color-primary-light)"
                            : "transparent",
                          border: `1px solid ${isActive ? "var(--color-primary)" : "transparent"}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "1.25rem",
                          textDecoration: "none",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {item.icon}
                      </Link>
                    );
                  }

                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: "var(--radius-md)",
                        background: isActive
                          ? "var(--color-primary-light)"
                          : "transparent",
                        border: `1px solid ${isActive ? "var(--color-primary)" : "transparent"}`,
                        textDecoration: "none",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "1rem",
                          lineHeight: 1.2,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {item.icon}
                      </span>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: "0.85rem",
                            fontWeight: 700,
                            color: isActive
                              ? "var(--color-primary)"
                              : "var(--color-text-primary)",
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <span>{item.label}</span>
                          {item.badge && (
                            <span
                              style={{
                                fontSize: "0.65rem",
                                padding: "1px 5px",
                                borderRadius: "var(--radius-full)",
                                background: "var(--color-primary)",
                                color: "white",
                              }}
                            >
                              {item.badge}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: "0.72rem",
                            color: isActive
                              ? "var(--color-primary-text)"
                              : "var(--color-text-muted)",
                            lineHeight: 1.25,
                            marginTop: 2,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {item.description}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* User Footer */}
      <div
        style={{
          padding: isCollapsed ? "14px 0" : "14px 16px",
          borderTop: "1px solid var(--color-border)",
          background: "var(--color-bg-surface-sub)",
          display: "flex",
          alignItems: "center",
          justifyContent: isCollapsed ? "center" : "space-between",
        }}
      >
        {!isCollapsed ? (
          <>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: "0.82rem",
                  fontWeight: 700,
                  color: "var(--color-text-primary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {userName}
              </div>
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "var(--color-text-secondary)",
                }}
              >
                {userRole}
              </div>
            </div>

            {onLogout && (
              <button
                onClick={onLogout}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-text-muted)",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  padding: "4px 8px",
                  borderRadius: "var(--radius-sm)",
                }}
                title="로그아웃"
              >
                로그아웃
              </button>
            )}
          </>
        ) : (
          <button
            onClick={onLogout}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "1.1rem",
              padding: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="로그아웃"
          >
            🚪
          </button>
        )}
      </div>
    </aside>
  );
}
