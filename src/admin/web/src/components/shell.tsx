import {
  Brain,
  ChartLine,
  CreditCard,
  Gauge,
  Key,
  ListChecks,
  Moon,
  Scroll,
  SignOut,
  Stack,
  Sun,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LogoMark } from '@/components/Logo';
import { useLogout, useMe } from '@/hooks/use-auth';
import { useNamespaces, useObservability, usePats } from '@/hooks/use-data';
import { useTheme } from '@/lib/theme';

interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  count?: number;
}

const TITLES: Record<string, { title: string; group: string }> = {
  '/': { title: 'Обзор', group: 'Память' },
  '/namespaces': { title: 'Namespaces', group: 'Память' },
  '/memory': { title: 'Память', group: 'Память' },
  '/pat': { title: 'PAT-токены', group: 'Доступ' },
  '/rules': { title: 'Правила', group: 'Доступ' },
  '/audit': { title: 'Аудит', group: 'Доступ' },
  '/observability': { title: 'Observability', group: 'Система' },
  '/billing': { title: 'Подписка', group: 'Система' },
};

function Sidebar() {
  const me = useMe();
  const { theme, toggle } = useTheme();
  const logout = useLogout();
  const navigate = useNavigate();
  const ns = useNamespaces();
  const pats = usePats();
  const obs = useObservability();

  async function onLogout() {
    await logout.mutateAsync();
    navigate('/login');
  }

  const operator = me.data?.operator;
  const nsCount = ns.data?.namespaces.length;
  const patCount = pats.data?.pats.filter((p) => !p.is_revoked).length;
  const memCount = obs.data?.counts.memories ?? undefined;

  const groups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: 'Память',
      items: [
        { to: '/', label: 'Обзор', icon: Gauge },
        { to: '/namespaces', label: 'Namespaces', icon: Stack, count: nsCount },
        { to: '/memory', label: 'Память', icon: Brain, count: memCount ?? undefined },
      ],
    },
    {
      label: 'Доступ',
      items: [
        { to: '/pat', label: 'PAT-токены', icon: Key, count: patCount },
        { to: '/rules', label: 'Правила', icon: Scroll },
        { to: '/audit', label: 'Аудит', icon: ListChecks },
      ],
    },
    {
      label: 'Система',
      items: [
        { to: '/observability', label: 'Observability', icon: ChartLine },
        { to: '/billing', label: 'Подписка', icon: CreditCard },
      ],
    },
  ];

  const initials = (operator?.username ?? '··').slice(0, 2).toUpperCase();

  return (
    <nav className="sidebar">
      <div className="sb-logo">
        <LogoMark palette="onDark" width={34} />
        <span className="word">
          <span className="a">Artel</span> <span className="m">Memory</span>
        </span>
      </div>

      {groups.map((g) => (
        <div className="sb-section" key={g.label}>
          <div className="sb-label">{g.label}</div>
          <div className="sb-nav">
            {g.items.map((it) => {
              const ItIcon = it.icon;
              return (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.to === '/'}
                  className={({ isActive }) => `sb-item${isActive ? ' active' : ''}`}
                >
                  <ItIcon size={18} />
                  {it.label}
                  {typeof it.count === 'number' && <span className="count">{it.count}</span>}
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}

      <div className="sb-spacer" />

      <div className="sb-foot">
        <div className="sb-plan">
          <span className="ic">
            <CreditCard size={16} />
          </span>
          <div className="t">
            <b>Cloud · $5/мес</b>
            <span>Managed-хостинг</span>
          </div>
        </div>
        <div className="sb-user">
          <span className="av">{initials}</span>
          <div className="nm">
            <b>{operator?.username ?? '—'}</b>
            <span>{operator?.role ?? ''}</span>
          </div>
          <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
            <button className="theme-toggle" style={{ marginLeft: 0 }} onClick={toggle} aria-label="Сменить тему">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              className="theme-toggle"
              style={{ marginLeft: 0 }}
              onClick={onLogout}
              disabled={logout.isPending}
              aria-label="Выйти"
              title="Выйти"
            >
              <SignOut size={16} />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}

function Topbar() {
  const loc = useLocation();
  const meta = TITLES[loc.pathname] ?? { title: '', group: '' };
  return (
    <header className="topbar">
      <div className="crumb">
        {meta.group}
        <span className="sep">/</span>
        <b>{meta.title}</b>
      </div>
      <div className="sp" />
    </header>
  );
}

export function AppShell() {
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Topbar />
        <div className="content">
          <div className="content-inner">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
