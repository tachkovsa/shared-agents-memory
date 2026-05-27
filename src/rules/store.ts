import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { namespaceDir } from '../namespaces/store.js';
import {
  FrontmatterParseError,
  parseRuleFile,
  serializeRuleFile,
} from './frontmatter.js';
import {
  RULE_ID_REGEX,
  type Rule,
  type RuleSummary,
  ruleFrontmatterSchema,
  ruleToSummary,
} from './types.js';

const INDEX_FILE = 'INDEX.md';
const INDEX_HEADER = '# Rules index\n\nAuto-generated — do not edit by hand.\n\n';

export class RuleNotFoundError extends Error {
  constructor(namespaceId: string, ruleId: string) {
    super(`Rule "${ruleId}" not found in namespace "${namespaceId}"`);
    this.name = 'RuleNotFoundError';
  }
}

export class InvalidRuleIdError extends Error {
  constructor(ruleId: string) {
    super(`Invalid rule id "${ruleId}" — must match ${RULE_ID_REGEX.source}`);
    this.name = 'InvalidRuleIdError';
  }
}

function rulesDir(dataDir: string, namespaceId: string): string {
  return join(namespaceDir(dataDir, namespaceId), 'rules');
}

function ruleFile(dataDir: string, namespaceId: string, ruleId: string): string {
  return join(rulesDir(dataDir, namespaceId), `${ruleId}.md`);
}

function assertValidRuleId(ruleId: string): void {
  if (!RULE_ID_REGEX.test(ruleId)) throw new InvalidRuleIdError(ruleId);
}

// Per-namespace write lock — sequences upsert/delete on the same namespace.
const namespaceLocks = new Map<string, Promise<void>>();

async function withNamespaceLock<T>(
  namespaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = namespaceLocks.get(namespaceId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => next);
  namespaceLocks.set(namespaceId, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (namespaceLocks.get(namespaceId) === chained) {
      namespaceLocks.delete(namespaceId);
    }
  }
}

export async function loadRule(
  dataDir: string,
  namespaceId: string,
  ruleId: string,
): Promise<Rule | null> {
  assertValidRuleId(ruleId);
  let raw: string;
  try {
    raw = await readFile(ruleFile(dataDir, namespaceId, ruleId), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return parseRuleFile(raw);
}

export async function listRules(
  dataDir: string,
  namespaceId: string,
): Promise<RuleSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(rulesDir(dataDir, namespaceId));
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const summaries: RuleSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry === INDEX_FILE) continue;
    const ruleId = entry.slice(0, -'.md'.length);
    if (!RULE_ID_REGEX.test(ruleId)) continue;
    try {
      const rule = await loadRule(dataDir, namespaceId, ruleId);
      if (rule) summaries.push(ruleToSummary(rule));
    } catch (err) {
      if (err instanceof FrontmatterParseError) continue;
      throw err;
    }
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return summaries;
}

export interface UpsertRuleInput {
  ruleId: string;
  title: string;
  body: string;
  tags?: string[];
  applies_to?: string[];
  severity?: 'hard' | 'soft';
  createdBy: string;
  now?: () => Date;
}

export async function upsertRule(
  dataDir: string,
  namespaceId: string,
  input: UpsertRuleInput,
): Promise<Rule> {
  assertValidRuleId(input.ruleId);
  return withNamespaceLock(namespaceId, async () => {
    const dir = rulesDir(dataDir, namespaceId);
    await mkdir(dir, { recursive: true });

    const now = (input.now ?? (() => new Date()))().toISOString();
    const existing = await loadRule(dataDir, namespaceId, input.ruleId);
    const createdAt = existing?.frontmatter.created_at ?? now;
    const candidate = {
      id: input.ruleId,
      title: input.title,
      tags: input.tags ?? existing?.frontmatter.tags ?? [],
      applies_to: input.applies_to ?? existing?.frontmatter.applies_to ?? [],
      severity:
        input.severity ?? existing?.frontmatter.severity ?? 'hard',
      created_at: createdAt,
      updated_at: now,
      created_by: existing?.frontmatter.created_by ?? input.createdBy,
    };
    const frontmatter = ruleFrontmatterSchema.parse(candidate);

    const rule: Rule = { frontmatter, body: input.body };
    const serialized = serializeRuleFile(rule);

    const finalPath = ruleFile(dataDir, namespaceId, input.ruleId);
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    const fh = await open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(serialized);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, finalPath);
    await regenerateIndexLocked(dataDir, namespaceId);
    return rule;
  });
}

export async function deleteRule(
  dataDir: string,
  namespaceId: string,
  ruleId: string,
): Promise<void> {
  assertValidRuleId(ruleId);
  await withNamespaceLock(namespaceId, async () => {
    try {
      await unlink(ruleFile(dataDir, namespaceId, ruleId));
    } catch (err) {
      if (isEnoent(err)) throw new RuleNotFoundError(namespaceId, ruleId);
      throw err;
    }
    await regenerateIndexLocked(dataDir, namespaceId);
  });
}

export async function regenerateIndex(
  dataDir: string,
  namespaceId: string,
): Promise<void> {
  await withNamespaceLock(namespaceId, () =>
    regenerateIndexLocked(dataDir, namespaceId),
  );
}

async function regenerateIndexLocked(
  dataDir: string,
  namespaceId: string,
): Promise<void> {
  const dir = rulesDir(dataDir, namespaceId);
  await mkdir(dir, { recursive: true });
  const summaries = await listRules(dataDir, namespaceId);
  const body = summaries
    .map(
      (s) =>
        `- [${s.title}](${s.id}.md) — severity:${s.severity}${
          s.tags.length > 0 ? ` tags:${s.tags.join(',')}` : ''
        }`,
    )
    .join('\n');
  const content = `${INDEX_HEADER}${body}${body.length > 0 ? '\n' : ''}`;
  await writeFile(join(dir, INDEX_FILE), content, { mode: 0o600 });
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
