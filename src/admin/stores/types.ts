/**
 * Operator + session domain types and the repository interfaces that form the
 * SaaS seam (ADR-0009 §3.3). The OSS build binds these to SQLite; the private
 * SaaS layer swaps in a Postgres implementation without touching callers.
 *
 * Interfaces are async on purpose: better-sqlite3 is synchronous, but the
 * Postgres impl will not be, so the contract is the async superset.
 */

export type OperatorRole = 'owner' | 'viewer';

export interface Operator {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  role: OperatorRole;
  is_disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface NewOperator {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  role: OperatorRole;
  created_at: string;
}

export interface OperatorSession {
  id: string;
  operator_id: string;
  created_at: string;
  absolute_expires_at: string;
  idle_expires_at: string;
  last_seen_at: string;
  csrf_token: string;
  ip: string | null;
  user_agent: string | null;
}

export interface OperatorRepository {
  create(operator: NewOperator): Promise<void>;
  getById(id: string): Promise<Operator | undefined>;
  getByUsername(username: string): Promise<Operator | undefined>;
  count(): Promise<number>;
  recordLogin(id: string, at: string): Promise<void>;
}

export interface SessionRepository {
  create(session: OperatorSession): Promise<void>;
  get(id: string): Promise<OperatorSession | undefined>;
  touch(id: string, idleExpiresAt: string, lastSeenAt: string): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByOperator(operatorId: string): Promise<void>;
  deleteExpired(now: string): Promise<void>;
}

export class DuplicateOperatorError extends Error {
  constructor(username: string) {
    super(`operator already exists: ${username}`);
    this.name = 'DuplicateOperatorError';
  }
}
