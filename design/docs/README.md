# Handoff: ArtelMemory — Landing & Operator Console

## Overview

**ArtelMemory** — общая память для AI-агентов (shared memory for AI agents), distributed open-source with a managed cloud option (300₽/mo). Focused on CIS markets (first: Kyrgyzstan, Russia), Russian-language UI, local LLM/embeddings, data staying inside the user's contour.

This bundle contains two design references:

1. **Landing page** (`landing/main.html`) — Russian marketing page, JTBD-driven copy, dark «Контур» brand language.
2. **Operator console** (`console/index.html`) — the SAM admin console (BFF): namespaces, memory browser, PAT keys, rules, audit, observability, billing. Light + dark themes, fully clickable.

Plus the shared brand system: logo (`am-logo.js`), landing tokens (`brand.css`), console tokens (`console/console.css`).

> There are also 5 earlier landing **direction explorations** under `landing/v1…v5` + a gallery (`index.html`). The chosen/active direction is **`landing/main.html`** (built on direction A «Контур»). The v1–v5 files are kept for reference only — not required for production.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes showing intended look and behaviour, **not production code to copy verbatim**. The task is to **recreate these designs in the target codebase's environment** using its established patterns.

The product already has a backend (PRD §4 says the MVP is implemented: MCP memory store/get/search, namespaces + sharing, per-agent PAT keys, rules + audit, episodic memory, BFF console). So the realistic job is:
- **Console**: wire these screens to the real BFF API, replacing the mock `console/data.js` fixtures with live data. React is a natural target (the prototype is React 18), but any SPA framework is fine.
- **Landing**: rebuild as a static/SSR page (Next.js, Astro, plain HTML — your call). It has no dynamic data.

If no frontend environment exists yet, **React + Vite** is the recommended choice (matches the prototype).

## Fidelity

**High-fidelity.** Final colors, typography, spacing, component states, and interactions are all intentional. Recreate pixel-closely using the brand tokens below. The only "fake" parts are: mock data (see `console/data.js`), the faux-semantic search (does token-overlap ranking client-side — replace with the real Qdrant vector search), and auth (a stub — wire to the real session/CSRF flow).

---

## Brand System

### Logo
The mark is **3 stacked rounded layers** (teal squircle → cream slab → graphite chevron base) with **3 elbowed connectors** ending in open rings (teal up, terracotta straight, graphite down). It represents a modular memory stack feeding multiple agents.

- Rendered as **inline SVG** by `am-logo.js` (`window.AMLogo.svg(palette, w, h)` / `.icon(palette)` / `.lockup({dark})`). Palettes: `brand` (light bg), `onDark` (dark bg), `mono`.
- Wordmark: **"Artel Memory"** — `Artel` in graphite (`#1C2430` / light on dark), `Memory` in teal. Two words, space between. (Product/dev name may be written single-word `ArtelMemory`.)
- Reproduce as a real SVG asset (`logo.svg`, `logo-mark.svg`, favicon). Do **not** rasterize — it must stay crisp on light, dark, and favicon sizes.

### Color palette (brand core)
| Role | Name | Hex |
|---|---|---|
| Primary dark | Graphite | `#1C2430` |
| Brand accent | Teal | `#2B7D7A` (hover `#246B68`, press `#1F5C5A`; dark-mode `#34928E`) |
| Warm accent | Terracotta | `#C96A4A` (dark-mode `#DB7B5A`) — status dots, "shared core", sparing highlights only; **never** a primary CTA |
| Background | Warm Cream | `#F3EEE4` |
| Secondary neutral | Stone Grey | `#D6D2C4` |
| Muted text | Warm Slate | `#6B7280` |
| Utility blue | Functional Blue | `#2A6CF0` — links/focus only |

Status: success `#2F9E66`, warning `#D98A2B`, danger `#D0503C`, info `#2A6CF0` (each with a soft tint + readable fg — see token files).

### Typography
- **Headings / logo:** Manrope (600/700/800), `letter-spacing: -0.01em…-0.02em`.
- **Body / UI:** Inter (400/500/600).
- **Mono (IDs, code, metrics):** JetBrains Mono, `font-feature-settings: "tnum" 1`.
- Both Manrope and Inter have strong Cyrillic support — required.

### Spacing / radius / shadow
- Radius scale: `6 / 9 / 13 / 18 / 999px`.
- Shadows are minimal/soft (see `--shadow-sm/md/lg` in `console/console.css`).
- Generous whitespace; cards use subtle 1px borders, not heavy shadows.

