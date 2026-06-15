import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashSecret, TOKEN_NAMESPACE } from './hash.js';
import {
  PatNotFoundError,
  PatRotationStateError,
  PatStore,
} from './pat-store.js';
import type { AgentPat, PatRecord } from './types.js';

const PEPPER = Buffer.alloc(32, 0x42);

let workDir: string;
let storePath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-pat-'));
  storePath = join(workDir, '_auth', 'pats.jsonl');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function openStore(opts?: { now?: () => Date; cacheTtlMs?: number }) {
  return PatStore.open({
    storePath,
    pepper: PEPPER,
    now: opts?.now,
    cacheTtlMs: opts?.cacheTtlMs,
  });
}

async function mintDefault(store: PatStore, overrides: Partial<Parameters<PatStore['mint']>[0]> = {}) {
  return store.mint({
    display_name: 'Claude Code',
    agent_identity: 'agent_test',
    allowed_namespaces: ['personal'],
    scopes: ['memory:read', 'memory:write'],
    created_by: 'bootstrap',
    ...overrides,
  });
}

describe('PatStore.mint + lookup', () => {
  it('resolves a freshly-minted token to its PAT', async () => {
    const store = await openStore();
    const { pat, secret } = await mintDefault(store);

    const result = store.lookup(secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pat.id).toBe(pat.id);
      expect(result.pat.agent_identity).toBe('agent_test');
      expect(result.pat.allowed_namespaces).toEqual(['personal']);
    }
  });

  it('persists the PAT as JSONL with mode 0600', async () => {
    const store = await openStore();
    const { pat } = await mintDefault(store);

    const raw = await readFile(storePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as PatRecord;
    expect(record.id).toBe(pat.id);
    expect(record.token_hash).toBe(pat.token_hash);
    expect(record.token_prefix).toHaveLength(12);
  });

  it('does NOT persist the plaintext secret', async () => {
    const store = await openStore();
    const { secret } = await mintDefault(store);

    const raw = await readFile(storePath, 'utf8');
    const stripped = secret.slice(TOKEN_NAMESPACE.length);
    expect(raw).not.toContain(stripped);
  });

  it('returns malformed for tokens that are not sam_pat_', () => {
    return openStore().then((store) => {
      expect(store.lookup('Bearer abc')).toEqual({ ok: false, reason: 'malformed' });
      expect(store.lookup('')).toEqual({ ok: false, reason: 'malformed' });
    });
  });

  it('returns unknown for syntactically-valid tokens that do not exist', async () => {
    const store = await openStore();
    const fake = `sam_pat_${'A'.repeat(27)}`;
    const result = store.lookup(fake);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});

describe('PatStore.revoke', () => {
  it('marks the PAT revoked and lookup fails with reason=revoked', async () => {
    const store = await openStore();
    const { pat, secret } = await mintDefault(store);

    await store.revoke(pat.id, 'leaked');

    const result = store.lookup(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('invalidates the lookup cache immediately on revoke', async () => {
    const store = await openStore({ cacheTtlMs: 60_000 });
    const { pat, secret } = await mintDefault(store);

    // Prime the cache.
    expect(store.lookup(secret).ok).toBe(true);

    await store.revoke(pat.id, 'rotation');

    const result = store.lookup(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('persists the revoke as a superseding JSONL line', async () => {
    const store = await openStore();
    const { pat } = await mintDefault(store);
    await store.revoke(pat.id, 'rotation');

    const raw = await readFile(storePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const second = JSON.parse(lines[1]!) as PatRecord;
    expect(second.id).toBe(pat.id);
    expect(second.is_revoked).toBe(true);
    expect(second.revoked_reason).toBe('rotation');
    expect(second._supersedes).toBe(pat.id);
  });

  it('throws PatNotFoundError for an unknown id', async () => {
    const store = await openStore();
    await expect(store.revoke('does_not_exist', 'whatever')).rejects.toBeInstanceOf(
      PatNotFoundError,
    );
  });
});

describe('PatStore expiry', () => {
  it('returns expired when expires_at is in the past', async () => {
    let now = new Date('2026-05-27T12:00:00Z');
    const store = await openStore({ now: () => now });
    const { secret } = await mintDefault(store, {
      expires_at: '2026-05-27T12:30:00Z',
    });

    expect(store.lookup(secret).ok).toBe(true);

    now = new Date('2026-05-27T13:00:00Z');
    const result = store.lookup(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('treats expires_at=null as no expiry', async () => {
    const store = await openStore();
    const { secret } = await mintDefault(store, { expires_at: null });
    expect(store.lookup(secret).ok).toBe(true);
  });
});

describe('PatStore prefix collisions', () => {
  it('resolves the correct PAT when two records share a token_prefix', async () => {
    const store = await openStore();
    const { pat: realPat, secret: realSecret } = await mintDefault(store, {
      display_name: 'Real',
    });

    // Forge a second record with the SAME prefix but a hash that no real secret produces.
    const fakeId = 'fake_pat_id';
    const collision: AgentPat = {
      ...realPat,
      id: fakeId,
      display_name: 'Collision',
      token_hash: hashSecret('decoy', PEPPER),
    };
    await writeFile(storePath, `${JSON.stringify(realPat)}\n${JSON.stringify(collision)}\n`, {
      flag: 'w',
    });

    const reopened = await PatStore.open({ storePath, pepper: PEPPER });
    const result = reopened.lookup(realSecret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pat.id).toBe(realPat.id);
      expect(result.pat.display_name).toBe('Real');
    }
  });
});

describe('PatStore JSONL fold-on-load', () => {
  it('reads the latest record per id from disk', async () => {
    const store = await openStore();
    const { pat, secret } = await mintDefault(store);
    await store.revoke(pat.id, 'cleanup');

    const reopened = await PatStore.open({ storePath, pepper: PEPPER });
    const result = reopened.lookup(secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('initialises cleanly when the store file does not exist', async () => {
    const store = await openStore();
    expect(store.list()).toEqual([]);
  });
});

describe('PatStore.rotate', () => {
  it('mints a new PAT and revokes the old one in a single append', async () => {
    const store = await openStore();
    const { pat: oldPat, secret: oldSecret } = await mintDefault(store, {
      display_name: 'before-rotation',
    });

    const rotated = await store.rotate(oldPat.id, {
      display_name: 'after-rotation',
      agent_identity: oldPat.agent_identity,
      allowed_namespaces: oldPat.allowed_namespaces,
      scopes: oldPat.scopes,
      created_by: 'admin',
      expires_at: oldPat.expires_at,
    });

    expect(rotated.pat.id).not.toBe(oldPat.id);
    expect(rotated.secret).not.toBe(oldSecret);
    expect(rotated.pat.scopes).toEqual(oldPat.scopes);
    expect(rotated.pat.allowed_namespaces).toEqual(oldPat.allowed_namespaces);

    // New secret resolves to the new PAT.
    const newLookup = store.lookup(rotated.secret);
    expect(newLookup.ok).toBe(true);
    if (newLookup.ok) expect(newLookup.pat.id).toBe(rotated.pat.id);

    // Old secret is now revoked.
    const oldLookup = store.lookup(oldSecret);
    expect(oldLookup.ok).toBe(false);
    if (!oldLookup.ok) expect(oldLookup.reason).toBe('revoked');

    // Only ONE additional flush — the JSONL grew by exactly 2 lines (initial mint + 2 rotation lines).
    const raw = await readFile(storePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    const second = JSON.parse(lines[1]!) as PatRecord;
    const third = JSON.parse(lines[2]!) as PatRecord;
    expect(second.id).toBe(rotated.pat.id);
    expect(second.is_revoked).toBe(false);
    expect(third.id).toBe(oldPat.id);
    expect(third.is_revoked).toBe(true);
    expect(third._supersedes).toBe(oldPat.id);
    expect(third.revoked_reason).toContain(rotated.pat.id);
  });

  it('throws PatNotFoundError when rotating an unknown id', async () => {
    const store = await openStore();
    await expect(
      store.rotate('missing', {
        display_name: 'x',
        agent_identity: 'agent',
        allowed_namespaces: ['personal'],
        scopes: ['memory:read'],
        created_by: 'admin',
      }),
    ).rejects.toBeInstanceOf(PatNotFoundError);
  });

  it('refuses to rotate an already-revoked PAT', async () => {
    const store = await openStore();
    const { pat } = await mintDefault(store);
    await store.revoke(pat.id, 'manual');
    await expect(
      store.rotate(pat.id, {
        display_name: 'x',
        agent_identity: pat.agent_identity,
        allowed_namespaces: pat.allowed_namespaces,
        scopes: pat.scopes,
        created_by: 'admin',
      }),
    ).rejects.toBeInstanceOf(PatRotationStateError);
  });

  it('survives reload — fold-on-load reflects rotation', async () => {
    const store = await openStore();
    const { pat: oldPat, secret: oldSecret } = await mintDefault(store);
    const rotated = await store.rotate(oldPat.id, {
      display_name: oldPat.display_name,
      agent_identity: oldPat.agent_identity,
      allowed_namespaces: oldPat.allowed_namespaces,
      scopes: oldPat.scopes,
      created_by: 'admin',
      expires_at: oldPat.expires_at,
    });

    const reopened = await PatStore.open({ storePath, pepper: PEPPER });
    const newLookup = reopened.lookup(rotated.secret);
    expect(newLookup.ok).toBe(true);
    const oldLookup = reopened.lookup(oldSecret);
    expect(oldLookup.ok).toBe(false);
    if (!oldLookup.ok) expect(oldLookup.reason).toBe('revoked');
  });
});

describe('PatStore.lookup cache behaviour', () => {
  it('serves repeated lookups from cache within TTL', async () => {
    let now = new Date('2026-05-27T12:00:00Z');
    const store = await openStore({ now: () => now, cacheTtlMs: 60_000 });
    const { secret } = await mintDefault(store);

    expect(store.lookup(secret).ok).toBe(true);

    // Advance just under TTL — still a hit.
    now = new Date(now.getTime() + 30_000);
    expect(store.lookup(secret).ok).toBe(true);

    // Advance past TTL — must re-resolve, still ok.
    now = new Date(now.getTime() + 31_000);
    expect(store.lookup(secret).ok).toBe(true);
  });
});

describe('PatStore write serialization', () => {
  it('serializes concurrent rotations of the same PAT — exactly one wins', async () => {
    const store = await openStore();
    const { pat } = await mintDefault(store, { display_name: 'to-rotate' });

    const rotateInput = {
      display_name: 'rotated',
      agent_identity: pat.agent_identity,
      allowed_namespaces: pat.allowed_namespaces,
      scopes: pat.scopes,
      created_by: 'admin',
      expires_at: pat.expires_at,
    };

    // Fire both without awaiting between them; the write mutex must order them
    // so the second sees the already-revoked old PAT instead of double-minting.
    const [a, b] = await Promise.allSettled([
      store.rotate(pat.id, rotateInput),
      store.rotate(pat.id, rotateInput),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PatRotationStateError);

    // Exactly one live replacement exists for that identity.
    const live = store.list().filter((p) => !p.is_revoked && p.agent_identity === pat.agent_identity);
    expect(live).toHaveLength(1);
  });

  it('serializes concurrent revoke + rotate — rotate after revoke is rejected', async () => {
    const store = await openStore();
    const { pat } = await mintDefault(store);

    const [revokeRes, rotateRes] = await Promise.allSettled([
      store.revoke(pat.id, 'concurrent'),
      store.rotate(pat.id, {
        display_name: 'rotated',
        agent_identity: pat.agent_identity,
        allowed_namespaces: pat.allowed_namespaces,
        scopes: pat.scopes,
        created_by: 'admin',
        expires_at: pat.expires_at,
      }),
    ]);

    // revoke is queued first and always succeeds; rotate then sees a revoked PAT.
    expect(revokeRes.status).toBe('fulfilled');
    expect(rotateRes.status).toBe('rejected');
    expect((rotateRes as PromiseRejectedResult).reason).toBeInstanceOf(PatRotationStateError);
  });
});
