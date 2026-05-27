# Operator scripts

## migrate-claude-memory

One-shot migration from a Claude Code per-project memory directory
(`~/.claude/projects/<slug>/memory/`) into a shared-agents-memory rules
namespace.

### Prerequisites

- The target namespace must already exist (created by the first-boot bootstrap
  or `namespace.create` tool). The script will error if the namespace is absent.
- `tsx` (bundled as a dev dependency — `npx tsx` or `npm run migrate:claude-memory`).

### Usage

```bash
# Dry-run first — see what would be written without touching any files.
npm run migrate:claude-memory -- \
  --source ~/.claude/projects/-Users-you-myproject/memory \
  --namespace personal \
  --data-dir ./data \
  --dry-run \
  --verbose

# Live run.
npm run migrate:claude-memory -- \
  --source ~/.claude/projects/-Users-you-myproject/memory \
  --namespace personal \
  --data-dir ./data

# Or invoke directly with tsx.
npx tsx scripts/migrate-claude-memory.ts \
  --source ~/.claude/projects/-Users-you-myproject/memory \
  --data-dir ./data
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--source <dir>` | *(required)* | Source Claude Code memory directory |
| `--namespace <id>` | `personal` | Target namespace in the rules store |
| `--data-dir <path>` | `$DATA_DIR` or `./data` | Rules store data directory |
| `--dry-run` | `false` | List what would be written; write nothing |
| `--verbose` | `false` | Log a line per file (created / updated / unchanged) |
| `--help` | — | Print usage |

### Behaviour

- `MEMORY.md` is always skipped (the rules layer regenerates its own index).
- Filename stems are normalized to kebab-case rule IDs: `user_role.md` → id `user-role`.
- Files whose stems cannot become a valid rule ID (too short, all non-alphanumeric) are
  skipped with a warning on stderr; the run continues.
- Frontmatter is parsed best-effort: the `title` field is preferred, then `name`, then
  the filename stem. `tags` and `severity` are carried over if present; otherwise they
  default to `[]` and `hard` respectively.
- The script is **idempotent**: re-running after a successful import is a no-op when
  content is unchanged; files whose content changed on disk will be updated.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (includes dry-run and all-unchanged) |
| `1` | Fatal error (source dir missing, namespace missing, any per-file error) |
