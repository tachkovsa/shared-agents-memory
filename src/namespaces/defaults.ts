import { DEDUP_DEFAULT_THRESHOLD } from '../memory/types.js';
import type { NamespaceQuota, RetentionPolicy } from './types.js';

export const DEFAULT_RETENTION: RetentionPolicy = 'keep-forever';

/** Default per-namespace dedup threshold (ADR-0006 §3.2). */
export const DEFAULT_DEDUP_THRESHOLD = DEDUP_DEFAULT_THRESHOLD;

export const DEFAULT_RULES_INDEX_BODY = `# Rules

This file indexes the rules stored in this namespace.

Each rule lives in its own file under \`rules/\` and is exposed as an MCP resource
under \`mem://<namespace>/rules/<slug>\`. See ADR-0001 for the rule-vs-episodic
split, ADR-0002 §3.6 for the on-disk layout.

No rules yet — add one via the \`rules.upsert\` tool (issue #17 / #18).
`;

export function getDefaultQuota(env: NodeJS.ProcessEnv = process.env): NamespaceQuota {
  return {
    daily_embedding_tokens: parsePositiveInt(
      env['DEFAULT_NS_DAILY_EMBEDDING_TOKENS'],
      1_000_000,
    ),
    daily_writes: parsePositiveInt(env['DEFAULT_NS_DAILY_WRITES'], 5_000),
    daily_searches: parsePositiveInt(env['DEFAULT_NS_DAILY_SEARCHES'], 20_000),
    max_memories: parsePositiveInt(env['DEFAULT_NS_MAX_MEMORIES'], 100_000),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid positive integer: "${value}" — expected a positive integer.`,
    );
  }
  return n;
}
