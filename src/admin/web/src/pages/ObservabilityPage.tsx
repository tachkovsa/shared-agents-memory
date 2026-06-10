import { Brain, Database, Heartbeat, Key, Stack } from '@phosphor-icons/react';
import { Badge, Loading, Stat } from '@/components/ui-kit';
import { useObservability } from '@/hooks/use-data';
import { compactNumber } from '@/lib/format';

export function ObservabilityPage() {
  const obs = useObservability();
  if (obs.isPending) return <Loading />;
  const d = obs.data;
  if (!d) return <p className="muted">Нет данных.</p>;

  const healthy = d.health.status === 'ok';

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Observability</h2>
          <p>Здоровье инстанса, счётчики и ключевые метрики.</p>
        </div>
        <div className="actions">
          <Badge tone={healthy ? 'ok' : 'warn'}>
            <Heartbeat size={13} /> {healthy ? 'healthy' : 'degraded'}
          </Badge>
        </div>
      </div>

      <div className="stat-grid">
        <Stat icon={<Stack size={15} />} label="Namespaces" value={compactNumber(d.counts.namespaces)} />
        <Stat icon={<Brain size={15} />} label="Записей памяти" value={compactNumber(d.counts.memories)} tone="terra" />
        <Stat icon={<Key size={15} />} label="Активных PAT" value={compactNumber(d.counts.pats_active)} detail={`всего ${d.counts.pats_total}`} />
        <Stat icon={<Database size={15} />} label="Qdrant" value={d.health.qdrant === 'ok' ? 'OK' : 'DOWN'} />
      </div>

      <div className="divider" />
      <div className="section-title">Сервисы</div>
      <div className="card">
        <ServiceRow name="Qdrant (векторы)" status={d.health.qdrant === 'ok' ? 'ok' : 'down'} />
        <ServiceRow name="Embeddings breaker" status={d.health.embeddings_breaker === 'open' ? 'down' : 'ok'} detail={d.health.embeddings_breaker} />
        <ServiceRow name="Версия движка" status="ok" detail={d.health.version} last />
      </div>

      <div className="divider" />
      <div className="section-title">Метрики (mem_*)</div>
      <div className="card">
        {Object.entries(d.metrics).map(([name, m], i, arr) => {
          const total = m.values.reduce((s, v) => s + (v.value ?? 0), 0);
          return (
            <div
              className="row between"
              key={name}
              style={{ padding: '12px 18px', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}
            >
              <span className="mono" style={{ fontSize: 13 }}>{name}</span>
              <span className="row" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 12 }}>{m.type}</span>
                <span className="num" style={{ fontWeight: 600 }}>{compactNumber(total)}</span>
              </span>
            </div>
          );
        })}
        {Object.keys(d.metrics).length === 0 && (
          <div className="muted" style={{ padding: 18 }}>Метрики пока не накоплены.</div>
        )}
      </div>
    </>
  );
}

function ServiceRow({ name, status, detail, last }: { name: string; status: 'ok' | 'down'; detail?: string; last?: boolean }) {
  return (
    <div className="row between" style={{ padding: '14px 18px', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <span className="row" style={{ gap: 9 }}>
        <span className={`dot ${status === 'ok' ? 'ok' : 'danger'}`} />
        {name}
      </span>
      {detail && <span className="mono muted" style={{ fontSize: 12.5 }}>{detail}</span>}
    </div>
  );
}
