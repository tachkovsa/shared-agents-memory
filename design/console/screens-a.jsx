/* ArtelMemory console — screens A: Overview, Namespaces, Memory */
const { useState: useStateA } = React;

/* ============ OVERVIEW ============ */
function OverviewScreen({ go }) {
  const T = window.DB.totals, m = window.DB.metrics;
  const recent = window.DB.audit.slice(0, 6);
  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt">
          <h2>Обзор</h2>
          <p>Состояние общей памяти, агентов и активности в вашем контуре.</p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => go("observability")}><Ic n="chart-line" />Метрики</button>
          <button className="btn btn-primary" onClick={() => go("memory")}><Ic n="plus" />Записать память</button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat icon="brain" tint="teal" label="Всего записей" value={T.memories.toLocaleString("ru")} delta="+310 за 24ч" dir="up" />
        <Stat icon="magnifying-glass" tint="terra" label="Поисков за 24ч" value={T.searches24h.toLocaleString("ru")} delta="+12% к среднему" dir="up" />
        <Stat icon="robot" tint="info" label="Активных агентов" value={T.activeAgents + " / " + window.DB.agents.length} delta="1 отозван" dir="flat" />
        <Stat icon="key" tint="teal" label="Активных ключей" value={T.activePats} delta="6 всего" dir="flat" />
      </div>

      <div className="grid-2" style={{ marginTop: 16, gridTemplateColumns: "1.6fr 1fr" }}>
        <div className="card">
          <div className="between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
            <div><h3 style={{ fontSize: 16 }}>Активность памяти</h3><p className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Записи и поиски · 14 дней</p></div>
            <div className="row" style={{ gap: 16, fontSize: 12 }}>
              <span className="row" style={{ gap: 6 }}><span className="dot teal" />Поиски</span>
              <span className="row" style={{ gap: 6 }}><span className="dot terra" />Записи</span>
            </div>
          </div>
          <div className="card-pad">
            <LineChart data={m.searches} days={m.days} color="var(--accent)" h={140} />
          </div>
        </div>

        <div className="card">
          <div className="between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: 16 }}>Хранилище</h3>
            <span className="badge teal">Cloud · {window.DB.operator.region}</span>
          </div>
          <div className="card-pad">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 13 }}>Использовано</span>
              <span className="mono" style={{ fontSize: 13 }}>{T.storageUsed} / {T.storageCap} ГБ</span>
            </div>
            <div className="score" style={{ display: "block" }}>
              <div className="track" style={{ width: "100%", height: 9 }}><div className="fill" style={{ width: (T.storageUsed / T.storageCap * 100) + "%" }} /></div>
            </div>
            <div className="divider" />
            <Kv rows={[
              ["Латентность p50", T.p50 + " мс"],
              ["Латентность p95", T.p95 + " мс"],
              ["Namespaces", T.namespaces],
              ["Регион", window.DB.operator.region],
            ]} />
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16, gridTemplateColumns: "1.6fr 1fr" }}>
        <div className="card">
          <div className="between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: 16 }}>Namespaces</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => go("namespaces")}>Все <Ic n="arrow-right" /></button>
          </div>
          <div>
            {window.DB.namespaces.slice(0, 4).map(n => (
              <div key={n.id} className="between" style={{ padding: "13px 22px", borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => go("namespaces", n.id)}>
                <div className="row" style={{ gap: 12 }}>
                  <span style={{ width: 34, height: 34, borderRadius: 9, background: n.color + "22", color: n.color, display: "flex", alignItems: "center", justifyContent: "center" }}><Ic n="folder-simple" b /></span>
                  <div>
                    <div className="row" style={{ gap: 8 }}><b style={{ fontSize: 13.5 }}>{n.title}</b><span className="chip-mono">{n.id}</span></div>
                    <span className="muted" style={{ fontSize: 12 }}>{n.memories.toLocaleString("ru")} записей · {n.members} участн. · {n.agents} агентов</span>
                  </div>
                </div>
                <span className="badge neutral">{n.updated}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: 16 }}>Последние события</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => go("audit")}>Аудит <Ic n="arrow-right" /></button>
          </div>
          <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {recent.map(e => (
              <div key={e.id} className="row" style={{ gap: 11, alignItems: "flex-start" }}>
                <span style={{ width: 28, height: 28, borderRadius: 7, flex: "none", background: e.result === "ok" ? "var(--accent-soft)" : "var(--danger-soft)", color: e.result === "ok" ? "var(--accent-soft-fg)" : "var(--danger-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}><Ic n={auditIcon(e.action)} b /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5 }}><b className="mono">{e.action}</b></div>
                  <div className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.actor} · {e.ts.split(",")[1]}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function auditIcon(a) {
  if (a.startsWith("memory.write")) return "pencil-simple";
  if (a.startsWith("memory.search")) return "magnifying-glass";
  if (a.startsWith("memory.delete")) return "trash";
  if (a.startsWith("pat")) return "key";
  if (a.startsWith("namespace")) return "folder-simple";
  if (a.startsWith("rule")) return "scroll";
  if (a.startsWith("auth")) return "sign-in";
  return "circle";
}

function Stat({ icon, tint, label, value, delta, dir }) {
  const tints = { teal: ["var(--accent-soft)", "var(--accent-soft-fg)"], terra: ["var(--terra-soft)", "var(--terra-soft-fg)"], info: ["var(--info-soft)", "var(--info-fg)"] };
  const c = tints[tint] || tints.teal;
  const dicon = dir === "up" ? "trend-up" : dir === "down" ? "trend-down" : "minus";
  return (
    <div className="stat">
      <div className="sh"><span className="si" style={{ background: c[0], color: c[1] }}><Ic n={icon} b /></span>{label}</div>
      <div className="v">{value}</div>
      <div className={"d " + dir}><Ic n={dicon} b s={13} />{delta}</div>
    </div>
  );
}

function Kv({ rows }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => <React.Fragment key={i}><dt>{k}</dt><dd className="mono">{v}</dd></React.Fragment>)}
    </dl>
  );
}

/* ============ NAMESPACES ============ */
function NamespacesScreen({ focusId, clearFocus }) {
  const [detail, setDetail] = useStateA(focusId ? window.DB.nsById(focusId) : null);
  const [shareModal, setShareModal] = useStateA(false);
  const [createModal, setCreateModal] = useStateA(false);
  const toast = useToast();

  React.useEffect(() => { if (focusId) { const n = window.DB.nsById(focusId); if (n) setDetail(n); } }, [focusId]);

  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt"><h2>Namespaces</h2><p>Изолированные пространства памяти. Делитесь доступом с людьми и агентами.</p></div>
        <div className="actions"><button className="btn btn-primary" onClick={() => setCreateModal(true)}><Ic n="plus" />Новый namespace</button></div>
      </div>

      <div className="grid-3">
        {window.DB.namespaces.map(n => {
          const owner = window.DB.personById(n.owner);
          return (
            <div key={n.id} className="card" style={{ padding: 0, cursor: "pointer", overflow: "hidden" }} onClick={() => setDetail(n)}>
              <div style={{ padding: "20px 20px 16px" }}>
                <div className="between">
                  <span style={{ width: 40, height: 40, borderRadius: 11, background: n.color + "22", color: n.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}><Ic n="folder-simple" b /></span>
                  <span className={"badge " + (n.visibility === "shared" ? "teal" : "neutral")}><Ic n={n.visibility === "shared" ? "users-three" : "lock-simple"} b />{n.visibility === "shared" ? "общий" : "приватный"}</span>
                </div>
                <h3 style={{ fontSize: 17, marginTop: 14 }}>{n.title}</h3>
                <div className="chip-mono" style={{ marginTop: 6, display: "inline-block" }}>{n.id}</div>
                <p className="muted" style={{ fontSize: 13, marginTop: 10, minHeight: 38 }}>{n.desc}</p>
              </div>
              <div className="between" style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}>
                <div className="row" style={{ gap: 14, fontSize: 12 }}>
                  <span className="row muted" style={{ gap: 5 }}><Ic n="brain" />{n.memories.toLocaleString("ru")}</span>
                  <span className="row muted" style={{ gap: 5 }}><Ic n="users" />{n.members}</span>
                  <span className="row muted" style={{ gap: 5 }}><Ic n="robot" />{n.agents}</span>
                </div>
                <span className="muted" style={{ fontSize: 11.5 }}>{n.updated}</span>
              </div>
            </div>
          );
        })}
      </div>

      {detail && (
        <Drawer
          title={detail.title}
          subtitle={detail.id}
          onClose={() => { setDetail(null); clearFocus && clearFocus(); }}
          footer={<React.Fragment>
            <button className="btn btn-ghost" onClick={() => { setDetail(null); clearFocus && clearFocus(); }}>Закрыть</button>
            <button className="btn btn-secondary" onClick={() => setShareModal(true)}><Ic n="user-plus" />Поделиться</button>
          </React.Fragment>}
        >
          <NamespaceDetail ns={detail} onShare={() => setShareModal(true)} />
        </Drawer>
      )}

      {shareModal && <ShareModal ns={detail} onClose={() => setShareModal(false)} onDone={(name) => { setShareModal(false); toast("Доступ открыт: " + name); }} />}
      {createModal && <CreateNsModal onClose={() => setCreateModal(false)} onDone={(id) => { setCreateModal(false); toast("Namespace создан: " + id); }} />}
    </div>
  );
}

function NamespaceDetail({ ns, onShare }) {
  const owner = window.DB.personById(ns.owner);
  const sharedPeople = window.DB.people.slice(0, ns.members);
  const nsAgents = window.DB.agents.filter(a => a.status !== "revoked").slice(0, ns.agents);
  const nsMems = window.DB.memories.filter(m => m.ns === ns.id).slice(0, 4);
  return (
    <div>
      <div className="callout info" style={{ marginBottom: 20 }}>
        <Ic n="info" b /><div>{ns.desc}</div>
      </div>
      <div className="grid-2" style={{ marginBottom: 22 }}>
        <MiniStat icon="brain" label="Записей" value={ns.memories.toLocaleString("ru")} />
        <MiniStat icon="clock" label="Обновлён" value={ns.updated} />
      </div>

      <div className="between" style={{ marginBottom: 12 }}>
        <span className="section-title" style={{ margin: 0 }}>Участники · {sharedPeople.length}</span>
        <button className="btn btn-ghost btn-sm" onClick={onShare}><Ic n="user-plus" />Добавить</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
        {sharedPeople.map(p => (
          <div key={p.id} className="between" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
            <div className="row" style={{ gap: 10 }}><Avatar person={p} size={30} /><div><b style={{ fontSize: 13 }}>{p.name}</b><div className="muted" style={{ fontSize: 11.5 }}>{p.email}</div></div></div>
            <span className={"badge " + (p.role === "owner" ? "teal" : "neutral")}>{p.role}</span>
          </div>
        ))}
      </div>

      <div className="section-title">Подключённые агенты · {nsAgents.length}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 22 }}>
        {nsAgents.map(a => (
          <span key={a.id} className="row" style={{ gap: 8, padding: "7px 11px", border: "1px solid var(--border)", borderRadius: "var(--r-pill)" }}>
            <AgentAvatar agent={a} size={22} /><span style={{ fontSize: 12.5, fontWeight: 500 }}>{a.label}</span>
          </span>
        ))}
      </div>

      <div className="section-title">Последняя память</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {nsMems.map(m => (
          <div key={m.id} style={{ padding: "12px 14px", border: "1px solid var(--border)", borderLeft: "2px solid " + (m.status === "fresh" ? "var(--accent)" : m.status === "stale" ? "var(--warn)" : "var(--fg-4)"), borderRadius: "var(--r-md)" }}>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{m.content}</div>
            <div className="row between" style={{ marginTop: 9 }}>
              <span className="chip-mono">{m.id}</span><StatusBadge s={m.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value }) {
  return (
    <div style={{ padding: "14px 16px", border: "1px solid var(--border)", borderRadius: "var(--r-md)", background: "var(--surface-2)" }}>
      <div className="row muted" style={{ gap: 7, fontSize: 12 }}><Ic n={icon} />{label}</div>
      <div style={{ fontFamily: "var(--font-head)", fontWeight: 800, fontSize: 20, marginTop: 6 }}>{value}</div>
    </div>
  );
}

function ShareModal({ ns, onClose, onDone }) {
  const [email, setEmail] = useStateA("");
  const [role, setRole] = useStateA("member");
  return (
    <Modal title="Поделиться доступом" icon="user-plus" subtitle={"Namespace «" + ns.title + "» · " + ns.id} onClose={onClose}
      footer={<React.Fragment><button className="btn btn-ghost" onClick={onClose}>Отмена</button><button className="btn btn-primary" disabled={!email} onClick={() => onDone(email)}><Ic n="paper-plane-tilt" />Открыть доступ</button></React.Fragment>}>
      <div className="field"><label>Email участника или ID агента</label><input className="input" placeholder="dilnoza@artelmemory.dev или agent:kimi-1c04" value={email} onChange={e => setEmail(e.target.value)} /></div>
      <div className="field"><label>Роль</label>
        <Seg value={role} onChange={setRole} options={[{ v: "viewer", label: "Viewer" }, { v: "member", label: "Member" }, { v: "admin", label: "Admin" }]} />
        <div className="hint">{role === "viewer" ? "Только чтение памяти." : role === "member" ? "Чтение и запись памяти." : "Полный доступ, включая управление участниками."}</div>
      </div>
      <div className="callout info"><Ic n="info" b /><div>Приглашённый получит доступ к общей памяти namespace. Модель — как приватный репозиторий.</div></div>
    </Modal>
  );
}

function CreateNsModal({ onClose, onDone }) {
  const [title, setTitle] = useStateA("");
  const id = title.toLowerCase().replace(/[^a-zа-я0-9]+/gi, "-").replace(/^-|-$/g, "") || "new-namespace";
  return (
    <Modal title="Новый namespace" icon="folder-plus" subtitle="Изолированное пространство памяти для проекта" onClose={onClose}
      footer={<React.Fragment><button className="btn btn-ghost" onClick={onClose}>Отмена</button><button className="btn btn-primary" disabled={!title} onClick={() => onDone(id)}><Ic n="check" />Создать</button></React.Fragment>}>
      <div className="field"><label>Название</label><input className="input" placeholder="Team Core" value={title} onChange={e => setTitle(e.target.value)} autoFocus /></div>
      <div className="field"><label>Идентификатор</label><input className="input mono" value={id} readOnly /><div className="hint">kebab-case, генерируется автоматически. Используется в API и MCP.</div></div>
      <div className="field"><label>Видимость</label>
        <Seg value="private" onChange={() => {}} options={[{ v: "private", label: "Приватный" }, { v: "shared", label: "Общий" }]} />
        <div className="hint">Позже можно открыть доступ участникам и агентам.</div>
      </div>
    </Modal>
  );
}

Object.assign(window, { OverviewScreen, NamespacesScreen, Stat, Kv, auditIcon });
