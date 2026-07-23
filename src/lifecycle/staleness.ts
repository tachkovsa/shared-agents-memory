/**
 * Staleness auditor (ADR-0006 §3.6).
 *
 * Nightly sweep: for each namespace with `staleness_audit_enabled`, scroll up
 * to `staleness_audit_batch_size` non-deleted, non-immortal points that carry a
 * `verifies_against` reference, re-check the external reference, and write back
 * `staleness_signal` + `verifies_against.captured_at = now`.
 *
 * The audit WARNS; it never gates or deletes.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { resolveLifecycle } from '../namespaces/defaults.js';
import { listNamespaceIds, loadNamespace } from '../namespaces/store.js';
import { payloadToMemory } from '../memory/service.js';
import type { StalenessSignal, VerifiesAgainst } from '../memory/types.js';
import { stalenessAuditTotal } from '../metrics/registry.js';

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const URL_HEAD_TIMEOUT_MS = 5000;

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

/** True when `target` is the root itself or lives beneath it. */
function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * Conservative guard for a writer-supplied git commit-ish before it reaches
 * `git`. Accepts SHAs and ordinary branch/tag names; rejects anything that
 * could be read as an option (leading '-') or shell/path trickery. Paired with
 * `--end-of-options` at the call site (defence in depth).
 */
function isSafeGitRef(ref: string): boolean {
  return /^[0-9a-zA-Z][0-9a-zA-Z._/-]*$/.test(ref) && !ref.includes('..');
}

// ── SSRF guard (issue #103 / SEC-2) ───────────────────────────────────────────
//
// The url staleness checker fetches a WRITER-supplied URL. Without a guard this
// is a blind-SSRF oracle: any `memory:write` PAT can plant a URL pointing at
// loopback / RFC1918 / link-local / cloud-metadata (169.254.169.254) and read
// the reachability back out via `staleness_signal` (200→fresh, 404→broken_ref).
//
// Defence: allow only http/https, resolve the host via DNS, and reject if ANY
// resolved address falls in a blocked range. `redirect: 'manual'` at the fetch
// site stops a public host from 30x-redirecting into an internal address.

/** Parse a dotted-quad IPv4 literal into an unsigned 32-bit int, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/**
 * True if an IPv4 address is one we must never let the auditor reach.
 * Ranges: 0.0.0.0/8 (this-network/unspecified), 10/8·172.16/12·192.168/16
 * (RFC1918 private), 100.64/10 (CGNAT), 127/8 (loopback), 169.254/16
 * (link-local incl. cloud metadata 169.254.169.254), 224/4 (multicast),
 * 240/4 (reserved incl. 255.255.255.255 broadcast). Unparseable → blocked.
 */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    // /0 has an all-zero mask (a plain `<<32` would be a no-op in JS).
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  };
  return (
    inRange('0.0.0.0', 8) || // this-network / unspecified
    inRange('10.0.0.0', 8) || // RFC1918
    inRange('100.64.0.0', 10) || // CGNAT (RFC6598)
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local / cloud metadata
    inRange('172.16.0.0', 12) || // RFC1918
    inRange('192.168.0.0', 16) || // RFC1918
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved / broadcast
  );
}

/** Expand any IPv6 literal (incl. `::`, zone id, embedded IPv4) to 16 bytes. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.split('%')[0]; // strip zone id (fe80::1%eth0)
  let tailGroups: number[] = [];
  if (s.includes('.')) {
    // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) — fold into two 16-bit groups.
    const idx = s.lastIndexOf(':');
    const v4 = ipv4ToInt(s.slice(idx + 1));
    if (v4 === null) return null;
    tailGroups = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    s = s.slice(0, idx); // may leave a trailing ':' (from '::ffff:')
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const h of side.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parseSide(halves[0]);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const back = parseSide(halves[1]);
    if (back === null) return null;
    const fill = 8 - head.length - back.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...back, ...tailGroups];
  } else {
    groups = [...head, ...tailGroups];
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!Number.isInteger(g) || g < 0 || g > 0xffff) return null;
    bytes.push((g >>> 8) & 0xff, g & 0xff);
  }
  return bytes;
}

/**
 * True if an IPv6 address must be blocked. Covers :: (unspecified), ::1
 * (loopback), fe80::/10 (link-local), fc00::/7 (unique-local), ff00::/8
 * (multicast), and IPv4-mapped/compatible addresses (delegated to the IPv4
 * rules). Unparseable → blocked.
 */
