# SAM Admin Console — Screen Spec (for Claude Design)

> **What this is.** A design brief for the **Shared Agents Memory (SAM)** operator
> console — a web admin for a self-hosted MCP memory service. Hand this whole file
> to a design tool (Claude Design) as the prompt. Brand tokens (palette, logo,
> type, tone) are placeholders below — fill them in before generating.
>
> **Audience of the product:** a single technical **operator** (instance admin)
> who runs the server and manually onboards the first users. It is NOT an
> end-user/customer app.
>
> **Stack the screens target:** React 19 + Vite + Tailwind v4 + shadcn-style
> primitives + Phosphor icons + TanStack Query v5 + React Router 7. SPA talks to a
> JSON BFF at `/api/admin/*` (cookie session + CSRF on mutations).

---

## 0. Brand & design system (fill in)

- **Product name:** SAM — Shared Agents Memory.
- **Palette:** `<<primary>>`, `<<accent>>`, neutrals; semantic: success/green,
  warning/amber, danger/red, info/blue. Dark mode: yes (default to system).
- **Logo:** `<<logo>>` (mark + wordmark).
- **Type:** UI sans `<<font>>`; **monospace for all IDs, tokens, JSON, refs**.
- **Tone:** calm, precise, developer-grade. No marketing fluff. Dense but readable
  tables. Generous empty-states that teach.
- **Density:** comfortable default; tables are the primary surface.

### Global UI patterns (apply to every screen)
- **Layout:** persistent left sidebar (nav) + top bar + scrollable content.
- **States, always design all four:** `loading` (skeletons, not spinners where a
  shape is known), `empty` (illustration + one-line explanation + primary CTA),
  `error` (inline banner with a Retry action; never a blank screen), `populated`.
- **Mutations:** confirm destructive actions in a modal; show a toast on
  success/failure; optimistic where safe.
- **Copy buttons** on every ID / token / ref (monospace chip + copy icon).
- **Relative + absolute time:** show "2h ago" with the exact ISO timestamp on hover.
- **Auth model:** the logged-in operator is an **instance admin** and sees/manages
  everything; show a small role badge. No per-row permission UI in v1.

---

## 1. Authentication

> **Two distinct surfaces — do not merge them.**
> - **§1.1–1.2 Operator auth** ships in the open-source console (this product). No
>   self-serve signup: username/password (+ optional TOTP), first operator gated by
>   a one-time setup token.
> - **§1.3 End-user signup** (email + captcha + social VK/Yandex/…) is a **future
>   SaaS-layer surface** that lives in a separate product, NOT in this console.
>   Included here only as a forward-looking note; design it later. Likely
>   **email-only** to start.

### 1.1 Operator Setup — first-run only
Centered card on a neutral full-height background, logo on top.
- Title "Set up your instance" + one-line subtitle.
- **Setup token** — monospace text input; placeholder `sam_setup_…`; helper
  "Printed to the server logs on first boot."
- **Username** — 3–64 chars.
- **Password** — ≥8 chars, with a strength meter.
- **Enable two-factor (TOTP)** — toggle (off by default). If on, after submit show
  a QR code + a list of one-time **recovery codes** to copy/download.
- Primary button **Create operator**.
- **Errors:** invalid setup token → inline under the token field
  (`invalid_setup_token`); weak password → inline. Success → redirect to Dashboard.
- **Data:** `POST /api/admin/setup { username, password, setup_token? }`.

