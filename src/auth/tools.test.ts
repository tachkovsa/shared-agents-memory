import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthAuditWriter } from './audit.js';
import { PatStore } from './pat-store.js';
import { registerPatTools } from './tools.js';
import type { AgentPat, AgentScope } from './types.js';

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
let storePath: string;
let auditPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-pat-tools-'));
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
}

async function setupHarness(
  options: { sessionScopes?: AgentScope[] } = {},
): Promise<Harness> {
  const patStore = await PatStore.open({ storePath, pepper: PEPPER });
  const minted = await patStore.mint({
    display_name: 'session',
    agent_identity: 'agent_session',
    allowed_namespaces: ['personal'],
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
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server, patStore, sessionPat: minted.pat };
}

function parsePayload(result: { content: { type: string; text?: string }[] }) {
  const text = result.content[0]?.text;
  if (!text) throw new Error('no text in tool response');
  return JSON.parse(text);
}

describe('pat_create', () => {
  it('two-call ceremony mints a PAT on the second call', async () => {
    const { client, patStore } = await setupHarness();
    const firstCall = await client.callTool({
      name: 'pat_create',
      arguments: {
        display_name: 'codex',
        agent_identity: 'agent_codex',
        allowed_namespaces: ['personal'],
        scopes: ['memory:read'],
      },
    });
    const firstBody = parsePayload(firstCall as never);
    expect(firstBody.pending).toBeDefined();
    expect(typeof firstBody.pending.confirmation_token).toBe('string');

    const secondCall = await client.callTool({
      name: 'pat_create',
      arguments: {
        display_name: 'codex',
        agent_identity: 'agent_codex',
        allowed_namespaces: ['personal'],
        scopes: ['memory:read'],
        confirmation_token: firstBody.pending.confirmation_token,
      },
    });
    const secondBody = parsePayload(secondCall as never);
    expect(secondBody.pat_id).toBeDefined();
    expect(secondBody.secret).toMatch(/^sam_pat_/);

    const lookup = patStore.lookup(secondBody.secret);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.pat.agent_identity).toBe('agent_codex');
      expect(lookup.pat.scopes).toEqual(['memory:read']);
    }
  });

  it('rejects the second call when input changed (input_hash mismatch)', async () => {
    const { client } = await setupHarness();
    const firstCall = await client.callTool({
      name: 'pat_create',
      arguments: {
        display_name: 'a',
        agent_identity: 'agent_x',
        allowed_namespaces: ['personal'],
        scopes: ['memory:read'],
      },
    });
    const firstBody = parsePayload(firstCall as never);

    const second = await client.callTool({
      name: 'pat_create',
      arguments: {
        display_name: 'a',
        agent_identity: 'agent_x',
        allowed_namespaces: ['personal'],
        scopes: ['memory:write'], // tampered
        confirmation_token: firstBody.pending.confirmation_token,
      },
    });
    const body = parsePayload(second as never);
    expect(body.error).toBe('MCP_CONFIRM_INVALID');
    expect(body.reason).toBe('mismatch');
  });

  it('rejects replay of an already-consumed confirmation token', async () => {
    const { client } = await setupHarness();
    const first = parsePayload(
      (await client.callTool({
        name: 'pat_create',
        arguments: {
          display_name: 'd',
          agent_identity: 'agent_d',
          allowed_namespaces: ['personal'],
          scopes: ['memory:read'],
        },
      })) as never,
    );
    const ok = parsePayload(
      (await client.callTool({
        name: 'pat_create',
        arguments: {
          display_name: 'd',
          agent_identity: 'agent_d',
          allowed_namespaces: ['personal'],
          scopes: ['memory:read'],
          confirmation_token: first.pending.confirmation_token,
        },
      })) as never,
    );
    expect(ok.pat_id).toBeDefined();

    const replay = parsePayload(
      (await client.callTool({
        name: 'pat_create',
        arguments: {
          display_name: 'd',
          agent_identity: 'agent_d',
          allowed_namespaces: ['personal'],
          scopes: ['memory:read'],
          confirmation_token: first.pending.confirmation_token,
        },
      })) as never,
    );
    expect(replay.error).toBe('MCP_CONFIRM_REPLAY');
  });

  it('refuses non-admin callers with scope_insufficient', async () => {
    const { client } = await setupHarness({ sessionScopes: ['memory:read'] });
    const body = parsePayload(
      (await client.callTool({
        name: 'pat_create',
        arguments: {
          display_name: 'x',
          agent_identity: 'agent_x',
          allowed_namespaces: ['personal'],
          scopes: ['memory:read'],
        },
      })) as never,
    );
    expect(body.error).toBe('scope_insufficient');
  });
});

