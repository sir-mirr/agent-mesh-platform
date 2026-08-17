import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext.tsx";
import { RbacProvider } from "@/contexts/RbacContext.tsx";
import { I18nProvider } from "@/contexts/I18nContext.tsx";
import { RootLayout } from "@/layouts/RootLayout.tsx";
import { GuardedRoute } from "@/components/index.ts";

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

            {/* Authenticated Shell — RBAC 기반 동적 사이드바 */}
            <Route element={<RootLayout />}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />

              {/* 1. 에이전트 운영 스튜디오 (모든 사용자 접근 가능) */}
              <Route path="/creator" element={<AgentsPage />} />
              <Route path="/creator/groups" element={<GroupsPage />} />
              <Route path="/creator/topology" element={<TopologyPage />} />
              <Route path="/creator/playground" element={<PlaygroundPage />} />
              <Route path="/creator/lease-queue" element={<LeaseQueuePage />} />
              <Route path="/creator/register" element={<RegisterAgentPage />} />

              {/* 2. 실시간 서버 모니터링 콘솔 (플랫폼 관리자 전용) */}
              <Route
                path="/platform"
                element={
                  <GuardedRoute requiredCapability="server.inspect">
                    <PlatformOverviewPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/platform/telemetry"
                element={
                  <GuardedRoute requiredCapability="server.inspect">
                    <TelemetryPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/platform/tenants"
                element={
                  <GuardedRoute requiredCapability="server.inspect">
                    <TenantTrafficPage />
                  </GuardedRoute>
                }
              />

              {/* 3. 테넌트 관리 콘솔 (테넌트 권한자 전용) */}
              <Route
                path="/tenant/egress-acl"
                element={
                  <GuardedRoute requiredCapability="policy.send_restrict">
                    <TenantEgressAclPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/tenant/audits"
                element={
                  <GuardedRoute requiredCapability="audit.read_metadata">
                    <AuditLogsPage />
                  </GuardedRoute>
                }
              />
              <Route
                path="/tenant/rbac"
                element={
                  <GuardedRoute requiredCapability="role.assign">
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