### Iconography
Phosphor Icons (`@phosphor-icons/web@2.1.1`) — regular (`ph ph-*`) and bold (`ph-bold ph-*`), line style with rounded ends. Swap for your codebase's icon set if preferred; names in the prototype map cleanly to Phosphor.

---

## Landing Page (`landing/main.html`)

Single-column, dark hero on cream page. Sticky translucent dark nav. Sections in order:

1. **Nav** — logo (dark lockup) + anchor links (Как это работает / Возможности / Сценарии / Сравнение / Цены), GitHub icon, teal "Подключить память" CTA.
2. **Hero** (dark, graphite, radial teal+terracotta glow) — 2-col grid: left = eyebrow pill, H1 «Перестань объяснять *контекст* заново» (terracotta underline accent), sub, two CTAs, 3 chips; right = **"recall card"** mock showing memory restored into a new agent session.
3. **Steps** (cream band) — 4 numbered steps: подключить по MCP → создать namespace → расшарить доступ → выдать ключ агенту.
4. **Aha** — 2 cards (агент уже всё помнит / коллега в том же контексте).
5. **Benefits** (cream) — 4 cards (ноль переобъяснений / «почему так сделали» за секунды / единый источник правды / знания переживают агента).
6. **Pains** (dark) — 4 pain statements + reassurance callout. From PRD emotions.
7. **Core Jobs** — 2 "job" cards with numbered steps (восстановить контекст / единый контекст с командой).
8. **Objections** (cream) — 3 honest Q&A (данные за рубеж / вендор-лок / сложно настраивать).
9. **Compare** — table: claude-mem & аналоги / DIY свой сервер / «память» в чатах — vs ArtelMemory.
10. **Pricing** — 2 plans: **Self-hosted — Бесплатно** (open-source) and **ArtelMemory Cloud — 300₽/мес** (managed, recommended). Note: subscription just covers infra cost.
11. **Final CTA** (dark) + **Footer** (dark).

**Key copy decisions (from user):** local model only (do **not** name YandexGPT/GigaChat); no fake testimonials; agents named are Claude Code, Codex, Kimi, GLM, OpenClaw, Hermes + "любой клиент с MCP"; pricing = free self-host vs 300₽ managed cloud; angle = "без своего сервера, сертификатов и mTLS".

**Motion:** hero load = transform-only rise (opacity stays 1 so content is never hidden if transitions stall); scroll-reveal via IntersectionObserver adding `.in` (also transform-only). Respects `prefers-reduced-motion`. A 1.6s safety timeout force-reveals everything. **Keep this defensiveness** — never gate content visibility on an animation completing.

---

## Operator Console (`console/index.html`)

React 18 SPA. App shell = **persistent dark sidebar** (248px) + main column (topbar + scrolling content). Light theme default; dark theme via toggle (persisted to `localStorage['am-console-theme']`). Sidebar stays dark in both themes for brand presence.

### Routes / screens
| Route | Screen | Key elements |
|---|---|---|
| `overview` | **Обзор** | 4 stat cards, activity line chart, storage card, namespaces list, recent audit events |
| `namespaces` | **Namespaces** | 3-col card grid → click opens **detail drawer** (members, agents, recent memory) → **Share modal** (email/agent + role) and **Create modal** (auto kebab-id) |
| `memory` | **Память** | Semantic search bar + type filter; table (content, agent, score/type, status, created) → **detail drawer** (full content, tags, metadata, source agent) + **Write modal** |
| `pat` | **PAT-токены** | Table of keys (masked prefix, agent, scopes, ns count, calls, status) → **Create modal** → **one-time secret-reveal modal** (full token shown once, copy, MCP snippet, danger warning) + **Revoke modal** + rotate |
| `rules` | **Правила** | 6 rule cards (validation/lifecycle/security/access) with enable toggles |
| `audit` | **Аудит** | Filterable table (all / agents / humans / denied) — action, actor (human vs agent), target, ns, IP, time, result |
| `observability` | **Observability** | 4 stat cards, 3 line charts (searches/writes/latency), service-health list |
| `billing` | **Подписка** | Active 300₽ Cloud plan card, "what's included", free self-host card |
| — | **Login** | Split layout: form (email/pass/GitHub) + dark brand art panel |

