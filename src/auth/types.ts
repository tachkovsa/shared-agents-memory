export type AgentScope =
  | 'memory:read'
  | 'memory:write'
  | 'memory:delete'
  | 'rules:read'
  | 'rules:write'
  | 'namespace:admin'
  | 'service:admin';

export const ALL_SCOPES: readonly AgentScope[] = [
  'memory:read',
  'memory:write',
  'memory:delete',
  'rules:read',
  'rules:write',
  'namespace:admin',
  'service:admin',
] as const;

export interface AgentPat {
  id: string;
  display_name: string;
  token_prefix: string;
  token_hash: string;
  agent_identity: string;
  allowed_namespaces: string[];
  scopes: AgentScope[];
  created_at: string;
  created_by: string;
  expires_at: string | null;
  last_used_at: string | null;
  is_revoked: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface PatRecord extends AgentPat {
  _supersedes?: string;
}

export interface MintInput {
  display_name: string;
  agent_identity: string;
  allowed_namespaces: string[];
  scopes: AgentScope[];
  created_by: string;
  expires_at?: string | null;
}

export interface MintResult {
  pat: AgentPat;
  secret: string;
}

export type LookupResult =
  | { ok: true; pat: AgentPat }
  | { ok: false; reason: LookupFailureReason; token_prefix?: string };

export type LookupFailureReason =
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired';
