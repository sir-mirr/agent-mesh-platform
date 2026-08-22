import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext.tsx";
import { RbacProvider } from "@/contexts/RbacContext.tsx";
import { I18nProvider } from "@/contexts/I18nContext.tsx";
import { RootLayout } from "@/layouts/RootLayout.tsx";
import { GuardedRoute } from "@/components/index.ts";
import { ChangePasswordPage } from "@/pages/ChangePasswordPage.tsx";

// Pages
import { LoginPage } from "@/pages/LoginPage.tsx";
import { DashboardPage } from "@/pages/DashboardPage.tsx";

// Studio Suite Pages
import { AgentsPage } from "@/pages/creator/AgentsPage.tsx";
import { GroupsPage } from "@/pages/creator/GroupsPage.tsx";
import { TopologyPage } from "@/pages/creator/TopologyPage.tsx";
import { PlaygroundPage } from "@/pages/creator/PlaygroundPage.tsx";
import { LeaseQueuePage } from "@/pages/creator/LeaseQueuePage.tsx";
import { RegisterAgentPage } from "@/pages/creator/RegisterAgentPage.tsx";

// Platform Suite Pages
import { PlatformOverviewPage } from "@/pages/platform/PlatformOverviewPage.tsx";
import { TelemetryPage } from "@/pages/platform/TelemetryPage.tsx";
import { TenantTrafficPage } from "@/pages/platform/TenantTrafficPage.tsx";
import { UserAdminPage } from "@/pages/platform/UserAdminPage.tsx";
import { TenantManagementPage } from "@/pages/platform/TenantManagementPage.tsx";

// Tenant Suite Pages
import { TenantEgressAclPage } from "@/pages/tenant/TenantEgressAclPage.tsx";
import { AuditLogsPage } from "@/pages/tenant/AuditLogsPage.tsx";
import { RbacManagementPage } from "@/pages/tenant/RbacManagementPage.tsx";

export function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <RbacProvider>
          <BrowserRouter>
          <Routes>
            {/* Public — 통합 단일 로그인 게이트웨이 */}
            <Route path="/login" element={<LoginPage />} />

            {/* Outside the guard on purpose: the guard sends people *here*, so
                putting it behind the same check redirects to itself for ever. */}
            <Route path="/change-password" element={<ChangePasswordPage />} />

            {/* Authenticated Shell — RBAC 기반 동적 사이드바 */}
            <Route
              element={
                <GuardedRoute>
                  <RootLayout />
                </GuardedRoute>
              }
            >
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />

              {/* 1. 에이전트 운영 스튜디오 (모든 사용자 접근 가능) */}
              <Route path="/creator" element={<AgentsPage />} />
              <Route path="/creator/groups" element={<GroupsPage />} />
              <Route path="/creator/topology" element={<TopologyPage />} />
              <Route path="/creator/playground" element={<PlaygroundPage />} />
              <Route path="/creator/lease-queue" element={<LeaseQueuePage />} />
              <Route path="/creator/register" element={<RegisterAgentPage />} />

              {/* 2. 실시간 서버 모니터링 콘솔 (인증된 사용자/운영자) */}
              <Route path="/platform" element={<PlatformOverviewPage />} />
              <Route path="/platform/telemetry" element={<TelemetryPage />} />
              <Route
                path="/platform/users"
                element={
                  <GuardedRoute requiredCapability="user.admit">
                    <UserAdminPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/platform/tenant-directory"
                element={
                  <GuardedRoute requiredRole="PLATFORM_ADMIN">
                    <TenantManagementPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/platform/tenants"
                element={
                  <GuardedRoute requiredCapability="tenant.read.stats">
                    <TenantTrafficPage />
                  </GuardedRoute>
                }
              />

              {/* 3. 테넌트 관리 콘솔 (테넌트 권한자 전용) */}
              <Route
                path="/tenant/egress-acl"
                element={
                  <GuardedRoute requiredCapability="group.manage">
                    <TenantEgressAclPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/tenant/audits"
                element={
                  <GuardedRoute requiredCapability="audit.read.metadata">
                    <AuditLogsPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/tenant/rbac"
                element={
                  <GuardedRoute requiredCapability="role.grant">
                    <RbacManagementPage />
                  </GuardedRoute>
                }
              />
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </RbacProvider>
    </AuthProvider>
  </I18nProvider>
  );
}
