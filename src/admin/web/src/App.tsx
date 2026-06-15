import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/shell';
import { ToastProvider } from '@/components/ui-kit';
import { useMe, useSetupStatus } from '@/hooks/use-auth';
import { ThemeProvider } from '@/lib/theme';
import { AuditPage } from '@/pages/AuditPage';
import { BillingPage } from '@/pages/BillingPage';
import { LoginPage } from '@/pages/LoginPage';
import { MemoryPage } from '@/pages/MemoryPage';
import { NamespacesPage } from '@/pages/NamespacesPage';
import { ObservabilityPage } from '@/pages/ObservabilityPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { PatPage } from '@/pages/PatPage';
import { RulesPage } from '@/pages/RulesPage';
import { SetupPage } from '@/pages/SetupPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

function Gate() {
  const me = useMe();
  const status = useSetupStatus();

  if (me.isPending || status.isPending) {
    return <div className="muted" style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>Загрузка…</div>;
  }

  const authed = !me.isError && Boolean(me.data?.operator);
  const needsSetup = status.data?.needs_setup ?? false;

  if (!authed) {
    return (
      <Routes>
        <Route path="/setup" element={needsSetup ? <SetupPage /> : <Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to={needsSetup ? '/setup' : '/login'} replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/namespaces" element={<NamespacesPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/pat" element={<PatPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/observability" element={<ObservabilityPage />} />
        <Route path="/billing" element={<BillingPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <BrowserRouter>
            <Gate />
          </BrowserRouter>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
