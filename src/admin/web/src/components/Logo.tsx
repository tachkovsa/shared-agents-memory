/**
 * ArtelMemory mark — modular stack + connected agents.
 * React port of the handoff's am-logo.js (window.AMLogo). The mark is 3 stacked
 * rounded layers (teal squircle → cream slab → graphite chevron base) with 3
 * elbowed connectors ending in open rings (teal up, terracotta straight, graphite down).
 */

type Palette = { g: string; s: string; t: string; terra: string; node: string };

const PALETTES: Record<'brand' | 'onDark' | 'mono', Palette> = {
  brand: { g: '#1C2430', s: '#ECE4D3', t: '#2B7D7A', terra: '#C96A4A', node: '#1C2430' },
  onDark: { g: '#303B4A', s: '#ECE4D3', t: '#34928E', terra: '#DB7B5A', node: '#D9DDE3' },
  mono: { g: '#1C2430', s: '#BCC0C6', t: '#1C2430', terra: '#1C2430', node: '#1C2430' },
};

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function LogoMark({
  palette = 'brand',
  width = 40,
  height,
}: {
  palette?: keyof typeof PALETTES;
  width?: number;
  height?: number;
}) {
  const c = PALETTES[palette];
  const sw = 3.2;
  const h = height ?? Math.round((width * 60) / 72);
  return (
    <svg
      className="mark"
      width={width}
      height={h}
      viewBox="0 0 72 60"
      fill="none"
      aria-hidden="true"
    >
      {/* bottom — graphite layer with downward-chevron base */}
      <path d="M6 43 Q6 37.5 11 37.5 L35 37.5 Q40 37.5 40 43 L40 47 Q23 53.5 6 47 Z" fill={c.g} />
      {/* middle — cream slab (with subtle depth edge) */}
      <rect x="6" y="26.4" width="34" height="11.5" rx="7" fill={shade(c.s, 0.86)} />
      <rect x="6" y="25" width="34" height="11.5" rx="7" fill={c.s} />
      {/* top — teal squircle (with subtle depth edge) */}
      <rect x="6" y="7" width="34" height="19" rx="8.5" fill={shade(c.t, 0.72)} />
      <rect x="6" y="5" width="34" height="19" rx="8.5" fill={c.t} />
      {/* teal connector — elbow up */}
      <path d="M40 14.5 H50 L56 11.5" fill="none" stroke={c.t} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="61" cy="12.5" r="5" fill="none" stroke={c.t} strokeWidth={sw} />
      {/* terracotta connector — straight (shared-core accent) */}
      <path d="M40 31 H58" fill="none" stroke={c.terra} strokeWidth={sw} strokeLinecap="round" />
      <circle cx="63" cy="31" r="5" fill="none" stroke={c.terra} strokeWidth={sw} />
      {/* graphite connector — elbow down */}
      <path d="M40 43 H50 L56 46.5" fill="none" stroke={c.node} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="61" cy="46" r="5" fill="none" stroke={c.node} strokeWidth={sw} />
    </svg>
  );
}

/** Full lockup: mark + "Artel Memory" wordmark (Artel graphite/cream, Memory teal). */
export function LogoLockup({ dark = false, iconWidth = 38 }: { dark?: boolean; iconWidth?: number }) {
  return (
    <>
      <LogoMark palette={dark ? 'onDark' : 'brand'} width={iconWidth} />
      <span className="word">
        <span className="a">Artel</span> <span className="m">Memory</span>
      </span>
    </>
  );
}
