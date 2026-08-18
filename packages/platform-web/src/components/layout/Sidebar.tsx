import React, { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "@/contexts/I18nContext.tsx";
import type { Capability } from "@/types/auth.ts";

export interface NavItemDef {
  label: string;
  description: string;
  href: string;
  icon: string;
  /**
   * The capability a viewer must hold for this item to appear.
   *
   * **`Capability`, not `string`.** As a string it accepted six names the
   * contract does not define — `server.inspect`, `policy.send_restrict`,
   * `audit.read_content`, `role.assign` — and every one of them compiled. A
   * name nobody holds hides its item from everybody, so the menu was the same
   * for every role, which is how this was found: by looking at it.
   *
   * The route guards took the contract's type when `@agent-mesh/contracts`
   * landed and were corrected by the compiler. This table was not typed, so it
   * kept its own copy of the vocabulary and drifted alone.
   */
  requiredCapability?: Capability;
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
  const { language, setLanguage, t } = useI18n();
  const [isLangOpen, setIsLangOpen] = useState(false);
  const langPopoverRef = useRef<HTMLDivElement>(null);

  // Close language popup when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (langPopoverRef.current && !langPopoverRef.current.contains(e.target as Node)) {
        setIsLangOpen(false);
      }
    }
    if (isLangOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isLangOpen]);

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
      title: t("nav.sec.overview", "핵심 개요"),
      items: [
        {
          label: t("nav.dashboard", "대시보드"),
          description: t("nav.dashboard.desc", "통합 플릿 및 서버 현황 요약"),
          href: "/dashboard",
          icon: "📊",
        },
      ],
    },
    {
      title: t("nav.sec.studio", "에이전트 운영 스튜디오"),
      items: [
        {
          label: t("nav.agents", "내 에이전트"),
          description: t("nav.agents.desc", "소유 에이전트 목록 및 연결 상태"),
          href: "/creator",
          icon: "🤖",
        },
        {
          label: t("nav.groups", "그룹 관리"),
          description: t("nav.groups.desc", "그룹 생성 및 에이전트 배속/이동"),
          href: "/creator/groups",
          icon: "👥",
        },
        {
          label: t("nav.topology", "에이전트 토폴로지"),
          description: t("nav.topology.desc", "원형 오비탈 노드-엣지 인터랙티브 제어"),
          href: "/creator/topology",
          icon: "🌐",
        },
        {
          label: t("nav.playground", "메시지 플레이그라운드"),
          description: t("nav.playground.desc", "JWT 프록시 발송 및 실시간 영수증"),
          href: "/creator/playground",
          icon: "💬",
        },
        {
          label: t("nav.mailbox", "에이전트 메일함"),
          description: t("nav.mailbox.desc", "300s TTL 카운트다운 및 ACK/NACK"),
          href: "/creator/lease-queue",
          icon: "📬",
        },
        {
          label: t("nav.register", "신규 에이전트 등록"),
          description: t("nav.register.desc", "신원 등록 및 Ed25519 키 제안"),
          href: "/creator/register",
          icon: "➕",
        },
      ],
    },
    {
      title: t("nav.sec.platform", "실시간 서버 모니터링"),
      items: [
        {
          label: t("nav.server", "서버 인프라 현황"),
          description: t("nav.server.desc", "실시간 허브 헬스 및 온라인 소켓"),
          href: "/platform",
          icon: "⚡",
          // No capability. `/api/v1/agents` and `/api/v1/health` gate on a
          // session and nothing more, and App.tsx guards this route the same
          // way. A menu stricter than the route hides a page from someone who
          // is allowed to open it.
        },
        {
          label: t("nav.telemetry", "노드 텔레메트리"),
          description: t("nav.telemetry.desc", "프로세스 CPU, RAM 및 소켓 지표"),
          href: "/platform/telemetry",
          icon: "📈",
          // As above. The screen reads three routes with three different
          // gates, so the honest form is a partial render, not one name.
        },
        {
          label: t("nav.tenants", "테넌트 라우팅 분석"),
          description: t("nav.tenants.desc", "조직별 라우팅 처리량 및 스토리지"),
          href: "/platform/tenants",
          icon: "🏢",
          requiredCapability: "tenant.read.stats",
        },
      ],
    },
    {
      title: t("nav.sec.tenant", "테넌트 관리 콘솔"),
      items: [
        {
          label: t("nav.egress", "이그레스 ACL 행렬"),
          description: t("nav.egress.desc", "그룹 간 통신 허용/차단 제어"),
          href: "/tenant/egress-acl",
          icon: "🛡️",
          requiredCapability: "group.manage",
        },
        {
          label: t("nav.audit", "메시지 본문 감사"),
          description: t("nav.audit.desc", "audit.read.content 기반 열람"),
          href: "/tenant/audits",
          icon: "🔍",
          requiredCapability: "audit.read.metadata",
        },
        {
          label: t("nav.rbac", "조직 멤버 RBAC"),
          description: t("nav.rbac.desc", "관리자별 9대 권한 부여/회수"),
          href: "/tenant/rbac",
          icon: "🔑",
          requiredCapability: "role.grant",
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
            // No `admin.all` fallback. It is not in the contract and must not
            // come back: § 11 exists because "is an administrator" is not a
            // capability, and one name standing for all twelve is the shape it
            // undoes. An admin holds the twelve individually.
            return userCapabilities.includes(item.requiredCapability);
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

      {/* User Footer with Upward Language Combobox */}
      <div
        ref={langPopoverRef}
        style={{
          position: "relative",
          padding: isCollapsed ? "14px 0" : "12px 14px",
          borderTop: "1px solid var(--color-border)",
          background: "var(--color-bg-surface-sub)",
          display: "flex",
          alignItems: "center",
          justifyContent: isCollapsed ? "center" : "space-between",
          gap: 8,
        }}
      >
        {/* Upward Language Selection Combobox Popover */}
        {isLangOpen && (
          <div
            style={{
              position: "absolute",
              bottom: "calc(100% + 8px)",
              left: isCollapsed ? "50%" : 12,
              transform: isCollapsed ? "translateX(-50%)" : "none",
              zIndex: 100,
              background: "var(--color-bg-surface, #FFFFFF)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.12)",
              padding: "6px",
              display: "flex",
              flexDirection: "column",
              gap: 3,
              minWidth: 148,
              animation: "fadeInUp 0.15s ease-out",
            }}
          >
            <div
              style={{
                fontSize: "0.68rem",
                fontWeight: 700,
                color: "var(--color-text-muted)",
                padding: "3px 8px 4px",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                borderBottom: "1px solid var(--color-border-subtle, #F1F5F9)",
                marginBottom: 2,
              }}
            >
              Language / 언어 선택
            </div>

            <button
              type="button"
              onClick={() => {
                setLanguage("ko");
                setIsLangOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "7px 10px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                background: language === "ko" ? "var(--color-primary-light, #EFF6FF)" : "transparent",
                color: language === "ko" ? "var(--color-primary, #2563EB)" : "var(--color-text-primary)",
                fontWeight: language === "ko" ? 700 : 500,
                fontSize: "0.82rem",
                cursor: "pointer",
                textAlign: "left",
                transition: "background 0.12s ease",
              }}
              onMouseEnter={(e) => {
                if (language !== "ko") e.currentTarget.style.background = "var(--color-bg-surface-hover, #F8FAFC)";
              }}
              onMouseLeave={(e) => {
                if (language !== "ko") e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "1.1rem" }}>🇰🇷</span>
                <span>한국어</span>
              </span>
              {language === "ko" && <span style={{ fontSize: "0.8rem", fontWeight: 800 }}>✓</span>}
            </button>

            <button
              type="button"
              onClick={() => {
                setLanguage("en");
                setIsLangOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "7px 10px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                background: language === "en" ? "var(--color-primary-light, #EFF6FF)" : "transparent",
                color: language === "en" ? "var(--color-primary, #2563EB)" : "var(--color-text-primary)",
                fontWeight: language === "en" ? 700 : 500,
                fontSize: "0.82rem",
                cursor: "pointer",
                textAlign: "left",
                transition: "background 0.12s ease",
              }}
              onMouseEnter={(e) => {
                if (language !== "en") e.currentTarget.style.background = "var(--color-bg-surface-hover, #F8FAFC)";
              }}
              onMouseLeave={(e) => {
                if (language !== "en") e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "1.1rem" }}>🇺🇸</span>
                <span>English</span>
              </span>
              {language === "en" && <span style={{ fontSize: "0.8rem", fontWeight: 800 }}>✓</span>}
            </button>
          </div>
        )}

        {!isCollapsed ? (
          <>
            {/* Flag Trigger & User Info Container */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
              {/* Flag Icon Button Trigger */}
              <button
                type="button"
                onClick={() => setIsLangOpen((prev) => !prev)}
                title="언어 변경 (Language Switcher)"
                style={{
                  width: 30,
                  height: 30,
                  minWidth: 30,
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)",
                  background: isLangOpen ? "var(--color-primary-light, #EFF6FF)" : "var(--color-bg-surface, #FFFFFF)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontSize: "1.05rem",
                  padding: 0,
                  transition: "all 0.15s ease",
                  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
                }}
              >
                {language === "ko" ? "🇰🇷" : "🇺🇸"}
              </button>

              {/* User Name & Role */}
              <div style={{ minWidth: 0, overflow: "hidden" }}>
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
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {userRole}
                </div>
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
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  padding: "4px 6px",
                  borderRadius: "var(--radius-sm)",
                  whiteSpace: "nowrap",
                }}
                title={t("common.logout", "로그아웃")}
              >
                {t("common.logout", "로그아웃")}
              </button>
            )}
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            {/* Flag Trigger in Collapsed Sidebar */}
            <button
              type="button"
              onClick={() => setIsLangOpen((prev) => !prev)}
              title="언어 변경 (Language Switcher)"
              style={{
                width: 28,
                height: 28,
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
                background: isLangOpen ? "var(--color-primary-light, #EFF6FF)" : "var(--color-bg-surface, #FFFFFF)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: "1rem",
                padding: 0,
              }}
            >
              {language === "ko" ? "🇰🇷" : "🇺🇸"}
            </button>

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
          </div>
        )}
      </div>
    </aside>
  );
}
