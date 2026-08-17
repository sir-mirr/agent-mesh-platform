import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { RootLayout } from "@/layouts/RootLayout.tsx";
import { LoginPage } from "@/pages/LoginPage.tsx";
import { DashboardPage } from "@/pages/DashboardPage.tsx";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public — 단일 로그인 게이트웨이 */}
        <Route path="/login" element={<LoginPage />} />

        {/* Authenticated shell — RBAC 기반 동적 메뉴 */}
        <Route element={<RootLayout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />

          {/* Phase 1 stubs — 추후 구현 */}
          {/* <Route path="/agents/*"   element={<AgentsOutlet />} /> */}
          {/* <Route path="/groups/*"   element={<GroupsOutlet />} /> */}
          {/* <Route path="/topology"   element={<TopologyPage />} /> */}
          {/* <Route path="/inbox/*"    element={<InboxOutlet />} /> */}
          {/* <Route path="/audit/*"    element={<AuditOutlet />} /> */}
          {/* <Route path="/admin/*"    element={<AdminOutlet />} /> */}
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
