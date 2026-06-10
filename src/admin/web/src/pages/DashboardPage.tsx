import {
  Brain,
  ChartLine,
  Key,
  ListChecks,
  Scroll,
  SignOut,
  Stack,
  type Icon,
} from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useLogout, useMe } from '@/hooks/use-auth';

// Placeholder nav for the management screens that land in follow-up PRs
// (#64–#69). The shell + auth gate is what this scaffold establishes.
const SECTIONS: Array<{ icon: Icon; label: string }> = [
  { icon: Key, label: 'Access keys' },
  { icon: Stack, label: 'Namespaces' },
  { icon: Scroll, label: 'Rules' },
  { icon: Brain, label: 'Memory browser' },
  { icon: ListChecks, label: 'Audit log' },
  { icon: ChartLine, label: 'Observability' },
];

export function DashboardPage() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const operator = me.data?.operator;

  async function onLogout() {
    await logout.mutateAsync();
    navigate('/login');
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <span className="font-semibold">SAM Admin</span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {operator?.username} · {operator?.role}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onLogout}
            disabled={logout.isPending}
          >
            <SignOut size={16} /> Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-4xl gap-4 p-6 sm:grid-cols-2">
        {SECTIONS.map(({ icon: SectionIcon, label }) => (
          <Card key={label} className="opacity-60">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <SectionIcon size={20} /> {label}
              </CardTitle>
              <CardDescription>Coming soon</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Management UI for {label.toLowerCase()} lands in a follow-up.
            </CardContent>
          </Card>
        ))}
      </main>
    </div>
  );
}
