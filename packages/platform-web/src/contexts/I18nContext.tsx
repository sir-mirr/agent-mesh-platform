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
    "nav.mailbox": "에이전트 메일함",
    "nav.mailbox.desc": "300s TTL 카운트다운 및 ACK/NACK 리스 관리",
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
    "nav.audit.desc": "audit.read.content 기반 열람",
    "nav.rbac": "조직 멤버 RBAC",
    "nav.rbac.desc": "계정별 권한 부여 및 회수",

    // Breadcrumbs
    "bc.home": "홈",
    "bc.dashboard": "대시보드",
    "bc.studio": "에이전트 운영 스튜디오",
    "bc.agents": "소유 에이전트",
    "bc.groups": "그룹 관리",
    "bc.topology": "에이전트 토폴로지",
    "bc.playground": "메시지 플레이그라운드",
    "bc.mailbox": "에이전트 메일함",
    "bc.register": "신규 에이전트 등록",
    "bc.platform": "실시간 서버 모니터링",
    "bc.server": "서버 인프라 현황",
    "bc.telemetry": "노드 텔레메트리",
    "bc.tenants": "테넌트 트래픽 격리",
    "bc.governance": "플랫폼 거버넌스",
    "bc.egress": "Egress ACL 매트릭스",
    "bc.audit": "보안 감사 로그",
    "bc.rbac": "RBAC 권한 관리",

    // Common UI
    "common.logout": "로그아웃",
    "common.refresh": "새로고침",
    "common.create": "생성하기",
    "common.cancel": "취소",
    "common.save": "저장",
    "common.close": "닫기",
    "common.disconnected": "통신 불가",

    // Topology Page
    "topo.title": "에이전트 토폴로지",
    "topo.subtitle": "실시간 연결된 {groups}개 그룹 네트워크 및 {agents}개 에이전트 라우팅 토폴로지",
    "topo.filter.all": "전체 그룹 보기 ({count})",
    "topo.search.placeholder": "에이전트 검색 (핀둥이, claude)...",
    "topo.hud.groups": "Groups",
    "topo.hud.agents": "Agents",
    "topo.hud.gateways": "Gateways",
    "topo.hud.egress": "Egress",

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
    "agents.col.fingerprint": "Ed25519 공개키 지문",
    "agents.col.inbox": "메일함 적체 (Mailbox)",
    "agents.col.lastSeen": "최근 활동",
    "agents.col.actions": "작업",
    "agents.teardownBtn": "Teardown (영구 삭제)",

    // Mailbox Queue Page
    "lease.title": "에이전트 메일함 리스 큐 (Mailbox Queue)",
    "lease.subtitle": "비동기 메시지 수신 에이전트를 위한 300초 TTL 메일함 리스 및 ACK/NACK 재시도 관리 (SPEC § 9)",

    // Role-Tailored Dashboard
    "dash.platform.title": "플랫폼 인프라 & 글로벌 허브 대시보드",
    "dash.platform.sub": "글로벌 분산 노드 토폴로지, 실시간 CPU/RAM 부하 및 테넌트 트래픽 격리 상태",
    "dash.tenant.title": "테넌트 조직 거버넌스 & 플릿 대시보드",
    "dash.tenant.sub": "조직 소속 에이전트 그룹, 그룹 간 Egress 통신 정책 및 보안 감사 현황",
    "dash.group.title": "에이전트 그룹 운영 관리 대시보드",
    "dash.group.sub": "담당 그룹별 에이전트 멤버십 이동, 메일함 큐 적체 및 그룹 간 통신 모니터링",
    "dash.operator.title": "소유 에이전트 운영 대시보드",
    "dash.operator.sub": "소유한 Ed25519 에이전트 연결 상태, 메일함 큐 및 메시지 테스트",

    "dash.pa.nodes": "전체 에이전트 노드",
    "dash.pa.nodesSub": "실시간 레지스트리",
    "dash.pa.sockets": "활성 웹소켓 풀",
    "dash.pa.socketsSub": "mTLS 연결",
    "dash.pa.tenants": "활성 테넌트 조직",
    "dash.pa.tenantTrafficTitle": "테넌트 조직별 트래픽 및 그룹 할당 현황",

    "dash.ta.groups": "조직 소속 그룹",
    "dash.ta.agents": "총 소속 에이전트",
    "dash.ta.agentsSub": "실시간 에이전트 플릿",
    "dash.ta.egress": "Egress 허용 규칙",
    "dash.ta.egressSub": "Deny-by-default",
    "dash.ta.approval": "미승인 키 대기 큐",
    "dash.ta.groupFleet": "조직 에이전트 그룹 현황",
    "dash.ta.pendingApproval": "신규 에이전트 공개키 승인 대기 큐",

    "dash.ga.groups": "담당 관리 그룹",
    "dash.ga.groupsSub": "Support, Billing, Analytics",
    "dash.ga.agents": "그룹 내 에이전트",
    "dash.ga.lease": "메일함 큐 적체",
    "dash.ga.leaseSub": "300s TTL 관리",
    "dash.ga.health": "그룹 헬스 지표",
    "dash.ga.membershipTitle": "그룹별 에이전트 멤버십 & 상태",

    "dash.op.fleetTitle": "소유 에이전트 플릿 상태 요약",
    "dash.kpi.agents": "소유 에이전트",
    "dash.kpi.agentsSub": "개 등록됨",
    "dash.kpi.sockets": "온라인 소켓",
    "dash.kpi.socketsSub": "연결 활성",
    "dash.kpi.inbox": "미수신 메일함",
    "dash.kpi.inboxSub": "메일함 대기",
    "dash.kpi.latency": "오늘의 전송량",
    "dash.kpi.latencySub": "건 완료",
    "dash.viewAll": "전체 보기 →",
    "dash.viewDetail": "상세 분석 보기 →",

    // Playground Page
    "play.title": "메시지 라우팅 플레이그라운드",
    "play.subtitle": "RFC 7519 JWT 토큰 기반 프록시 메시지 전송 및 전자서명 배달 영수증 검증 테스트",

    // Register Page
    "reg.title": "신규 에이전트 신원 등록 & 키 제안",

    // Egress ACL Page
    "egress.title": "그룹 간 이그레스 ACL 행렬",
    "egress.subtitle": "Deny-by-default 기반 그룹 간 방향성(A→B != B→A) 통신 제어 (SPEC § 12 / -32018 EGRESS_DENIED)",
    "egress.desc": "각 버튼을 클릭하여 출발 그룹(Source)에서 도착 그룹(Target)으로의 단방향 메시지 발송 허용/차단을 실시간 전환할 수 있습니다.",

    // RBAC Management Page
    "rbac.title": "조직 멤버 RBAC 권한 할당",
    "rbac.col.name": "멤버 이름 / 계정",
    "rbac.col.role": "역할 (Role)",
    "rbac.col.caps": "부여된 Capability (클릭하여 토글)",

    // Audit Logs Page
    "audit.title": "참가자 본문 감사 스트림",
    "audit.subtitle": "SPEC § 11.0 프라이버시 경계: audit.read.content 권한 보유자에게만 본문 노출, 미보유 시 [content withheld] 리댁션",
    "audit.refreshBtn": "↻ 감사 로그 갱신",
    "audit.col.time": "타임스탬프",
    "audit.col.route": "송수신 경로",
    "audit.col.length": "길이 (Bytes)",
    "audit.col.content": "메시지 본문 (§ 11.0 프라이버시 경계)",
    "audit.col.signature": "서명 상태",
    "audit.held": "[content withheld — requires audit.read.content]",
    "audit.status.has": "✓ audit.read.content 보유 (본문 열람 가능 — 열람 시 내부 감사 로그 기록됨)",
    "audit.status.none": "⚠️ audit.read.content 미보유 (본문 유출 차단, 메타데이터만 열람)",

    // Server Health Page
    "server.title": "실시간 서버 인프라 현황판",
    "server.subtitle": "현재 가동 중인 메시 허브 및 HTTP 서버의 실시간 헬스(/health), 활성 소켓 및 프로세스 모니터링",
    "server.refreshBtn": "↻ 메트릭 새로고침",
    "server.kpi.health": "허브 헬스체크",
    "server.kpi.sockets": "총 온라인 소켓",
    "server.kpi.socketsSub": "WebSocket 활성",
    "server.kpi.throughput": "전체 초당 처리량",
    "server.kpi.throughputSub": "정상 버퍼",
    "server.col.node": "노드 ID / 역할",
    "server.col.status": "헬스 상태 (/health)",
    "server.col.sockets": "온라인 소켓",
    "server.col.uptime": "가동 시간 (Uptime)",

    // Telemetry Page
    "telem.title": "노드 텔레메트리 모니터링",
    "telem.subtitle": "서버 프로세스 CPU, RAM, 이벤트 루프 지연율 및 실시간 웹소켓 연결 헬스 메트릭",
    "telem.refreshBtn": "↻ 실시간 갱신",
    "telem.logTitle": "📊 텔레메트리 진단 로그",
    "telem.logSub": "서버가 10초 주기로 수집하는 핵심 런타임 지표 스트림",

    // Tenant Traffic Page
    "traffic.title": "테넌트 라우팅 처리량 분석",
    "traffic.col.tenant": "테넌트 조직 명 / ID",
    "traffic.col.routes": "24h 메시지 라우팅 건수",
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
    "nav.mailbox": "Agent Mailbox",
    "nav.mailbox.desc": "300s TTL Countdown & ACK/NACK Flow",
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
    "nav.rbac.desc": "Grant and revoke member capabilities",

    // Breadcrumbs
    "bc.home": "Home",
    "bc.dashboard": "Dashboard",
    "bc.studio": "Agent Operations Studio",
    "bc.agents": "My Agents",
    "bc.groups": "Group Management",
    "bc.topology": "Agent Topology",
    "bc.playground": "Message Playground",
    "bc.mailbox": "Agent Mailbox",
    "bc.register": "Register Agent",
    "bc.platform": "Server Monitoring",
    "bc.server": "Server Infrastructure",
    "bc.telemetry": "Node Telemetry",
    "bc.tenants": "Tenant Traffic",
    "bc.governance": "Platform Governance",
    "bc.egress": "Egress ACL Matrix",
    "bc.audit": "Security Audit Logs",
    "bc.rbac": "RBAC Permissions",

    // Common UI
    "common.logout": "Logout",
    "common.refresh": "Refresh",
    "common.create": "Create",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.close": "Close",
    "common.disconnected": "Offline / Disconnected",

    // Topology Page
    "topo.title": "Agent Topology",
    "topo.subtitle": "Real-time routing topology of {groups} connected groups and {agents} agent nodes",
    "topo.filter.all": "View All Groups ({count})",
    "topo.search.placeholder": "Search agents (e.g. 핀둥이, claude)...",
    "topo.hud.groups": "Groups",
    "topo.hud.agents": "Agents",
    "topo.hud.gateways": "Gateways",
    "topo.hud.egress": "Egress",

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
    "agents.col.fingerprint": "Ed25519 Public Key Fingerprint",
    "agents.col.inbox": "Mailbox Depth (Undelivered)",
    "agents.col.lastSeen": "Last Seen",
    "agents.col.actions": "Actions",
    "agents.teardownBtn": "Teardown (Permanent Delete)",

    // Mailbox Queue Page
    "lease.title": "Agent Mailbox Lease Queue",
    "lease.subtitle": "300s TTL mailbox lease countdown and ACK/NACK retry management for asynchronously connected agents (SPEC § 9)",

    // Role-Tailored Dashboard
    "dash.platform.title": "Platform Infrastructure & Global Hub Dashboard",
    "dash.platform.sub": "Global node topology, realtime CPU/RAM load, and tenant traffic isolation",
    "dash.tenant.title": "Tenant Governance & Fleet Dashboard",
    "dash.tenant.sub": "Tenant agent groups, inter-group egress policies, and audit logs",
    "dash.group.title": "Agent Group Operations Dashboard",
    "dash.group.sub": "Group agent memberships, mailbox lease queue, and inter-group messaging",
    "dash.operator.title": "Owned Agent Fleet Dashboard",
    "dash.operator.sub": "Owned Ed25519 agent connections, mailbox lease queue, and message tests",

    "dash.pa.nodes": "Total Agent Nodes",
    "dash.pa.nodesSub": "Live Registry",
    "dash.pa.sockets": "Active WebSocket Pool",
    "dash.pa.socketsSub": "mTLS connections",
    "dash.pa.tenants": "Active Tenant Orgs",
    "dash.pa.tenantTrafficTitle": "Tenant Resource & Traffic Breakdown",

    "dash.ta.groups": "Tenant Agent Groups",
    "dash.ta.agents": "Total Fleet Agents",
    "dash.ta.agentsSub": "Live Agent Fleet",
    "dash.ta.egress": "Egress Rules Allowed",
    "dash.ta.egressSub": "Deny-by-default",
    "dash.ta.approval": "Pending Key Approvals",
    "dash.ta.groupFleet": "Tenant Agent Groups",
    "dash.ta.pendingApproval": "Pending Ed25519 Key Approvals",

    "dash.ga.groups": "Managed Groups",
    "dash.ga.groupsSub": "Support, Billing, Analytics",
    "dash.ga.agents": "Group Agents",
    "dash.ga.lease": "Mailbox Queue Depth",
    "dash.ga.leaseSub": "300s TTL flow",
    "dash.ga.health": "Group Health Score",
    "dash.ga.membershipTitle": "Group Memberships & Status",

    "dash.op.fleetTitle": "Owned Agent Fleet Summary",
    "dash.kpi.agents": "Owned Agents",
    "dash.kpi.agentsSub": "registered",
    "dash.kpi.sockets": "Online Sockets",
    "dash.kpi.socketsSub": "active connections",
    "dash.kpi.inbox": "Mailbox Pending",
    "dash.kpi.inboxSub": "queued messages",
    "dash.kpi.latency": "Daily Dispatch",
    "dash.kpi.latencySub": "messages sent",
    "dash.viewAll": "View All →",
    "dash.viewDetail": "View Breakdown →",

    // Playground Page
    "play.title": "Message Routing Playground",
    "play.subtitle": "RFC 7519 JWT-based proxy dispatch and digital signature delivery receipt verification test",

    // Register Page
    "reg.title": "Register New Agent Identity & Propose Key",

    // Egress ACL Page
    "egress.title": "Inter-Group Egress ACL Matrix",
    "egress.subtitle": "Deny-by-default directional (A→B != B→A) inter-group policy control (SPEC § 12 / -32018 EGRESS_DENIED)",
    "egress.desc": "Click any cell to toggle real-time unidirectional message egress allowance from Source group to Target group.",

    // RBAC Management Page
    "rbac.title": "Organization Member RBAC Capabilities",
    "rbac.col.name": "Member Name / Account",
    "rbac.col.role": "Role",
    "rbac.col.caps": "Assigned Capabilities (Click to toggle)",

    // Audit Logs Page
    "audit.title": "Participant Content Audit Stream",
    "audit.subtitle": "SPEC § 11.0 Privacy Boundary: Content revealed only to audit.read.content holders, [content withheld] for others",
    "audit.refreshBtn": "↻ Refresh Audit Logs",
    "audit.col.time": "Timestamp",
    "audit.col.route": "Route",
    "audit.col.length": "Length (Bytes)",
    "audit.col.content": "Message Content (§ 11.0 Privacy Boundary)",
    "audit.col.signature": "Signature",
    "audit.held": "[content withheld — requires audit.read.content]",
    "audit.status.has": "✓ audit.read.content held (Full plaintext reading enabled — every read is audited)",
    "audit.status.none": "⚠️ audit.read.content not held (Plaintext withheld, metadata only)",

    // Server Health Page
    "server.title": "Real-time Server Infrastructure",
    "server.subtitle": "Active WebSocket Hub and HTTP server health (/health), active sockets, and process telemetry",
    "server.refreshBtn": "↻ Refresh Metrics",
    "server.kpi.health": "Hub Healthcheck",
    "server.kpi.sockets": "Total Online Sockets",
    "server.kpi.socketsSub": "WebSocket Active",
    "server.kpi.throughput": "Total Throughput",
    "server.kpi.throughputSub": "Buffer Normal",
    "server.col.node": "Node ID / Role",
    "server.col.status": "Health Status (/health)",
    "server.col.sockets": "Online Sockets",
    "server.col.uptime": "Uptime",

    // Telemetry Page
    "telem.title": "Node Telemetry Monitoring",
    "telem.subtitle": "Server process CPU, RAM, event loop lag, and real-time WebSocket connection health metrics",
    "telem.refreshBtn": "↻ Refresh Telemetry",
    "telem.logTitle": "📊 Telemetry Diagnostic Log",
    "telem.logSub": "Runtime metric stream sampled every 10 seconds",

    // Tenant Traffic Page
    "traffic.title": "Tenant Routing Traffic Analysis",
    "traffic.col.tenant": "Tenant Organization / ID",
    "traffic.col.routes": "24h Routing Volume",
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