### Interactions & behaviour
- **Nav:** client-side route state (`route`); active item highlighted with teal left-bar. Replace with your router (React Router etc.).
- **Drawers:** slide in from right (`translateX(100%)`→0, .26s), scrim with blur, Esc to close.
- **Modals:** centered, scrim, pop-in (.22s), Esc to close.
- **Toasts:** bottom-center, dark pill, auto-dismiss 2.6s. Provided via `ToastProvider`/`useToast`.
- **Namespace / memory drawers** open from row/card click.
- **PAT secret reveal:** the full token is shown **once** — copy button + warning that it can't be recovered, only rotated. **In production the token must come from the backend on create and never be retrievable again.**
- **Semantic search:** prototype does client-side token-overlap ranking (`rel*0.7 + storedScore*0.3`). **Replace with real Qdrant vector search**; keep the UI (score bar, "ранжировано по близости", latency note).
- **Theme toggle:** sets `data-theme="dark|light"` on `<html>`, persisted.
- **NS switcher** (topbar, on overview/memory): cycles namespace scope.

### State management (prototype → production)
Prototype keeps everything in React `useState` + the mock `window.DB`. For production:
- Route → router.
- Auth/session → real cookie session + CSRF token on mutations (PRD §4 / memory `mem_19d8f4`: all mutations require `X-CSRF-Token`; GET без токена).
- Lists (namespaces, memories, pats, rules, audit, metrics) → API queries (React Query/SWR), replacing `window.DB`.
- Theme → keep localStorage approach.

### Data shapes
See `console/data.js` — it documents every entity shape the screens consume: `operator`, `agents`, `people`, `namespaces`, `memories`, `pats`, `rules`, `audit`, `metrics`, `totals`. Mirror these as API response shapes (or adapt the components to your real shapes).

---

## Design Tokens

All tokens live in two files — **use these as the source of truth**:
- `brand.css` — landing tokens (`:root` custom properties).
- `console/console.css` — console tokens, including the full **`[data-theme="dark"]`** override block, component classes (buttons, cards, badges, tables, drawers, modals, forms, toggles, stats, charts, toasts), and the responsive breakpoint (`760px`).

Buttons: primary = teal bg / white text; secondary = surface + border; danger variants for destructive. Heights 34 (sm) / 40 (base) / 46 (lg).

---

## Assets

- **Logo:** generated by `am-logo.js` (no binary asset). Export to `logo.svg` + favicon for production.
- **Fonts:** Google Fonts — Manrope, Inter, JetBrains Mono.
- **Icons:** Phosphor Icons web font (CDN in prototype) — self-host or use your icon system in production.
- **No raster images** are used; the hero "recall card", architecture, and charts are all CSS/SVG/DOM.

---

## Files in this bundle

```
README.md                     ← this file
PRD.md                        ← product requirements (JTBD, scope, edge cases)
brand-brief.md                ← original brand/visual brief
am-logo.js                    ← shared SVG logo renderer (window.AMLogo)
brand.css                     ← landing design tokens + base components

landing/
  main.html                   ← ★ the landing page (chosen direction)
  v1-kontur.html … v5-residency.html   ← earlier direction explorations (reference)
index.html                    ← gallery comparing the 5 explorations (reference)

console/
  index.html                  ← ★ console entry (loads React + all modules)
  console.css                 ← console design tokens (light+dark) + components
  data.js                     ← mock CIS fixtures + entity shapes (window.DB)
  components.jsx              ← shared components (Logo, Drawer, Modal, Toast, Badge, charts…)
  screens-a.jsx               ← Overview, Namespaces (+ drawer/modals)
  screens-mem.jsx             ← Memory browser (+ search, drawer, write modal)
  screens-b.jsx               ← PAT, Rules, Audit, Observability, Billing
  app.jsx                     ← shell, sidebar, topbar, router, theme, login
```

To run the prototype locally: serve the folder over HTTP (e.g. `npx serve`) and open `console/index.html` or `landing/main.html`. The console uses in-browser Babel (fine for the prototype; precompile for production).

## Notes for the implementer
- Russian is the primary UI language for the first markets. Keep the copy; it's deliberately plain and non-hypey (see `brand-brief.md` §9 messaging do/don't).
- Don't promise legal compliance — wording is "deployment profiles help align with local data requirements" / "local-only mode".
- Only **non-secret** data is accepted into memory (PRD §5 + the no-secrets rule); the console reflects this with a no-secrets filter note.
- Per-agent keys: revoking one must not affect others (PRD §6 edge cases) — the PAT screen models this.
