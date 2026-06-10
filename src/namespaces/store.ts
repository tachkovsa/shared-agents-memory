import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import type { AgentScope } from '../auth/types.js';
import {
  DEFAULT_DEDUP_THRESHOLD,
  DEFAULT_LIFECYCLE,
  DEFAULT_RETENTION,
  DEFAULT_RULES_INDEX_BODY,
  getDefaultQuota,
} from './defaults.js';
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
  dedup_threshold?: number;
  quota?: NamespaceQuota;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export class NamespaceExistsError extends Error {
  constructor(public readonly namespaceId: string) {
    super(`Namespace already exists: ${namespaceId}`);
    this.name = 'NamespaceExistsError';
  }
}

export class NamespaceNotFoundError extends Error {
  constructor(public readonly namespaceId: string) {
    super(`Namespace not found: ${namespaceId}`);
    this.name = 'NamespaceNotFoundError';
  }
}

/** Canonical namespace-id shape (kebab-case, 3–64 chars). */
const NAMESPACE_ID_REGEX = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Validate a namespace id before it reaches the filesystem. Callers that take an
 * id from an untrusted boundary (e.g. the admin BFF `:id` param) MUST gate on this
 * first — `namespaceDir` joins the id raw, so an unchecked id with encoded slashes
 * / `..` could escape `dataDir/namespaces/`.
 */
export function isValidNamespaceId(id: string): boolean {
  return NAMESPACE_ID_REGEX.test(id);
}

export function namespaceDir(dataDir: string, id: string): string {
  return join(dataDir, 'namespaces', id);
}

function deletedDir(dataDir: string): string {
  return join(dataDir, '_deleted');
}

/**
 * Creates a namespace skeleton atomically:
 * 1. Write all files into a temp directory `data/namespaces/.tmp-<id>-<random>/`
 * 2. Rename (atomic on same filesystem) to `data/namespaces/<id>/`
 * 3. If target already exists → throw NamespaceExistsError
 * 4. Clean up any leftover temp dir from a previous failed run
 */
