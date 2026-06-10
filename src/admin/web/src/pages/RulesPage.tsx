import { useState } from 'react';
import { LockSimple, Plus, Scroll, ShieldCheck } from '@phosphor-icons/react';
import { Badge, Empty, Loading, Modal, useToast } from '@/components/ui-kit';
import { useCreateRule, useNamespaces, useRules } from '@/hooks/use-data';
import { ApiError } from '@/lib/api';

export function RulesPage() {
  const namespaces = useNamespaces();
  const nsList = namespaces.data?.namespaces ?? [];
  const [ns, setNs] = useState<string | null>(null);
  const activeNs = ns ?? nsList[0]?.id ?? null;
  const rules = useRules(activeNs);
  const create = useCreateRule(activeNs ?? '');
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Правила</h2>
          <p>Валидация, жизненный цикл, безопасность и доступ. Всегда подгружаемый класс памяти.</p>
        </div>
        <div className="actions">
          <select className="select" style={{ width: 180 }} value={activeNs ?? ''} onChange={(e) => setNs(e.target.value)}>
            {nsList.map((n) => (
              <option key={n.id} value={n.id}>
                {n.display_name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={!activeNs} onClick={() => setShowCreate(true)}>
            <Plus size={17} /> Создать правило
          </button>
        </div>
      </div>

      <div className="callout info" style={{ marginBottom: 20 }}>
        <ShieldCheck size={19} />
        <div>
          Правила — это markdown-инструкции, которые агент видит всегда (в отличие от эпизодической памяти). Задайте
          их здесь кнопкой «Создать правило» или из агента через MCP-инструмент <span className="mono">rules_upsert</span>.
          Включение/отключение существующего правила пока только через MCP.
        </div>
      </div>

      {!activeNs ? (
        <Empty icon={<Scroll size={28} />} title="Нет namespaces" />
      ) : rules.isPending ? (
        <Loading />
      ) : !rules.data || rules.data.rules.length === 0 ? (
        <Empty icon={<Scroll size={28} />} title="Правил нет">
          Нажмите «Создать правило», чтобы задать первое — например «id namespace в kebab-case».
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
                <span className="badge neutral" title="Включение/отключение через MCP">
                  <LockSimple size={12} /> read-only
                </span>
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

      {showCreate && activeNs && (
        <CreateRuleModal
          pending={create.isPending}
          onClose={() => setShowCreate(false)}
          onCreate={async (input) => {
            try {
              await create.mutateAsync(input);
              toast('Правило сохранено');
              setShowCreate(false);
            } catch (e) {
              const code = e instanceof ApiError ? e.code : 'Ошибка';
              toast(code === 'invalid_rule_id' ? 'id правила: только латиница/цифры/дефис' : code);
            }
          }}
        />
      )}
    </>
  );
}

function CreateRuleModal({
  pending,
  onClose,
  onCreate,
}: {
  pending: boolean;
  onClose: () => void;
  onCreate: (input: { rule_id: string; title: string; body: string; severity: 'hard' | 'soft' }) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<'hard' | 'soft'>('hard');
  const ruleId = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const valid = ruleId.length > 0 && title.trim().length > 0 && body.trim().length > 0;
  return (
    <Modal
      title={
        <>
          <Scroll size={20} /> Новое правило
        </>
      }
      subtitle="Markdown-инструкция, которую агент будет видеть всегда."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid || pending}
            onClick={() => onCreate({ rule_id: ruleId, title: title.trim(), body: body.trim(), severity })}
          >
            Сохранить
          </button>
        </>
      }
    >
      <div className="field">
        <label>Название</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="id namespace в kebab-case" />
        {ruleId && <div className="hint">id: <span className="mono">{ruleId}</span></div>}
      </div>
      <div className="field">
        <label>Серьёзность</label>
        <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value as 'hard' | 'soft')}>
          <option value="hard">hard — обязательное</option>
          <option value="soft">soft — рекомендация</option>
        </select>
      </div>
      <div className="field">
        <label>Текст правила (markdown)</label>
        <textarea
          className="textarea"
          style={{ minHeight: 140 }}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'Например:\n- id namespace всегда в kebab-case\n- owner_agent_id обязателен при создании'}
        />
      </div>
    </Modal>
  );
}
