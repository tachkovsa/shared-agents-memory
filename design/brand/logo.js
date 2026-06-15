/* ArtelMemory shared logo renderer — modular stack + connected agents */
(function (global) {
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n>>16)&255, g = (n>>8)&255, b = n&255;
    r = Math.round(r*f); g = Math.round(g*f); b = Math.round(b*f);
    return `#${((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1)}`;
  }
  // ArtelMemory mark — teal squircle + cream slab + graphite chevron base, with 3 elbowed connectors
  function icon(c) {
    const sw = 3.2;
    let s = '';
    // bottom — graphite layer with downward-chevron base
    s += `<path d="M6 43 Q6 37.5 11 37.5 L35 37.5 Q40 37.5 40 43 L40 47 Q23 53.5 6 47 Z" fill="${c.g}"/>`;
    // middle — cream slab (with subtle depth edge)
    s += `<rect x="6" y="26.4" width="34" height="11.5" rx="7" fill="${shade(c.s, 0.86)}"/>`;
    s += `<rect x="6" y="25" width="34" height="11.5" rx="7" fill="${c.s}"/>`;
    // top — teal squircle (with subtle depth edge)
    s += `<rect x="6" y="7" width="34" height="19" rx="8.5" fill="${shade(c.t, 0.72)}"/>`;
    s += `<rect x="6" y="5" width="34" height="19" rx="8.5" fill="${c.t}"/>`;
    // teal connector — elbow up
    s += `<path d="M40 14.5 H50 L56 11.5" fill="none" stroke="${c.t}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    s += `<circle cx="61" cy="12.5" r="5" fill="none" stroke="${c.t}" stroke-width="${sw}"/>`;
    // terracotta connector — straight (shared-core accent)
    s += `<path d="M40 31 H58" fill="none" stroke="${c.terra}" stroke-width="${sw}" stroke-linecap="round"/>`;
    s += `<circle cx="63" cy="31" r="5" fill="none" stroke="${c.terra}" stroke-width="${sw}"/>`;
    // graphite connector — elbow down
    s += `<path d="M40 43 H50 L56 46.5" fill="none" stroke="${c.node}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    s += `<circle cx="61" cy="46" r="5" fill="none" stroke="${c.node}" stroke-width="${sw}"/>`;
    return s;
  }
  const PALETTES = {
    brand: { g:'#1C2430', s:'#ECE4D3', t:'#2B7D7A', terra:'#C96A4A', node:'#1C2430' },
    onDark:{ g:'#303B4A', s:'#ECE4D3', t:'#34928E', terra:'#DB7B5A', node:'#D9DDE3' },
    mono:  { g:'#1C2430', s:'#BCC0C6', t:'#1C2430', terra:'#1C2430', node:'#1C2430' }
  };
  function svg(pal, w, h) {
    pal = pal || 'brand'; w = w || 40; h = h || 33;
    return `<svg class="mark" width="${w}" height="${h}" viewBox="0 0 72 60" fill="none" aria-hidden="true">${icon(PALETTES[pal]||pal)}</svg>`;
  }
  function lockup(opts) {
    opts = opts || {};
    const dark = opts.dark;
    const pal = dark ? 'onDark' : 'brand';
    const w = opts.iconW || 38, h = Math.round(w * 60 / 72);
    return `${svg(pal, w, h)}<span class="word"><span class="a">Artel</span> <span class="m">Memory</span></span>`;
  }
  // Auto-render: any element with data-am-logo, plus standalone data-am-icon
  function render(root) {
    root = root || document;
    root.querySelectorAll('[data-am-logo]').forEach(el => {
      const dark = el.classList.contains('on-dark') || el.dataset.amLogo === 'dark';
      el.innerHTML = lockup({ dark, iconW: parseInt(el.dataset.iconW) || 38 });
    });
    root.querySelectorAll('[data-am-icon]').forEach(el => {
      const pal = el.dataset.amIcon || 'brand';
      const w = parseInt(el.getAttribute('width')) || 60;
      const h = parseInt(el.getAttribute('height')) || Math.round(w*60/72);
      el.innerHTML = icon(PALETTES[pal] || PALETTES.brand);
      el.setAttribute('viewBox', '0 0 72 60');
    });
  }
  global.AMLogo = { icon, svg, lockup, render, PALETTES };
  if (document.readyState !== 'loading') render();
  else document.addEventListener('DOMContentLoaded', () => render());
})(window);