### 1.2 Operator Login
Same centered card.
- **Username**, **Password**.
- **TOTP code** — 6–8 digit field, shown only when the operator has 2FA enabled.
- Primary **Sign in**. Secondary link "Forgot password?" (v1: disabled / "contact
  the instance admin").
- **Errors:** wrong credentials → single generic error (no enumeration); after N
  failures → "Too many attempts, try again later" (rate-limited). Success →
  Dashboard.
- **Data:** `POST /api/admin/auth/login`.

### 1.3 End-user Signup — FUTURE / SaaS layer (note only, not built here)
Two-column marketing layout (form left, value-prop right; single column on mobile).
- **Email** (format-validated).
- **Password** + strength — or passwordless magic-link (decide later).
- **Captcha:** **cap.js** widget (self-hosted, privacy-friendly; fits the
  data-residency stance). RF alternative: Yandex SmartCaptcha.
- Primary **Create account**.
- Divider "or continue with" → **social icon buttons**, brand-colored:
  **VK ID**, **Yandex ID**, **Telegram** (pragmatic trio for RU); later optionally
  **T‑ID (Tinkoff)**, **Sber ID**, **Mail.ru**. (Gosuslugi/ESIA: too heavy for a
  dev product.)
- 152-ФЗ personal-data consent checkbox; link to Terms/Privacy.
- "Already have an account? Sign in."
- **States:** email taken → inline; captcha unsolved → block submit; social →
  provider redirect/popup → callback → onboarding (create org/namespace) or
  verify-email screen.

---

## 2. App shell

- **Sidebar (left, collapsible):** logo at top; nav items with Phosphor icons —
  **Dashboard, Namespaces, PATs, Memory, Rules, Audit, Observability**. Footer:
  operator name + role badge + **Log out**.
- **Top bar:** current section title / breadcrumbs; a small **health dot**
  (green/amber/red, sourced from Dashboard health); optional global search.
- **Content area:** page title + primary actions top-right; below, the table/detail.
- **Health dot states:** green = all ok; amber = degraded (e.g. embeddings
  breaker open); red = Qdrant down.

---

## 3. Screens

### 3.1 Dashboard / Overview
**Purpose:** at-a-glance instance health and scale.
**Layout:** grid of metric cards + a recent-activity panel + alerts.
- **Health card:** Qdrant `ok | degraded | down`; embeddings circuit breaker
  `closed | open`; server version; uptime.
- **Count cards:** total namespaces, total memories, active PATs, operators.
- **Today's activity:** writes / searches today (from quota usage), soft+hard
  lifecycle deletes in the last 24h.
- **Recent audit (5 rows)** → links to Audit.
- **Alerts list:** breaker open; a namespace at/near a quota cap; PATs expiring
  within 7 days.
- **States:** degraded/down health → card turns amber/red with a short reason.
- **Data:** `GET /api/admin/health` (+ counts). *(BFF endpoint pending — #69.)*

### 3.2 Namespaces — list
Table. Search/filter by id. Top-right **New namespace**.
| Column | Notes / values |
|---|---|
| `id` | kebab-case, monospace |
| `display_name` | |
| `owner_agent_id` | monospace |
| `retention_policy` | badge: `keep-forever` · `decay-90d` · `decay-180d` · `decay-365d` |
| `dedup_threshold` | `0.85`–`0.99`, or `1.0` = "dedup off" |
| `# memories` | numeric |
| `created_at` | relative+exact |
- Row action: **Open**.
- **New namespace** modal: `id` (validated kebab `^[a-z][a-z0-9-]{1,62}[a-z0-9]$`),
  `display_name`, `owner_agent_id`.
- **Data:** `GET /api/admin/namespaces`.

### 3.3 Namespace — detail
Header (display_name + id chip) with tabs: **Overview · Members · Quota & Lifecycle**.
- **Overview:** visibility (`private`), owner, created/updated, memory count.
- **Members** table: `agent_id`, `scopes[]`, `added_by`, `added_at`. Actions: **Add
  member** (agent_id + scope multi-select), **Remove** (confirm).
  - **scope values (from `ALL_SCOPES`):** `memory:read`, `memory:write`,
    `memory:delete`, `namespace:admin`, `service:admin`. (Render as toggles/chips;
    treat the canonical list as authoritative from the API.)
- **Quota & Lifecycle** form (each field shows current value; quota fields show a
  usage bar of today's consumption):
  - **Quota:** `daily_embedding_tokens` (default 1 000 000), `daily_writes`
    (5 000), `daily_searches` (20 000), `max_memories` (100 000) — positive ints.
  - **Lifecycle:** `decay_weight` slider `0.0–1.0` (default 0.5);
    `soft_delete_after_days` int or **null = "rank-only, never delete"**;
    `hard_delete_grace_days` (default 30); `staleness_audit_enabled` toggle (default
    on); `staleness_audit_batch_size` (default 100); `filesystem_audit_root` path
    or null.
- **Data:** `GET /api/admin/namespaces/:id`; updates via `namespace_update` (write
  BFF — pending slice); add/remove member.

### 3.4 PATs — management
Table. Top-right **Create PAT**.
| Column | Values |
|---|---|
| `display_name` | |
| `agent_identity` | monospace |
| `scopes[]` | chips (see scope values above) |
| `allowed_namespaces[]` | chips |
| `token_prefix` | monospace (e.g. `sam_pat_ab…`) — never the full token |
| `last_used_at` | relative or "never" |
| `expires_at` | date or "never" |
| status | badge: **active** (green) · **expiring soon** (amber, <7d) · **revoked** (gray) · **expired** (red) |
| `created_at` / `created_by` | `created_by` like `operator:<id>` |
- **Create PAT** modal: `display_name`, `agent_identity`, **scope picker**
  (checkboxes from `ALL_SCOPES`, ≥1), **namespace picker** (multi-select of existing
  namespaces, ≥1), `expires_at` (date | never).
- **One-time secret reveal:** on create, a modal shows the plaintext
  `sam_pat_…` once — monospace, copy button, bold warning "shown only once, store
  it now." Closing the modal makes it unrecoverable.
- **Revoke:** row action → confirm modal with an optional **reason**; sets status to
  revoked. (Revoking an agent's last PAT also prunes its namespace memberships —
  surface this in the confirm copy.)
- **Rotate:** (later) re-issues a secret, revokes the old — same one-time reveal.
- **Data:** `GET /api/admin/pats`, `GET /:id`, `POST /api/admin/pats`,
  `POST /api/admin/pats/:id/revoke`.

### 3.5 Memory browser
**Layout:** namespace selector at top → paginated list/table → right-side detail
drawer.
| Column | Values |
|---|---|
| `id` | shortened, monospace |
| content | one-line preview (truncate) |
| `tags[]` | chips |
| `agent_id` | monospace |
| `retrieval_count` | numeric |
| `staleness_signal` | badge: `fresh` (green) · `unverified` (gray) · `stale` (amber) · `broken_ref` (red) |
| `decay_score` | `0.0–1.0` mini-bar |
| `created_at` | relative+exact |
| flags | small icons for **superseded** / **deleted** |
- **Include deleted** toggle (shows tombstones, visibly marked).
- **Pagination:** cursor-based — "Load more" button (opaque cursor).
- **Detail drawer:** full `content`, `summary`, `metadata` (pretty JSON), `source`,
  `verifies_against` (`{ kind: file|url|git_commit, ref, captured_at,
  last_known_value }`), `superseded_by`, timestamps. Action **Delete** (confirm; for
  a tombstone the label is **Purge**).
- **Empty state:** "No memories in this namespace yet."
- **Data:** `GET /api/admin/namespaces/:id/memories?limit&cursor&include_deleted`,
  `GET .../:memId`, `DELETE .../:memId`.

### 3.6 Rules viewer (read-only in v1)
**Layout:** namespace selector → rule list → rule viewer.
- **List columns:** `id`, `title`, `severity` (badge: `hard` | `soft`), `tags[]`,
  `updated_at`.
- **Viewer:** frontmatter block (`id`, `title`, `severity`, `tags[]`,
  `applies_to[]`, `created_at`, `created_by`, `updated_at`) + **body rendered as
  Markdown**.
- Editing is on the MCP `rules_*` path for now → an **Edit** affordance can be
  "coming soon" / link to docs.
- **Data:** `GET /api/admin/namespaces/:id/rules`, `GET .../rules/:ruleId`.

### 3.7 Audit log
**Layout:** filter bar + table.
| Column | Values |
|---|---|
| `ts` | relative+exact, newest first |
| `event` | badge, color-coded |
| details | key fields inline: `agent_identity` / `namespace` / `tool` / `reason` |
- **event values:** `auth.success` (muted), `auth.failure` (red),
  `pat.minted` (blue), `pat.revoked` (amber), `auth.rate_limited` (amber),
  `namespace.member_removed` (gray).
- **Filters:** event (dropdown), limit (50 / 100 / 500).
- Row expand → full `details` JSON.
- **Data:** `GET /api/admin/audit?limit&event`.

### 3.8 Observability dashboard
**Purpose:** operational metrics from the Prometheus registry.
- **Health panel:** Qdrant, embeddings breaker, version (same source as Dashboard).
- **Metric tiles / sparklines:** embedding calls & latency; dedup outcomes
  (`inserted | reinforced | merged`); decay sweep duration; lifecycle deletes
  (`soft | hard`); quota rejections (by `limit`); staleness audit results
  (`fresh | stale | broken_ref | skipped`).
- Link to raw `/metrics` (loopback-only note).
- **Data:** `GET /api/admin/health` + counters. *(BFF endpoint pending — #69.)*

---

## 4. Enum reference (authoritative values for pickers/badges)

- **Agent scopes (`ALL_SCOPES`):** `memory:read`, `memory:write`, `memory:delete`,
  `namespace:admin`, `service:admin`.
- **Retention policy:** `keep-forever`, `decay-90d`, `decay-180d`, `decay-365d`.
- **Staleness signal:** `fresh`, `unverified`, `stale`, `broken_ref`.
- **verifies_against.kind:** `file`, `url`, `git_commit`.
- **Rule severity:** `hard`, `soft`.
- **Store outcome (info badges where shown):** `inserted`, `reinforced`, `merged`.
- **Audit events:** `auth.success`, `auth.failure`, `pat.minted`, `pat.revoked`,
  `auth.rate_limited`, `namespace.member_removed`.
- **PAT status (derived):** `active`, `expiring soon`, `revoked`, `expired`.
- **Health:** Qdrant `ok | degraded | down`; breaker `closed | open`.

## 5. Build order for the screens (suggested)
1. App shell + nav + global states.
2. Login / Setup (operator auth — already partly scaffolded).
3. Namespaces (list + detail) and PATs — the onboarding core.
4. Memory browser.
5. Rules + Audit (read).
6. Dashboard + Observability (after the #69 health endpoint lands).
