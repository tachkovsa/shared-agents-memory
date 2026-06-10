import { useState } from 'react';
import { ListChecks, Robot, User } from '@phosphor-icons/react';
import { Badge, Empty, Loading } from '@/components/ui-kit';
import { useAudit } from '@/hooks/use-data';
import { formatDate } from '@/lib/format';

const FILTERS: Array<{ key: string; label: string; event?: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'auth', label: 'Вход', event: 'auth.success' },
  { key: 'pat', label: 'PAT', event: 'pat.minted' },
  { key: 'denied', label: 'Отказы', event: 'auth.failure' },
];

export function AuditPage() {
  const [filter, setFilter] = useState('all');
  const event = FILTERS.find((f) => f.key === filter)?.event;
  const audit = useAudit(event);

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Аудит</h2>
          <p>Журнал действий операторов и агентов. Хвост последних событий.</p>
        </div>
      </div>

      <div className="table-wrap">
        <div className="table-toolbar">
          <div className="seg">
            {FILTERS.map((f) => (
              <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {audit.isPending ? (
          <Loading />
        ) : !audit.data || audit.data.entries.length === 0 ? (
          <Empty icon={<ListChecks size={28} />} title="Событий нет" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Событие</th>
                <th>Актор</th>
                <th>Время</th>
                <th>Результат</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.entries.map((e, i) => {
                const actor = String(e.actor ?? e.username ?? e.operator ?? '—');
                const isAgent = String(e.event).startsWith('pat') || String(e.actorKind) === 'agent';
                const ok = e.result ? e.result === 'ok' : !String(e.event).includes('fail');
                return (
                  <tr key={i} style={{ cursor: 'default' }}>
                    <td className="mono">{String(e.event)}</td>
                    <td>
                      <span className="row" style={{ gap: 7 }}>
                        {isAgent ? <Robot size={15} /> : <User size={15} />}
                        <span className="mono">{actor}</span>
                      </span>
                    </td>
                    <td className="muted">{formatDate(typeof e.ts === 'string' ? e.ts : (e.timestamp as string))}</td>
                    <td>{ok ? <Badge tone="ok">ok</Badge> : <Badge tone="danger">denied</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
