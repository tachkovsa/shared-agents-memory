import {
  DEDUP_DEFAULT_THRESHOLD,
  DEFAULT_DECAY_WEIGHT,
  DEFAULT_HARD_DELETE_GRACE_DAYS,
  DEFAULT_STALENESS_AUDIT_BATCH_SIZE,
} from '../memory/types.js';
import type {
  Namespace,
  NamespaceLifecycleDefaults,
  NamespaceQuota,
  RetentionPolicy,
} from './types.js';

export const DEFAULT_RETENTION: RetentionPolicy = 'keep-forever';

/** Default per-namespace dedup threshold (ADR-0006 §3.2). */
export const DEFAULT_DEDUP_THRESHOLD = DEDUP_DEFAULT_THRESHOLD;

/**
 * ADR-0006 §3.4/§3.6 lifecycle defaults. Applied at namespace creation and used
 * to resolve absent fields on pre-#27 namespace files. Defaults are surprise-free:
 * rank-only decay (no soft-delete), staleness audit on but a no-op without
 * per-memory `verifies_against`.
 */
export const DEFAULT_LIFECYCLE: NamespaceLifecycleDefaults = {
  decay_weight: DEFAULT_DECAY_WEIGHT,
  soft_delete_after_days: null,
  hard_delete_grace_days: DEFAULT_HARD_DELETE_GRACE_DAYS,
  staleness_audit_enabled: true,
  staleness_audit_batch_size: DEFAULT_STALENESS_AUDIT_BATCH_SIZE,
  filesystem_audit_root: null,
};

export const DEFAULT_RULES_INDEX_BODY = `# Rules

This file indexes the rules stored in this namespace.

Each rule lives in its own file under \`rules/\` and is exposed as an MCP resource
under \`mem://<namespace>/rules/<slug>\`. See ADR-0001 for the rule-vs-episodic
split, ADR-0002 §3.6 for the on-disk layout.

No rules yet — add one via the \`rules.upsert\` tool (issue #17 / #18).
`;

/**
 * Resolve a namespace's lifecycle config, filling any absent field from
 * DEFAULT_LIFECYCLE. Pre-#27 namespace files lack these keys entirely; this lets
 * the decay sweep (#27) and staleness audit (#28) treat every namespace uniformly.
 */
export function resolveLifecycle(
  ns: Pick<
    Namespace,
    | 'decay_weight'
    | 'soft_delete_after_days'
    | 'hard_delete_grace_days'
    | 'staleness_audit_enabled'
    | 'staleness_audit_batch_size'
    | 'filesystem_audit_root'
  >,
): NamespaceLifecycleDefaults {
  return {
    decay_weight: ns.decay_weight ?? DEFAULT_LIFECYCLE.decay_weight,
    soft_delete_after_days:
      ns.soft_delete_after_days === undefined
        ? DEFAULT_LIFECYCLE.soft_delete_after_days
        : ns.soft_delete_after_days,
    hard_delete_grace_days:
      ns.hard_delete_grace_days ?? DEFAULT_LIFECYCLE.hard_delete_grace_days,
    staleness_audit_enabled:
      ns.staleness_audit_enabled ?? DEFAULT_LIFECYCLE.staleness_audit_enabled,
    staleness_audit_batch_size:
      ns.staleness_audit_batch_size ?? DEFAULT_LIFECYCLE.staleness_audit_batch_size,
    filesystem_audit_root:
      ns.filesystem_audit_root === undefined
        ? DEFAULT_LIFECYCLE.filesystem_audit_root
        : ns.filesystem_audit_root,
  };
}

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
