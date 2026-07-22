/* ArtelMemory console — mock CIS-flavored fixtures (exposed on window.DB) */
(function () {
  const operator = {
    name: "Артём Кадыров",
    email: "artem@artelmemory.dev",
    initials: "АК",
    org: "Artel Memory · CIS",
    plan: "Cloud · 300₽/мес",
    region: "kg-bishkek-1",
  };

  // agents (each holds its own PAT)
  const agents = [
    { id: "claude-code-7f3a", label: "Claude Code", kind: "claude", color: "#C96A4A", status: "active" },
    { id: "codex-ru-22a1",   label: "Codex",       kind: "codex",  color: "#2B7D7A", status: "active" },
    { id: "kimi-1c04",        label: "Kimi",        kind: "kimi",   color: "#5B6CC4", status: "active" },
    { id: "glm-x49b",         label: "GLM",         kind: "glm",    color: "#7A5BC4", status: "idle" },
    { id: "opencaw-9d12",     label: "OpenClaw",    kind: "open",   color: "#C4965B", status: "active" },
    { id: "hermes-bot-04",    label: "Hermes",      kind: "hermes", color: "#3B8FB0", status: "revoked" },
  ];

  // members (humans + agents) for sharing
  const people = [
    { id: "u-artem", name: "Артём Кадыров", email: "artem@artelmemory.dev", role: "owner", initials: "АК", color: "linear-gradient(135deg,#2B7D7A,#C96A4A)", human: true },
    { id: "u-dilnoza", name: "Дилноза Рахимова", email: "dilnoza@artelmemory.dev", role: "admin", initials: "ДР", color: "linear-gradient(135deg,#5B6CC4,#3B8FB0)", human: true },
    { id: "u-timur", name: "Тимур Сапаров", email: "timur@team.kz", role: "member", initials: "ТС", color: "linear-gradient(135deg,#C4965B,#C96A4A)", human: true },
    { id: "u-aida", name: "Аида Бекова", email: "aida@team.kg", role: "viewer", initials: "АБ", color: "linear-gradient(135deg,#7A5BC4,#5B6CC4)", human: true },
  ];

  const namespaces = [
    { id: "team-core",   title: "Team Core",      desc: "Архитектурные решения и общий контекст продукта", members: 4, agents: 5, memories: 2481, shared: true,  visibility: "shared",  updated: "2 мин назад", owner: "u-artem", color: "#2B7D7A" },
    { id: "api-gateway", title: "API Gateway",    desc: "Контракты API, правила валидации, схемы", members: 3, agents: 3, memories: 864, shared: true,  visibility: "shared",  updated: "18 мин назад", owner: "u-artem", color: "#C96A4A" },
    { id: "deploy-kr",   title: "Deploy · KR",    desc: "Развёртывание в KR-регионе, переменные окружения", members: 2, agents: 2, memories: 342, shared: true,  visibility: "shared",  updated: "1 ч назад", owner: "u-dilnoza", color: "#5B6CC4" },
    { id: "docs-ru",     title: "Docs · RU",      desc: "Документация и онбординг на русском", members: 3, agents: 2, memories: 1203, shared: true,  visibility: "shared",  updated: "3 ч назад", owner: "u-artem", color: "#7A5BC4" },
    { id: "mobile-app",  title: "Mobile App",     desc: "Мобильный клиент, релизы и QA", members: 2, agents: 1, memories: 198, shared: false, visibility: "private", updated: "вчера", owner: "u-timur", color: "#3B8FB0" },
    { id: "sandbox",     title: "Sandbox",        desc: "Личные эксперименты и черновики", members: 1, agents: 1, memories: 47, shared: false, visibility: "private", updated: "2 дня назад", owner: "u-artem", color: "#C4965B" },
  ];

  const memories = [
    { id: "mem_a1f9c2", ns: "team-core", content: "Решение: prod работает на PostgreSQL-профиле, миграции через Alembic. SQLite остаётся для лёгкого self-hosted старта.", tags: ["infra", "decision", "db"], agent: "claude-code-7f3a", score: 0.94, status: "fresh", created: "10 июн 2026, 14:32", type: "decision", accesses: 38 },
    { id: "mem_b3e1d7", ns: "team-core", content: "Namespace API: id в kebab-case, owner_agent_id обязателен при создании. Валидация на уровне BFF.", tags: ["api", "rule", "validation"], agent: "kimi-1c04", score: 0.91, status: "fresh", created: "10 июн 2026, 13:08", type: "rule", accesses: 22 },
    { id: "mem_c8a204", ns: "team-core", content: "Qdrant: dedup_threshold 0.92 для коллекции docs-ru. Дубли схлопываются на этапе записи.", tags: ["qdrant", "config"], agent: "codex-ru-22a1", score: 0.79, status: "unverified", created: "10 июн 2026, 11:45", type: "fact", accesses: 9 },
    { id: "mem_d5f730", ns: "deploy-kr", content: "Deploy-скрипт для KR-региона: переменные окружения ARTEL_REGION=kg, LOCAL_ONLY=true, бэкап в bishkek-1.", tags: ["deploy", "kr", "env"], agent: "opencaw-9d12", score: 0.66, status: "stale", created: "8 июн 2026, 09:20", type: "fact", accesses: 14 },
    { id: "mem_e2b918", ns: "api-gateway", content: "Rate limit для PAT: 600 req/min на ключ, burst 50. Превышение → 429 с Retry-After.", tags: ["api", "rate-limit", "pat"], agent: "codex-ru-22a1", score: 0.88, status: "fresh", created: "10 июн 2026, 10:12", type: "rule", accesses: 17 },
    { id: "mem_f7c350", ns: "docs-ru", content: "Онбординг: первый шаг — подключить artel-mcp в конфиг агента, второй — создать namespace проекта.", tags: ["docs", "onboarding"], agent: "kimi-1c04", score: 0.83, status: "fresh", created: "9 июн 2026, 16:50", type: "fact", accesses: 28 },
    { id: "mem_0a4e61", ns: "team-core", content: "Эпизод: обсуждали переход на локальную embedding-модель. Вывод — bge-m3 локально, fallback не нужен.", tags: ["embeddings", "episode"], agent: "claude-code-7f3a", score: 0.72, status: "fresh", created: "9 июн 2026, 15:22", type: "episode", accesses: 11 },
    { id: "mem_19d8f4", ns: "api-gateway", content: "CSRF: все мутации требуют X-CSRF-Token из cookie-сессии. GET — без токена.", tags: ["api", "security", "csrf"], agent: "codex-ru-22a1", score: 0.86, status: "fresh", created: "9 июн 2026, 12:04", type: "rule", accesses: 19 },
    { id: "mem_2c6b80", ns: "docs-ru", content: "Контакт поддержки в Telegram-канале закреплён в README, отвечаем best-effort.", tags: ["docs", "support"], agent: "opencaw-9d12", score: 0.54, status: "stale", created: "6 июн 2026, 18:30", type: "fact", accesses: 6 },
    { id: "mem_3f1a09", ns: "team-core", content: "Решение: episodic-память хранит сжатые summary сессий, а не полный transcript. Экономит storage.", tags: ["memory", "decision", "episode"], agent: "glm-x49b", score: 0.80, status: "unverified", created: "8 июн 2026, 14:10", type: "decision", accesses: 13 },
    { id: "mem_4b7e22", ns: "mobile-app", content: "QA: релиз 2.4 откатили из-за крэша на холодном старте. Фикс в 2.4.1, добавлен smoke-тест.", tags: ["qa", "release", "mobile"], agent: "kimi-1c04", score: 0.61, status: "fresh", created: "7 июн 2026, 11:00", type: "episode", accesses: 8 },
    { id: "mem_5e9c13", ns: "deploy-kr", content: "Бэкап: ежедневный снапшот Qdrant + SQLite в 03:00 по Bishkek, хранение 14 дней.", tags: ["deploy", "backup"], agent: "opencaw-9d12", score: 0.75, status: "fresh", created: "7 июн 2026, 03:00", type: "fact", accesses: 21 },
  ];

  const pats = [
    { id: "pat_7f3a", name: "Claude Code · рабочий", agent: "claude-code-7f3a", prefix: "sam_pat_7f3a", scopes: ["memory:read", "memory:write", "search"], ns: ["team-core", "api-gateway", "docs-ru"], created: "1 июн 2026", lastUsed: "2 мин назад", status: "active", calls: 18420 },
    { id: "pat_22a1", name: "Codex · CI", agent: "codex-ru-22a1", prefix: "sam_pat_22a1", scopes: ["memory:read", "memory:write", "search"], ns: ["api-gateway", "team-core"], created: "1 июн 2026", lastUsed: "18 мин назад", status: "active", calls: 9210 },
    { id: "pat_1c04", name: "Kimi · ассистент", agent: "kimi-1c04", prefix: "sam_pat_1c04", scopes: ["memory:read", "search"], ns: ["team-core", "docs-ru"], created: "3 июн 2026", lastUsed: "1 ч назад", status: "active", calls: 6740 },
    { id: "pat_x49b", name: "GLM · ресёрч", agent: "glm-x49b", prefix: "sam_pat_x49b", scopes: ["memory:read", "search"], ns: ["team-core"], created: "4 июн 2026", lastUsed: "5 ч назад", status: "active", calls: 2130 },
    { id: "pat_9d12", name: "OpenClaw · deploy", agent: "opencaw-9d12", prefix: "sam_pat_9d12", scopes: ["memory:read", "memory:write"], ns: ["deploy-kr"], created: "2 июн 2026", lastUsed: "1 ч назад", status: "active", calls: 4015 },
    { id: "pat_04hr", name: "Hermes · бот (старый)", agent: "hermes-bot-04", prefix: "sam_pat_04hr", scopes: ["memory:read"], ns: ["docs-ru"], created: "28 мая 2026", lastUsed: "3 дня назад", status: "revoked", calls: 880 },
  ];

  const rules = [
    { id: "r1", name: "kebab-case namespace id", scope: "api-gateway", kind: "validation", effect: "deny", desc: "id namespace должен быть в kebab-case; иначе запись отклоняется.", enabled: true, hits: 12 },
    { id: "r2", name: "owner_agent_id обязателен", scope: "team-core", kind: "validation", effect: "deny", desc: "Запись без owner_agent_id не принимается.", enabled: true, hits: 4 },
    { id: "r3", name: "dedup ≥ 0.92", scope: "*", kind: "lifecycle", effect: "merge", desc: "Записи с косинусной близостью ≥ 0.92 объединяются.", enabled: true, hits: 318 },
    { id: "r4", name: "staleness 30 дней", scope: "*", kind: "lifecycle", effect: "flag", desc: "Память без обращений 30 дней помечается stale.", enabled: true, hits: 47 },
    { id: "r5", name: "no-secrets фильтр", scope: "*", kind: "security", effect: "block", desc: "Шаблоны токенов/ключей блокируются при записи.", enabled: true, hits: 9 },
    { id: "r6", name: "viewer — только чтение", scope: "*", kind: "access", effect: "deny", desc: "Роль viewer не может писать в память.", enabled: false, hits: 0 },
  ];

  const audit = [
    { id: "a1", action: "memory.write", actor: "claude-code-7f3a", actorKind: "agent", target: "mem_a1f9c2", ns: "team-core", ts: "10 июн 2026, 14:32:08", ip: "10.0.2.14", result: "ok" },
    { id: "a2", action: "pat.create", actor: "u-artem", actorKind: "human", target: "pat_x49b", ns: "—", ts: "10 июн 2026, 14:20:55", ip: "212.42.x.x", result: "ok" },
    { id: "a3", action: "namespace.share", actor: "u-artem", actorKind: "human", target: "deploy-kr", ns: "deploy-kr", ts: "10 июн 2026, 13:51:02", ip: "212.42.x.x", result: "ok" },
    { id: "a4", action: "memory.search", actor: "kimi-1c04", actorKind: "agent", target: "«как деплоим prod»", ns: "team-core", ts: "10 июн 2026, 13:08:44", ip: "10.0.2.31", result: "ok" },
    { id: "a5", action: "pat.revoke", actor: "u-artem", actorKind: "human", target: "pat_04hr", ns: "—", ts: "10 июн 2026, 12:30:10", ip: "212.42.x.x", result: "ok" },
    { id: "a6", action: "memory.write", actor: "hermes-bot-04", actorKind: "agent", target: "—", ns: "docs-ru", ts: "10 июн 2026, 12:29:50", ip: "10.0.2.9", result: "denied" },
    { id: "a7", action: "memory.delete", actor: "u-dilnoza", actorKind: "human", target: "mem_91xx02", ns: "api-gateway", ts: "10 июн 2026, 11:14:22", ip: "95.56.x.x", result: "ok" },
    { id: "a8", action: "rule.update", actor: "u-artem", actorKind: "human", target: "r4 staleness", ns: "*", ts: "9 июн 2026, 17:40:11", ip: "212.42.x.x", result: "ok" },
    { id: "a9", action: "auth.login", actor: "u-artem", actorKind: "human", target: "console", ns: "—", ts: "9 июн 2026, 09:02:33", ip: "212.42.x.x", result: "ok" },
    { id: "a10", action: "memory.search", actor: "codex-ru-22a1", actorKind: "agent", target: "«csrf токен»", ns: "api-gateway", ts: "9 июн 2026, 12:05:01", ip: "10.0.2.22", result: "ok" },
  ];

  // observability — 14-day series
  const days = ["28","29","30","31","1","2","3","4","5","6","7","8","9","10"];
  const writes = [120,142,98,165,180,150,210,240,198,220,260,245,280,310];
  const searches = [340,380,310,420,460,400,520,610,540,580,640,620,700,760];
  const latency = [44,46,41,52,48,45,50,47,43,49,46,42,40,38];

  window.DB = {
    operator, agents, people, namespaces, memories, pats, rules, audit,
    metrics: { days, writes, searches, latency },
    totals: {
      memories: namespaces.reduce((s,n)=>s+n.memories,0),
      namespaces: namespaces.length,
      activeAgents: agents.filter(a=>a.status!=="revoked").length,
      activePats: pats.filter(p=>p.status==="active").length,
      searches24h: 1842,
      writes24h: 310,
      p50: 38, p95: 96,
      storageUsed: 1.8, storageCap: 50,
    },
    agentById: (id) => agents.find(a => a.id === id) || { id, label: id, color: "#6B7280", kind: "open" },
    nsById: (id) => namespaces.find(n => n.id === id),
    personById: (id) => people.find(p => p.id === id),
  };
})();
