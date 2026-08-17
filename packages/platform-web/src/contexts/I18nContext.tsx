import React, { createContext, useContext, useState, useEffect } from "react";

export type Language = "ko" | "en";

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, fallback?: string) => string;
}

export const DICTIONARY: Record<Language, Record<string, string>> = {
  ko: {
    // Navigation Sections
    "nav.sec.overview": "핵심 개요",
    "nav.sec.studio": "에이전트 운영 스튜디오",
    "nav.sec.platform": "실시간 서버 모니터링",
    "nav.sec.tenant": "테넌트 관리 콘솔",

    // Navigation Items
    "nav.dashboard": "대시보드",
    "nav.dashboard.desc": "통합 플릿 및 서버 현황 요약",
    "nav.agents": "내 에이전트",
    "nav.agents.desc": "소유 에이전트 목록 및 연결 상태",
    "nav.groups": "그룹 관리",
    "nav.groups.desc": "그룹 생성 및 에이전트 배속/이동",
    "nav.topology": "에이전트 토폴로지",
    "nav.topology.desc": "원형 오비탈 노드-엣지 인터랙티브 제어",
    "nav.playground": "메시지 플레이그라운드",
    "nav.playground.desc": "JWT 프록시 발송 및 실시간 영수증",
    "nav.leaseQueue": "소켓리스 리스 큐",
    "nav.leaseQueue.desc": "300s TTL 카운트다운 및 ACK/NACK",
    "nav.register": "신규 에이전트 등록",
    "nav.register.desc": "신원 등록 및 Ed25519 키 제안",
    "nav.server": "서버 인프라 현황",
    "nav.server.desc": "실시간 허브 헬스 및 온라인 소켓",
    "nav.telemetry": "노드 텔레메트리",
    "nav.telemetry.desc": "프로세스 CPU, RAM 및 소켓 지표",
    "nav.tenants": "테넌트 라우팅 분석",
    "nav.tenants.desc": "조직별 라우팅 처리량 및 스토리지",
    "nav.egress": "이그레스 ACL 행렬",
    "nav.egress.desc": "그룹 간 통신 허용/차단 제어",
    "nav.audit": "메시지 본문 감사",
    "nav.audit.desc": "audit.read_content 기반 열람",
    "nav.rbac": "조직 멤버 RBAC",
    "nav.rbac.desc": "관리자별 9대 권한 부여/회수",

    // Breadcrumbs
    "bc.home": "홈",
    "bc.dashboard": "대시보드",
    "bc.studio": "에이전트 운영 스튜디오",
    "bc.agents": "소유 에이전트",
    "bc.groups": "그룹 관리",
    "bc.topology": "에이전트 토폴로지",
    "bc.playground": "메시지 플레이그라운드",
    "bc.leaseQueue": "소켓리스 큐",
    "bc.register": "신규 에이전트 등록",
    "bc.platform": "실시간 서버 모니터링",
    "bc.server": "서버 인프라 현황",
    "bc.telemetry": "노드 텔레메트리",
    "bc.tenants": "테넌트 트래픽 격리",
    "bc.governance": "플랫폼 거버넌스",
    "bc.groupGovernance": "그룹 거버넌스",
    "bc.egress": "Egress ACL 매트릭스",
    "bc.audit": "보안 감사 로그",
    "bc.rbac": "RBAC 권한 관리",

    // Common UI
    "common.logout": "로그아웃",
    "common.korean": "한국어",
    "common.english": "English",
    "common.refresh": "새로고침",
    "common.create": "생성하기",
    "common.cancel": "취소",
    "common.save": "저장",
    "common.close": "닫기",
    "common.delete": "삭제",
    "common.actions": "작업",
    "common.status": "상태",
    "common.online": "온라인",
    "common.offline": "오프라인",
    "common.active": "활성",
    "common.inactive": "비활성",
    "common.search": "검색",
    "common.all": "전체",
    "common.created": "생성 일시",

    // Topology Page
    "topo.title": "에이전트 토폴로지",
    "topo.subtitle": "실시간 연결된 {groups}개 그룹 네트워크 및 {agents}개 에이전트 라우팅 토폴로지",
    "topo.filter.all": "전체 그룹 보기 ({count})",
    "topo.search.placeholder": "에이전트 검색 (핀둥이, claude)...",
    "topo.hud.groups": "Groups",
    "topo.hud.agents": "Agents",
    "topo.hud.gateways": "Gateways",
    "topo.hud.egress": "Egress",
    "topo.inspector.title": "노드 인스펙터",
    "topo.inspector.type": "노드 타입",
    "topo.inspector.group": "소속 그룹",
    "topo.inspector.status": "런타임 상태",
    "topo.inspector.peers": "연결된 피어 노드",
    "topo.inspector.noPeers": "직접 연결된 피어 없음",
    "topo.sim.title": "그룹 스케일 단계:",
    "topo.sim.full": "⚡ 10-그룹 풀 로드 (139노드)",
    "topo.sim.notice": "* 론칭 시 하단 툴박스는 운영자 전용 디버그 패널로 분리됩니다",

    // Groups Page
    "groups.title": "그룹 관리 & 에이전트 배속",
    "groups.subtitle": "그룹 생성 및 소유 에이전트 멤버십 이동·배치 (SPEC § 11.3 / § 12 group.manage)",
    "groups.createBtn": "➕ 그룹 생성",
    "groups.col.name": "그룹 명 / ID",
    "groups.col.desc": "그룹 설명",
    "groups.col.agents": "소속 에이전트",
    "groups.col.members": "배속 에이전트 목록",
    "groups.col.created": "생성 일시",
    "groups.col.actions": "작업",
    "groups.assignBtn": "에이전트 배속/이동",
    "groups.modal.createTitle": "신규 그룹 생성",
    "groups.modal.nameLabel": "그룹 이름",
    "groups.modal.namePlaceholder": "예: Analytics Group (데이터 분석)",
    "groups.modal.descLabel": "그룹 설명",
    "groups.modal.descPlaceholder": "그룹의 역할 및 격리 목적을 입력하세요",
    "groups.modal.assignTitle": "에이전트 배속 및 이동",
    "groups.modal.agentIdLabel": "배속할 에이전트 ID",

    // Agents Page
    "agents.title": "내 에이전트 관리",
    "agents.subtitle": "소유한 Ed25519 에이전트 신원, 암호학적 지문 및 실시간 웹소켓 연결 상태",
    "agents.col.name": "에이전트 명 / ID",
    "agents.col.group": "소속 그룹",
    "agents.col.fingerprint": "Ed25519 공개키 지문",
    "agents.col.inbox": "미수신 큐 (Lease)",
    "agents.col.lastSeen": "최근 활동",
    "agents.col.status": "연결 상태",
    "agents.col.actions": "작업",
    "agents.teardownBtn": "Teardown (영구 삭제)",

    // Lease Queue Page
    "lease.title": "소켓리스 리스 큐 (Lease Queue)",
    "lease.subtitle": "비동기 연결 에이전트를 위한 300초 TTL 리스 큐 및 ACK/NACK 재시도 관리 (SPEC § 9)",

    // Dashboard Page
    "dash.title": "통합 운영 대시보드",
    "dash.subtitle": "단일 패브릭 에이전트 플릿 요약, 실시간 허브 헬스 및 인박스 적체 모니터링",
    "dash.kpi.agents": "소유 에이전트",
    "dash.kpi.agentsSub": "개 등록됨",
    "dash.kpi.sockets": "온라인 소켓",
    "dash.kpi.socketsSub": "연결 활성",
    "dash.kpi.inbox": "인박스 적체 큐",
    "dash.kpi.inboxSub": "건 대기 중",
    "dash.kpi.latency": "평균 디스패치 지연",
    "dash.kpi.latencySub": "p99 기준",

    // Playground Page
    "play.title": "메시지 라우팅 플레이그라운드",
    "play.subtitle": "RFC 7519 JWT 토큰 기반 프록시 메시지 전송 및 전자서명 배달 영수증 검증 테스트",

    // Register Page
    "reg.title": "신규 에이전트 신원 등록",
    "reg.subtitle": "Ed25519 공개키 기반 새 자율 에이전트 등록 제안 및 테넌트 승인 대기 큐 등록",
  },
  en: {
    // Navigation Sections
    "nav.sec.overview": "Overview",
    "nav.sec.studio": "Agent Operations Studio",
    "nav.sec.platform": "Real-time Server Monitoring",
    "nav.sec.tenant": "Tenant Admin Console",

    // Navigation Items
    "nav.dashboard": "Dashboard",
    "nav.dashboard.desc": "Fleet Summary & Infrastructure Status",
    "nav.agents": "My Agents",
    "nav.agents.desc": "Owned Agent Registry & Connection Status",
    "nav.groups": "Group Management",
    "nav.groups.desc": "Create Groups & Assign Agent Memberships",
    "nav.topology": "Agent Topology",
    "nav.topology.desc": "Orbital Dynamic Node-Edge Viewport",
    "nav.playground": "Message Playground",
    "nav.playground.desc": "JWT Proxy Dispatch & Realtime Delivery Receipts",
    "nav.leaseQueue": "Socketless Lease Queue",
    "nav.leaseQueue.desc": "300s TTL Countdown & ACK/NACK Flow",
    "nav.register": "Register Agent",
    "nav.register.desc": "Identity Provisioning & Ed25519 Key Submission",
    "nav.server": "Server Infrastructure",
    "nav.server.desc": "Realtime Hub Health & Socket Connections",
    "nav.telemetry": "Node Telemetry",
    "nav.telemetry.desc": "Process CPU, Memory & Socket Metrics",
    "nav.tenants": "Tenant Routing Traffic",
    "nav.tenants.desc": "Tenant Routing Throughput & State Volumes",
    "nav.egress": "Egress ACL Matrix",
    "nav.egress.desc": "Inter-Group Communication Allow/Deny Rules",
    "nav.audit": "Audit Logs",
    "nav.audit.desc": "Tamper-Evident Content Auditing",
    "nav.rbac": "Member RBAC",
    "nav.rbac.desc": "Manage 9 Core Admin Capabilities",

    // Breadcrumbs
    "bc.home": "Home",
    "bc.dashboard": "Dashboard",
    "bc.studio": "Agent Operations Studio",
    "bc.agents": "My Agents",
    "bc.groups": "Group Management",
    "bc.topology": "Agent Topology",
    "bc.playground": "Message Playground",
    "bc.leaseQueue": "Socketless Queue",
    "bc.register": "Register Agent",
    "bc.platform": "Server Monitoring",
    "bc.server": "Server Infrastructure",
    "bc.telemetry": "Node Telemetry",
    "bc.tenants": "Tenant Traffic",
    "bc.governance": "Platform Governance",
    "bc.groupGovernance": "Group Governance",
    "bc.egress": "Egress ACL Matrix",
    "bc.audit": "Security Audit Logs",
    "bc.rbac": "RBAC Permissions",

    // Common UI
    "common.logout": "Logout",
    "common.korean": "한국어",
    "common.english": "English",
    "common.refresh": "Refresh",
    "common.create": "Create",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.close": "Close",
    "common.delete": "Delete",
    "common.actions": "Actions",
    "common.status": "Status",
    "common.online": "Online",
    "common.offline": "Offline",
    "common.active": "Active",
    "common.inactive": "Inactive",
    "common.search": "Search",
    "common.all": "All",
    "common.created": "Created At",

    // Topology Page
    "topo.title": "Agent Topology",
    "topo.subtitle": "Real-time routing topology of {groups} connected groups and {agents} agent nodes",
    "topo.filter.all": "View All Groups ({count})",
    "topo.search.placeholder": "Search agents (e.g. 핀둥이, claude)...",
    "topo.hud.groups": "Groups",
    "topo.hud.agents": "Agents",
    "topo.hud.gateways": "Gateways",
    "topo.hud.egress": "Egress",
    "topo.inspector.title": "Node Inspector",
    "topo.inspector.type": "Node Type",
    "topo.inspector.group": "Assigned Group",
    "topo.inspector.status": "Runtime Status",
    "topo.inspector.peers": "Connected Peers",
    "topo.inspector.noPeers": "No directly connected peers",
    "topo.sim.title": "Group Scale Stage:",
    "topo.sim.full": "⚡ Full 10-Group Galaxy (139 Nodes)",
    "topo.sim.notice": "* In production launch, this test toolbox will be separated into an operator debug panel",

    // Groups Page
    "groups.title": "Group Management & Member Assignment",
    "groups.subtitle": "Create groups and assign agent memberships (SPEC § 11.3 / § 12 group.manage)",
    "groups.createBtn": "➕ Create Group",
    "groups.col.name": "Group Name / ID",
    "groups.col.desc": "Description",
    "groups.col.agents": "Agents",
    "groups.col.members": "Assigned Agents",
    "groups.col.created": "Created At",
    "groups.col.actions": "Actions",
    "groups.assignBtn": "Assign / Move Agent",
    "groups.modal.createTitle": "Create New Group",
    "groups.modal.nameLabel": "Group Name",
    "groups.modal.namePlaceholder": "e.g. Analytics Group",
    "groups.modal.descLabel": "Description",
    "groups.modal.descPlaceholder": "Enter role and isolation purpose for this group",
    "groups.modal.assignTitle": "Assign & Move Agent",
    "groups.modal.agentIdLabel": "Agent ID to Assign",

    // Agents Page
    "agents.title": "My Agents",
    "agents.subtitle": "Owned Ed25519 agent identities, cryptographic fingerprints, and real-time WebSocket connection state",
    "agents.col.name": "Agent Name / ID",
    "agents.col.group": "Assigned Group",
    "agents.col.fingerprint": "Ed25519 Public Key Fingerprint",
    "agents.col.inbox": "Lease Queue (Undelivered)",
    "agents.col.lastSeen": "Last Seen",
    "agents.col.status": "Connection Status",
    "agents.col.actions": "Actions",
    "agents.teardownBtn": "Teardown (Permanent Delete)",

    // Lease Queue Page
    "lease.title": "Socketless Lease Queue",
    "lease.subtitle": "300s TTL lease countdown and ACK/NACK retry management for asynchronously connected agents (SPEC § 9)",

    // Dashboard Page
    "dash.title": "Unified Operations Dashboard",
    "dash.subtitle": "Fleet summary, real-time hub health, and undelivered lease queue monitoring",
    "dash.kpi.agents": "Owned Agents",
    "dash.kpi.agentsSub": "registered",
    "dash.kpi.sockets": "Online Sockets",
    "dash.kpi.socketsSub": "active connections",
    "dash.kpi.inbox": "Lease Queue Pending",
    "dash.kpi.inboxSub": "queued messages",
    "dash.kpi.latency": "Dispatch Latency",
    "dash.kpi.latencySub": "p99 benchmark",

    // Playground Page
    "play.title": "Message Routing Playground",
    "play.subtitle": "RFC 7519 JWT-based proxy dispatch and digital signature delivery receipt verification test",

    // Register Page
    "reg.title": "Register New Agent Identity",
    "reg.subtitle": "Submit Ed25519 public key proposal and register into tenant approval queue",
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
