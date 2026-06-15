import { useNavigate } from 'react-router-dom';
import { Brain, Key, MagnifyingGlass, Stack } from '@phosphor-icons/react';
import { Badge, Loading, Stat } from '@/components/ui-kit';
import { useAudit, useNamespaces, useObservability } from '@/hooks/use-data';
import { compactNumber, relativeTime } from '@/lib/format';

export function OverviewPage() {
  const obs = useObservability();
  const ns = useNamespaces();
  const audit = useAudit();
  const navigate = useNavigate();

  if (obs.isPending) return <Loading />;
  const counts = obs.data?.counts;

  const searchMetric = obs.data
    ? Object.entries(obs.data.metrics).find(([n]) => n.includes('search'))?.[1]
    : undefined;
  const searchTotal = searchMetric?.values.reduce((s, v) => s + (v.value ?? 0), 0) ?? null;

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Обзор</h2>
          <p>Состояние вашей общей памяти и активность агентов.</p>
        </div>
      </div>

      <div className="stat-grid">
        <Stat icon={<Brain size={15} />} label="Записей памяти" value={compactNumber(counts?.memories ?? null)} tone="terra" />
        <Stat icon={<Stack size={15} />} label="Namespaces" value={compactNumber(counts?.namespaces)} />
        <Stat icon={<Key size={15} />} label="Активных ключей" value={compactNumber(counts?.pats_active)} detail={`всего ${counts?.pats_total ?? 0}`} />
        <Stat icon={<MagnifyingGlass size={15} />} label="Поисков (всего)" value={compactNumber(searchTotal)} />
      </div>

      <div className="divider" />

      <div className="grid-2">
        <div className="card card-pad">
          <div className="section-title">Namespaces</div>
          {ns.isPending ? (
            <Loading />
          ) : (
            (ns.data?.namespaces ?? []).slice(0, 6).map((n) => (
              <div
                className="row between"
                key={n.id}
                style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                onClick={() => navigate('/namespaces')}
              >
                <span className="row" style={{ gap: 9 }}>
                  <span className="dot teal" />
                  <b style={{ fontWeight: 600 }}>{n.display_name}</b>
                </span>
                <span className="chip-mono">{n.id}</span>
              </div>
            ))
          )}
          {ns.data && ns.data.namespaces.length === 0 && <p className="muted">Пока пусто.</p>}
        </div>

        <div className="card card-pad">
          <div className="section-title">Последние события</div>
          {audit.isPending ? (
            <Loading />
          ) : (
            (audit.data?.entries ?? []).slice(0, 7).map((e, i) => (
              <div className="row between" key={i} style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 12.5 }}>{String(e.event)}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {relativeTime(typeof e.ts === 'string' ? e.ts : (e.timestamp as string))}
                </span>
              </div>
            ))
          )}
          {audit.data && audit.data.entries.length === 0 && <p className="muted">Событий нет.</p>}
        </div>
      </div>

      <div className="divider" />
      <div className="row" style={{ gap: 10 }}>
        <Badge tone="teal">v{obs.data?.health.version ?? '—'}</Badge>
        <Badge tone={obs.data?.health.status === 'ok' ? 'ok' : 'warn'}>{obs.data?.health.status}</Badge>
      </div>
    </>
  );
}
