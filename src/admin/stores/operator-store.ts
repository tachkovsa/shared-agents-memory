import type { Db } from './db.js';
import {
  DuplicateOperatorError,
  type NewOperator,
  type Operator,
  type OperatorRepository,
  type OperatorRole,
} from './types.js';

const INSERT_SQL = `INSERT INTO operators (id, username, password_hash, totp_secret, role, is_disabled, created_at, last_login_at)
   VALUES (@id, @username, @password_hash, @totp_secret, @role, 0, @created_at, NULL)`;

interface OperatorRow {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  role: string;
  is_disabled: number;
  created_at: string;
  last_login_at: string | null;
}

function toOperator(row: OperatorRow): Operator {
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    totp_secret: row.totp_secret,
    role: row.role as OperatorRole,
    is_disabled: row.is_disabled !== 0,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

function insertParams(operator: NewOperator) {
  return {
    id: operator.id,
    username: operator.username,
    password_hash: operator.password_hash,
    totp_secret: operator.totp_secret,
    role: operator.role,
    created_at: operator.created_at,
  };
}

export class SqliteOperatorStore implements OperatorRepository {
  constructor(private readonly db: Db) {}

  async create(operator: NewOperator): Promise<void> {
    try {
      this.db.prepare(INSERT_SQL).run(insertParams(operator));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateOperatorError(operator.username);
      }
      throw err;
    }
  }

  async createFirst(operator: NewOperator): Promise<boolean> {
    const insert = this.db.prepare(INSERT_SQL);
    const countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM operators');
    // Synchronous better-sqlite3 transaction: the count-check and insert run
    // without yielding to other JS, so concurrent setup requests can't race.
    const tx = this.db.transaction((op: NewOperator): boolean => {
      const { n } = countStmt.get() as { n: number };
      if (n > 0) return false;
      insert.run(insertParams(op));
      return true;
    });
    return tx(operator);
  }

  async getById(id: string): Promise<Operator | undefined> {
    const row = this.db
      .prepare('SELECT * FROM operators WHERE id = ?')
      .get(id) as OperatorRow | undefined;
    return row ? toOperator(row) : undefined;
  }

  async getByUsername(username: string): Promise<Operator | undefined> {
    const row = this.db
      .prepare('SELECT * FROM operators WHERE username = ?')
      .get(username) as OperatorRow | undefined;
    return row ? toOperator(row) : undefined;
  }

  async count(): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM operators')
      .get() as { n: number };
    return row.n;
  }

  async recordLogin(id: string, at: string): Promise<void> {
    this.db
      .prepare('UPDATE operators SET last_login_at = ? WHERE id = ?')
      .run(at, id);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
