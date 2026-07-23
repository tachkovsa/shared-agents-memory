import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthAuditWriter } from '../auth/audit.js';
import { PatStore } from '../auth/pat-store.js';
import { registerPatTools } from '../auth/tools.js';
import type { AgentPat, AgentScope } from '../auth/types.js';
import { createNamespaceSkeleton, loadMembers, namespaceDir } from './store.js';
import { makeOrphanPruneCallback, registerNamespaceTools } from './tools.js';

const PEPPER = Buffer.alloc(32, 0x42);
const FULL_SCOPES: AgentScope[] = [
  'memory:read',
  'memory:write',
  'memory:delete',
  'rules:read',
  'rules:write',
  'namespace:admin',
  'service:admin',
];

let workDir: string;
let auditPath: string;
let storePath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-ns-tools-'));
  storePath = join(workDir, '_auth', 'pats.jsonl');
  auditPath = join(workDir, '_auth', 'audit.jsonl');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface Harness {
  client: Client;
  server: McpServer;
  patStore: PatStore;
  sessionPat: AgentPat;
  qdrantDelete: ReturnType<typeof vi.fn>;
}

const TEST_COLLECTION = 'agent_memories';

async function setupHarness(
  options: { sessionScopes?: AgentScope[]; qdrantDelete?: ReturnType<typeof vi.fn> } = {},
): Promise<Harness> {
  const qdrantDelete = options.qdrantDelete ?? vi.fn(async () => ({ status: 'completed' }));
  const patStore = await PatStore.open({ storePath, pepper: PEPPER });
  const minted = await patStore.mint({
    display_name: 'session',
    agent_identity: 'agent_session',
    allowed_namespaces: ['personal', 'team-alpha', 'ns-one', 'ns-two', 'target'],
    scopes: options.sessionScopes ?? FULL_SCOPES,
    created_by: 'bootstrap',
  });

  const auditor = new AuthAuditWriter({
    path: auditPath,
    successSampleRate: 1,
    random: () => 0,
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });

  registerPatTools(server, {
    patStore,
    sessionPat: minted.pat,
    auditor,
    sessionId: 'sess_test',
    pepper: PEPPER,
    onPatRevoked: makeOrphanPruneCallback(patStore, workDir, auditor),
  });

  registerNamespaceTools(server, {
    patStore,
    sessionPat: minted.pat,
    auditor,
    sessionId: 'sess_test',
    pepper: PEPPER,
    dataDir: workDir,
    qdrant: { delete: qdrantDelete } as never,
    collection: TEST_COLLECTION,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server, patStore, sessionPat: minted.pat, qdrantDelete };
}

function parsePayload(result: { content: { type: string; text?: string }[] }) {
  const text = result.content[0]?.text;
  if (!text) throw new Error('no text in tool response');
  return JSON.parse(text);
}

// ============================================================================
// namespace.create
// ============================================================================
describe('namespace_create', () => {
  it('two-call: pending → created; directory layout exists; owner is member with all scopes', async () => {
    const { client } = await setupHarness();

    const firstCall = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: {
          id: 'team-alpha',
          display_name: 'Team Alpha',
          owner_agent_id: 'agent_alice',
        },
      })) as never,
    );
    expect(firstCall.pending).toBeDefined();
    expect(typeof firstCall.pending.confirmation_token).toBe('string');
    expect(firstCall.pending.will_do.namespace_id).toBe('team-alpha');

    const secondCall = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: {
          id: 'team-alpha',
          display_name: 'Team Alpha',
          owner_agent_id: 'agent_alice',
          confirmation_token: firstCall.pending.confirmation_token,
        },
      })) as never,
    );
    expect(secondCall.namespace_id).toBe('team-alpha');
    expect(secondCall.owner_agent_id).toBe('agent_alice');

    // Directory layout should exist.
    const dir = namespaceDir(workDir, 'team-alpha');
    const dirStat = await stat(dir);
    expect(dirStat.isDirectory()).toBe(true);

    // Owner should be a member with all scopes.
    const members = await loadMembers(workDir, 'team-alpha');
    expect(members).toBeDefined();
    const ownerEntry = members?.find((m) => m.agent_id === 'agent_alice');
    expect(ownerEntry).toBeDefined();
    expect(ownerEntry?.scopes).toContain('namespace:admin');
    expect(ownerEntry?.scopes).toContain('memory:read');
  });

  it('non-admin caller gets scope_insufficient', async () => {
    const { client } = await setupHarness({ sessionScopes: ['memory:read'] });
    const body = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: { id: 'team-alpha', display_name: 'Team Alpha', owner_agent_id: 'agent_x' },
      })) as never,
    );
    expect(body.error).toBe('scope_insufficient');
  });

  it('confirmation tamper → MCP_CONFIRM_INVALID', async () => {
    const { client } = await setupHarness();

    const first = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: { id: 'ns-one', display_name: 'NS One', owner_agent_id: 'agent_x' },
      })) as never,
    );

    // Change the input (different display_name) but reuse the token.
    const second = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: {
          id: 'ns-one',
          display_name: 'NS One TAMPERED',
          owner_agent_id: 'agent_x',
          confirmation_token: first.pending.confirmation_token,
        },
      })) as never,
    );
    expect(second.error).toBe('MCP_CONFIRM_INVALID');
    expect(second.reason).toBe('mismatch');
  });

  it('replay of confirmation token → MCP_CONFIRM_REPLAY', async () => {
    const { client } = await setupHarness();

    const args = { id: 'ns-two', display_name: 'NS Two', owner_agent_id: 'agent_x' };
    const first = parsePayload(
      (await client.callTool({ name: 'namespace_create', arguments: args })) as never,
    );

    // First confirm: success.
    const ok = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: { ...args, confirmation_token: first.pending.confirmation_token },
      })) as never,
    );
    expect(ok.namespace_id).toBe('ns-two');

    // Second confirm: replay.
    const replay = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: { ...args, confirmation_token: first.pending.confirmation_token },
      })) as never,
    );
    expect(replay.error).toBe('MCP_CONFIRM_REPLAY');
  });

  it('existing id → namespace_exists error (not an exception)', async () => {
    const { client } = await setupHarness();

    const args = { id: 'target', display_name: 'Target', owner_agent_id: 'agent_x' };
    const first = parsePayload(
      (await client.callTool({ name: 'namespace_create', arguments: args })) as never,
    );
    await client.callTool({
      name: 'namespace_create',
      arguments: { ...args, confirmation_token: first.pending.confirmation_token },
    });

    // Try to create it again.
    const first2 = parsePayload(
      (await client.callTool({ name: 'namespace_create', arguments: args })) as never,
    );
    const dupe = parsePayload(
      (await client.callTool({
        name: 'namespace_create',
        arguments: { ...args, confirmation_token: first2.pending.confirmation_token },
      })) as never,
    );
    expect(dupe.error).toBe('namespace_exists');
  });
});

