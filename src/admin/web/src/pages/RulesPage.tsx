import { useState } from 'react';
import { Scroll, ShieldCheck } from '@phosphor-icons/react';
import { Badge, Empty, Loading } from '@/components/ui-kit';
import { useNamespaces, useRules } from '@/hooks/use-data';

export function RulesPage() {
  const namespaces = useNamespaces();
  const nsList = namespaces.data?.namespaces ?? [];
  const [ns, setNs] = useState<string | null>(null);
  const activeNs = ns ?? nsList[0]?.id ?? null;
  const rules = useRules(activeNs);

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Правила</h2>
          <p>Валидация, жизненный цикл, безопасность и доступ. Всегда подгружаемый класс памяти.</p>
        </div>
        <div className="actions">
          <select className="select" style={{ width: 200 }} value={activeNs ?? ''} onChange={(e) => setNs(e.target.value)}>
            {nsList.map((n) => (
              <option key={n.id} value={n.id}>
                {n.display_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="callout info" style={{ marginBottom: 20 }}>
        <ShieldCheck size={19} />
        <div>
          Правила — файловый, всегда загружаемый класс памяти. Редактирование и включение/отключение
          выполняется через MCP (<span className="mono">rules_*</span>); консоль показывает их в режиме чтения.
        </div>
      </div>

      {!activeNs ? (
        <Empty icon={<Scroll size={28} />} title="Нет namespaces" />
      ) : rules.isPending ? (
        <Loading />
      ) : !rules.data || rules.data.rules.length === 0 ? (
        <Empty icon={<Scroll size={28} />} title="Правил нет">
          В этом namespace пока не заданы правила.
        </Empty>
      ) : (
        <div className="grid-2">
          {rules.data.rules.map((r) => (
            <div className="card card-pad" key={r.id}>
              <div className="row between">
                <div className="row" style={{ gap: 10 }}>
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--accent-soft)',
                      color: 'var(--accent-soft-fg)',
                    }}
                  >
                    <ShieldCheck size={18} />
                  </span>
                  <div>
                    <div style={{ fontWeight: 700 }}>{r.title}</div>
                    <span className="chip-mono">{r.id}</span>
                  </div>
                </div>
                <button className="toggle on" disabled aria-label="Управляется через MCP" title="Редактирование через MCP" />
              </div>
              {r.severity && (
                <div style={{ marginTop: 12 }}>
                  <Badge tone={r.severity === 'hard' ? 'danger' : 'warn'}>{r.severity}</Badge>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
