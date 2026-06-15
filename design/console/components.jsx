/* ArtelMemory console — shared components (React UMD + Babel) */
const { useState, useEffect, useRef, createContext, useContext, useCallback } = React;

/* ---------- icons ---------- */
function Ic({ n, b, s }) {
  return <i className={(b ? "ph-bold ph-" : "ph ph-") + n} style={s ? { fontSize: s } : undefined} />;
}

/* ---------- logo (uses window.AMLogo) ---------- */
function Logo({ dark = true, w = 30 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && window.AMLogo) ref.current.innerHTML = window.AMLogo.svg(dark ? "onDark" : "brand", w, Math.round(w * 60 / 72));
  }, [dark, w]);
  return <span ref={ref} className="am-mark" style={{ display: "inline-flex" }} />;
}

/* ---------- avatars ---------- */
function Avatar({ person, size = 30 }) {
  return (
    <span className="avatar human" style={{ background: person.color, width: size, height: size, fontSize: size * 0.4 }}>
      {person.initials}
    </span>
  );
}
function AgentAvatar({ agent, size = 30 }) {
  const icons = { claude: "sparkle", codex: "terminal-window", kimi: "robot", glm: "brain", open: "code", hermes: "feather" };
  return (
    <span className="avatar agent" style={{ background: agent.color, width: size, height: size, fontSize: size * 0.46 }} title={agent.label}>
      <i className={"ph-bold ph-" + (icons[agent.kind] || "robot")} />
    </span>
  );
}
function AgentChip({ id }) {
  const a = window.DB.agentById(id);
  return (
    <span className="row" style={{ gap: 8 }}>
      <AgentAvatar agent={a} size={24} />
      <span style={{ fontWeight: 500 }}>{a.label}</span>
      <span className="mono muted" style={{ fontSize: 11 }}>{id}</span>
    </span>
  );
}

/* ---------- status badges ---------- */
const STATUS = {
  fresh: { cls: "ok", icon: "check-circle", label: "fresh" },
  stale: { cls: "warn", icon: "clock-countdown", label: "stale" },
  unverified: { cls: "neutral", icon: "question", label: "unverified" },
  active: { cls: "ok", icon: "check-circle", label: "активен" },
  idle: { cls: "neutral", icon: "moon", label: "idle" },
  revoked: { cls: "danger", icon: "prohibit", label: "отозван" },
  ok: { cls: "ok", icon: "check", label: "ok" },
  denied: { cls: "danger", icon: "x", label: "denied" },
};
function StatusBadge({ s }) {
  const m = STATUS[s] || { cls: "neutral", icon: "circle", label: s };
  return <span className={"badge " + m.cls}><i className={"ph-bold ph-" + m.icon} />{m.label}</span>;
}

function Score({ v }) {
  return (
    <span className="score">
      <span className="track"><span className="fill" style={{ width: Math.round(v * 100) + "%" }} /></span>
      <span className="n">{v.toFixed(2)}</span>
    </span>
  );
}

function Tags({ items }) {
  return <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>{items.map(t => <span key={t} className="tag">{t}</span>)}</span>;
}

/* ---------- toggle ---------- */
function Toggle({ on, onChange }) {
  return <button className={"toggle" + (on ? " on" : "")} onClick={() => onChange(!on)} aria-pressed={on} />;
}

/* ---------- segmented ---------- */
function Seg({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.v} className={value === o.v ? "on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ---------- drawer ---------- */
function Drawer({ title, subtitle, onClose, children, footer }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <React.Fragment>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div className="dt">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><Ic n="x" /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </React.Fragment>
  );
}

/* ---------- modal ---------- */
function Modal({ title, icon, subtitle, onClose, children, footer, wide }) {
  useEffect(() => {
    const h = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-wrap">
      <div className="scrim" onClick={onClose} />
      <div className={"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{icon && <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent-soft-fg)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Ic n={icon} b /></span>}{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- toast ---------- */
const ToastCtx = createContext(() => {});
function useToast() { return useContext(ToastCtx); }
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, icon = "check-circle") => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, msg, icon }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.map(t => <div className="toast" key={t.id}><Ic n={t.icon} b />{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- empty ---------- */
function Empty({ icon, title, text, action }) {
  return (
    <div className="empty">
      <div className="ic"><Ic n={icon} /></div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

/* ---------- mini bar chart ---------- */
function Bars({ data, terra }) {
  const max = Math.max(...data);
  return (
    <div className="bars">
      {data.map((d, i) => <div key={i} className={"b" + (terra ? " terra" : "")} style={{ height: Math.max(3, (d / max) * 100) + "%" }} title={String(d)} />)}
    </div>
  );
}

/* ---------- line chart (svg) ---------- */
function LineChart({ data, days, color = "var(--accent)", h = 150, fmt = (x)=>x }) {
  const w = 640, pad = 8;
  const max = Math.max(...data) * 1.12, min = Math.min(...data) * 0.85;
  const pts = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = h - pad - ((d - min) / (max - min)) * (h - pad * 2);
    return [x, y];
  });
  const path = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = path + ` L${pts[pts.length-1][0].toFixed(1)} ${h-pad} L${pad} ${h-pad} Z`;
  const id = "g" + Math.random().toString(36).slice(2, 7);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h, display: "block" }} preserveAspectRatio="none">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2.6" fill={color} opacity={i === pts.length - 1 ? 1 : 0} />)}
    </svg>
  );
}

Object.assign(window, {
  Ic, Logo, Avatar, AgentAvatar, AgentChip, StatusBadge, Score, Tags,
  Toggle, Seg, Drawer, Modal, ToastProvider, useToast, Empty, Bars, LineChart, STATUS,
});
