export type { Capability } from "@agent-mesh/contracts";
export { CAPABILITY, ALL_CAPABILITIES } from "@agent-mesh/contracts";
import type { Capability } from "@agent-mesh/contracts";

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
