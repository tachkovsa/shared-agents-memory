import type { Db } from './db.js';
import type { OperatorSession, SessionRepository } from './types.js';

export class SqliteSessionStore implements SessionRepository {
  constructor(private readonly db: Db) {}

  async create(session: OperatorSession): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO operator_sessions
           (id, operator_id, created_at, absolute_expires_at, idle_expires_at, last_seen_at, csrf_token, ip, user_agent)
         VALUES
           (@id, @operator_id, @created_at, @absolute_expires_at, @idle_expires_at, @last_seen_at, @csrf_token, @ip, @user_agent)`,
      )
      .run(session);
  }

  async get(id: string): Promise<OperatorSession | undefined> {
    return this.db
      .prepare('SELECT * FROM operator_sessions WHERE id = ?')
      .get(id) as OperatorSession | undefined;
  }

  async touch(id: string, idleExpiresAt: string, lastSeenAt: string): Promise<void> {
    this.db
      .prepare(
        'UPDATE operator_sessions SET idle_expires_at = ?, last_seen_at = ? WHERE id = ?',
      )
      .run(idleExpiresAt, lastSeenAt, id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM operator_sessions WHERE id = ?').run(id);
  }

  async deleteByOperator(operatorId: string): Promise<void> {
    this.db
      .prepare('DELETE FROM operator_sessions WHERE operator_id = ?')
      .run(operatorId);
  }

  async deleteExpired(now: string): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM operator_sessions WHERE absolute_expires_at <= ? OR idle_expires_at <= ?',
      )
      .run(now, now);
  }
}
