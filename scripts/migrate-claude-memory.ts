/**
 * scripts/migrate-claude-memory.ts
 *
 * One-shot operator CLI: seeds rules in a shared-agents-memory namespace from
 * an existing Claude Code memory directory (~/.claude/projects/<slug>/memory/).
 *
 * Usage:
 *   npx tsx scripts/migrate-claude-memory.ts \
 *     --source ~/.claude/projects/<slug>/memory \
 *     [--namespace personal] \
 *     [--data-dir ./data] \
 *     [--dry-run] \
 *     [--verbose]
 *
 * Exit codes:
 *   0 — success (including dry-run and all-unchanged)
 *   1 — fatal error (source dir missing, namespace missing, partial failure)
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import yaml from 'yaml';
import { loadNamespace } from '../src/namespaces/store.js';
import { loadRule, upsertRule } from '../src/rules/store.js';
import { RULE_ID_REGEX } from '../src/rules/types.js';

// ---------------------------------------------------------------------------
// Named error class (follows AuthError pattern from src/auth/request-context.ts)
// ---------------------------------------------------------------------------

export class MigrationError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationSummary {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: { file: string; message: string }[];
}

export interface MigrationOptions {
  sourceDir: string;
  namespaceId: string;
  dataDir: string;
  dryRun: boolean;
  verbose: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INDEX_FILE = 'MEMORY.md';
const CREATED_BY = 'migrate-claude-memory';

/**
 * Convert a filename stem to a valid rule ID.
 *
 * Rules:
 *   1. Lowercase everything.
 *   2. Replace underscores with hyphens (Claude Code uses snake_case filenames).
 *   3. Strip any characters that are not [a-z0-9-].
 *   4. Collapse consecutive hyphens into one.
 *   5. Trim leading/trailing hyphens.
 *
 * Returns null if the result still does not satisfy RULE_ID_REGEX (< 3 chars
 * or the regex otherwise rejects it), so the caller can skip the file.
 */
export function stemToRuleId(stem: string): string | null {
  const id = stem
    .toLowerCase()
    // Underscores and spaces and dots → hyphens (common filename separators).
    .replace(/[_\s.]+/g, '-')
    // Strip anything else that is not [a-z0-9-].
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return RULE_ID_REGEX.test(id) ? id : null;
}

/**
 * Infer a human-readable title from a filename stem.
 * "user_role" → "user role", "no-bot-comments" → "no bot comments"
 */
export function stemToTitle(stem: string): string {
  return stem.replace(/[_-]+/g, ' ').trim();
}

interface RawFrontmatter {
  title?: string;
  name?: string;
  tags?: string[];
  severity?: 'hard' | 'soft';
  [key: string]: unknown;
}

/**
 * Parse a source markdown file. Handles two cases:
 *   - Files with a `---` frontmatter block (e.g. Claude Code memory files with
 *     `name:`, `description:`, `metadata:` fields).
 *   - Plain markdown files with no frontmatter at all.
 *
 * Returns { frontmatter, body }. Frontmatter fields are best-effort; missing
 * required fields will be inferred downstream.
 */
export function parseSourceFile(raw: string): {
  frontmatter: RawFrontmatter;
  body: string;
} {
  const DELIM = '---';
  if (!raw.startsWith(`${DELIM}\n`)) {
    // No frontmatter — the whole content is the body.
    return { frontmatter: {}, body: raw };
  }

  const rest = raw.slice(DELIM.length + 1);
  const closingIdx = rest.indexOf(`\n${DELIM}`);
  if (closingIdx === -1) {
    // Malformed frontmatter — treat whole content as body.
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = rest.slice(0, closingIdx);
  // closingIdx points to the '\n' before '---'. Layout: ...\n---\n<body>
  // So body starts at: closingIdx + 1 ('\n') + DELIM.length ('---') + 1 ('\n')
  const body = rest.slice(closingIdx + 1 + DELIM.length).replace(/^\n/, '');

  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlBlock);
  } catch {
    // Unparseable YAML — ignore frontmatter, use full content as body.
    return { frontmatter: {}, body: raw };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { frontmatter: {}, body: raw };
  }

  return { frontmatter: parsed as RawFrontmatter, body };
}

