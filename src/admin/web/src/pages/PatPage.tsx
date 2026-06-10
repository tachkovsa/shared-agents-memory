import { useState } from 'react';
import { ArrowsClockwise, Copy, Key, Plus, Prohibit, Warning } from '@phosphor-icons/react';
import { Badge, Empty, Loading, Modal, useToast } from '@/components/ui-kit';
import { useCreatePat, useNamespaces, usePats, useRevokePat, useRotatePat } from '@/hooks/use-data';
import { ApiError, type AgentScope, type Pat } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';

const ALL_SCOPES: AgentScope[] = [
  'memory:read',
  'memory:write',
  'memory:delete',
  'rules:read',
  'rules:write',
  'namespace:admin',
  'service:admin',
];

export function PatPage() {
  const pats = usePats();
  const namespaces = useNamespaces();
  const create = useCreatePat();
  const revoke = useRevokePat();
  const rotate = useRotatePat();
  const toast = useToast();

  const [showCreate, setShowCreate] = useState(false);
  const [secret, setSecret] = useState<{ pat: Pat; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<Pat | null>(null);

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>PAT-токены</h2>
          <p>Персональные токены агентов. У каждого агента — свой ключ: отзыв одного не влияет на остальные.</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={17} /> Создать ключ
          </button>
        </div>
      </div>

      {pats.isPending ? (
        <Loading />
      ) : !pats.data || pats.data.pats.length === 0 ? (
        <Empty icon={<Key size={28} />} title="Пока нет ключей">
          Создайте первый PAT, чтобы подключить агента по MCP.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Ключ</th>
                <th>Агент</th>
                <th>Scopes</th>
                <th>Namespaces</th>
                <th>Использован</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pats.data.pats.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.display_name}</div>
                    <span className="chip-mono">{p.token_prefix}…</span>
                  </td>
                  <td className="mono">{p.agent_identity}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                      {p.scopes.map((s) => (
                        <span className="tag" key={s}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="num">{p.allowed_namespaces.length}</td>
                  <td className="muted">{relativeTime(p.last_used_at)}</td>
                  <td>
                    {p.is_revoked ? (
                      <Badge tone="danger">отозван</Badge>
                    ) : (
                      <Badge tone="ok">активен</Badge>
                    )}
                  </td>
                  <td>
                    <div className="row row-actions" style={{ justifyContent: 'flex-end' }}>
                      {!p.is_revoked && (
                        <>
                          <button
                            className="btn btn-sm btn-secondary"
                            disabled={rotate.isPending}
                            onClick={async () => {
                              try {
                                const res = await rotate.mutateAsync(p.id);
                                setSecret(res);
                              } catch (e) {
                                toast(e instanceof ApiError ? e.code : 'Ошибка ротации');
                              }
                            }}
                          >
                            <ArrowsClockwise size={15} /> Ротация
                          </button>
                          <button className="btn btn-sm btn-danger-ghost" onClick={() => setRevoking(p)}>
                            <Prohibit size={15} /> Отозвать
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreatePatModal
          namespaces={(namespaces.data?.namespaces ?? []).map((n) => n.id)}
          pending={create.isPending}
          onClose={() => setShowCreate(false)}
          onCreate={async (input) => {
            try {
              const res = await create.mutateAsync(input);
              setShowCreate(false);
              setSecret(res);
            } catch (e) {
              toast(e instanceof ApiError ? e.code : 'Не удалось создать ключ');
            }
          }}
        />
      )}

      {secret && <SecretRevealModal data={secret} onClose={() => setSecret(null)} />}

      {revoking && (
        <Modal
          title="Отозвать ключ?"
          subtitle={`${revoking.display_name} (${revoking.token_prefix}…)`}
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setRevoking(null)}>
                Отмена
              </button>
              <button
                className="btn btn-danger"
                disabled={revoke.isPending}
                onClick={async () => {
                  try {
                    await revoke.mutateAsync({ id: revoking.id });
                    toast('Ключ отозван');
                    setRevoking(null);
                  } catch (e) {
                    toast(e instanceof ApiError ? e.code : 'Ошибка');
                  }
                }}
              >
                Отозвать
              </button>
            </>
          }
        >
          <div className="callout danger">
            <Warning size={19} />
            <div>
              Отзыв необратим. Агент <b>{revoking.agent_identity}</b> сразу потеряет доступ. Остальные ключи не затрагиваются.
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function CreatePatModal({
  namespaces,
  pending,
  onClose,
  onCreate,
}: {
  namespaces: string[];
  pending: boolean;
  onClose: () => void;
  onCreate: (input: { display_name: string; agent_identity: string; allowed_namespaces: string[]; scopes: AgentScope[] }) => void;
}) {
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(['memory:read', 'memory:write']);
  const [ns, setNs] = useState<string[]>(namespaces.slice(0, 1));

  const toggle = <T,>(arr: T[], v: T, set: (a: T[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const valid = name.trim() && agent.trim() && scopes.length > 0 && ns.length > 0;

  return (
    <Modal
      title={
        <>
          <Key size={20} /> Новый PAT-ключ
        </>
      }
      subtitle="Секрет показывается один раз. Сохраните его сразу."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid || pending}
            onClick={() =>
              onCreate({ display_name: name.trim(), agent_identity: agent.trim(), allowed_namespaces: ns, scopes })
            }
          >
            Создать ключ
          </button>
        </>
      }
    >
      <div className="field">
        <label>Название</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code · рабочий" />
      </div>
      <div className="field">
        <label>Идентификатор агента</label>
        <input className="input mono" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="claude-code-7f3a" />
      </div>
      <div className="field">
        <label>Scopes</label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {ALL_SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              className={`tag`}
              style={{
                cursor: 'pointer',
                background: scopes.includes(s) ? 'var(--accent-soft)' : 'var(--surface-3)',
                color: scopes.includes(s) ? 'var(--accent-soft-fg)' : 'var(--fg-2)',
              }}
              onClick={() => toggle(scopes, s, setScopes)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Namespaces</label>
        {namespaces.length === 0 ? (
          <p className="hint">Сначала создайте namespace.</p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {namespaces.map((n) => (
              <button
                key={n}
                type="button"
                className="tag"
                style={{
                  cursor: 'pointer',
                  background: ns.includes(n) ? 'var(--accent-soft)' : 'var(--surface-3)',
                  color: ns.includes(n) ? 'var(--accent-soft-fg)' : 'var(--fg-2)',
                }}
                onClick={() => toggle(ns, n, setNs)}
              >
                {n}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function SecretRevealModal({ data, onClose }: { data: { pat: Pat; secret: string }; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal
      title={
        <>
          <Key size={20} /> Ключ создан
        </>
      }
      subtitle={`${data.pat.display_name} · ${data.pat.agent_identity}`}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Я сохранил ключ
        </button>
      }
    >
      <div className="callout warn" style={{ marginBottom: 16 }}>
        <Warning size={19} />
        <div>
          Секрет показывается <b>один раз</b> и не хранится на сервере. Если потеряете — только ротация.
        </div>
      </div>
      <div className="secret-box">
        <span className="val">{data.secret}</span>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => {
            void navigator.clipboard.writeText(data.secret);
            toast('Скопировано');
          }}
        >
          <Copy size={15} /> Копировать
        </button>
      </div>
      <div className="divider" />
      <div className="section-title">Подключение по MCP</div>
      <pre
        className="chip-mono"
        style={{ display: 'block', whiteSpace: 'pre-wrap', padding: 14, lineHeight: 1.6 }}
      >{`{
  "mcpServers": {
    "artel-memory": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer ${data.secret}" }
    }
  }
}`}</pre>
      <p className="hint" style={{ marginTop: 10 }}>
        Создан: {formatDate(data.pat.created_at)}
      </p>
    </Modal>
  );
}
