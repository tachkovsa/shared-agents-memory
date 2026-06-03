import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthAuditWriter } from '../auth/audit.js';
import { PatStore } from '../auth/pat-store.js';
import { ALL_SCOPES, type AgentPat, type AgentScope } from '../auth/types.js';
import { createNamespaceSkeleton } from '../namespaces/store.js';
import { registerRuleTools } from './tools.js';

const PEPPER = Buffer.alloc(32, 0x42);

let workDir: string;
let storePath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-rules-tools-'));
  storePath = join(workDir, '_auth', 'pats.jsonl');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface Harness {
  client: Client;
  server: McpServer;
  sessionPat: AgentPat;
}

async function setupHarness(
  options: { sessionScopes?: AgentScope[]; allowedNamespaces?: string[] } = {},
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

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerRuleTools(server, {
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

  return { client, server, sessionPat: minted.pat };
}

function parsePayload(result: { content: { type: string; text?: string }[] }) {
  const text = result.content[0]?.text;
  if (!text) throw new Error('no text in tool response');
  return JSON.parse(text);
}

describe('rules.upsert + rules.read', () => {
  it('writes a rule and reads it back', async () => {
    const { client } = await setupHarness();
    const upsert = parsePayload(
      (await client.callTool({
        name: 'rules_upsert',
        arguments: {
          namespace: 'personal',
          id: 'no-bots',
          title: 'No bot comments',
          body: '# why\n\nbecause.',
          tags: ['github'],
          severity: 'hard',
        },
      })) as never,
    );
    expect(upsert.uri).toBe('mem://personal/rules/no-bots');
    expect(upsert.frontmatter.created_by).toBe('agent_session');

    const read = parsePayload(
      (await client.callTool({
        name: 'rules_read',
        arguments: { namespace: 'personal', id: 'no-bots' },
      })) as never,
    );
    expect(read.frontmatter.title).toBe('No bot comments');
    expect(read.body).toContain('because.');
  });

  it('rejects writes when token lacks rules:write', async () => {
    const { client } = await setupHarness({ sessionScopes: ['rules:read'] });
    const body = parsePayload(
      (await client.callTool({
        name: 'rules_upsert',
        arguments: {
          namespace: 'personal',
          id: 'denied',
          title: 't',
          body: '',
        },
      })) as never,
    );
    expect(body.error).toBe('scope_insufficient');
  });

  it('rejects reads when token lacks rules:read', async () => {
    const { client } = await setupHarness({ sessionScopes: ['rules:write'] });
    await client.callTool({
      name: 'rules_upsert',
      arguments: {
        namespace: 'personal',
        id: 'r-1',
        title: 't',
        body: 'b',
      },
    });
    const read = parsePayload(
      (await client.callTool({
        name: 'rules_read',
        arguments: { namespace: 'personal', id: 'r-1' },
      })) as never,
    );
    expect(read.error).toBe('scope_insufficient');
  });
});

describe('rules_list', () => {
  it('returns rules across readable namespaces for admin', async () => {
    const { client } = await setupHarness({
      allowedNamespaces: ['personal', 'team-alpha'],
    });
    await client.callTool({
      name: 'rules_upsert',
      arguments: { namespace: 'personal', id: 'a-rule', title: 'A', body: '' },
    });
    await client.callTool({
      name: 'rules_upsert',
      arguments: { namespace: 'team-alpha', id: 'b-rule', title: 'B', body: '' },
    });
    const body = parsePayload(
      (await client.callTool({ name: 'rules_list', arguments: {} })) as never,
    );
    const uris: string[] = body.rules.map((r: { uri: string }) => r.uri);
    expect(uris).toContain('mem://personal/rules/a-rule');
    expect(uris).toContain('mem://team-alpha/rules/b-rule');
  });

  it('filters by namespace argument', async () => {
    const { client } = await setupHarness({
      allowedNamespaces: ['personal', 'team-alpha'],
    });
    await client.callTool({
      name: 'rules_upsert',
      arguments: { namespace: 'personal', id: 'a-rule', title: 'A', body: '' },
    });
    await client.callTool({
      name: 'rules_upsert',
      arguments: { namespace: 'team-alpha', id: 'b-rule', title: 'B', body: '' },
    });
    const body = parsePayload(
      (await client.callTool({
        name: 'rules_list',
        arguments: { namespace: 'team-alpha' },
      })) as never,
    );
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].uri).toBe('mem://team-alpha/rules/b-rule');
  });
});

describe('rules_delete', () => {
  it('removes the file and updates the index', async () => {
    const { client } = await setupHarness();
    await client.callTool({
      name: 'rules_upsert',
      arguments: { namespace: 'personal', id: 'gone', title: 't', body: '' },
    });
    const indexPath = join(workDir, 'namespaces', 'personal', 'rules', 'INDEX.md');
    expect(await readFile(indexPath, 'utf8')).toContain('gone.md');
    await client.callTool({
      name: 'rules_delete',
      arguments: { namespace: 'personal', id: 'gone' },
    });
    expect(await readFile(indexPath, 'utf8')).not.toContain('gone.md');
  });

  it('returns not_found when the rule does not exist', async () => {
    const { client } = await setupHarness();
    const body = parsePayload(
      (await client.callTool({
        name: 'rules_delete',
        arguments: { namespace: 'personal', id: 'missing' },
      })) as never,
    );
    expect(body.error).toBe('not_found');
  });
});

describe('MCP Resources surface', () => {
  it('lists rules as resources across readable namespaces', async () => {
    const { client } = await setupHarness();
    await client.callTool({
      name: 'rules_upsert',
      arguments: {
        namespace: 'personal',
        id: 'res-1',
        title: 'Resource One',
        body: 'b',
      },
    });
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain('mem://personal/rules/res-1');
  });

  it('reads a rule via resources/read', async () => {
    const { client } = await setupHarness();
    await client.callTool({
      name: 'rules_upsert',
      arguments: {
        namespace: 'personal',
        id: 'res-read',
        title: 'Readable',
        body: '# yes\n',
      },
    });
    const result = await client.readResource({
      uri: 'mem://personal/rules/res-read',
    });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe('text/markdown');
    expect(result.contents[0].text).toContain('Readable');
    expect(result.contents[0].text).toContain('# yes');
  });

  it('emits resources/updated notifications on upsert and delete', async () => {
    const { client } = await setupHarness();
    const notifications: string[] = [];
    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification) => {
        notifications.push(notification.params.uri);
      },
    );
    await client.subscribeResource({ uri: 'mem://personal/rules/' });
    await client.callTool({
      name: 'rules_upsert',
      arguments: {
        namespace: 'personal',
        id: 'sub-1',
        title: 'sub',
        body: '',
      },
    });
    await client.callTool({
      name: 'rules_delete',
      arguments: { namespace: 'personal', id: 'sub-1' },
    });

    expect(notifications).toContain('mem://personal/rules/sub-1');
    expect(notifications).toContain('mem://personal/rules/');
  });
});