function isBlockedIpv6FromBytes(bytes: number[]): boolean {
  // ::  (all zero) and ::1
  if (bytes.every((b) => b === 0)) return true;
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 — check the tail as v4.
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes.slice(0, 12).every((b) => b === 0)) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * True if `ip` (an IPv4 or IPv6 literal) is an address the staleness auditor
 * must refuse to reach — SSRF guard for issue #103. Anything that is not a
 * valid IP literal is treated as blocked (fail closed). Exported for tests.
 */
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) {
    const bytes = expandIpv6(ip);
    if (bytes === null) return true;
    return isBlockedIpv6FromBytes(bytes);
  }
  return true; // not a valid IP → block
}

// ── Checker interface ─────────────────────────────────────────────────────────

/**
 * Side-effecting checks for each verifies_against kind.
 * Injectable for deterministic tests.
 *
 * Return value semantics:
 *   - A concrete StalenessSignal: write it back to Qdrant.
 *   - null: leave the existing signal unchanged (e.g. network error, repo unreachable).
 */
export interface StalenessCheckers {
  file(
    ref: string,
    root: string,
    lastKnownValue?: string,
  ): Promise<StalenessSignal | null>;
  url(ref: string): Promise<StalenessSignal | null>;
  gitCommit(ref: string, root: string): Promise<StalenessSignal | null>;
}

// ── Default real checkers ─────────────────────────────────────────────────────

export const defaultStalenessCheckers: StalenessCheckers = {
  async file(ref, root, lastKnownValue) {
    // Resolve the root through symlinks first so containment is checked against
    // the real directory.
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      // Root missing/unreadable — cannot audit safely; leave signal unchanged.
      return null;
    }

    // Lexical pre-check (cheap reject of obvious `../` escapes).
    const candidate = resolve(realRoot, ref);
    if (!isInside(candidate, realRoot)) {
      return null;
    }

    // Resolve the target through symlinks and re-check containment — defeats a
    // symlink INSIDE the root that points outside it (lexical checks miss this).
    let realTarget: string;
    try {
      realTarget = await realpath(candidate);
    } catch (err: unknown) {
      if (isEnoent(err)) return 'broken_ref';
      // Other IO error — leave signal unchanged.
      return null;
    }
    if (!isInside(realTarget, realRoot)) {
      // Symlink escaped the root — refuse to read.
      return null;
    }

    let contents: Buffer;
    try {
      contents = await readFile(realTarget);
    } catch (err: unknown) {
      if (isEnoent(err)) return 'broken_ref';
      // Other IO error — leave signal unchanged.
      return null;
    }

    if (lastKnownValue !== undefined) {
      const sha = 'sha256:' + createHash('sha256').update(contents).digest('hex');
      return sha === lastKnownValue ? 'fresh' : 'stale';
    }

    // No digest to compare — mark fresh (file exists, no drift check possible).
    return 'fresh';
  },

  async url(ref) {
    // SSRF guard (issue #103). `ref` is writer-supplied.
    let parsed: URL;
    try {
      parsed = new URL(ref);
    } catch {
      return null; // unparseable — cannot audit
    }

    // 1) Scheme allowlist — only http/https (blocks file:, gopher:, ftp:, …).
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const host = parsed.hostname;
    if (!host) return null;

    // 2) Resolve the host and reject if ANY resolved address is internal.
    //
    // Residual risk (documented, out of scope for #103): DNS rebinding. The OS
    // re-resolves the name when `fetch` connects, so an attacker who flips the
    // record between this check and the connect could still reach an internal
    // address. A perfect connect-time pin (custom lookup/dispatcher) is out of
    // scope; validating every resolved address here plus `redirect: 'manual'`
    // below removes the practical, repeatable oracle.
    let addrs: Array<{ address: string }>;
    try {
      addrs = await dnsLookup(host, { all: true });
    } catch {
      return null; // DNS failure — cannot audit safely
    }
    if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
      return null;
    }

    try {
      const res = await fetch(ref, {
        method: 'HEAD',
        // Do NOT follow redirects: a 30x to an internal IP would bypass the DNS
        // check above. `manual` yields an opaqueredirect response (status 0)
        // which maps to neither fresh nor broken_ref → null (left unchanged).
        redirect: 'manual',
        signal: AbortSignal.timeout(URL_HEAD_TIMEOUT_MS),
      });
      if (res.status === 200) return 'fresh';
      if (res.status === 404) return 'broken_ref';
      // Anything else (5xx, redirect, rate-limit, etc.) — leave unchanged.
      return null;
    } catch {
      return null;
    }
  },

  async gitCommit(ref, root) {
    // `ref` is writer-controlled — reject anything that could be read as a git
    // option (e.g. "--upload-pack=...") before it reaches execFile. We also pass
    // `--end-of-options` so git never interprets it as a flag (git >= 2.24).
    if (!isSafeGitRef(ref)) return null;

    // Check if the commit is an ancestor of HEAD but not HEAD itself → stale.
    // - `git merge-base --is-ancestor <ref> HEAD` exits 0 if ref is ancestor, 1 if not.
    // - If they are equal (ref IS HEAD) we treat as fresh.
    try {
      // First, check if they are the same commit.
      const { stdout: headOut } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
      const head = headOut.trim();
      const { stdout: refOut } = await execFileAsync('git', [
        '-C',
        root,
        'rev-parse',
        '--end-of-options',
        ref,
      ]);
      const refResolved = refOut.trim();
      if (head === refResolved) return 'fresh';

      // Is ref an ancestor of HEAD?
      try {
        await execFileAsync('git', [
          '-C',
          root,
          'merge-base',
          '--is-ancestor',
          '--end-of-options',
          ref,
          'HEAD',
        ]);
        // Exit 0 → ref is ancestor of HEAD → HEAD has moved past it → stale.
        return 'stale';
      } catch {
        // Exit 1 → ref is NOT an ancestor — not in history (unknown commit or diverged).
        // Leave signal unchanged.
        return null;
      }
    } catch {
      // Repo unreachable or commit unknown — leave signal unchanged.
      return null;
    }
  },
};

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface StalenessStats {
  namespacesSwept: number;
  checked: number;
  byResult: Record<StalenessSignal | 'skipped', number>;
}

