import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import {
  generateToken,
  hashSecret,
  parseToken,
  safeEqualHex,
  TOKEN_NAMESPACE,
} from './hash.js';
import type {
  AgentPat,
  AgentScope,
  LookupResult,
  MintInput,
  MintResult,
  PatRecord,
} from './types.js';

export const DEFAULT_CACHE_TTL_MS = 60_000;

export interface PatStoreOptions {
  storePath: string;
  pepper: Buffer;
  cacheTtlMs?: number;
  now?: () => Date;
}

interface CacheEntry {
  pat: AgentPat;
  expiresAt: number;
}

export class PatStore {
  private readonly storePath: string;
  private readonly pepper: Buffer;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly byId = new Map<string, AgentPat>();
  private readonly byPrefix = new Map<string, Set<string>>();
  private readonly cache = new Map<string, CacheEntry>();

  private constructor(opts: PatStoreOptions) {
    this.storePath = opts.storePath;
    this.pepper = opts.pepper;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  static async open(opts: PatStoreOptions): Promise<PatStore> {
    const store = new PatStore(opts);
    await store.load();
    return store;
  }

  async mint(input: MintInput): Promise<MintResult> {
    const token = generateToken();
    const secret = token.slice(TOKEN_NAMESPACE.length);
    const prefix = secret.slice(0, 12);
    const hash = hashSecret(secret, this.pepper);
    const createdAt = this.now().toISOString();

    const pat: AgentPat = {
      id: createId(),
      display_name: input.display_name,
      token_prefix: prefix,
      token_hash: hash,
      agent_identity: input.agent_identity,
      allowed_namespaces: [...input.allowed_namespaces],
      scopes: [...input.scopes] as AgentScope[],
      created_at: createdAt,
      created_by: input.created_by,
      expires_at: input.expires_at ?? null,
      last_used_at: null,
      is_revoked: false,
      revoked_at: null,
      revoked_reason: null,
    };

    await this.append(pat);
    this.index(pat);
    return { pat, secret: token };
  }

  async revoke(patId: string, reason: string): Promise<AgentPat> {
    const current = this.byId.get(patId);
    if (!current) {
      throw new PatNotFoundError(patId);
    }
    if (current.is_revoked) return current;

    const updated: AgentPat = {
      ...current,
      is_revoked: true,
      revoked_at: this.now().toISOString(),
      revoked_reason: reason,
    };
    await this.append(updated, { supersedes: patId });
    this.index(updated);
    this.invalidateCacheForId(patId);
    return updated;
  }

  lookup(rawToken: string): LookupResult {
    const parsed = parseToken(rawToken);
    if (!parsed) return { ok: false, reason: 'malformed' };

    const cached = this.cache.get(parsed.secret);
    if (cached && cached.expiresAt > this.now().getTime()) {
      return this.evaluate(cached.pat, parsed.prefix);
    }
    if (cached) this.cache.delete(parsed.secret);

    const candidateIds = this.byPrefix.get(parsed.prefix);
    if (!candidateIds || candidateIds.size === 0) {
      return { ok: false, reason: 'unknown', token_prefix: parsed.prefix };
    }

    const hash = hashSecret(parsed.secret, this.pepper);
    for (const id of candidateIds) {
      const pat = this.byId.get(id);
      if (!pat) continue;
      if (!safeEqualHex(pat.token_hash, hash)) continue;
      this.cache.set(parsed.secret, {
        pat,
        expiresAt: this.now().getTime() + this.cacheTtlMs,
      });
      return this.evaluate(pat, parsed.prefix);
    }
    return { ok: false, reason: 'unknown', token_prefix: parsed.prefix };
  }

  list(): AgentPat[] {
    return Array.from(this.byId.values());
  }

  get(id: string): AgentPat | undefined {
    return this.byId.get(id);
  }

  private evaluate(pat: AgentPat, prefix: string): LookupResult {
    if (pat.is_revoked) {
      return { ok: false, reason: 'revoked', token_prefix: prefix };
    }
    if (pat.expires_at && Date.parse(pat.expires_at) <= this.now().getTime()) {
      return { ok: false, reason: 'expired', token_prefix: prefix };
    }
    return { ok: true, pat };
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.storePath, 'utf8');
    } catch (err) {
      if (isEnoent(err)) {
        await mkdir(dirname(this.storePath), { recursive: true });
        return;
      }
      throw err;
    }
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const record = JSON.parse(trimmed) as PatRecord;
      this.index(record);
    }
  }

  private async append(pat: AgentPat, meta?: { supersedes?: string }): Promise<void> {
    const record: PatRecord = meta?.supersedes ? { ...pat, _supersedes: meta.supersedes } : pat;
    await mkdir(dirname(this.storePath), { recursive: true });
    await appendFile(this.storePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  private index(pat: AgentPat): void {
    const previous = this.byId.get(pat.id);
    if (previous && previous.token_prefix !== pat.token_prefix) {
      const set = this.byPrefix.get(previous.token_prefix);
      set?.delete(pat.id);
      if (set && set.size === 0) this.byPrefix.delete(previous.token_prefix);
    }
    this.byId.set(pat.id, pat);
    let set = this.byPrefix.get(pat.token_prefix);
    if (!set) {
      set = new Set();
      this.byPrefix.set(pat.token_prefix, set);
    }
    set.add(pat.id);
  }

  private invalidateCacheForId(id: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.pat.id === id) this.cache.delete(key);
    }
  }
}

export class PatNotFoundError extends Error {
  constructor(patId: string) {
    super(`PAT not found: ${patId}`);
    this.name = 'PatNotFoundError';
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
