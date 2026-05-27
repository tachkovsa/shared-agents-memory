import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthAuditWriter } from '../auth/audit.js';
import { PatStore } from '../auth/pat-store.js';
import { ALL_SCOPES, type AgentPat, type AgentScope } from '../auth/types.js';
import type { EmbeddingClient } from '../embeddings.js';
import { createNamespaceSkeleton } from '../namespaces/store.js';
import { MemoryService } from './service.js';
import { registerMemoryTools } from './tools.js';
import { MEMORY_KIND } from './types.js';

const PEPPER = Buffer.alloc(32, 0x42);
const COLLECTION = 'agent_memories';

let workDir: string;
let storePath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-memory-tools-'));
  storePath = join(workDir, '_auth', 'pats.jsonl');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface FakeQdrant {
  upsert: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  setPayload: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeQdrant(overrides: Partial<FakeQdrant> = {}): {
  client: QdrantClient;
  fake: FakeQdrant;
} {
  const fake: FakeQdrant = {
    upsert: overrides.upsert ?? vi.fn(async () => ({ status: 'completed' })),
    search: overrides.search ?? vi.fn(async () => []),
    retrieve: overrides.retrieve ?? vi.fn(async () => []),
    setPayload: overrides.setPayload ?? vi.fn(async () => ({ status: 'completed' })),
    delete: overrides.delete ?? vi.fn(async () => ({ status: 'completed' })),
  };
  return { client: fake as unknown as QdrantClient, fake };
}

function makeEmbeddings() {
  return {
    embed: vi.fn(async (_t: string) => Array.from({ length: 4096 }, () => 0)),
  } as unknown as EmbeddingClient;
}

interface Harness {
  client: Client;
  fake: FakeQdrant;
  embeddings: EmbeddingClient;
  sessionPat: AgentPat;
}

async function setupHarness(
  options: { sessionScopes?: AgentScope[]; allowedNamespaces?: string[] } = {},
  qdrantOverrides: Partial<FakeQdrant> = {},
): Promise<Harness> {
  const patStore = await PatStore.open({ storePath, pepper: PEPPER });
  const scopes = options.sessionScopes ?? ALL_SCOPES;
  const allowed = options.allowedNamespaces ?? ['personal'];
  const minted = await patStore.mint({
    display_name: 'session',
    agent_identity: 'agent_session',
    allowed_namespaces: allowed,
    scopes: [...scopes],
    created_by: 'bootstrap',
  });

  for (const ns of allowed) {
    await createNamespaceSkeleton(workDir, {
      id: ns,
      display_name: ns,
      owner_agent_id: 'agent_session',
      owner_scopes: [...scopes],
    });
  }

  const auditor = new AuthAuditWriter({
    path: join(workDir, '_auth', 'audit.jsonl'),
    successSampleRate: 1,
    random: () => 0,
  });

  const { client: qdrantClient, fake } = makeQdrant(qdrantOverrides);
  const embeddings = makeEmbeddings();
  const service = new MemoryService({
    qdrant: qdrantClient,
    embeddings,
    collection: COLLECTION,
  });

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMemoryTools(server, {
    service,
    sessionPat: minted.pat,
    auditor,
    dataDir: workDir,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, fake, embeddings, sessionPat: minted.pat };
}

function parsePayload(result: { content: { type: string; text?: string }[] }) {
  const text = result.content[0]?.text;
  if (!text) throw new Error('no text in tool response');
  return JSON.parse(text);
}

describe('memory.store', () => {
  it('registers under noun.verb name and stores under the authorized namespace', async () => {
    const { client, fake } = await setupHarness();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'memory.store',
        'memory.search',
        'memory.get',
        'memory.update_metadata',
        'memory.delete',
      ]),
    );

    const body = parsePayload(
      (await client.callTool({
        name: 'memory.store',
        arguments: {
          namespace: 'personal',
          content: 'hello world',
          tags: ['note'],
        },
      })) as never,
    );
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.upsert).toHaveBeenCalledTimes(1);
    const [, upsertBody] = (fake.upsert.mock.calls[0] ?? []) as [
      string,
      { points: { payload: Record<string, unknown> }[] },
    ];
    expect(upsertBody.points[0].payload['namespace']).toBe('personal');
    expect(upsertBody.points[0].payload['kind']).toBe(MEMORY_KIND);
  });

  it('returns an auth error when the caller is not a member of the namespace', async () => {
    const { client } = await setupHarness({ allowedNamespaces: ['personal'] });
    const result = (await client.callTool({
      name: 'memory.store',
      arguments: { namespace: 'other', content: 'hi' },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBeDefined();
  });

  it('rejects writes when the token lacks memory:write', async () => {
    const { client } = await setupHarness({ sessionScopes: ['memory:read'] });
    const result = (await client.callTool({
      name: 'memory.store',
      arguments: { namespace: 'personal', content: 'hi' },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe('memory.search', () => {
  it('returns scored results', async () => {
    const { client } = await setupHarness({}, {
      search: vi.fn(async () => [
        {
          id: 'mem-1',
          score: 0.42,
          payload: {
            namespace: 'personal',
            agent_id: 'agent_session',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'memory.search',
        arguments: { namespace: 'personal', query: 'hello' },
      })) as never,
    );
    expect(body).toHaveLength(1);
    expect(body[0].memory.id).toBe('mem-1');
    expect(body[0].score).toBe(0.42);
  });
});

describe('memory.get', () => {
  it('returns the memory when in-namespace', async () => {
    const { client } = await setupHarness({}, {
      retrieve: vi.fn(async () => [
        {
          id: '11111111-1111-1111-1111-111111111111',
          payload: {
            namespace: 'personal',
            agent_id: 'agent_session',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'memory.get',
        arguments: {
          namespace: 'personal',
          id: '11111111-1111-1111-1111-111111111111',
        },
      })) as never,
    );
    expect(body.id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('returns not_found for a missing id', async () => {
    const { client } = await setupHarness();
    const result = (await client.callTool({
      name: 'memory.get',
      arguments: {
        namespace: 'personal',
        id: '11111111-1111-1111-1111-111111111111',
      },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('not_found');
  });
});

describe('memory.update_metadata', () => {
  it('updates metadata without re-embedding', async () => {
    const { client, embeddings, fake } = await setupHarness({}, {
      retrieve: vi.fn(async () => [
        {
          id: '11111111-1111-1111-1111-111111111111',
          payload: {
            namespace: 'personal',
            agent_id: 'agent_session',
            kind: MEMORY_KIND,
            content: 'hi',
            metadata: { a: 1 },
            tags: ['x'],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'memory.update_metadata',
        arguments: {
          namespace: 'personal',
          id: '11111111-1111-1111-1111-111111111111',
          metadata: { b: 2 },
          tags: ['y'],
        },
      })) as never,
    );
    expect(body.metadata).toEqual({ b: 2 });
    expect(body.tags).toEqual(['y']);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(fake.setPayload).toHaveBeenCalledTimes(1);
  });
});

describe('memory.delete', () => {
  it('deletes by id', async () => {
    const { client, fake } = await setupHarness({}, {
      retrieve: vi.fn(async () => [
        {
          id: '11111111-1111-1111-1111-111111111111',
          payload: {
            namespace: 'personal',
            agent_id: 'agent_session',
            kind: MEMORY_KIND,
            content: 'hi',
            tags: [],
            created_at: 'now',
            updated_at: 'now',
          },
        },
      ]),
    });

    const body = parsePayload(
      (await client.callTool({
        name: 'memory.delete',
        arguments: {
          namespace: 'personal',
          id: '11111111-1111-1111-1111-111111111111',
        },
      })) as never,
    );
    expect(body.deleted).toBe(true);
    expect(fake.delete).toHaveBeenCalledTimes(1);
  });

  it('returns not_found if absent', async () => {
    const { client } = await setupHarness();
    const result = (await client.callTool({
      name: 'memory.delete',
      arguments: {
        namespace: 'personal',
        id: '11111111-1111-1111-1111-111111111111',
      },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('not_found');
  });
});
