import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle, X } from '@phosphor-icons/react';

// ── Drawer ───────────────────────────────────────────────────────────────
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEscape(onClose);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <header className="drawer-head">
          <div className="dt">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEscape(onClose);
  return (
    <div className="modal-wrap">
      <div className="scrim" onClick={onClose} />
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Escape stack: only the top-most open layer closes on Esc, so a modal stacked
// over a drawer doesn't close both at once.
const escStack: Array<() => void> = [];
let escBound = false;

function ensureEscListener() {
  if (escBound) return;
  escBound = true;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && escStack.length > 0) {
      escStack[escStack.length - 1]();
    }
  });
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    ensureEscListener();
    const handler = () => ref.current();
    escStack.push(handler);
    return () => {
      const i = escStack.lastIndexOf(handler);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, []);
}

// ── Toast ────────────────────────────────────────────────────────────────
interface Toast {
  id: number;
  message: string;
}
const ToastCtx = createContext<{ push: (message: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string) => {
    const id = Date.now() + Math.floor(performance.now());
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <CheckCircle size={18} weight="fill" />
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx.push;
}

// ── Badge / dot ──────────────────────────────────────────────────────────
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'teal' | 'terra' | 'neutral';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Dot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'teal' | 'terra' | 'muted' }) {
  return <span className={`dot ${tone}`} />;
}

// ── Avatar ───────────────────────────────────────────────────────────────
export function Avatar({ initials, color, human }: { initials: string; color?: string; human?: boolean }) {
  return (
    <span className={`avatar ${human ? 'human' : 'agent'}`} style={color ? { background: color } : undefined}>
      {initials}
    </span>
  );
}

// ── Stat card ────────────────────────────────────────────────────────────
export function Stat({
  icon,
  label,
  value,
  detail,
  tone = 'teal',
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'teal' | 'terra';
}) {
  const bg = tone === 'terra' ? 'var(--terra-soft)' : 'var(--accent-soft)';
  const fg = tone === 'terra' ? 'var(--terra-soft-fg)' : 'var(--accent-soft-fg)';
  return (
    <div className="stat">
      <div className="sh">
        <span className="si" style={{ background: bg, color: fg }}>
          {icon}
        </span>
        {label}
      </div>
      <div className="v">{value}</div>
      {detail && <div className="d flat">{detail}</div>}
    </div>
  );
}

// ── Score bar ────────────────────────────────────────────────────────────
export function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return (
    <div className="score">
      <div className="track">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="n">{score.toFixed(2)}</span>
    </div>
  );
}

// ── Line chart (SVG) ─────────────────────────────────────────────────────
export function LineChart({ series, height = 120, color = 'var(--accent)' }: { series: number[]; height?: number; color?: string }) {
  const w = 600;
  const h = height;
  if (series.length === 0) return <svg className="linechart" viewBox={`0 0 ${w} ${h}`} />;
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const span = max - min || 1;
  const step = w / Math.max(1, series.length - 1);
  const pts = series.map((v, i) => [i * step, h - ((v - min) / span) * (h - 12) - 6] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg className="linechart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height }}>
      <path className="area" d={area} fill={color} />
      <path className="line" d={line} stroke={color} />
    </svg>
  );
}

// ── Empty / Loading ──────────────────────────────────────────────────────
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="ic">{icon}</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ label = 'Загрузка…' }: { label?: string }) {
  return <div className="muted" style={{ padding: 40, textAlign: 'center' }}>{label}</div>;
}
