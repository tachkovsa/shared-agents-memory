import { useState } from 'react';
import { Plus, Stack, UserPlus, Users } from '@phosphor-icons/react';
import { Badge, Drawer, Empty, Loading, Modal, useToast } from '@/components/ui-kit';
import {
  useCreateNamespace,
  useNamespace,
  useNamespaces,
  useShareNamespace,
} from '@/hooks/use-data';
import { ApiError, type AgentScope } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';

const NS_COLORS = ['#2B7D7A', '#C96A4A', '#5B6CC4', '#7A5BC4', '#3B8FB0', '#C4965B'];

export function NamespacesPage() {
  const list = useNamespaces();
  const create = useCreateNamespace();
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Namespaces</h2>
          <p>Изолированные пространства памяти. Делитесь доступом с людьми и агентами.</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={17} /> Создать namespace
          </button>
        </div>
      </div>

      {list.isPending ? (
        <Loading />
      ) : !list.data || list.data.namespaces.length === 0 ? (
        <Empty icon={<Stack size={28} />} title="Пока нет namespaces">
          Создайте первый, чтобы начать накапливать общий контекст.
        </Empty>
      ) : (
        <div className="grid-3">
          {list.data.namespaces.map((n, i) => (
            <button
              key={n.id}
              className="card card-pad"
              style={{ textAlign: 'left', cursor: 'pointer' }}
              onClick={() => setOpenId(n.id)}
            >
              <div className="row between">
                <span className="dot" style={{ background: NS_COLORS[i % NS_COLORS.length] }} />
                <span className="chip-mono">{n.id}</span>
              </div>
              <h3 style={{ fontSize: 17, marginTop: 12 }}>{n.display_name}</h3>
              <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                Владелец: <span className="mono">{n.owner_agent_id}</span>
              </p>
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <Badge tone="teal">dedup {n.dedup_threshold}</Badge>
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  {relativeTime(n.updated_at)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {openId && <NamespaceDrawer id={openId} onClose={() => setOpenId(null)} />}

      {showCreate && (
        <CreateNamespaceModal
          pending={create.isPending}
          onClose={() => setShowCreate(false)}
          onCreate={async (input) => {
            try {
              await create.mutateAsync(input);
              toast('Namespace создан');
              setShowCreate(false);
            } catch (e) {
              toast(e instanceof ApiError ? e.code : 'Не удалось создать');
            }
          }}
        />
      )}
    </>
  );
}

function NamespaceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useNamespace(id);
  const share = useShareNamespace(id);
  const toast = useToast();
  const [showShare, setShowShare] = useState(false);
  const ns = detail.data;

  return (
    <>
      <Drawer
        title={ns?.display_name ?? id}
        subtitle={<span className="mono">{id}</span>}
        onClose={onClose}
        footer={
          <button className="btn btn-primary" onClick={() => setShowShare(true)}>
            <UserPlus size={17} /> Поделиться
          </button>
        }
      >
        {detail.isPending ? (
          <Loading />
        ) : ns ? (
          <>
            <div className="section-title">Свойства</div>
            <dl className="kv">
              <dt>Владелец</dt>
              <dd className="mono">{ns.owner_agent_id}</dd>
              <dt>Видимость</dt>
              <dd>{ns.visibility}</dd>
              <dt>Dedup-порог</dt>
              <dd className="mono">{ns.dedup_threshold}</dd>
              <dt>Создан</dt>
              <dd>{formatDate(ns.created_at)}</dd>
              <dt>Обновлён</dt>
              <dd>{formatDate(ns.updated_at)}</dd>
            </dl>

            <div className="divider" />
            <div className="section-title">
              <Users size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              Участники ({ns.members.length})
            </div>
            {ns.members.length === 0 ? (
              <p className="muted">Пока только владелец.</p>
            ) : (
              ns.members.map((m) => (
                <div className="row between" key={m.agent_id} style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="mono">{m.agent_id}</span>
                  <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {m.scopes.map((s) => (
                      <span className="tag" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            )}
          </>
        ) : (
          <p className="muted">Не найдено.</p>
        )}
      </Drawer>

      {showShare && (
        <ShareModal
          pending={share.isPending}
          onClose={() => setShowShare(false)}
          onShare={async (input) => {
            try {
              await share.mutateAsync(input);
              toast('Доступ выдан');
              setShowShare(false);
            } catch (e) {
              toast(e instanceof ApiError ? e.code : 'Не удалось');
            }
          }}
        />
      )}
    </>
  );
}

function CreateNamespaceModal({
  pending,
  onClose,
  onCreate,
}: {
  pending: boolean;
  onClose: () => void;
  onCreate: (input: { id: string; display_name: string; owner_agent_id: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const id = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const valid = id.length > 0 && owner.trim().length > 0;
  return (
    <Modal
      title={
        <>
          <Stack size={20} /> Новый namespace
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid || pending}
            onClick={() => onCreate({ id, display_name: title.trim(), owner_agent_id: owner.trim() })}
          >
            Создать
          </button>
        </>
      }
    >
      <div className="field">
        <label>Название</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Team Core" />
        {id && <div className="hint">id: <span className="mono">{id}</span></div>}
      </div>
      <div className="field">
        <label>Владелец (agent id)</label>
        <input className="input mono" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="claude-code-7f3a" />
      </div>
    </Modal>
  );
}

const SHARE_SCOPES: AgentScope[] = ['memory:read', 'memory:write', 'memory:delete', 'rules:read'];

function ShareModal({
  pending,
  onClose,
  onShare,
}: {
  pending: boolean;
  onClose: () => void;
  onShare: (input: { agent_id: string; scopes: AgentScope[] }) => void;
}) {
  const [agent, setAgent] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(['memory:read']);
  return (
    <Modal
      title={
        <>
          <UserPlus size={20} /> Поделиться доступом
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            disabled={!agent.trim() || scopes.length === 0 || pending}
            onClick={() => onShare({ agent_id: agent.trim(), scopes })}
          >
            Выдать доступ
          </button>
        </>
      }
    >
      <div className="field">
        <label>Агент или участник (id / email)</label>
        <input className="input mono" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="codex-ru-22a1" />
      </div>
      <div className="field">
        <label>Права</label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {SHARE_SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              className="tag"
              style={{
                cursor: 'pointer',
                background: scopes.includes(s) ? 'var(--accent-soft)' : 'var(--surface-3)',
                color: scopes.includes(s) ? 'var(--accent-soft-fg)' : 'var(--fg-2)',
              }}
              onClick={() => setScopes((a) => (a.includes(s) ? a.filter((x) => x !== s) : [...a, s]))}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
