import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNamespaceSkeleton } from '../namespaces/store.js';
import type { NamespaceMembers } from '../namespaces/types.js';
import { PatStore } from './pat-store.js';
import { AuthError } from './request-context.js';
import {
  authorizeNamespaceAccess,
  resolvePat,
  resolveRequest,
} from './resolve-request.js';
import type { AgentPat, AgentScope } from './types.js';

const PEPPER = Buffer.alloc(32, 0x42);
const ALL_OWNER_SCOPES: AgentScope[] = [
  'memory:read',
  'memory:write',
  'memory:delete',
  'rules:read',
  'rules:write',
  'namespace:admin',
  'service:admin',
];

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-resolve-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function openStore() {
  return PatStore.open({
    storePath: join(workDir, '_auth', 'pats.jsonl'),
    pepper: PEPPER,
  });
}

interface Fixture {
  store: PatStore;
  ownerPat: AgentPat;
  ownerSecret: string;
}

async function setupPersonalNamespace(
  overrides: { ownerScopes?: AgentScope[]; allowedNamespaces?: string[] } = {},
): Promise<Fixture> {
  const store = await openStore();
  const ownerScopes = overrides.ownerScopes ?? ALL_OWNER_SCOPES;
  const minted = await store.mint({
    display_name: 'owner',
    agent_identity: 'agent_owner',
    allowed_namespaces: overrides.allowedNamespaces ?? ['personal'],
    scopes: ownerScopes,
    created_by: 'bootstrap',
  });
  await createNamespaceSkeleton(workDir, {
    id: 'personal',
    display_name: 'Personal',
    owner_agent_id: 'agent_owner',
    owner_scopes: ownerScopes,
    now: () => new Date('2026-05-27T12:00:00Z'),
  });
  return { store, ownerPat: minted.pat, ownerSecret: minted.secret };
}

async function writeMembers(namespaceId: string, members: NamespaceMembers) {
  const path = join(workDir, 'namespaces', namespaceId, '_members.json');
  await writeFile(path, `${JSON.stringify(members, null, 2)}\n`);
}

describe('resolvePat', () => {
  it('returns the pat for a valid secret', async () => {
    const { store, ownerPat, ownerSecret } = await setupPersonalNamespace();
    const pat = resolvePat(store, ownerSecret);
    expect(pat.id).toBe(ownerPat.id);
  });

  it('throws AuthError(missing) for an empty secret', async () => {
    const store = await openStore();
    try {
      resolvePat(store, '');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).reason).toBe('missing');
    }
  });

  it('throws AuthError(malformed) for a non-sam_pat token', async () => {
    const store = await openStore();
    expect(() => resolvePat(store, 'Bearer abc')).toThrow(AuthError);
    try {
      resolvePat(store, 'Bearer abc');
    } catch (err) {
      expect((err as AuthError).reason).toBe('malformed');
    }
  });

  it('throws AuthError(unknown) for a well-formed but missing token', async () => {
    const store = await openStore();
    const fake = `sam_pat_${'A'.repeat(27)}`;
    try {
      resolvePat(store, fake);
    } catch (err) {
      expect((err as AuthError).reason).toBe('unknown');
    }
  });

  it('throws AuthError(revoked) for a revoked PAT', async () => {
    const { store, ownerPat, ownerSecret } = await setupPersonalNamespace();
    await store.revoke(ownerPat.id, 'rotation');
    try {
      resolvePat(store, ownerSecret);
    } catch (err) {
      expect((err as AuthError).reason).toBe('revoked');
    }
  });
});

