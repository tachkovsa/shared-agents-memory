import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthAuditWriter,
  DEFAULT_SUCCESS_SAMPLE_RATE,
  resolveSampleRate,
} from './audit.js';

let workDir: string;
let auditPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-audit-'));
  auditPath = join(workDir, '_auth', 'audit.jsonl');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('AuthAuditWriter.record', () => {
  it('writes every auth.failure line at full rate', async () => {
    const writer = new AuthAuditWriter({
      path: auditPath,
      successSampleRate: 0,
      random: () => 0.99,
      now: () => new Date('2026-05-27T12:00:00Z'),
    });
    expect(await writer.record('auth.failure', { reason: 'unknown' })).toBe(true);
    expect(await writer.record('auth.failure', { reason: 'revoked' })).toBe(true);

    const raw = await readFile(auditPath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe('auth.failure');
    expect(parsed.ts).toBe('2026-05-27T12:00:00.000Z');
    expect(parsed.details.reason).toBe('unknown');
  });

  it('drops auth.success lines when random >= sample rate', async () => {
    const writer = new AuthAuditWriter({
      path: auditPath,
      successSampleRate: 0.1,
      random: () => 0.5,
    });
    expect(await writer.record('auth.success', { agent_identity: 'x' })).toBe(false);
  });

  it('keeps auth.success lines when random < sample rate', async () => {
    const writer = new AuthAuditWriter({
      path: auditPath,
      successSampleRate: 0.1,
      random: () => 0.05,
    });
    expect(await writer.record('auth.success', { agent_identity: 'x' })).toBe(true);
  });

  it('does not sample non-auth.success events', async () => {
    const writer = new AuthAuditWriter({
      path: auditPath,
      successSampleRate: 0,
      random: () => 0.99,
    });
    expect(await writer.record('pat.minted', { pat_id: 'p1' })).toBe(true);
    expect(await writer.record('pat.revoked', { pat_id: 'p1' })).toBe(true);
    expect(await writer.record('auth.rate_limited', { remote_addr: '1' })).toBe(true);
  });
});

describe('resolveSampleRate', () => {
  it('returns the default when env var is unset', () => {
    expect(resolveSampleRate({})).toBe(DEFAULT_SUCCESS_SAMPLE_RATE);
  });

  it('parses a valid env value', () => {
    expect(resolveSampleRate({ AUDIT_SUCCESS_SAMPLE_RATE: '0.5' })).toBe(0.5);
  });

  it('rejects out-of-range values', () => {
    expect(() =>
      resolveSampleRate({ AUDIT_SUCCESS_SAMPLE_RATE: '2' }),
    ).toThrow(/\[0, 1\]/);
  });

  it('rejects non-numeric values', () => {
    expect(() =>
      resolveSampleRate({ AUDIT_SUCCESS_SAMPLE_RATE: 'half' }),
    ).toThrow(/\[0, 1\]/);
  });
});
