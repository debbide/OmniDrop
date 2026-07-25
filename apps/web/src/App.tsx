import { Navigate, Route, Routes } from "react-router-dom";
import { Spin } from "antd";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { AppLayout } from "./layouts/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";
import { DashboardPage } from "./pages/DashboardPage";
import { TargetsPage } from "./pages/TargetsPage";
import { JobsPage } from "./pages/JobsPage";
import { JobCreatePage } from "./pages/JobCreatePage";
import { JobDetailPage } from "./pages/JobDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ArtifactsPage } from "./pages/ArtifactsPage";
import { TargetDetailPage } from "./pages/TargetDetailPage";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  if (loading) {
    return (
      <div className="auth-shell">
        <Spin size="large" />
      </div>
    );
  }
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  if (loading) {
    return (
      <div className="auth-shell">
        <Spin size="large" />
      </div>
    );
  }
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function SetupOnly({ children }: { children: React.ReactNode }) {
  const { loading, needsSetup, user } = useAuth();
  if (loading) {
    return (
      <div className="auth-shell">
        <Spin size="large" />
      </div>
    );
  }
  if (!needsSetup) {
    return <Navigate to={user ? "/" : "/login"} replace />;
  }
  return <>{children}</>;
}

function RoutesTree() {
  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <SetupOnly>
            <SetupPage />
          </SetupOnly>
        }
      />
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        element={
          <Protected>
            <AppLayout />
          </Protected>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="artifacts" element={<ArtifactsPage />} />
        <Route path="targets" element={<TargetsPage />} />
        <Route
          path="targets/:id"
          element={
            <RouteErrorBoundary>
              <TargetDetailPage />
            </RouteErrorBoundary>
          }
        />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/new" element={<JobCreatePage />} />
        <Route path="jobs/:id" element={<JobDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <RoutesTree />
    </AuthProvider>
  );
}