export async function createNamespaceSkeleton(
  dataDir: string,
  spec: CreateNamespaceSpec,
): Promise<Namespace> {
  const now = (spec.now ?? (() => new Date()))().toISOString();
  const nsDir = join(dataDir, 'namespaces');
  const dir = namespaceDir(dataDir, spec.id);
  const tmpDir = join(nsDir, `.tmp-${spec.id}-${createId()}`);

  const namespace: Namespace = {
    id: spec.id,
    display_name: spec.display_name,
    owner_agent_id: spec.owner_agent_id,
    visibility: 'private',
    retention_policy: spec.retention_policy ?? DEFAULT_RETENTION,
    dedup_threshold: spec.dedup_threshold ?? DEFAULT_DEDUP_THRESHOLD,
    // ADR-0006 §3.4/§3.6 lifecycle config — written explicitly so new namespace
    // files carry the full shape (#27 foundation).
    ...DEFAULT_LIFECYCLE,
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

  // Ensure parent exists.
  await mkdir(nsDir, { recursive: true });

  // Clean up any leftover temp dir with the same id prefix (from a previous failed run).
  // We enumerate the namespaces dir and remove matching .tmp- dirs.
  try {
    const entries = await readdir(nsDir);
    const prefix = `.tmp-${spec.id}-`;
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        await rm(join(nsDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // If readdir fails (no parent yet), ignore — mkdir above will have created it.
  }

  // Check if target already exists.
  if (await dirExists(dir)) {
    throw new NamespaceExistsError(spec.id);
  }

  // Write everything into the temp dir.
  await mkdir(tmpDir, { recursive: true });
  await mkdir(join(tmpDir, 'rules'), { recursive: true });
  await mkdir(join(tmpDir, 'audit'), { recursive: true });

  await writeFile(
    join(tmpDir, '_namespace.json'),
    `${JSON.stringify(namespace, null, 2)}\n`,
  );
  await writeFile(
    join(tmpDir, '_members.json'),
    `${JSON.stringify(members, null, 2)}\n`,
  );
  await writeFile(
    join(tmpDir, '_quota.json'),
    `${JSON.stringify({ usage: {}, last_reset: now }, null, 2)}\n`,
  );
  await writeFile(join(tmpDir, 'rules', 'INDEX.md'), DEFAULT_RULES_INDEX_BODY);

  // Atomic rename: will fail if target exists (created between our check and rename).
  // On Linux/macOS rename(2) replaces an empty dir — we rely on the pre-check above
  // and accept the small TOCTOU window in exchange for simplicity (single-process server).
  await rename(tmpDir, dir);

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

/**
 * List all namespace IDs in the data directory.
 * Returns IDs of directories that contain a _namespace.json file.
 */
export async function listNamespaceIds(dataDir: string): Promise<string[]> {
  const nsDir = join(dataDir, 'namespaces');
  let entries: string[];
  try {
    entries = await readdir(nsDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // skip .tmp- dirs and hidden files
    const nsFile = join(nsDir, entry, '_namespace.json');
    if (await fileExists(nsFile)) {
      ids.push(entry);
    }
  }
  return ids;
}

/**
 * Save the full members list for a namespace.
 */
export async function saveMembers(
  dataDir: string,
  id: string,
  members: NamespaceMember[],
): Promise<void> {
  const path = join(namespaceDir(dataDir, id), '_members.json');
  const data: NamespaceMembers = { members };
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

// Per-namespace lock — serializes member read-modify-write so concurrent
// share/unshare requests can't clobber each other (parity with the rules store).
const memberLocks = new Map<string, Promise<void>>();

async function withMembersLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = memberLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => next);
  memberLocks.set(id, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (memberLocks.get(id) === chained) memberLocks.delete(id);
  }
}

/**
 * Add a member, or update the scopes of an existing one, under a per-namespace
 * lock. Preserves the original `added_by`/`added_at` for an existing member.
 */
export async function upsertMember(
  dataDir: string,
  id: string,
  input: { agent_id: string; scopes: AgentScope[]; addedBy: string; now?: string },
): Promise<NamespaceMember> {
  return withMembersLock(id, async () => {
    const members = (await loadMembers(dataDir, id)) ?? [];
    const existing = members.find((m) => m.agent_id === input.agent_id);
    const member: NamespaceMember = {
      agent_id: input.agent_id,
      scopes: [...input.scopes],
      added_by: existing?.added_by ?? input.addedBy,
      added_at: existing?.added_at ?? input.now ?? new Date().toISOString(),
    };
    const next = existing
      ? members.map((m) => (m.agent_id === member.agent_id ? member : m))
      : [...members, member];
    await saveMembers(dataDir, id, next);
    return member;
  });
}

/** Remove a member under the per-namespace lock. Returns how many were removed. */
export async function removeMember(dataDir: string, id: string, agentId: string): Promise<number> {
  return withMembersLock(id, async () => {
    const members = (await loadMembers(dataDir, id)) ?? [];
    const next = members.filter((m) => m.agent_id !== agentId);
    if (next.length !== members.length) await saveMembers(dataDir, id, next);
    return members.length - next.length;
  });
}

/**
 * Save the namespace metadata file (_namespace.json).
 */
export async function saveNamespace(
  dataDir: string,
  ns: Namespace,
): Promise<void> {
  const path = join(namespaceDir(dataDir, ns.id), '_namespace.json');
  await writeFile(path, `${JSON.stringify(ns, null, 2)}\n`);
}

/**
 * Soft-delete a namespace: moves `data/namespaces/<id>/` to
 * `data/_deleted/<id>-<unix_ms>/`.
 *
 * The 30-day hard-delete grace period is a future ops concern — no cron is
 * implemented here. The deleted directory is preserved indefinitely until an
 * operator manually runs a cleanup job (see issue #10 / ops runbook).
 *
 * Throws NamespaceNotFoundError if the source directory does not exist.
 */
export async function softDeleteNamespace(
  dataDir: string,
  id: string,
  nowMs?: number,
): Promise<string> {
  const src = namespaceDir(dataDir, id);
  if (!(await dirExists(src))) {
    throw new NamespaceNotFoundError(id);
  }
  const ts = nowMs ?? Date.now();
  const dest = join(deletedDir(dataDir), `${id}-${ts}`);
  await mkdir(deletedDir(dataDir), { recursive: true });
  await rename(src, dest);
  return dest;
}

/**
 * Walk all namespace _members.json files and remove entries matching the
 * given agentIdentity. Returns a list of { namespaceId, removed } tuples
 * for namespaces where at least one entry was pruned.
 */
export async function pruneOrphanedMembers(
  dataDir: string,
  revokedAgentIdentity: string,
): Promise<{ namespaceId: string; removed: number }[]> {
  const ids = await listNamespaceIds(dataDir);
  const result: { namespaceId: string; removed: number }[] = [];

  for (const id of ids) {
    const members = await loadMembers(dataDir, id);
    if (!members) continue;
    const filtered = members.filter((m) => m.agent_id !== revokedAgentIdentity);
    const removed = members.length - filtered.length;
    if (removed > 0) {
      await saveMembers(dataDir, id, filtered);
      result.push({ namespaceId: id, removed });
    }
  }

  return result;
}

async function readJsonIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const s = await stat(path);
    return s.isDirectory();
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const s = await stat(path);
    return s.isFile();
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
