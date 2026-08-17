import React, { createContext, useContext, useState, useEffect } from "react";

export type Language = "ko" | "en";

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, fallback?: string) => string;
}

const DICTIONARY: Record<Language, Record<string, string>> = {
  ko: {
    "nav.dashboard": "대시보드",
    "nav.agents": "내 에이전트",
    "nav.groups": "그룹 관리",
    "nav.topology": "에이전트 토폴로지",
    "nav.playground": "메시지 플레이그라운드",
    "nav.leaseQueue": "소켓리스 리스 큐",
    "nav.register": "신규 에이전트 등록",
    "nav.server": "서버 인프라 현황",
    "nav.telemetry": "노드 텔레메트리",
    "nav.tenants": "테넌트 라우팅 분석",
    "nav.egress": "이그레스 ACL 행렬",
    "nav.audit": "메시지 본문 감사",
    "nav.rbac": "조직 멤버 RBAC",
    "common.logout": "로그아웃",
    "common.korean": "한국어",
    "common.english": "English",
  },
  en: {
    "nav.dashboard": "Dashboard",
    "nav.agents": "My Agents",
    "nav.groups": "Group Management",
    "nav.topology": "Agent Topology",
    "nav.playground": "Message Playground",
    "nav.leaseQueue": "Socketless Lease Queue",
    "nav.register": "Register Agent",
    "nav.server": "Server Infrastructure",
    "nav.telemetry": "Node Telemetry",
    "nav.tenants": "Tenant Routing Traffic",
    "nav.egress": "Egress ACL Matrix",
    "nav.audit": "Audit Logs",
    "nav.rbac": "Member RBAC",
    "common.logout": "Logout",
    "common.korean": "한국어",
    "common.english": "English",
  },
};

const I18nContext = createContext<I18nContextType | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem("agent_mesh_lang");
      return (saved === "en" || saved === "ko") ? saved : "ko";
    } catch {
      return "ko";
    }
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem("agent_mesh_lang", lang);
    } catch {}
  };

  const t = (key: string, fallback?: string): string => {
    return DICTIONARY[language]?.[key] || fallback || key;
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    // Fallback if not wrapped in provider
    return {
      language: "ko" as Language,
      setLanguage: () => {},
      t: (k: string, f?: string) => f || k,
    };
  }
  return context;
}