// ============================================================================
// namespace.list
// ============================================================================
describe('namespace_list', () => {
  it('admin sees all namespaces', async () => {
    const { client } = await setupHarness();

    // Create two namespaces directly on disk (bypass tool to avoid ceremony).
    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: 'agent_x',
      owner_scopes: ['memory:read'],
    });
    await createNamespaceSkeleton(workDir, {
      id: 'ns-two',
      display_name: 'NS Two',
      owner_agent_id: 'agent_y',
      owner_scopes: ['memory:read'],
    });

    const body = parsePayload(
      (await client.callTool({ name: 'namespace_list', arguments: {} })) as never,
    );
    expect(body.namespaces).toHaveLength(2);
    const ids = body.namespaces.map((n: { id: string }) => n.id);
    expect(ids).toContain('ns-one');
    expect(ids).toContain('ns-two');
  });

  it('non-admin sees only namespaces they are a member of', async () => {
    // Create a harness with non-admin scopes.
    const patStore = await PatStore.open({ storePath, pepper: PEPPER });
    const minted = await patStore.mint({
      display_name: 'session',
      agent_identity: 'agent_member',
      allowed_namespaces: ['ns-one', 'ns-two'],
      scopes: ['memory:read', 'namespace:admin'],
      created_by: 'bootstrap',
    });

    const auditor = new AuthAuditWriter({ path: auditPath, successSampleRate: 1, random: () => 0 });
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    registerNamespaceTools(server, {
      patStore,
      sessionPat: minted.pat,
      auditor,
      sessionId: 'sess_test',
      pepper: PEPPER,
      dataDir: workDir,
      qdrant: { delete: vi.fn(async () => ({ status: 'completed' })) } as never,
      collection: TEST_COLLECTION,
    });

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    // Create two namespaces: member in ns-one, NOT a member of ns-two.
    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: 'agent_other',
      owner_scopes: ['memory:read'],
    });
    await createNamespaceSkeleton(workDir, {
      id: 'ns-two',
      display_name: 'NS Two',
      owner_agent_id: 'agent_other',
      owner_scopes: ['memory:read'],
    });

    // Manually add agent_member only to ns-one.
    const ns1Members = (await loadMembers(workDir, 'ns-one')) ?? [];
    ns1Members.push({
      agent_id: 'agent_member',
      scopes: ['memory:read'],
      added_by: 'agent_other',
      added_at: new Date().toISOString(),
    });
    const { saveMembers } = await import('./store.js');
    await saveMembers(workDir, 'ns-one', ns1Members);

    const body = parsePayload(
      (await client.callTool({ name: 'namespace_list', arguments: {} })) as never,
    );
    expect(body.namespaces).toHaveLength(1);
    expect(body.namespaces[0].id).toBe('ns-one');
  });
});

