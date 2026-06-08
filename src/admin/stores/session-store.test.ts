import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { SqliteOperatorStore } from './operator-store.js';
import { SqliteSessionStore } from './session-store.js';
import type { OperatorSession } from './types.js';

let db: Db;
let store: SqliteSessionStore;

function session(overrides: Partial<OperatorSession> = {}): OperatorSession {
  return {
    id: 'sess_1',
    operator_id: 'op_1',
    created_at: '2026-06-08T00:00:00.000Z',
    absolute_expires_at: '2026-07-08T00:00:00.000Z',
    idle_expires_at: '2026-06-15T00:00:00.000Z',
    last_seen_at: '2026-06-08T00:00:00.000Z',
    csrf_token: 'csrf-abc',
    ip: '127.0.0.1',
    user_agent: 'vitest',
    ...overrides,
  };
}

beforeEach(async () => {
  db = openDb(':memory:');
  // operator_sessions has a FK to operators(id); seed the parent row.
  await new SqliteOperatorStore(db).create({
    id: 'op_1',
    username: 'admin',
    password_hash: 'scrypt$aa$bb',
    totp_secret: null,
    role: 'owner',
    created_at: '2026-06-08T00:00:00.000Z',
  });
  store = new SqliteSessionStore(db);
});

afterEach(() => {
  db.close();
});

describe('SqliteSessionStore', () => {
  it('creates and reads a session', async () => {
    await store.create(session());
    const read = await store.get('sess_1');
    expect(read?.operator_id).toBe('op_1');
    expect(read?.csrf_token).toBe('csrf-abc');
  });

  it('touches the idle window and last-seen', async () => {
    await store.create(session());
    await store.touch('sess_1', '2026-06-20T00:00:00.000Z', '2026-06-13T00:00:00.000Z');
    const read = await store.get('sess_1');
    expect(read?.idle_expires_at).toBe('2026-06-20T00:00:00.000Z');
    expect(read?.last_seen_at).toBe('2026-06-13T00:00:00.000Z');
  });

  it('deletes a single session', async () => {
    await store.create(session());
    await store.delete('sess_1');
    expect(await store.get('sess_1')).toBeUndefined();
  });

  it('deletes all sessions for an operator', async () => {
    await store.create(session({ id: 'sess_1' }));
    await store.create(session({ id: 'sess_2' }));
    await store.deleteByOperator('op_1');
    expect(await store.get('sess_1')).toBeUndefined();
    expect(await store.get('sess_2')).toBeUndefined();
  });

  it('purges sessions past either expiry bound', async () => {
    await store.create(session({ id: 'live' }));
    await store.create(
      session({ id: 'idle_dead', idle_expires_at: '2026-06-01T00:00:00.000Z' }),
    );
    await store.create(
      session({ id: 'abs_dead', absolute_expires_at: '2026-06-01T00:00:00.000Z' }),
    );
    await store.deleteExpired('2026-06-08T00:00:00.000Z');
    expect(await store.get('live')).toBeDefined();
    expect(await store.get('idle_dead')).toBeUndefined();
    expect(await store.get('abs_dead')).toBeUndefined();
  });
});
