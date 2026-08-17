/**
 * Authentication & RBAC Capability Types
 * SPEC § 11.3, § 12, § 17 & Contracts v0.14.1
 */

export type Capability =
  | "key.approve"          // Ed25519 공개키 승인/거부
  | "agent.teardown"       // 영구 신원 삭제 (SPEC § 9.3)
  | "group.manage"         // 그룹 생성/에이전트 이동
  | "policy.send_restrict" // 그룹 간 이그레스 ACL 제어
  | "audit.read_content"   // 메시지 원문 열람
  | "audit.read_metadata"  // 메타데이터([content withheld]) 열람
  | "server.inspect"       // 서버 헬스/텔레메트리 모니터링
  | "role.assign"          // 조직 멤버 RBAC 역할 할당
  | "role.grant"           // 조직 멤버 세분화 Capability 부여/회수 (§11.3)
  | "admin.all";           // 슈퍼어드민 마스터 권한

export type UserRole =
  | "AGENT_OPERATOR"       // 일반 에이전트 생성/운영자
  | "GROUP_ADMIN"          // 그룹 관리자
  | "TENANT_ADMIN"         // 테넌트 조직 관리자
  | "PLATFORM_ADMIN";      // 플랫폼 인프라 슈퍼 관리자

export interface User {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  role: UserRole;
  capabilities: Capability[];
  tenantId: string;
  authProvider: "github" | "local";
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}
