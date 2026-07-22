/* ArtelMemory console — app shell, router, theme, login (React UMD + Babel) */
const { useState: useStateApp, useEffect: useEffectApp } = React;

const NAV = [
  { group: "Память", items: [
    { id: "overview", label: "Обзор", icon: "squares-four" },
    { id: "namespaces", label: "Namespaces", icon: "folders", count: () => window.DB.namespaces.length },
    { id: "memory", label: "Память", icon: "brain", count: () => "2.4k" },
  ]},
  { group: "Доступ", items: [
    { id: "pat", label: "PAT-токены", icon: "key", count: () => window.DB.pats.filter(p=>p.status==="active").length },
    { id: "rules", label: "Правила", icon: "scroll" },
    { id: "audit", label: "Аудит", icon: "list-magnifying-glass" },
  ]},
  { group: "Сервис", items: [
    { id: "observability", label: "Observability", icon: "chart-line-up" },
    { id: "billing", label: "Подписка", icon: "credit-card" },
  ]},
];

const TITLES = {
  overview: ["Обзор", "Состояние памяти"],
  namespaces: ["Namespaces", "Пространства памяти"],
  memory: ["Память", "Семантический браузер"],
  pat: ["PAT-токены", "Ключи доступа"],
  rules: ["Правила", "Политики памяти"],
  audit: ["Аудит", "Журнал доступа"],
  observability: ["Observability", "Метрики и здоровье"],
  billing: ["Подписка", "Биллинг"],
};

function useTheme() {
  const [theme, setTheme] = useStateApp(() => localStorage.getItem("am-console-theme") || "light");
  useEffectApp(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("am-console-theme", theme);
  }, [theme]);
  return [theme, setTheme];
}

