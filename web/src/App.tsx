import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { setAuthHandler } from './api';
import { Layout } from './components/Layout';
import { Toaster } from './components/Toasts';
import { Loading } from './components/ui';

const Login = lazy(() => import('./pages/Login'));
const Invite = lazy(() => import('./pages/Invite'));
const ChangePassword = lazy(() => import('./pages/ChangePassword'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reports = lazy(() => import('./pages/Reports'));
const Requests = lazy(() => import('./pages/Requests'));
const Apps = lazy(() => import('./pages/Apps'));
const Entities = lazy(() => import('./pages/Entities'));
const Keys = lazy(() => import('./pages/Keys'));
const Providers = lazy(() => import('./pages/Providers'));
const Models = lazy(() => import('./pages/Models'));
const RoutesPage = lazy(() => import('./pages/RoutesPage'));
const Prompts = lazy(() => import('./pages/Prompts'));
const PromptDetail = lazy(() => import('./pages/PromptDetail'));
const Guardrails = lazy(() => import('./pages/Guardrails'));
const Budgets = lazy(() => import('./pages/Budgets'));
const Users = lazy(() => import('./pages/Users'));
const Audit = lazy(() => import('./pages/Audit'));
const Notifications = lazy(() => import('./pages/Notifications'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Profile = lazy(() => import('./pages/Profile'));
const Playground = lazy(() => import('./pages/Playground'));

/** Connects API-level auth failures to router navigation. */
function AuthBridge() {
  const navigate = useNavigate();
  const loc = useLocation();
  const { refresh } = useAuth();
  useEffect(() => {
    setAuthHandler((kind) => {
      if (kind === 'login') {
        void refresh();
        if (!loc.pathname.startsWith('/login')) navigate(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
      } else if (kind === 'change-password') {
        void refresh().then(() => navigate('/change-password', { replace: true }));
      } else if (kind === 'mfa') {
        void refresh().then(() => navigate('/profile', { replace: true }));
      }
    });
    return () => setAuthHandler(null);
  }, [navigate, loc.pathname, loc.search, refresh]);
  return null;
}

function RequireAuth({ children, partial }: { children: ReactNode; partial?: 'change-password' }) {
  const { status, user } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <Loading full label="Loading session…" />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (user.mustChangePassword && partial !== 'change-password') return <Navigate to="/change-password" replace />;
  if (!user.mustChangePassword && user.mfaEnrollmentRequired && loc.pathname !== '/profile') return <Navigate to="/profile" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <AuthBridge />
        <Suspense fallback={<Loading full />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/invite/:token" element={<Invite />} />
            <Route
              path="/change-password"
              element={
                <RequireAuth partial="change-password">
                  <ChangePassword />
                </RequireAuth>
              }
            />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="reports" element={<Reports />} />
              <Route path="requests" element={<Requests />} />
              <Route path="apps" element={<Apps />} />
              <Route path="entities" element={<Entities />} />
              <Route path="keys" element={<Keys />} />
              <Route path="providers" element={<Providers />} />
              <Route path="models" element={<Models />} />
              <Route path="routes" element={<RoutesPage />} />
              <Route path="prompts" element={<Prompts />} />
              <Route path="prompts/:id" element={<PromptDetail />} />
              <Route path="guardrails" element={<Guardrails />} />
              <Route path="budgets" element={<Budgets />} />
              <Route path="users" element={<Users />} />
              <Route path="audit" element={<Audit />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="profile" element={<Profile />} />
              <Route path="playground" element={<Playground />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
        <Toaster />
      </AuthProvider>
    </BrowserRouter>
  );
}