// ============================================================================
// namespace.update
// ============================================================================
describe('namespace_update', () => {
  it('requires namespace:admin — non-member gets scope_insufficient or namespace_forbidden', async () => {
    const { client } = await setupHarness({ sessionScopes: ['memory:read'] });

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: 'agent_other',
      owner_scopes: ['namespace:admin'],
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'namespace_update',
        arguments: { id: 'ns-one', display_name: 'Updated' },
      })) as never,
    );
    // Non-member will get namespace_forbidden or scope_insufficient.
    expect(['namespace_forbidden', 'scope_insufficient']).toContain(body.error);
  });

  it('updates display_name and merges quota fields for namespace admin', async () => {
    const { client, sessionPat } = await setupHarness();

    // Create namespace where session agent is the owner.
    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: sessionPat.agent_identity,
      owner_scopes: FULL_SCOPES,
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'namespace_update',
        arguments: {
          id: 'ns-one',
          display_name: 'NS One Updated',
          quota: { daily_writes: 100 },
        },
      })) as never,
    );
    expect(body.namespace_id).toBe('ns-one');
    expect(body.display_name).toBe('NS One Updated');
    // Only daily_writes changed; others stay at defaults.
    expect(body.quota.daily_writes).toBe(100);
    expect(body.quota.daily_embedding_tokens).toBeGreaterThan(0);
  });
});

