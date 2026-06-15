/* ArtelMemory console — screens B: PAT, Rules, Audit, Observability, Billing */
const { useState: useStateB } = React;

/* ============ PAT TOKENS ============ */
function PatScreen() {
  const [createStep, setCreateStep] = useStateB(null); // null | "form" | "reveal"
  const [revealToken, setRevealToken] = useStateB(null);
  const [revoke, setRevoke] = useStateB(null);
  const toast = useToast();

  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt"><h2>PAT-токены</h2><p>Персональные ключи доступа. У каждого агента — свой ключ; блокировка одного не затрагивает остальных.</p></div>
        <div className="actions"><button className="btn btn-primary" onClick={() => setCreateStep("form")}><Ic n="key" />Создать ключ</button></div>
      </div>

      <div className="callout info" style={{ marginBottom: 18 }}>
        <Ic n="info" b /><div>Секрет ключа показывается <b>один раз</b> при создании. Сохраните его сразу — восстановить нельзя, только ротировать.</div>
      </div>

      <div className="table-wrap">
        <table className="tbl">
          <thead><tr>
            <th>Ключ</th><th>Агент</th><th>Scopes</th><th>Namespaces</th><th>Вызовов</th><th>Последний</th><th>Статус</th><th></th>
          </tr></thead>
          <tbody>
            {window.DB.pats.map(p => {
              const a = window.DB.agentById(p.agent);
              const revoked = p.status === "revoked";
              return (
                <tr key={p.id} style={revoked ? { opacity: .6 } : null}>
                  <td><div style={{ fontWeight: 600, fontSize: 13.5 }}>{p.name}</div><span className="chip-mono" style={{ marginTop: 5, display: "inline-block" }}>{p.prefix}…••••</span></td>
                  <td><div className="row" style={{ gap: 8 }}><AgentAvatar agent={a} size={24} /><span style={{ fontSize: 13 }}>{a.label}</span></div></td>
                  <td><div className="row" style={{ gap: 5, flexWrap: "wrap", maxWidth: 200 }}>{p.scopes.map(s => <span key={s} className="tag">{s}</span>)}</div></td>
                  <td><span className="mono muted" style={{ fontSize: 12 }}>{p.ns.length} ns</span></td>
                  <td className="num muted">{p.calls.toLocaleString("ru")}</td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{p.lastUsed}</td>
                  <td><StatusBadge s={p.status} /></td>
                  <td>
                    <div className="row row-actions" style={{ gap: 4, justifyContent: "flex-end" }}>
                      {!revoked && <button className="icon-btn" style={{ width: 32, height: 32 }} title="Ротировать" onClick={() => { setRevealToken({ ...p, rotated: true }); }}><Ic n="arrows-clockwise" /></button>}
                      {!revoked && <button className="icon-btn" style={{ width: 32, height: 32 }} title="Отозвать" onClick={() => setRevoke(p)}><Ic n="prohibit" /></button>}
                      {revoked && <span className="muted" style={{ fontSize: 12, paddingRight: 8 }}>—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {createStep === "form" && <CreatePatModal onClose={() => setCreateStep(null)} onCreate={(data) => { setCreateStep(null); setRevealToken(data); }} />}
      {revealToken && <RevealTokenModal data={revealToken} onClose={() => setRevealToken(null)} />}
      {revoke && <RevokeModal pat={revoke} onClose={() => setRevoke(null)} onConfirm={() => { setRevoke(null); toast("Ключ отозван: " + revoke.name, "prohibit"); }} />}
    </div>
  );
}

function CreatePatModal({ onClose, onCreate }) {
  const [name, setName] = useStateB("");
  const [agent, setAgent] = useStateB(window.DB.agents[0].id);
  const [scopes, setScopes] = useStateB({ "memory:read": true, "memory:write": true, "search": true });
  const toggle = (s) => setScopes(p => ({ ...p, [s]: !p[s] }));
  return (
    <Modal title="Создать PAT-ключ" icon="key" subtitle="Персональный ключ доступа для агента" onClose={onClose}
      footer={<React.Fragment><button className="btn btn-ghost" onClick={onClose}>Отмена</button>
        <button className="btn btn-primary" disabled={!name} onClick={() => onCreate({ name, agent, prefix: "sam_pat_" + Math.random().toString(36).slice(2, 6), scopes: Object.keys(scopes).filter(s => scopes[s]) })}><Ic n="check" />Создать ключ</button></React.Fragment>}>
      <div className="field"><label>Название ключа</label><input className="input" placeholder="Claude Code · рабочий" value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
      <div className="field"><label>Агент</label>
        <select className="select" value={agent} onChange={e => setAgent(e.target.value)}>
          {window.DB.agents.filter(a => a.status !== "revoked").map(a => <option key={a.id} value={a.id}>{a.label} · {a.id}</option>)}
        </select>
      </div>
      <div className="field"><label>Scopes</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {[["memory:read", "Чтение памяти"], ["memory:write", "Запись памяти"], ["search", "Семантический поиск"]].map(([s, d]) => (
            <div key={s} className="between" style={{ padding: "10px 13px", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
              <div><span className="chip-mono">{s}</span><span className="muted" style={{ fontSize: 12.5, marginLeft: 10 }}>{d}</span></div>
              <Toggle on={scopes[s]} onChange={() => toggle(s)} />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function RevealTokenModal({ data, onClose }) {
  const token = (data.prefix || "sam_pat_xxxx") + "_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 12);
  const [copied, setCopied] = useStateB(false);
  const copy = () => { navigator.clipboard && navigator.clipboard.writeText(token).catch(()=>{}); setCopied(true); setTimeout(() => setCopied(false), 1800); };
  return (
    <Modal title={data.rotated ? "Ключ ротирован" : "Ключ создан"} icon="check-circle" onClose={onClose}
      subtitle={data.rotated ? "Старый секрет аннулирован. Новый показан ниже." : "Сохраните секрет — он показывается только сейчас."}
      footer={<button className="btn btn-primary btn-block" onClick={onClose}>Я сохранил ключ</button>}>
      <div className="callout danger" style={{ marginBottom: 16 }}>
        <Ic n="warning" b /><div><b>Это единственный раз, когда виден полный ключ.</b> Восстановить его нельзя — только ротировать заново.</div>
      </div>
      <div className="field"><label>{data.name || "PAT"}</label>
        <div className="secret-box">
          <span className="val">{token}</span>
          <button className="btn btn-secondary btn-sm" onClick={copy}><Ic n={copied ? "check" : "copy"} />{copied ? "Скопировано" : "Копировать"}</button>
        </div>
      </div>
      <div className="section-title" style={{ marginTop: 18 }}>Подключение по MCP</div>
      <div className="card" style={{ padding: 14, background: "var(--code-bg)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--code-fg)" }}>
        <div>{'{'}</div>
        <div>&nbsp;&nbsp;"command": "artel-mcp",</div>
        <div>&nbsp;&nbsp;"env": {'{'} "ARTEL_TOKEN": "{token.slice(0, 18)}…" {'}'}</div>
        <div>{'}'}</div>
      </div>
    </Modal>
  );
}

function RevokeModal({ pat, onClose, onConfirm }) {
  return (
    <Modal title="Отозвать ключ?" icon="prohibit" onClose={onClose}
      subtitle={"«" + pat.name + "» (" + pat.prefix + "…) перестанет работать немедленно."}
      footer={<React.Fragment><button className="btn btn-ghost" onClick={onClose}>Отмена</button><button className="btn btn-danger" onClick={onConfirm}><Ic n="prohibit" />Отозвать ключ</button></React.Fragment>}>
      <div className="callout danger"><Ic n="warning" b /><div>Агент <b>{window.DB.agentById(pat.agent).label}</b> потеряет доступ. Другие ключи продолжат работать — память не пострадает. Переподключение поддержано через новый ключ.</div></div>
    </Modal>
  );
}

/* ============ RULES ============ */
function RulesScreen() {
  const [rules, setRules] = useStateB(window.DB.rules);
  const toast = useToast();
  const toggle = (id) => setRules(rs => rs.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  const kindMeta = { validation: ["info", "shield-check"], lifecycle: ["teal", "recycle"], security: ["danger", "lock-key"], access: ["warn", "users-three"] };
  const effectBadge = { deny: "danger", merge: "teal", flag: "warn", block: "danger" };
  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt"><h2>Правила</h2><p>Политики записи, жизненного цикла и доступа к памяти. Применяются на уровне BFF.</p></div>
        <div className="actions"><button className="btn btn-primary" onClick={() => toast("Конструктор правил — скоро", "scroll")}><Ic n="plus" />Новое правило</button></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {rules.map(r => {
          const km = kindMeta[r.kind] || ["neutral", "scroll"];
          return (
            <div key={r.id} className="card card-pad">
              <div className="between" style={{ alignItems: "flex-start" }}>
                <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
                  <span style={{ width: 42, height: 42, borderRadius: 11, flex: "none", background: "var(--" + (km[0] === "neutral" ? "surface-3" : km[0] + "-soft") + ")", color: "var(--" + (km[0] === "neutral" ? "fg-2" : km[0] + "-fg") + ")", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}><Ic n={km[1]} b /></span>
                  <div>
                    <div className="row" style={{ gap: 9 }}><b style={{ fontSize: 15 }}>{r.name}</b><span className={"badge " + (effectBadge[r.effect] || "neutral")}>{r.effect}</span></div>
                    <p className="muted" style={{ fontSize: 13.5, marginTop: 6, maxWidth: 560 }}>{r.desc}</p>
                    <div className="row" style={{ gap: 14, marginTop: 10, fontSize: 12 }}>
                      <span className="row muted" style={{ gap: 5 }}><Ic n="target" />scope: <span className="chip-mono">{r.scope}</span></span>
                      <span className="row muted" style={{ gap: 5 }}><Ic n="lightning" />{r.hits} срабатываний</span>
                      <span className="badge neutral">{r.kind}</span>
                    </div>
                  </div>
                </div>
                <Toggle on={r.enabled} onChange={() => toggle(r.id)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============ AUDIT ============ */
function AuditScreen() {
  const [filter, setFilter] = useStateB("all");
  let rows = window.DB.audit;
  if (filter === "agents") rows = rows.filter(r => r.actorKind === "agent");
  if (filter === "humans") rows = rows.filter(r => r.actorKind === "human");
  if (filter === "denied") rows = rows.filter(r => r.result === "denied");
  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt"><h2>Аудит</h2><p>Журнал доступа: кто, что и когда. События людей и агентов.</p></div>
        <div className="actions"><button className="btn btn-secondary"><Ic n="download-simple" />Экспорт CSV</button></div>
      </div>
      <div className="table-wrap">
        <div className="table-toolbar">
          <div className="field-search"><Ic n="magnifying-glass" /><input placeholder="Поиск по событиям…" /></div>
          <Seg value={filter} onChange={setFilter} options={[{ v: "all", label: "Все" }, { v: "agents", label: "Агенты" }, { v: "humans", label: "Люди" }, { v: "denied", label: "Отклонённые" }]} />
        </div>
        <table className="tbl">
          <thead><tr><th>Событие</th><th>Кто</th><th>Объект</th><th>Namespace</th><th>IP</th><th>Время</th><th>Результат</th></tr></thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.id} style={{ cursor: "default" }}>
                <td><div className="row" style={{ gap: 9 }}><span style={{ width: 28, height: 28, borderRadius: 7, flex: "none", background: e.result === "ok" ? "var(--accent-soft)" : "var(--danger-soft)", color: e.result === "ok" ? "var(--accent-soft-fg)" : "var(--danger-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}><Ic n={auditIcon(e.action)} b /></span><span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{e.action}</span></div></td>
                <td><div className="row" style={{ gap: 7 }}><span style={{ width: 20, height: 20, borderRadius: e.actorKind === "agent" ? 5 : 99, background: e.actorKind === "agent" ? "var(--terra-soft)" : "var(--info-soft)", color: e.actorKind === "agent" ? "var(--terra-soft-fg)" : "var(--info-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}><Ic n={e.actorKind === "agent" ? "robot" : "user"} b /></span><span className="mono" style={{ fontSize: 12.5 }}>{e.actor}</span></div></td>
                <td><span className="chip-mono">{e.target}</span></td>
                <td className="muted" style={{ fontSize: 12.5 }}>{e.ns}</td>
                <td className="mono muted" style={{ fontSize: 12 }}>{e.ip}</td>
                <td className="muted" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{e.ts}</td>
                <td><StatusBadge s={e.result} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============ OBSERVABILITY ============ */
function ObservabilityScreen() {
  const m = window.DB.metrics, T = window.DB.totals;
  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt"><h2>Observability</h2><p>Производительность памяти, нагрузка и здоровье сервиса.</p></div>
        <div className="actions"><Seg value="14d" onChange={() => {}} options={[{ v: "24h", label: "24ч" }, { v: "7d", label: "7д" }, { v: "14d", label: "14д" }]} /></div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <Stat icon="magnifying-glass" tint="teal" label="Поисков за 24ч" value={T.searches24h.toLocaleString("ru")} delta="+12%" dir="up" />
        <Stat icon="pencil-simple" tint="terra" label="Записей за 24ч" value={T.writes24h} delta="+8%" dir="up" />
        <Stat icon="timer" tint="info" label="Латентность p50" value={T.p50 + " мс"} delta="-4 мс" dir="up" />
        <Stat icon="gauge" tint="teal" label="Латентность p95" value={T.p95 + " мс"} delta="стабильно" dir="flat" />
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <ChartCard title="Поисковые запросы" sub="14 дней" legend="Поиски"><LineChart data={m.searches} days={m.days} color="var(--accent)" /></ChartCard>
        <ChartCard title="Записи в память" sub="14 дней" legend="Записи"><LineChart data={m.writes} days={m.days} color="var(--terra)" /></ChartCard>
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <ChartCard title="Латентность поиска (p50)" sub="мс · 14 дней" legend="мс"><LineChart data={m.latency} days={m.days} color="var(--info)" h={140} /></ChartCard>
        <div className="card">
          <div className="between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}><h3 style={{ fontSize: 16 }}>Здоровье сервиса</h3><span className="badge ok"><Ic n="check-circle" b />operational</span></div>
          <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[["API (BFF)", "ok", "8 мс"], ["Qdrant", "ok", "12 мс"], ["SQLite", "ok", "1 мс"], ["Local embeddings", "ok", "34 мс"], ["Backup (Bishkek)", "ok", "03:00"]].map(([n, s, v]) => (
              <div key={n} className="between" style={{ padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="row" style={{ gap: 9, fontSize: 13.5 }}><span className="dot ok" />{n}</span>
                <span className="mono muted" style={{ fontSize: 12.5 }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, sub, legend, children }) {
  return (
    <div className="card">
      <div className="between" style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
        <div><h3 style={{ fontSize: 16 }}>{title}</h3><p className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{sub}</p></div>
      </div>
      <div className="card-pad">{children}</div>
    </div>
  );
}

/* ============ BILLING ============ */
function BillingScreen() {
  const toast = useToast();
  return (
    <div className="content-inner">
      <div className="page-head">
        <div className="pt"><h2>Подписка</h2><p>Простой биллинг: один план, покрывающий стоимость инфраструктуры.</p></div>
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: "1.3fr 1fr", marginBottom: 16 }}>
        <div className="card card-pad">
          <div className="between">
            <div className="row" style={{ gap: 12 }}><span style={{ width: 44, height: 44, borderRadius: 12, background: "var(--accent-soft)", color: "var(--accent-soft-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}><Ic n="cloud" b /></span>
              <div><h3 style={{ fontSize: 18 }}>ArtelMemory Cloud</h3><p className="muted" style={{ fontSize: 13 }}>Managed-хостинг · {window.DB.operator.region}</p></div></div>
            <span className="badge ok"><Ic n="check-circle" b />активна</span>
          </div>
          <div className="divider" />
          <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
            <span style={{ fontFamily: "var(--font-head)", fontWeight: 800, fontSize: 38, letterSpacing: "-.02em" }}>$5</span>
            <span className="muted">/ месяц</span>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>Следующее списание — 1 июля 2026. Без тарифной матрицы и апсейлов.</p>
          <div className="row" style={{ gap: 10, marginTop: 18 }}>
            <button className="btn btn-secondary" onClick={() => toast("Способ оплаты обновлён", "credit-card")}><Ic n="credit-card" />Способ оплаты</button>
            <button className="btn btn-ghost" onClick={() => toast("Счёт скачан", "download-simple")}><Ic n="receipt" />Счета</button>
          </div>
        </div>

        <div className="card card-pad">
          <h3 style={{ fontSize: 15 }}>В подписку входит</h3>
          <div className="billing-inc" style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 16 }}>
            {["Та же память и API, что в self-hosted", "Без своего сервера, сертификатов и mTLS", "Бэкапы и обновления на нашей стороне", "Данные в СНГ-инфраструктуре", "Неограниченно агентов и namespace"].map(t => (
              <div key={t} className="row" style={{ gap: 10, fontSize: 13.5, alignItems: "flex-start" }}><Ic n="check-circle" b s={17} /><span>{t}</span></div>
            ))}
          </div>
          <style>{`.billing-inc i{color:var(--accent);}`}</style>
        </div>
      </div>

      <div className="card card-pad">
        <div className="between" style={{ marginBottom: 6 }}>
          <h3 style={{ fontSize: 15 }}>Self-hosted — бесплатно</h3>
          <span className="badge teal">open-source</span>
        </div>
        <p className="muted" style={{ fontSize: 13.5, maxWidth: 620 }}>Нужен полный контроль? Разверните ArtelMemory из исходников в своём контуре — продукт остаётся бесплатным, вы платите только за свою инфраструктуру.</p>
        <button className="btn btn-secondary" style={{ marginTop: 14 }} onClick={() => toast("Ссылка на гайд скопирована", "github-logo")}><Ic n="github-logo" />Гайд по self-host</button>
      </div>
    </div>
  );
}

Object.assign(window, { PatScreen, RulesScreen, AuditScreen, ObservabilityScreen, BillingScreen, ChartCard });
