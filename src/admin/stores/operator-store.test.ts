import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { SqliteOperatorStore } from './operator-store.js';
import { DuplicateOperatorError, type NewOperator } from './types.js';

let db: Db;
let store: SqliteOperatorStore;

function newOperator(overrides: Partial<NewOperator> = {}): NewOperator {
  return {
    id: 'op_1',
    username: 'admin',
    password_hash: 'scrypt$aa$bb',
    totp_secret: null,
    role: 'owner',
    created_at: '2026-06-08T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  store = new SqliteOperatorStore(db);
});

afterEach(() => {
  db.close();
});

describe('SqliteOperatorStore', () => {
  it('creates and reads back an operator', async () => {
    await store.create(newOperator());
    const byId = await store.getById('op_1');
    const byName = await store.getByUsername('admin');
    expect(byId?.username).toBe('admin');
    expect(byId?.role).toBe('owner');
    expect(byId?.is_disabled).toBe(false);
    expect(byName?.id).toBe('op_1');
  });

  it('counts operators', async () => {
    expect(await store.count()).toBe(0);
    await store.create(newOperator());
    expect(await store.count()).toBe(1);
  });

  it('rejects a duplicate username', async () => {
    await store.create(newOperator());
    await expect(
      store.create(newOperator({ id: 'op_2' })),
    ).rejects.toBeInstanceOf(DuplicateOperatorError);
  });

  it('records the last login timestamp', async () => {
    await store.create(newOperator());
    await store.recordLogin('op_1', '2026-06-08T09:00:00.000Z');
    const op = await store.getById('op_1');
    expect(op?.last_login_at).toBe('2026-06-08T09:00:00.000Z');
  });

  it('returns undefined for unknown ids', async () => {
    expect(await store.getById('nope')).toBeUndefined();
    expect(await store.getByUsername('nope')).toBeUndefined();
  });

  it('createFirst inserts only when the table is empty', async () => {
    expect(await store.createFirst(newOperator())).toBe(true);
    expect(
      await store.createFirst(newOperator({ id: 'op_2', username: 'second' })),
    ).toBe(false);
    expect(await store.count()).toBe(1);
    expect(await store.getByUsername('admin')).toBeDefined();
    expect(await store.getByUsername('second')).toBeUndefined();
  });
});