// ============================================================================
// namespace.add_member / namespace.remove_member
// ============================================================================
describe('namespace.add_member and namespace.remove_member', () => {
  it('add_member mutates _members.json correctly', async () => {
    const { client, sessionPat } = await setupHarness();

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: sessionPat.agent_identity,
      owner_scopes: FULL_SCOPES,
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'namespace_add_member',
        arguments: {
          id: 'ns-one',
          agent_id: 'agent_new',
          scopes: ['memory:read', 'memory:write'],
        },
      })) as never,
    );
    expect(body.agent_id).toBe('agent_new');
    expect(body.scopes).toContain('memory:read');

    const members = await loadMembers(workDir, 'ns-one');
    expect(members?.some((m) => m.agent_id === 'agent_new')).toBe(true);
  });

  it('remove_member mutates _members.json correctly', async () => {
    const { client, sessionPat } = await setupHarness();

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: sessionPat.agent_identity,
      owner_scopes: FULL_SCOPES,
    });

    // Add a member first.
    await client.callTool({
      name: 'namespace_add_member',
      arguments: { id: 'ns-one', agent_id: 'agent_new', scopes: ['memory:read'] },
    });

    const removeBody = parsePayload(
      (await client.callTool({
        name: 'namespace_remove_member',
        arguments: { id: 'ns-one', agent_id: 'agent_new' },
      })) as never,
    );
    expect(removeBody.removed).toBe(true);

    const members = await loadMembers(workDir, 'ns-one');
    expect(members?.some((m) => m.agent_id === 'agent_new')).toBe(false);
  });

  it('remove_member returns not_found for non-member', async () => {
    const { client, sessionPat } = await setupHarness();

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: sessionPat.agent_identity,
      owner_scopes: FULL_SCOPES,
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'namespace_remove_member',
        arguments: { id: 'ns-one', agent_id: 'agent_ghost' },
      })) as never,
    );
    expect(body.error).toBe('not_found');
  });
});

// ============================================================================
// namespace.delete
// ============================================================================
describe('namespace_delete', () => {
  it('two-call: target dir is moved to _deleted/ with contents intact', async () => {
    const { client } = await setupHarness();

    // Create the namespace directly on disk.
    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });

    const pending = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'ns-one' },
      })) as never,
    );
    expect(pending.pending).toBeDefined();
    expect(pending.pending.will_do.namespace_id).toBe('ns-one');

    const done = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'ns-one', confirmation_token: pending.pending.confirmation_token },
      })) as never,
    );
    expect(done.deleted).toBe(true);
    expect(done.moved_to).toBeDefined();

    // Source should be gone.
    const src = namespaceDir(workDir, 'ns-one');
    await expect(stat(src)).rejects.toThrow();

    // Destination should exist with _namespace.json.
    const destEntries = await readdir(join(workDir, '_deleted'));
    expect(destEntries.some((e) => e.startsWith('ns-one-'))).toBe(true);
  });

  it('cascades a namespace-filtered Qdrant delete for the tenant vectors (issue #102)', async () => {
    const { client, qdrantDelete } = await setupHarness();

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });

    const pending = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'ns-one' },
      })) as never,
    );
    const done = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'ns-one', confirmation_token: pending.pending.confirmation_token },
      })) as never,
    );

    expect(done.deleted).toBe(true);
    expect(done.vectors_purged).toBe(true);

    // The purge must be a namespace-filtered delete against the collection.
    expect(qdrantDelete).toHaveBeenCalledTimes(1);
    const [collection, body] = qdrantDelete.mock.calls[0]!;
    expect(collection).toBe(TEST_COLLECTION);
    expect(body).toMatchObject({
      filter: { must: [{ key: 'namespace', match: { value: 'ns-one' } }] },
    });
  });

  it('still soft-deletes but reports vectors_purged=false when the Qdrant purge fails', async () => {
    const failingDelete = vi.fn(async () => {
      throw new Error('qdrant unreachable');
    });
    const { client } = await setupHarness({ qdrantDelete: failingDelete });

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });

    const pending = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'ns-one' },
      })) as never,
    );
    const done = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'ns-one', confirmation_token: pending.pending.confirmation_token },
      })) as never,
    );

    // Directory move committed even though the immediate purge failed — the
    // orphan sweep is the backstop.
    expect(done.deleted).toBe(true);
    expect(done.vectors_purged).toBe(false);
    const destEntries = await readdir(join(workDir, '_deleted'));
    expect(destEntries.some((e) => e.startsWith('ns-one-'))).toBe(true);
  });

  it('refuses to delete "personal" namespace', async () => {
    const { client } = await setupHarness();

    // Create personal namespace on disk so we can attempt deletion.
    await createNamespaceSkeleton(workDir, {
      id: 'personal',
      display_name: 'Personal',
      owner_agent_id: 'agent_x',
      owner_scopes: [],
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'personal' },
      })) as never,
    );
    expect(body.error).toBe('protected_namespace');
  });

  it('non-admin gets scope_insufficient', async () => {
    const { client } = await setupHarness({ sessionScopes: ['memory:read'] });

    const body = parsePayload(
      (await client.callTool({
        name: 'namespace_delete',
        arguments: { id: 'ns-one' },
      })) as never,
    );
    expect(body.error).toBe('scope_insufficient');
  });
});

