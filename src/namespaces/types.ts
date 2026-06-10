import type { AgentScope } from '../auth/types.js';

export type RetentionPolicy =
  | 'keep-forever'
  | 'decay-90d'
  | 'decay-180d'
  | 'decay-365d';

export type NamespaceVisibility = 'private';

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