function emptyStalenessStats(): StalenessStats {
  return {
    namespacesSwept: 0,
    checked: 0,
    byResult: { fresh: 0, stale: 0, broken_ref: 0, unverified: 0, skipped: 0 },
  };
}

// ── Auditor class ─────────────────────────────────────────────────────────────

export interface StalenessAuditorDeps {
  qdrant: QdrantClient;
  collection: string;
  dataDir: string;
  now?: () => Date;
  intervalMs?: number;
  checkers?: StalenessCheckers;
}

export class StalenessAuditor {
  private readonly qdrant: QdrantClient;
  private readonly collection: string;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly checkers: StalenessCheckers;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard: a slow sweep must not be restarted by the next tick. */
  private sweeping = false;
  /**
   * Per-namespace scroll cursor. Each nightly run resumes from where the last
   * left off and wraps to the start when exhausted, so namespaces with more than
   * `staleness_audit_batch_size` eligible points are swept over several runs
   * instead of re-auditing the same first page forever.
   */
  private readonly cursors = new Map<string, string | number | Record<string, unknown> | null | undefined>();

  constructor(deps: StalenessAuditorDeps) {
    this.qdrant = deps.qdrant;
    this.collection = deps.collection;
    this.dataDir = deps.dataDir;
    this.now = deps.now ?? (() => new Date());
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.checkers = deps.checkers ?? defaultStalenessCheckers;
  }

