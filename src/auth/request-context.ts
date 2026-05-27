import type { AgentScope } from './types.js';

export interface RequestContext {
  agentId: string;
  namespaceId: string;
  scopes: AgentScope[];
  allowedNamespaces: string[];
  patId: string;
  tokenPrefix: string;
}

export interface ServiceRequestContext {
  agentId: string;
  scopes: AgentScope[];
  patId: string;
  tokenPrefix: string;
}

export type AuthFailureReason =
  | 'missing'
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'namespace_forbidden'
  | 'scope_insufficient';

export class AuthError extends Error {
  constructor(
    public readonly reason: AuthFailureReason,
    message: string,
    public readonly tokenPrefix?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