describe('pat_list', () => {
  it('admins see all PATs', async () => {
    const { client, patStore, sessionPat } = await setupHarness();
    await patStore.mint({
      display_name: 'extra',
      agent_identity: 'agent_other',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: sessionPat.agent_identity,
    });
    const body = parsePayload(
      (await client.callTool({ name: 'pat_list', arguments: {} })) as never,
    );
    expect(body.pats).toHaveLength(2);
    const identities = body.pats.map((p: { agent_identity: string }) => p.agent_identity);
    expect(identities).toContain('agent_session');
    expect(identities).toContain('agent_other');
    // No secrets in the payload.
    for (const p of body.pats) {
      expect(p.secret).toBeUndefined();
      expect(p.token_hash).toBeUndefined();
    }
  });

  it('non-admins see only their own PATs', async () => {
    const { client, patStore, sessionPat } = await setupHarness({
      sessionScopes: ['memory:read'],
    });
    await patStore.mint({
      display_name: 'admin-token',
      agent_identity: 'agent_admin',
      allowed_namespaces: ['personal'],
      scopes: ['service:admin'],
      created_by: sessionPat.agent_identity,
    });
    const body = parsePayload(
      (await client.callTool({ name: 'pat_list', arguments: {} })) as never,
    );
    expect(body.pats).toHaveLength(1);
    expect(body.pats[0].agent_identity).toBe('agent_session');
  });
});

describe('pat_revoke', () => {
  it('admin can revoke any PAT', async () => {
    const { client, patStore, sessionPat } = await setupHarness();
    const minted = await patStore.mint({
      display_name: 'victim',
      agent_identity: 'agent_other',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: sessionPat.agent_identity,
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'pat_revoke',
        arguments: { pat_id: minted.pat.id, reason: 'cleanup' },
      })) as never,
    );
    expect(body.pat_id).toBe(minted.pat.id);
    expect(body.revoked_reason).toBe('cleanup');
    expect(patStore.get(minted.pat.id)?.is_revoked).toBe(true);
  });

  it('non-admin cannot revoke another agent’s PAT', async () => {
    const { client, patStore, sessionPat } = await setupHarness({
      sessionScopes: ['memory:read'],
    });
    const minted = await patStore.mint({
      display_name: 'other',
      agent_identity: 'agent_other',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read'],
      created_by: sessionPat.agent_identity,
    });
    const body = parsePayload(
      (await client.callTool({
        name: 'pat_revoke',
        arguments: { pat_id: minted.pat.id, reason: 'attempt' },
      })) as never,
    );
    expect(body.error).toBe('scope_insufficient');
    expect(patStore.get(minted.pat.id)?.is_revoked).toBe(false);
  });
});

describe('pat_rotate', () => {
  it('rotates a PAT via the two-call ceremony', async () => {
    const { client, patStore, sessionPat } = await setupHarness();
    const minted = await patStore.mint({
      display_name: 'rotate-me',
      agent_identity: 'agent_target',
      allowed_namespaces: ['personal'],
      scopes: ['memory:read', 'memory:write'],
      created_by: sessionPat.agent_identity,
    });

    const pending = parsePayload(
      (await client.callTool({
        name: 'pat_rotate',
        arguments: { pat_id: minted.pat.id },
      })) as never,
    );
    expect(pending.pending).toBeDefined();

    const rotated = parsePayload(
      (await client.callTool({
        name: 'pat_rotate',
        arguments: {
          pat_id: minted.pat.id,
          confirmation_token: pending.pending.confirmation_token,
        },
      })) as never,
    );
    expect(rotated.new_pat_id).toBeDefined();
    expect(rotated.replaced_pat_id).toBe(minted.pat.id);
    expect(rotated.secret).toMatch(/^sam_pat_/);

    expect(patStore.get(minted.pat.id)?.is_revoked).toBe(true);
    const lookup = patStore.lookup(rotated.secret);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.pat.scopes).toEqual(['memory:read', 'memory:write']);
  });
});
