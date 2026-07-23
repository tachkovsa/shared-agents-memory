import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type AuthAuditEvent =
  | 'auth.success'
  | 'auth.failure'
  | 'pat.minted'
  | 'pat.revoked'
  | 'auth.rate_limited'
  | 'namespace.member_removed'
  | 'namespace.vector_purge_failed'
  | 'namespace.hard_deleted';

export interface AuditWriterOptions {
  path: string;
  successSampleRate?: number;
  random?: () => number;
  now?: () => Date;
}

export interface AuditLine {
  ts: string;
  event: AuthAuditEvent;
  details: Record<string, unknown>;
}

export const SAMPLE_RATE_ENV_VAR = 'AUDIT_SUCCESS_SAMPLE_RATE';
export const DEFAULT_SUCCESS_SAMPLE_RATE = 0.1;

export function auditPathForDataDir(dataDir: string): string {
  return join(dataDir, '_auth', 'audit.jsonl');
}

export function resolveSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SAMPLE_RATE_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_SUCCESS_SAMPLE_RATE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `${SAMPLE_RATE_ENV_VAR} must be a number in [0, 1], got: ${raw}`,
    );
  }
  return value;
}

export class AuthAuditWriter {
  private readonly path: string;
  private readonly successSampleRate: number;
  private readonly random: () => number;
  private readonly now: () => Date;

  constructor(opts: AuditWriterOptions) {
    this.path = opts.path;
    this.successSampleRate = opts.successSampleRate ?? DEFAULT_SUCCESS_SAMPLE_RATE;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => new Date());
  }

  async record(
    event: AuthAuditEvent,
    details: Record<string, unknown>,
  ): Promise<boolean> {
    if (event === 'auth.success' && this.random() >= this.successSampleRate) {
      return false;
    }
    const line: AuditLine = {
      ts: this.now().toISOString(),
      event,
      details,
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  }
}
