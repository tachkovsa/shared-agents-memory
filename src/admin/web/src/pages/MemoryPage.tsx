import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Brain, MagnifyingGlass, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { Badge, Drawer, Empty, Loading, Modal, ScoreBar, useToast } from '@/components/ui-kit';
import { useDeleteMemory, useMemories, useNamespaces, useWriteMemory } from '@/hooks/use-data';
import { ApiError, api, type MemoryRecordView } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';

function stalenessTone(s: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (s === 'fresh') return 'ok';
  if (s === 'unverified') return 'warn';
  if (s === 'stale' || s === 'broken_ref') return 'danger';
  return 'neutral';
}

export function MemoryPage() {
  const namespaces = useNamespaces();
  const nsList = namespaces.data?.namespaces ?? [];
  const [ns, setNs] = useState<string | null>(null);
  const activeNs = ns ?? nsList[0]?.id ?? null;
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [open, setOpen] = useState<MemoryRecordView | null>(null);
  const [showWrite, setShowWrite] = useState(false);

  const list = useMemories(activeNs);
  const del = useDeleteMemory(activeNs ?? '');
  const write = useWriteMemory(activeNs ?? '');
  const toast = useToast();

  const search = useQuery({
    queryKey: ['mem-search', activeNs, submitted],
    queryFn: () => api.searchMemories(activeNs as string, submitted),
    enabled: !!activeNs && submitted.length > 0,
  });

  const listed = list.data?.pages.flatMap((p) => p.memories) ?? [];
  const rows: Array<MemoryRecordView & { score?: number }> =
    submitted && search.data ? search.data.results : listed;

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Память</h2>
          <p>Эпизодическая память агентов. Семантический поиск по близости (Qdrant).</p>
        </div>
        <div className="actions">
          <select className="select" style={{ width: 200 }} value={activeNs ?? ''} onChange={(e) => setNs(e.target.value)}>
            {nsList.map((n) => (
              <option key={n.id} value={n.id}>
                {n.display_name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={!activeNs} onClick={() => setShowWrite(true)}>
            <Plus size={17} /> Записать
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <div className="table-toolbar">
          <form
            className="field-search"
            style={{ flex: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(query.trim());
            }}
          >
            <MagnifyingGlass size={16} />
            <input placeholder="Семантический поиск по памяти…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </form>
          {submitted && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setQuery('');
                setSubmitted('');
              }}
            >
              Сбросить
            </button>
          )}
        </div>

        {!activeNs ? (
          <Empty icon={<Brain size={28} />} title="Нет namespaces" />
        ) : list.isPending || (submitted && search.isPending) ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty icon={<Brain size={28} />} title={submitted ? 'Ничего не найдено' : 'Память пуста'}>
            {submitted ? 'Попробуйте другой запрос.' : 'Агенты ещё ничего не записали.'}
          </Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Содержимое</th>
                <th>Агент</th>
                <th>{submitted ? 'Близость' : 'Статус'}</th>
                <th>Создано</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} onClick={() => setOpen(m)}>
                  <td style={{ maxWidth: 420 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.content}</div>
                    <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                      {m.tags.slice(0, 3).map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="mono">{m.agent_id}</td>
                  <td>
                    {submitted && m.score !== undefined ? (
                      <ScoreBar score={m.score} />
                    ) : (
                      <Badge tone={stalenessTone(m.staleness_signal)}>{m.staleness_signal}</Badge>
                    )}
                  </td>
                  <td className="muted">{relativeTime(m.created_at)}</td>
                  <td>
                    <div className="row row-actions" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-sm btn-danger-ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void del
                            .mutateAsync(m.id)
                            .then(() => toast('Удалено'))
                            .catch((err) => toast(err instanceof ApiError ? err.code : 'Ошибка'));
                        }}
                      >
                        <Trash size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!submitted && list.hasNextPage && (
          <div style={{ padding: 14, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button
              className="btn btn-sm btn-secondary"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'Загрузка…' : 'Загрузить ещё'}
            </button>
          </div>
        )}
      </div>

      {open && (
        <Drawer
          title="Запись памяти"
          subtitle={<span className="mono">{open.id}</span>}
          onClose={() => setOpen(null)}
          footer={
            <button
              className="btn btn-danger-ghost"
              onClick={() => {
                void del
                  .mutateAsync(open.id)
                  .then(() => {
                    toast('Удалено');
                    setOpen(null);
                  })
                  .catch((err) => toast(err instanceof ApiError ? err.code : 'Ошибка'));
              }}
            >
              <Trash size={16} /> Удалить
            </button>
          }
        >
          <p className="mem-content">{open.content}</p>
          {open.summary && (
            <>
              <div className="divider" />
              <div className="section-title">Summary</div>
              <p className="muted">{open.summary}</p>
            </>
          )}
          <div className="divider" />
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {open.tags.map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
          </div>
          <dl className="kv">
            <dt>Агент</dt>
            <dd className="mono">{open.agent_id}</dd>
            <dt>Источник</dt>
            <dd>{open.source ?? '—'}</dd>
            <dt>Статус</dt>
            <dd>
              <Badge tone={stalenessTone(open.staleness_signal)}>{open.staleness_signal}</Badge>
            </dd>
            <dt>Обращений</dt>
            <dd className="mono">{open.retrieval_count}</dd>
            <dt>Создано</dt>
            <dd>{formatDate(open.created_at)}</dd>
          </dl>
        </Drawer>
      )}

      {showWrite && activeNs && (
        <WriteModal
          pending={write.isPending}
          onClose={() => setShowWrite(false)}
          onWrite={async (input) => {
            try {
              await write.mutateAsync(input);
              toast('Записано');
              setShowWrite(false);
            } catch (e) {
              toast(e instanceof ApiError ? e.code : 'Не удалось записать');
            }
          }}
        />
      )}
    </>
  );
}

function WriteModal({
  pending,
  onClose,
  onWrite,
}: {
  pending: boolean;
  onClose: () => void;
  onWrite: (input: { content: string; agent_id: string; tags?: string[] }) => void;
}) {
  const [content, setContent] = useState('');
  const [agent, setAgent] = useState('');
  const [tags, setTags] = useState('');
  return (
    <Modal
      title={
        <>
          <PencilSimple size={20} /> Записать в память
        </>
      }
      subtitle="Только несекретные данные: не вставляйте сюда токены, ключи и пароли."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            disabled={!content.trim() || !agent.trim() || pending}
            onClick={() =>
              onWrite({
                content: content.trim(),
                agent_id: agent.trim(),
                tags: tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          >
            Записать
          </button>
        </>
      }
    >
      <div className="field">
        <label>Содержимое</label>
        <textarea className="textarea" value={content} onChange={(e) => setContent(e.target.value)} />
      </div>
      <div className="field">
        <label>Агент</label>
        <input className="input mono" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="claude-code-7f3a" />
      </div>
      <div className="field">
        <label>Теги (через запятую)</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="decision, infra" />
      </div>
    </Modal>
  );
}