describe('authorizeNamespaceAccess', () => {
  it('returns a RequestContext for an owner with full scopes', async () => {
    const { ownerPat } = await setupPersonalNamespace();
    const ctx = await authorizeNamespaceAccess({
      pat: ownerPat,
      requestedNamespace: 'personal',
      requiredScope: 'memory:write',
      dataDir: workDir,
    });
    expect(ctx.agentId).toBe('agent_owner');
    expect(ctx.namespaceId).toBe('personal');
    expect(ctx.scopes).toContain('memory:write');
    expect(ctx.patId).toBe(ownerPat.id);
  });

  it('rejects a namespace not in the token allowed_namespaces', async () => {
    const { ownerPat } = await setupPersonalNamespace();
    try {
      await authorizeNamespaceAccess({
        pat: ownerPat,
        requestedNamespace: 'team-alpha',
        requiredScope: 'memory:read',
        dataDir: workDir,
      });
    } catch (err) {
      expect((err as AuthError).reason).toBe('namespace_forbidden');
      expect((err as AuthError).details?.['detail']).toBe('not_in_allowed_namespaces');
    }
  });

  it('rejects a namespace that the token allows but does not exist on disk', async () => {
    const { ownerPat } = await setupPersonalNamespace({
      allowedNamespaces: ['personal', 'team-alpha'],
    });
    try {
      await authorizeNamespaceAccess({
        pat: ownerPat,
        requestedNamespace: 'team-alpha',
        requiredScope: 'memory:read',
        dataDir: workDir,
      });
    } catch (err) {
      expect((err as AuthError).reason).toBe('namespace_forbidden');
      expect((err as AuthError).details?.['detail']).toBe('namespace_missing');
    }
  });

  it('rejects non-owner agents missing from _members.json', async () => {
    await setupPersonalNamespace();
    const store = await openStore();
    const minted = await store.mint({
      display_name: 'intruder',
      agent_identity: 'agent_other',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: 'bootstrap',
    });
    try {
      await authorizeNamespaceAccess({
        pat: minted.pat,
        requestedNamespace: 'personal',
        requiredScope: 'memory:read',
        dataDir: workDir,
      });
    } catch (err) {
      expect((err as AuthError).reason).toBe('namespace_forbidden');
      expect((err as AuthError).details?.['detail']).toBe('not_a_member');
    }
  });

  it('grants the owner access even if _members.json omits them (ADR-0002 §3.2)', async () => {
    const { ownerPat } = await setupPersonalNamespace();
    // Strip the explicit member entry — owner should still be authorized implicitly.
    await writeMembers('personal', { members: [] });
    const ctx = await authorizeNamespaceAccess({
      pat: ownerPat,
      requestedNamespace: 'personal',
      requiredScope: 'namespace:admin',
      dataDir: workDir,
    });
    expect(ctx.agentId).toBe('agent_owner');
    expect(ctx.scopes).toContain('namespace:admin');
  });

  it('throws scope_insufficient when the member lacks the required scope', async () => {
    const { ownerPat } = await setupPersonalNamespace({
      ownerScopes: ['memory:read'],
    });
    try {
      await authorizeNamespaceAccess({
        pat: ownerPat,
        requestedNamespace: 'personal',
        requiredScope: 'memory:write',
        dataDir: workDir,
      });
    } catch (err) {
      expect((err as AuthError).reason).toBe('scope_insufficient');
    }
  });

  it('intersects token scopes with member scopes', async () => {
    // Owner is a member with [memory:read, memory:write] but the token is scoped to memory:read only.
    const { store } = await setupPersonalNamespace({
      ownerScopes: ['memory:read', 'memory:write'],
    });
    const minted = await store.mint({
      display_name: 'read-only token',
      agent_identity: 'agent_owner',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: 'bootstrap',
    });
    try {
      await authorizeNamespaceAccess({
        pat: minted.pat,
        requestedNamespace: 'personal',
        requiredScope: 'memory:write',
        dataDir: workDir,
      });
    } catch (err) {
      expect((err as AuthError).reason).toBe('scope_insufficient');
    }
  });
});

describe('resolveRequest end-to-end', () => {
  it('composes resolvePat + authorizeNamespaceAccess', async () => {
    const { store, ownerSecret } = await setupPersonalNamespace();
    const ctx = await resolveRequest({
      patStore: store,
      rawSecret: ownerSecret,
      requestedNamespace: 'personal',
      requiredScope: 'memory:read',
      dataDir: workDir,
    });
    expect(ctx.agentId).toBe('agent_owner');
  });
});
