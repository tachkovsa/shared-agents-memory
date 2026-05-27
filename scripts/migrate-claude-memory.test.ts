/**
 * scripts/migrate-claude-memory.test.ts
 *
 * Tests for the Claude Code memory migration script.
 * Each test runs against a temp source dir + temp data dir so nothing touches
 * the real ~/.claude/ or data/ directories.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNamespaceSkeleton } from '../src/namespaces/store.js';
import { loadRule } from '../src/rules/store.js';
import {
  migrate,
  MigrationError,
  parseSourceFile,
  stemToRuleId,
  stemToTitle,
  type MigrationOptions,
} from './migrate-claude-memory.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let sourceDir: string;
let dataDir: string;

const NAMESPACE = 'personal';

beforeEach(async () => {
  const base = join(tmpdir(), 'sam-migrate-test-');
  sourceDir = await mkdtemp(base + 'src-');
  dataDir = await mkdtemp(base + 'data-');

  await createNamespaceSkeleton(dataDir, {
    id: NAMESPACE,
    display_name: 'Personal',
    owner_agent_id: 'agent_test',
    owner_scopes: ['rules:read', 'rules:write'],
  });
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

describe('stemToRuleId', () => {
  it('converts snake_case to kebab-case', () => {
    expect(stemToRuleId('user_role')).toBe('user-role');
  });

  it('lowercases uppercase characters', () => {
    expect(stemToRuleId('UserRole')).toBe('userrole');
  });

  it('converts dots and spaces to hyphens', () => {
    expect(stemToRuleId('my.file name')).toBe('my-file-name');
  });

  it('returns null for stems that produce a too-short id', () => {
    expect(stemToRuleId('ab')).toBeNull(); // 2 chars — RULE_ID_REGEX needs ≥3
  });

  it('returns null for stems that collapse to empty', () => {
    expect(stemToRuleId('---')).toBeNull();
  });

  it('trims leading/trailing hyphens', () => {
    expect(stemToRuleId('_foo_bar_')).toBe('foo-bar');
  });
});

describe('stemToTitle', () => {
  it('converts snake_case to spaced words', () => {
    expect(stemToTitle('user_role')).toBe('user role');
  });

  it('converts kebab-case to spaced words', () => {
    expect(stemToTitle('no-bot-comments')).toBe('no bot comments');
  });
});

describe('parseSourceFile', () => {
  it('returns empty frontmatter and full text as body for plain markdown', () => {
    const raw = '# Hello\n\nSome content.\n';
    const { frontmatter, body } = parseSourceFile(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('parses valid YAML frontmatter and body', () => {
    const raw = '---\nname: my-rule\ntags: [foo, bar]\n---\nBody here.\n';
    const { frontmatter, body } = parseSourceFile(raw);
    expect(frontmatter).toMatchObject({ name: 'my-rule', tags: ['foo', 'bar'] });
    expect(body).toBe('Body here.\n');
  });

  it('falls back to full-content body when frontmatter is malformed', () => {
    const raw = '---\n: bad: yaml: [\n---\n\nBody.\n';
    const { body } = parseSourceFile(raw);
    // Malformed YAML — whole raw content becomes body.
    expect(body).toBe(raw);
  });

  it('falls back to full-content body when closing --- is missing', () => {
    const raw = '---\nname: x\n\nNo closing delimiter.\n';
    const { frontmatter, body } = parseSourceFile(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Integration: dry-run
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('reports correct counts without writing any rules', async () => {
    await writeFile(join(sourceDir, 'no_bot_comments.md'), '# Body\n\nContent.\n');
    await writeFile(join(sourceDir, 'use_squash_merge.md'), '# Body\n\nContent.\n');
    await writeFile(join(sourceDir, 'MEMORY.md'), '- [no_bot_comments](no_bot_comments.md)\n');

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: true,
      verbose: false,
    };

    const summary = await migrate(opts);

    // MEMORY.md is skipped; 2 files should be reported as "would create".
    expect(summary.created).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.unchanged).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toHaveLength(0);

    // Confirm nothing was actually written.
    const entries = await readdir(join(dataDir, 'namespaces', NAMESPACE, 'rules'));
    const ruleFiles = entries.filter((e) => e !== 'INDEX.md' && e.endsWith('.md'));
    expect(ruleFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: live run
// ---------------------------------------------------------------------------

describe('live run', () => {
  it('creates rules from source markdown files', async () => {
    await writeFile(
      join(sourceDir, 'no_bot_comments.md'),
      '# Do not post bot comments\n\nContent here.\n',
    );
    await writeFile(
      join(sourceDir, 'use_squash_merge.md'),
      '---\nname: use-squash-merge\ntags:\n  - git\n---\nPrefer squash.\n',
    );

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    const summary = await migrate(opts);

    expect(summary.created).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.unchanged).toBe(0);
    expect(summary.errors).toHaveLength(0);

    const rule1 = await loadRule(dataDir, NAMESPACE, 'no-bot-comments');
    expect(rule1).not.toBeNull();
    // No frontmatter in source → title inferred from filename stem.
    expect(rule1?.frontmatter.title).toBe('no bot comments');

    const rule2 = await loadRule(dataDir, NAMESPACE, 'use-squash-merge');
    expect(rule2).not.toBeNull();
    expect(rule2?.frontmatter.tags).toEqual(['git']);
    expect(rule2?.body).toBe('Prefer squash.\n');
  });

  it('infers title, tags, and severity from filename when frontmatter is absent', async () => {
    await writeFile(
      join(sourceDir, 'my_hard_rule.md'),
      '# Rule body without frontmatter.\n',
    );

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    await migrate(opts);

    const rule = await loadRule(dataDir, NAMESPACE, 'my-hard-rule');
    expect(rule).not.toBeNull();
    expect(rule?.frontmatter.title).toBe('my hard rule');
    expect(rule?.frontmatter.tags).toEqual([]);
    expect(rule?.frontmatter.severity).toBe('hard');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('re-running on the same source is a no-op after a successful import', async () => {
    await writeFile(
      join(sourceDir, 'my_rule.md'),
      '# Rule\n\nContent.\n',
    );

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    const first = await migrate(opts);
    expect(first.created).toBe(1);

    const second = await migrate(opts);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.errors).toHaveLength(0);
  });

  it('updates a rule when its content changes on re-run', async () => {
    const filePath = join(sourceDir, 'my_rule.md');
    await writeFile(filePath, '# Rule\n\nOriginal content.\n');

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    await migrate(opts);

    // Change the source file content.
    await writeFile(filePath, '# Rule\n\nUpdated content.\n');

    const second = await migrate(opts);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);

    const rule = await loadRule(dataDir, NAMESPACE, 'my-rule');
    // No frontmatter in source → whole file content is the body.
    expect(rule?.body).toBe('# Rule\n\nUpdated content.\n');
  });
});

// ---------------------------------------------------------------------------
// MEMORY.md skipping
// ---------------------------------------------------------------------------

describe('MEMORY.md skipping', () => {
  it('always skips MEMORY.md even when other files are present', async () => {
    await writeFile(join(sourceDir, 'MEMORY.md'), '- [some rule](some_rule.md)\n');
    await writeFile(join(sourceDir, 'some_rule.md'), '# Some rule\n\nContent.\n');

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    const summary = await migrate(opts);

    expect(summary.created).toBe(1); // only some_rule.md
    expect(summary.errors).toHaveLength(0);

    // MEMORY.md must not appear as a rule.
    const memoryRule = await loadRule(dataDir, NAMESPACE, 'memory');
    expect(memoryRule).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error conditions
// ---------------------------------------------------------------------------

describe('error conditions', () => {
  it('throws MigrationError when source directory does not exist', async () => {
    const opts: MigrationOptions = {
      sourceDir: '/tmp/this-path-does-not-exist-sam-migrate',
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    await expect(migrate(opts)).rejects.toBeInstanceOf(MigrationError);
  });

  it('throws MigrationError when target namespace does not exist', async () => {
    await writeFile(join(sourceDir, 'some_rule.md'), '# Rule\n\nContent.\n');

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: 'nonexistent-namespace',
      dataDir,
      dryRun: false,
      verbose: false,
    };

    await expect(migrate(opts)).rejects.toBeInstanceOf(MigrationError);
  });

  it('skips files whose names cannot be turned into a valid rule ID', async () => {
    // A two-character stem collapses to an ID shorter than 3 chars (RULE_ID_REGEX requires ≥3).
    await writeFile(join(sourceDir, 'ab.md'), '# Too short\n');
    await writeFile(join(sourceDir, 'valid_rule.md'), '# Valid\n\nContent.\n');

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    const summary = await migrate(opts);
    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Claude Code memory format (custom frontmatter structure)
// ---------------------------------------------------------------------------

describe('Claude Code memory format', () => {
  it('handles Claude Code memory files with name+description+metadata frontmatter', async () => {
    const content = [
      '---',
      'name: my-preference',
      'description: "A user preference."',
      'metadata:',
      '  node_type: memory',
      '  type: feedback',
      '---',
      '',
      'Always prefer squash merges in this repo.',
      '',
    ].join('\n');

    await writeFile(join(sourceDir, 'my_preference.md'), content);

    const opts: MigrationOptions = {
      sourceDir,
      namespaceId: NAMESPACE,
      dataDir,
      dryRun: false,
      verbose: false,
    };

    const summary = await migrate(opts);
    expect(summary.created).toBe(1);

    const rule = await loadRule(dataDir, NAMESPACE, 'my-preference');
    expect(rule).not.toBeNull();
    // Title inferred from `name` frontmatter field.
    expect(rule?.frontmatter.title).toBe('my-preference');
    // Body is the content after the frontmatter block.
    expect(rule?.body).toContain('Always prefer squash merges');
  });
});
