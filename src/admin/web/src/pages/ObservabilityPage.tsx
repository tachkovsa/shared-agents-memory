import { Brain, Database, Heartbeat, Key, Stack } from '@phosphor-icons/react';
import { Badge, Loading, Stat } from '@/components/ui-kit';
import { useObservability } from '@/hooks/use-data';
import { compactNumber } from '@/lib/format';

// Human-readable names for the engine's mem_* counters.
const METRIC_LABELS: Record<string, { label: string; hint: string }> = {
  mem_http_requests_total: { label: 'HTTP-запросов', hint: 'всего обращений к API' },
  mem_http_sessions_active: { label: 'Активных сессий', hint: 'открытые MCP-сессии сейчас' },
  mem_http_session_duration_seconds: { label: 'Длительность сессий', hint: 'наблюдений, сек' },
  mem_stdio_messages_total: { label: 'Сообщений stdio', hint: 'обмен по stdio-транспорту' },
  mem_pat_lookups_total: { label: 'Проверок PAT-ключей', hint: 'аутентификаций агентов' },
  mem_pat_active_count: { label: 'Активных PAT-ключей', hint: 'не отозванные токены' },
  mem_auth_failures_total: { label: 'Отказов авторизации', hint: 'неуспешные проверки доступа' },
  mem_embedding_calls_total: { label: 'Вызовов эмбеддингов', hint: 'обращения к модели векторизации' },
  mem_embedding_latency_seconds: { label: 'Задержка эмбеддингов', hint: 'наблюдений, сек' },
  mem_embedding_dimension_mismatches_total: { label: 'Несовпадений размерности', hint: 'вектор не той длины' },
  mem_memory_count: { label: 'Записей в памяти', hint: 'точек в Qdrant' },
  mem_quota_rejections_total: { label: 'Отклонено по квотам', hint: 'превышен лимит namespace' },
  mem_staleness_audit_total: { label: 'Проверок устаревания', hint: 'аудит свежести записей' },
  mem_decay_sweep_duration_seconds: { label: 'Пересчёт decay', hint: 'наблюдений, сек' },
  mem_lifecycle_deletes_total: { label: 'Удалений (жизненный цикл)', hint: 'очистка по политике хранения' },
};

function metricValue(m: { type: string; values: Array<{ value: number | null; series?: string }> }): number {
  if (m.type === 'histogram' || m.type === 'summary') {
    const count = m.values.find((v) => v.series?.endsWith('_count'));
    return count?.value ?? 0;
  }
  return m.values.reduce((s, v) => s + (v.value ?? 0), 0);
}

function prettifyMetric(name: string): { label: string; hint: string } {
  return (
    METRIC_LABELS[name] ?? {
      label: name.replace(/^mem_/, '').replace(/_total$/, '').replace(/_/g, ' '),
      hint: 'счётчик движка',
    }
  );
}

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
      <div className="section-title">Метрики движка</div>
      <div className="card">
        {Object.entries(d.metrics).map(([name, m], i, arr) => {
          const { label, hint } = prettifyMetric(name);
          return (
            <div
              className="row between"
              key={name}
              style={{ padding: '13px 18px', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{label}</div>
                <div className="muted" style={{ fontSize: 12 }}>{hint}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="num" style={{ fontWeight: 700, fontSize: 16 }}>{compactNumber(metricValue(m))}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>{name}</div>
              </div>
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