  /** Start the periodic audit timer. Unref'd so it never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the timer. Does NOT flush a final run — the audit is best-effort. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single audit sweep across all namespaces.
   * Called by the timer AND directly from tests.
   */
  async runOnce(): Promise<StalenessStats> {
    if (this.sweeping) return emptyStalenessStats();
    this.sweeping = true;
    try {
      return await this.sweep();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<StalenessStats> {
    const stats = emptyStalenessStats();
    const nowIso = this.now().toISOString();

    let nsIds: string[];
    try {
      nsIds = await listNamespaceIds(this.dataDir);
    } catch {
      return stats;
    }

    for (const nsId of nsIds) {
      let ns;
      try {
        ns = await loadNamespace(this.dataDir, nsId);
      } catch {
        continue;
      }
      if (!ns) continue;

      const lifecycle = resolveLifecycle(ns);
      if (!lifecycle.staleness_audit_enabled) continue;

      stats.namespacesSwept++;

      const batchSize = lifecycle.staleness_audit_batch_size;
      const filesystemRoot = lifecycle.filesystem_audit_root;

      // Scroll points: has verifies_against set, not soft-deleted, not immortal.
      let points: Array<{
        id: string | number;
        payload?: Record<string, unknown> | null;
      }>;
      try {
        const result = await this.qdrant.scroll(this.collection, {
          filter: {
            must: [
              { key: 'namespace', match: { value: nsId } },
            ],
            must_not: [
              { is_null: { key: 'verifies_against' } },
              { is_empty: { key: 'verifies_against' } },
            ],
          },
          limit: batchSize,
          offset: this.cursors.get(nsId) ?? undefined,
          with_payload: true,
          with_vector: false,
        });
        points = result.points;
        // Resume from the next page next run; wrap to the start (undefined) when
        // this was the last page, so every eligible point is eventually swept.
        this.cursors.set(nsId, result.next_page_offset ?? undefined);
      } catch {
        continue;
      }

      for (const point of points) {
        const id = point.id as string;
        const payload = (point.payload ?? {}) as Record<string, unknown>;

        // Skip soft-deleted points.
        if (payload['deleted_at'] !== null && payload['deleted_at'] !== undefined) {
          stats.byResult['skipped']++;
          continue;
        }

        // Skip immortal points.
        const metadata = payload['metadata'];
        if (
          typeof metadata === 'object' &&
          metadata !== null &&
          (metadata as Record<string, unknown>)['immortal'] === true
        ) {
          stats.byResult['skipped']++;
          continue;
        }

        let memory;
        try {
          memory = payloadToMemory(id, payload);
        } catch {
          stats.byResult['skipped']++;
          continue;
        }

        const va = memory.verifiesAgainst;
        if (!va) {
          stats.byResult['skipped']++;
          continue;
        }

        stats.checked++;

        let newSignal: StalenessSignal | null = null;
        try {
          newSignal = await this.dispatchCheck(va, filesystemRoot);
        } catch {
          // Defensive: any uncaught error leaves signal unchanged.
          newSignal = null;
        }

        if (newSignal !== null) {
          // Write back signal and bump captured_at.
          try {
            const updatedVerifiesAgainst = {
              kind: va.kind,
              ref: va.ref,
              captured_at: nowIso,
              ...(va.lastKnownValue !== undefined
                ? { last_known_value: va.lastKnownValue }
                : {}),
            };
            await this.qdrant.setPayload(this.collection, {
              wait: false,
              payload: {
                staleness_signal: newSignal,
                verifies_against: updatedVerifiesAgainst,
              },
              points: [id],
            });
          } catch {
            // Best-effort; skip write-back failures.
          }

          stats.byResult[newSignal] = (stats.byResult[newSignal] ?? 0) + 1;
          stalenessAuditTotal.inc({ result: newSignal });
        } else {
          stats.byResult['skipped']++;
          stalenessAuditTotal.inc({ result: 'skipped' });
        }
      }
    }

    return stats;
  }

  private async dispatchCheck(
    va: VerifiesAgainst,
    filesystemRoot: string | null,
  ): Promise<StalenessSignal | null> {
    switch (va.kind) {
      case 'file': {
        if (filesystemRoot === null) return null; // no root configured — skip
        return this.checkers.file(va.ref, filesystemRoot, va.lastKnownValue);
      }
      case 'url': {
        return this.checkers.url(va.ref);
      }
      case 'git_commit': {
        if (filesystemRoot === null) return null; // no repo root configured — skip
        return this.checkers.gitCommit(va.ref, filesystemRoot);
      }
    }
  }
}