function Sidebar({ route, go, theme, setTheme }) {
  const op = window.DB.operator;
  return (
    <aside className="sidebar">
      <div className="sb-logo"><Logo dark w={28} /><span className="word"><span className="a">Artel</span> <span className="m">Memory</span></span></div>
      <div className="sb-section" style={{ overflowY: "auto", flex: 1 }}>
        {NAV.map(grp => (
          <div key={grp.group}>
            <div className="sb-label">{grp.group}</div>
            <div className="sb-nav">
              {grp.items.map(it => (
                <button key={it.id} className={"sb-item" + (route === it.id ? " active" : "")} onClick={() => go(it.id)}>
                  <Ic n={it.icon} />{it.label}
                  {it.count && <span className="count">{it.count()}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="sb-foot">
        <div className="sb-plan">
          <span className="ic"><Ic n="cloud" b /></span>
          <div className="t"><b>Cloud · 300₽/мес</b><span>{op.region}</span></div>
          <button className="theme-toggle" style={{ marginLeft: "auto" }} title="Подписка" onClick={() => go("billing")}><Ic n="arrow-up-right" /></button>
        </div>
        <div className="sb-user">
          <span className="av">{op.initials}</span>
          <div className="nm"><b>{op.name}</b><span>{op.email}</span></div>
          <button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} title="Тема">
            <Ic n={theme === "light" ? "moon" : "sun"} b />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ route, ns, setNs }) {
  const [t, sub] = TITLES[route] || ["", ""];
  const cur = window.DB.nsById(ns);
  return (
    <header className="topbar">
      <div>
        <div className="crumb"><Ic n="house" s={14} /><span className="sep">/</span><b>{t}</b></div>
      </div>
      <div className="sp" />
      {(route === "memory" || route === "overview") && (
        <button className="ns-switch" onClick={() => setNs(nextNs(ns))}>
          <span className="dot" style={cur ? { background: cur.color } : null} />
          <span className="mono">{ns === "all" ? "все namespaces" : ns}</span>
          <Ic n="caret-up-down" />
        </button>
      )}
      <div className="topbar-search"><Ic n="magnifying-glass" /><input placeholder="Поиск…" /><kbd>⌘K</kbd></div>
      <button className="icon-btn" title="Уведомления"><Ic n="bell" /><span className="ping" /></button>
    </header>
  );
}
function nextNs(cur) {
  const ids = ["all", ...window.DB.namespaces.map(n => n.id)];
  return ids[(ids.indexOf(cur) + 1) % ids.length];
}

function Console() {
  const [route, setRoute] = useStateApp("overview");
  const [nsFocus, setNsFocus] = useStateApp(null);
  const [ns, setNs] = useStateApp("all");
  const [theme, setTheme] = useTheme();

  const go = (r, focus) => { setRoute(r); if (focus !== undefined) setNsFocus(focus); window.scrollTo && null; };

  let screen;
  if (route === "overview") screen = <OverviewScreen go={go} />;
  else if (route === "namespaces") screen = <NamespacesScreen focusId={nsFocus} clearFocus={() => setNsFocus(null)} />;
  else if (route === "memory") screen = <MemoryScreen ns={ns} />;
  else if (route === "pat") screen = <PatScreen />;
  else if (route === "rules") screen = <RulesScreen />;
  else if (route === "audit") screen = <AuditScreen />;
  else if (route === "observability") screen = <ObservabilityScreen />;
  else if (route === "billing") screen = <BillingScreen />;

  return (
    <div className="app">
      <Sidebar route={route} go={go} theme={theme} setTheme={setTheme} />
      <div className="main">
        <Topbar route={route} ns={ns} setNs={setNs} />
        <div className="content" key={route}>{screen}</div>
      </div>
    </div>
  );
}

/* ============ LOGIN ============ */
function Login({ onAuth }) {
  return (
    <div className="login">
      <div className="login-form-side">
        <div className="login-form">
          <div className="row" style={{ gap: 10, marginBottom: 30 }}>
            <Logo dark={false} w={32} />
            <span style={{ fontFamily: "var(--font-head)", fontWeight: 700, fontSize: 20, letterSpacing: "-.015em" }}><span style={{ color: "var(--fg)" }}>Artel</span> <span style={{ color: "var(--accent)" }}>Memory</span></span>
          </div>
          <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.02em" }}>Вход в консоль</h2>
          <p className="muted" style={{ fontSize: 14, marginTop: 8, marginBottom: 26 }}>Операторская панель управления общей памятью.</p>
          <div className="field"><label>Email</label><input className="input" defaultValue="artem@artelmemory.dev" /></div>
          <div className="field"><label>Пароль</label><input className="input" type="password" defaultValue="············" /></div>
          <div className="between" style={{ marginBottom: 20 }}>
            <label className="row" style={{ gap: 8, fontSize: 13, cursor: "pointer" }}><input type="checkbox" defaultChecked />Запомнить меня</label>
            <a href="#" style={{ fontSize: 13, color: "var(--accent)" }}>Забыли пароль?</a>
          </div>
          <button className="btn btn-primary btn-lg btn-block" onClick={onAuth}><Ic n="sign-in" />Войти в консоль</button>
          <div className="divider" />
          <button className="btn btn-secondary btn-block" onClick={onAuth}><Ic n="github-logo" />Войти через GitHub</button>
          <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 22 }}>Self-hosted? <a href="#" style={{ color: "var(--accent)" }}>Гайд по развёртыванию</a></p>
        </div>
      </div>
      <div className="login-art">
        <LoginArt />
      </div>
    </div>
  );
}

function LoginArt() {
  const ref = React.useRef(null);
  React.useEffect(() => { if (ref.current && window.AMLogo) ref.current.innerHTML = window.AMLogo.svg("onDark", 150, 125); }, []);
  return (
    <div style={{ position: "relative", zIndex: 2, textAlign: "center", maxWidth: 420 }}>
      <div ref={ref} style={{ display: "flex", justifyContent: "center", marginBottom: 30, filter: "drop-shadow(0 20px 40px rgba(0,0,0,.4))" }} />
      <h2 style={{ color: "#F4F3EE", fontSize: 30, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.1 }}>Общая память<br />для ваших AI-агентов</h2>
      <p style={{ color: "#A6ABB6", fontSize: 15, marginTop: 16, lineHeight: 1.6 }}>Единый контекст между сессиями и агентами. Namespaces, шеринг доступа и ключи — в вашем контуре.</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 26, flexWrap: "wrap" }}>
        {["Self-hosted", "Local-only", "MCP", "СНГ"].map(t => (
          <span key={t} style={{ fontSize: 12, color: "#C4C9D3", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", padding: "6px 12px", borderRadius: 999, fontFamily: "var(--font-mono)" }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/* ============ ROOT ============ */
function App() {
  const [authed, setAuthed] = useStateApp(() => sessionStorage.getItem("am-console-auth") === "1");
  const auth = () => { sessionStorage.setItem("am-console-auth", "1"); setAuthed(true); };
  return (
    <ToastProvider>
      {authed ? <Console /> : <Login onAuth={auth} />}
    </ToastProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
