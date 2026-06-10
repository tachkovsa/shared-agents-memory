import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useMe, useSetupStatus } from '@/hooks/use-auth';
import { DashboardPage } from '@/pages/DashboardPage';
import { LoginPage } from '@/pages/LoginPage';
import { SetupPage } from '@/pages/SetupPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function Gate() {
  const me = useMe();
  const status = useSetupStatus();

  if (me.isPending || status.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  const authed = !me.isError && Boolean(me.data?.operator);
  const needsSetup = status.data?.needs_setup ?? false;

  return (
    <Routes>
      <Route
        path="/login"
        element={authed ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/setup"
        element={needsSetup ? <SetupPage /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/"
        element={
          authed ? (
            <DashboardPage />
          ) : (
            <Navigate to={needsSetup ? '/setup' : '/login'} replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
