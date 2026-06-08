import type { OperatorRole } from '../stores/types.js';

/**
 * The authenticated console principal. Deliberately disjoint from agent PATs
 * (ADR-0007 §2) — an operator session is never an agent credential.
 */
export interface Principal {
  operatorId: string;
  role: OperatorRole;
  sessionId: string;
  csrfToken: string;
}

/**
 * Resolves a session cookie token to a Principal. The auth-provider seam
 * (ADR-0009 §3.3): OSS binds this to local operator sessions; the SaaS layer
 * can supply an SSO/org-scoped implementation without touching routes.
 */
export interface AuthProvider {
  resolveSession(token: string): Promise<Principal | null>;
}
