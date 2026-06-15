/* ArtelMemory console — Memory browser + detail drawer */
const { useState: useStateM } = React;

function MemoryScreen({ ns }) {
  const [q, setQ] = useStateM("");
  const [typeFilter, setTypeFilter] = useStateM("all");
  const [detail, setDetail] = useStateM(null);
  const [writeModal, setWriteModal] = useStateM(false);
  const [searching, setSearching] = useStateM(false);
  const toast = useToast();

  let rows = window.DB.memories.filter(m => ns === "all" || m.ns === ns);
  if (typeFilter !== "all") rows = rows.filter(m => m.type === typeFilter);
  if (q) {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = rows.map(m => {
      const hay = (m.content + " " + m.tags.join(" ") + " " + m.id + " " + m.ns).toLowerCase();
      const hits = tokens.filter(t => hay.includes(t)).length;
      // semantic-ish: blend token overlap with stored relevance
      const rel = hits / tokens.length;
      return { m, rank: rel * 0.7 + m.score * 0.3, hits };
    }).filter(x => x.hits > 0);
    scored.sort((a, b) => b.rank - a.rank);
    rows = scored.map(x => x.m);
  }

  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt"><h2>Память</h2><p>Семантический браузер памяти. Поиск по смыслу через Qdrant, фильтрация по namespace и типу.</p></div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => toast("Экспортировано в JSON", "download-simple")}><Ic n="download-simple" />Экспорт</button>
          <button className="btn btn-primary" onClick={() => setWriteModal(true)}><Ic n="plus" />Записать память</button>
        </div>
      </div>

      {/* semantic search bar */}
      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <div className="field-search" style={{ flex: 1, minWidth: 0 }}>
            <Ic n="magnifying-glass" />
            <input placeholder="Семантический поиск: «как мы деплоим prod», «правила namespace api»…" value={q}
              onChange={e => { setQ(e.target.value); setSearching(!!e.target.value); }} />
            {q && <button className="icon-btn" style={{ width: 28, height: 28, border: "none", background: "none" }} onClick={() => { setQ(""); setSearching(false); }}><Ic n="x" /></button>}
          </div>
          <Seg value={typeFilter} onChange={setTypeFilter} options={[
            { v: "all", label: "Все" }, { v: "decision", label: "Решения" }, { v: "rule", label: "Правила" }, { v: "fact", label: "Факты" }, { v: "episode", label: "Эпизоды" },
          ]} />
        </div>
        {searching && <div className="row muted" style={{ gap: 7, marginTop: 11, fontSize: 12.5, paddingLeft: 4 }}><Ic n="sparkle" b s={14} /><span>Семантический поиск · {rows.length}&nbsp;{plural(rows.length, "результат", "результата", "результатов")} · ранжировано по близости · {window.DB.totals.p50}&thinsp;мс · local embeddings</span></div>}
      </div>

      {rows.length === 0 ? (
        <Empty icon="brain" title="Ничего не найдено" text="Попробуйте изменить запрос или снять фильтр по типу." action={<button className="btn btn-secondary" onClick={() => { setQ(""); setTypeFilter("all"); }}>Сбросить фильтры</button>} />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr>
              <th style={{ width: "44%" }}>Содержание</th>
              <th>Агент</th>
              {searching ? <th>Близость</th> : <th>Тип</th>}
              <th>Статус</th>
              <th>Создано</th>
            </tr></thead>
            <tbody>
              {rows.map(m => (
                <tr key={m.id} onClick={() => setDetail(m)}>
                  <td>
                    <div style={{ fontSize: 13.5, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.content}</div>
                    <div className="row" style={{ gap: 6, marginTop: 7 }}>
                      <span className="chip-mono">{m.id}</span>
                      {ns === "all" && <span className="tag">{m.ns}</span>}
                    </div>
                  </td>
                  <td><AgentChip id={m.agent} /></td>
                  {searching ? <td><Score v={m.score} /></td> : <td><span className="badge neutral">{typeLabel(m.type)}</span></td>}
                  <td><StatusBadge s={m.status} /></td>
                  <td className="muted" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{m.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && <MemoryDrawer m={detail} onClose={() => setDetail(null)} onDelete={() => { setDetail(null); toast("Запись удалена", "trash"); }} />}
      {writeModal && <WriteMemoryModal ns={ns} onClose={() => setWriteModal(false)} onDone={() => { setWriteModal(false); toast("Память записана", "check-circle"); }} />}
    </div>
  );
}

function typeLabel(t) { return ({ decision: "решение", rule: "правило", fact: "факт", episode: "эпизод" })[t] || t; }
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function MemoryDrawer({ m, onClose, onDelete }) {
  const a = window.DB.agentById(m.agent);
  return (
    <Drawer title="Запись памяти" subtitle={m.id} onClose={onClose}
      footer={<React.Fragment>
        <button className="btn btn-danger-ghost" onClick={onDelete}><Ic n="trash" />Удалить</button>
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={onClose}>Закрыть</button>
      </React.Fragment>}>
      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <span className="badge neutral">{typeLabel(m.type)}</span>
        <StatusBadge s={m.status} />
        <span className="tag">{m.ns}</span>
      </div>
      <div className="mem-content card" style={{ padding: 18, marginBottom: 20, background: "var(--surface-2)" }}>{m.content}</div>

      <div className="section-title">Теги</div>
      <div style={{ marginBottom: 22 }}><Tags items={m.tags} /></div>

      <div className="section-title">Метаданные</div>
      <Kv rows={[
        ["ID", m.id],
        ["Namespace", m.ns],
        ["Тип", typeLabel(m.type)],
        ["Создано", m.created],
        ["Обращений", m.accesses],
        ["Близость", m.score.toFixed(2)],
      ]} />

      <div className="divider" />
      <div className="section-title">Источник</div>
      <div className="row between" style={{ padding: "12px 14px", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
        <div className="row" style={{ gap: 10 }}><AgentAvatar agent={a} size={32} /><div><b style={{ fontSize: 13 }}>{a.label}</b><div className="mono muted" style={{ fontSize: 11.5 }}>{a.id}</div></div></div>
        <StatusBadge s={a.status} />
      </div>

      <div className="callout warn" style={{ marginTop: 18 }}>
        <Ic n="shield-check" b /><div><b>Только несекретные данные.</b> no-secrets фильтр блокирует токены и ключи при записи.</div>
      </div>
    </Drawer>
  );
}

function WriteMemoryModal({ ns, onClose, onDone }) {
  const [content, setContent] = useStateM("");
  const [type, setType] = useStateM("decision");
  const [tags, setTags] = useStateM("");
  const targetNs = ns === "all" ? "team-core" : ns;
  return (
    <Modal title="Записать память" icon="pencil-simple" wide subtitle={"Namespace · " + targetNs} onClose={onClose}
      footer={<React.Fragment><button className="btn btn-ghost" onClick={onClose}>Отмена</button><button className="btn btn-primary" disabled={!content} onClick={onDone}><Ic n="check" />Сохранить</button></React.Fragment>}>
      <div className="field"><label>Содержание</label><textarea className="textarea" placeholder="Например: prod работает на PostgreSQL-профиле, миграции через Alembic…" value={content} onChange={e => setContent(e.target.value)} autoFocus /></div>
      <div className="grid-2">
        <div className="field"><label>Тип</label>
          <select className="select" value={type} onChange={e => setType(e.target.value)}>
            <option value="decision">Решение</option><option value="rule">Правило</option><option value="fact">Факт</option><option value="episode">Эпизод</option>
          </select>
        </div>
        <div className="field"><label>Теги</label><input className="input mono" placeholder="infra, decision, db" value={tags} onChange={e => setTags(e.target.value)} /></div>
      </div>
      <div className="callout info"><Ic n="sparkle" b /><div>Запись будет проиндексирована локальной embedding-моделью и станет доступна семантическому поиску для всех агентов namespace.</div></div>
    </Modal>
  );
}

Object.assign(window, { MemoryScreen, typeLabel });
