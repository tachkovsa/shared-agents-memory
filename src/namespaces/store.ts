import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentScope } from '../auth/types.js';
import { DEFAULT_RETENTION, DEFAULT_RULES_INDEX_BODY, getDefaultQuota } from './defaults.js';
import type {
  Namespace,
  NamespaceMember,
  NamespaceMembers,
  NamespaceQuota,
  RetentionPolicy,
} from './types.js';

export interface CreateNamespaceSpec {
  id: string;
  display_name: string;
  owner_agent_id: string;
  owner_scopes: AgentScope[];
  added_by?: string;
  retention_policy?: RetentionPolicy;
  quota?: NamespaceQuota;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export function namespaceDir(dataDir: string, id: string): string {
  return join(dataDir, 'namespaces', id);
}

export async function createNamespaceSkeleton(
  dataDir: string,
  spec: CreateNamespaceSpec,
): Promise<Namespace> {
  const now = (spec.now ?? (() => new Date()))().toISOString();
  const dir = namespaceDir(dataDir, spec.id);

  const namespace: Namespace = {
    id: spec.id,
    display_name: spec.display_name,
    owner_agent_id: spec.owner_agent_id,
    visibility: 'private',
    retention_policy: spec.retention_policy ?? DEFAULT_RETENTION,
    quota: spec.quota ?? getDefaultQuota(spec.env),
    created_at: now,
    updated_at: now,
  };

  const ownerMember: NamespaceMember = {
    agent_id: spec.owner_agent_id,
    scopes: [...spec.owner_scopes],
    added_by: spec.added_by ?? spec.owner_agent_id,
    added_at: now,
  };
  const members: NamespaceMembers = { members: [ownerMember] };

  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'rules'), { recursive: true });
  await mkdir(join(dir, 'audit'), { recursive: true });

  await writeFile(
    join(dir, '_namespace.json'),
    `${JSON.stringify(namespace, null, 2)}\n`,
  );
  await writeFile(
    join(dir, '_members.json'),
    `${JSON.stringify(members, null, 2)}\n`,
  );
  await writeFile(
    join(dir, '_quota.json'),
    `${JSON.stringify({ usage: {}, last_reset: now }, null, 2)}\n`,
  );
  await writeFile(join(dir, 'rules', 'INDEX.md'), DEFAULT_RULES_INDEX_BODY);

  return namespace;
}

export async function loadNamespace(
  dataDir: string,
  id: string,
): Promise<Namespace | null> {
  const path = join(namespaceDir(dataDir, id), '_namespace.json');
  const raw = await readJsonIfExists(path);
  return raw === null ? null : (JSON.parse(raw) as Namespace);
}

export async function loadMembers(
  dataDir: string,
  id: string,
): Promise<NamespaceMember[] | null> {
  const path = join(namespaceDir(dataDir, id), '_members.json');
  const raw = await readJsonIfExists(path);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as NamespaceMembers;
  return parsed.members;
}

async function readJsonIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}
