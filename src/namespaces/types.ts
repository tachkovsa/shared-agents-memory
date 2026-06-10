import type { AgentScope } from '../auth/types.js';

export type RetentionPolicy =
  | 'keep-forever'
  | 'decay-90d'
  | 'decay-180d'
  | 'decay-365d';

export type NamespaceVisibility = 'private';

/**
 * Fully-resolved lifecycle config (ADR-0006 §3.4/§3.6) — the same fields as the
 * optional ones on `Namespace`, but all present. Produced by `resolveLifecycle`
 * so callers (decay sweep, staleness audit) never branch on absence.
 */
export interface NamespaceLifecycleDefaults {
  decay_weight: number;
  soft_delete_after_days: number | null;
  hard_delete_grace_days: number;
  staleness_audit_enabled: boolean;
  staleness_audit_batch_size: number;
  filesystem_audit_root: string | null;
}

export interface NamespaceQuota {
  daily_embedding_tokens: number;
  daily_writes: number;
  daily_searches: number;
  max_memories: number;
}

export interface Namespace {
  id: string;
  display_name: string;
  owner_agent_id: string;
  visibility: NamespaceVisibility;
  retention_policy: RetentionPolicy;
  /**
   * Semantic dedup threshold for memory.store (ADR-0006 §3.2). Range [0.85, 0.99];
   * 1.0 disables dedup. Optional for forward-compat with pre-#26 namespace files —
   * absence resolves to DEFAULT_DEDUP_THRESHOLD.
   */
  dedup_threshold?: number;
  /**
   * ADR-0006 §3.4/§3.6 lifecycle policy. All optional for forward-compat with
   * pre-#27 namespace files — absence resolves to the defaults in defaults.ts.
   * The payload/config shape is locked by #27 so #28 (staleness) reshapes only
   * behaviour.
   */
  /** Blend between raw cosine and decay-adjusted score at search re-rank, [0,1]. */
  decay_weight?: number;
  /**
   * Days untouched after which an unretrieved point is soft-deleted (§3.4).
   * null/absent → rank-only decay, never delete. Only meaningful when
   * `retention_policy` is a decaying policy.
   */
  soft_delete_after_days?: number | null;
  /** Days a soft-deleted point is kept before physical removal (§3.4). */
  hard_delete_grace_days?: number;
  /** Whether the nightly staleness audit (#28) sweeps this namespace (§3.6). */
  staleness_audit_enabled?: boolean;
  /** Max points the staleness audit checks per sweep (§3.6). */
  staleness_audit_batch_size?: number;
  /** Operator-mounted read-only repo root for `verifies_against.kind=file` audits (§3.6). */
  filesystem_audit_root?: string | null;
  quota: NamespaceQuota;
  created_at: string;
  updated_at: string;
}

export interface NamespaceMember {
  agent_id: string;
  scopes: AgentScope[];
  added_by: string;
  added_at: string;
}

export interface NamespaceMembers {
  members: NamespaceMember[];
}

export const BOOTSTRAP_NAMESPACE_ID = 'personal';
export const BOOTSTRAP_NAMESPACE_DISPLAY_NAME = 'Personal';