/**
 * Check whether two rule snapshots are semantically identical so we can
 * skip writes on re-runs (idempotency).
 */
function isSameContent(
  existing: { title: string; body: string; tags: string[]; severity: 'hard' | 'soft' },
  incoming: { title: string; body: string; tags: string[]; severity: 'hard' | 'soft' },
): boolean {
  const normBody = (s: string) => s.trimEnd();
  return (
    existing.title === incoming.title &&
    normBody(existing.body) === normBody(incoming.body) &&
    existing.severity === incoming.severity &&
    existing.tags.length === incoming.tags.length &&
    existing.tags.every((t, i) => t === incoming.tags[i])
  );
}

// ---------------------------------------------------------------------------
// Core migration logic (exported so tests can call it directly)
// ---------------------------------------------------------------------------

export async function migrate(opts: MigrationOptions): Promise<MigrationSummary> {
  const { sourceDir, namespaceId, dataDir, dryRun, verbose } = opts;

  const log = (msg: string) => process.stdout.write(`${msg}\n`);
  const warn = (msg: string) => process.stderr.write(`${msg}\n`);

  // 1. Verify source directory exists.
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch (err) {
    throw new MigrationError(
      `Source directory not found or not readable: ${sourceDir}`,
      err,
    );
  }

  // 2. Verify target namespace exists (do NOT create it).
  const ns = await loadNamespace(dataDir, namespaceId);
  if (!ns) {
    throw new MigrationError(
      `Namespace "${namespaceId}" does not exist in data dir "${dataDir}". ` +
        `Run the bootstrap process first to create the namespace, then re-run this script.`,
    );
  }

  const summary: MigrationSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
  };

  // 3. Process each .md file.
  const mdFiles = entries.filter(
    (e) => e.endsWith('.md') && e !== INDEX_FILE,
  );

  for (const filename of mdFiles) {
    const filePath = join(sourceDir, filename);
    const stem = basename(filename, '.md');

    // Derive rule ID from filename stem.
    const ruleId = stemToRuleId(stem);
    if (!ruleId) {
      warn(
        `[skip] ${filename}: cannot derive a valid rule ID from stem "${stem}" — skipping.`,
      );
      summary.skipped++;
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`[error] ${filename}: ${message}`);
      summary.errors.push({ file: filename, message });
      continue;
    }

    const { frontmatter, body } = parseSourceFile(raw);

    // Infer fields from frontmatter or filename.
    const title: string =
      typeof frontmatter.title === 'string' && frontmatter.title.trim()
        ? frontmatter.title.trim()
        : typeof frontmatter.name === 'string' && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : stemToTitle(stem);

    const tags: string[] =
      Array.isArray(frontmatter.tags) &&
      frontmatter.tags.every((t) => typeof t === 'string')
        ? (frontmatter.tags as string[])
        : [];

    const severity: 'hard' | 'soft' =
      frontmatter.severity === 'soft' ? 'soft' : 'hard';

    const incoming = { title, body, tags, severity };

    // Idempotency check — load existing rule if it exists.
    let existingRule;
    try {
      existingRule = await loadRule(dataDir, namespaceId, ruleId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`[error] ${filename}: failed to load existing rule "${ruleId}": ${message}`);
      summary.errors.push({ file: filename, message });
      continue;
    }

    if (existingRule) {
      const existing = {
        title: existingRule.frontmatter.title,
        body: existingRule.body,
        tags: existingRule.frontmatter.tags,
        severity: existingRule.frontmatter.severity,
      };

      if (isSameContent(existing, incoming)) {
        if (verbose) log(`[unchanged] ${filename} → ${ruleId}`);
        summary.unchanged++;
        continue;
      }

      // Content differs — update.
      if (dryRun) {
        log(`[dry-run] would update: ${filename} → ${namespaceId}/${ruleId}`);
        summary.updated++;
        continue;
      }

      try {
        await upsertRule(dataDir, namespaceId, {
          ruleId,
          title,
          body,
          tags,
          severity,
          createdBy: CREATED_BY,
        });
        if (verbose) log(`[updated] ${filename} → ${ruleId}`);
        summary.updated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warn(`[error] ${filename}: upsert failed: ${message}`);
        summary.errors.push({ file: filename, message });
      }

      continue;
    }

    // Rule does not exist — create.
    if (dryRun) {
      log(`[dry-run] would create: ${filename} → ${namespaceId}/${ruleId}`);
      summary.created++;
      continue;
    }

    try {
      await upsertRule(dataDir, namespaceId, {
        ruleId,
        title,
        body,
        tags,
        severity,
        createdBy: CREATED_BY,
      });
      if (verbose) log(`[created] ${filename} → ${ruleId}`);
      summary.created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`[error] ${filename}: upsert failed: ${message}`);
      summary.errors.push({ file: filename, message });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let values: {
    source: string | undefined;
    namespace: string | undefined;
    'data-dir': string | undefined;
    'dry-run': boolean;
    verbose: boolean;
    help: boolean;
  };

  try {
    const result = parseArgs({
      args: process.argv.slice(2),
      options: {
        source: { type: 'string' },
        namespace: { type: 'string' },
        'data-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
    values = result.values as typeof values;
  } catch (err) {
    process.stderr.write(
      `Error parsing arguments: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  if (values.help) {
    process.stdout.write(
      [
        'Usage: tsx scripts/migrate-claude-memory.ts \\',
        '  --source <dir>        Source Claude Code memory directory (required)',
        '  [--namespace <id>]    Target namespace (default: personal)',
        '  [--data-dir <path>]   Rules store data directory (default: $DATA_DIR or ./data)',
        '  [--dry-run]           List changes without writing',
        '  [--verbose]           Log per-file decisions',
        '  [--help]              Show this help',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  if (!values.source) {
    process.stderr.write('Error: --source <dir> is required.\n');
    process.exit(1);
  }

  const opts: MigrationOptions = {
    sourceDir: values.source,
    namespaceId: values.namespace ?? 'personal',
    dataDir: values['data-dir'] ?? process.env['DATA_DIR'] ?? './data',
    dryRun: values['dry-run'],
    verbose: values.verbose,
  };

  if (opts.dryRun) {
    process.stdout.write(`[dry-run] No files will be written.\n`);
  }

  let summary: MigrationSummary;
  try {
    summary = await migrate(opts);
  } catch (err) {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Print summary.
  process.stdout.write(
    [
      '',
      'Migration summary:',
      `  created:   ${summary.created}`,
      `  updated:   ${summary.updated}`,
      `  unchanged: ${summary.unchanged}`,
      `  skipped:   ${summary.skipped}`,
      `  errors:    ${summary.errors.length}`,
      '',
    ].join('\n'),
  );

  if (summary.errors.length > 0) {
    process.stderr.write('Errors:\n');
    for (const e of summary.errors) {
      process.stderr.write(`  ${e.file}: ${e.message}\n`);
    }
    process.exit(1);
  }
}

// Only run main() when executed directly, not when imported by tests.
// We detect this by checking if the module is the entry point via import.meta.url.
const isMain = process.argv[1]
  ? import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    import.meta.url.endsWith(
      encodeURIComponent(process.argv[1]).replace(/%2F/g, '/'),
    ) ||
    process.argv[1].endsWith('migrate-claude-memory.ts') ||
    process.argv[1].endsWith('migrate-claude-memory.js')
  : false;

if (isMain) {
  await main();
}