// ============================================================================
// Orphan member prune on pat.revoke
// ============================================================================
describe('orphan member prune on pat.revoke', () => {
  it('revoke last PAT for an agent removes memberships in all namespaces', async () => {
    const { client, patStore, sessionPat } = await setupHarness();

    // Create two namespaces.
    for (const id of ['ns-one', 'ns-two']) {
      await createNamespaceSkeleton(workDir, {
        id,
        display_name: id,
        owner_agent_id: sessionPat.agent_identity,
        owner_scopes: FULL_SCOPES,
      });
    }

    // Mint a PAT for agent_member and add them to both namespaces.
    const memberPat = await patStore.mint({
      display_name: 'member-token',
      agent_identity: 'agent_member',
      allowed_namespaces: ['ns-one', 'ns-two'],
      scopes: ['memory:read'],
      created_by: sessionPat.agent_identity,
    });

    for (const id of ['ns-one', 'ns-two']) {
      await client.callTool({
        name: 'namespace_add_member',
        arguments: { id, agent_id: 'agent_member', scopes: ['memory:read'] },
      });
    }

    // Verify both memberships exist.
    for (const id of ['ns-one', 'ns-two']) {
      const members = await loadMembers(workDir, id);
      expect(members?.some((m) => m.agent_id === 'agent_member')).toBe(true);
    }

    // Revoke the only PAT for agent_member.
    const revokeBody = parsePayload(
      (await client.callTool({
        name: 'pat_revoke',
        arguments: { pat_id: memberPat.pat.id, reason: 'cleanup' },
      })) as never,
    );
    expect(revokeBody.pat_id).toBe(memberPat.pat.id);

    // Memberships should have been pruned.
    for (const id of ['ns-one', 'ns-two']) {
      const members = await loadMembers(workDir, id);
      expect(members?.some((m) => m.agent_id === 'agent_member')).toBe(false);
    }
  });

  it('revoke when agent still has another PAT leaves memberships intact', async () => {
    const { client, patStore, sessionPat } = await setupHarness();

    await createNamespaceSkeleton(workDir, {
      id: 'ns-one',
      display_name: 'NS One',
      owner_agent_id: sessionPat.agent_identity,
      owner_scopes: FULL_SCOPES,
    });

    // Mint TWO PATs for agent_member.
    const pat1 = await patStore.mint({
      display_name: 'member-token-1',
      agent_identity: 'agent_member',
      allowed_namespaces: ['ns-one'],
      scopes: ['memory:read'],
      created_by: sessionPat.agent_identity,
    });
    await patStore.mint({
      display_name: 'member-token-2',
      agent_identity: 'agent_member',
      allowed_namespaces: ['ns-one'],
      scopes: ['memory:read'],
      created_by: sessionPat.agent_identity,
    });

    // Add member to namespace.
    await client.callTool({
      name: 'namespace_add_member',
      arguments: { id: 'ns-one', agent_id: 'agent_member', scopes: ['memory:read'] },
    });

    // Revoke only the first PAT (second still exists).
    await client.callTool({
      name: 'pat_revoke',
      arguments: { pat_id: pat1.pat.id, reason: 'test' },
    });

    // Membership should still exist because agent still has pat2.
    const members = await loadMembers(workDir, 'ns-one');
    expect(members?.some((m) => m.agent_id === 'agent_member')).toBe(true);
  });
});
