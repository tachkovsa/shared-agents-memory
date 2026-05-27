import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNamespaceSkeleton } from '../namespaces/store.js';
import {
  deleteRule,
  InvalidRuleIdError,
  listRules,
  loadRule,
  regenerateIndex,
  RuleNotFoundError,
  upsertRule,
} from './store.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sam-rules-'));
  await createNamespaceSkeleton(workDir, {
    id: 'personal',
    display_name: 'Personal',
    owner_agent_id: 'agent_owner',
    owner_scopes: ['rules:read', 'rules:write'],
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('upsertRule + loadRule', () => {
  it('writes a rule that round-trips through loadRule', async () => {
    const written = await upsertRule(workDir, 'personal', {
      ruleId: 'no-bot-comments',
      title: 'Do not post bot comments',
      body: '# Why\n\nWe said so.\n',
      tags: ['github'],
      severity: 'hard',
      createdBy: 'agent_owner',
    });
    const loaded = await loadRule(workDir, 'personal', 'no-bot-comments');
    expect(loaded).not.toBeNull();
    expect(loaded?.frontmatter.id).toBe('no-bot-comments');
    expect(loaded?.frontmatter.title).toBe(written.frontmatter.title);
    expect(loaded?.body).toBe(written.body);
  });

  it('updates created_at on first write and leaves it stable on second', async () => {
    let now = new Date('2026-05-27T12:00:00Z');
    await upsertRule(workDir, 'personal', {
      ruleId: 'rule-1',
      title: 'first',
      body: 'b1',
      createdBy: 'agent_owner',
      now: () => now,
    });
    const first = await loadRule(workDir, 'personal', 'rule-1');
    const firstCreatedAt = first?.frontmatter.created_at;
    now = new Date('2026-05-28T12:00:00Z');
    await upsertRule(workDir, 'personal', {
      ruleId: 'rule-1',
      title: 'second',
      body: 'b2',
      createdBy: 'agent_owner',
      now: () => now,
    });
    const second = await loadRule(workDir, 'personal', 'rule-1');
    expect(second?.frontmatter.created_at).toBe(firstCreatedAt);
    expect(second?.frontmatter.updated_at).not.toBe(firstCreatedAt);
    expect(second?.frontmatter.title).toBe('second');
  });

  it('rejects invalid rule ids', async () => {
    await expect(
      upsertRule(workDir, 'personal', {
        ruleId: 'Has Caps',
        title: 't',
        body: '',
        createdBy: 'agent_owner',
      }),
    ).rejects.toBeInstanceOf(InvalidRuleIdError);
  });

  it('leaves no .tmp files behind on success', async () => {
    await upsertRule(workDir, 'personal', {
      ruleId: 'clean',
      title: 't',
      body: '',
      createdBy: 'agent_owner',
    });
    const entries = await readdir(join(workDir, 'namespaces', 'personal', 'rules'));
    for (const e of entries) expect(e).not.toMatch(/\.tmp/);
  });
});

describe('upsertRule lock serialization', () => {
  it('serializes concurrent writes to the same rule', async () => {
    // Fire 5 concurrent updates; final state must be deterministic (last-applied wins
    // BUT all writes complete without corruption).
    const writes = Array.from({ length: 5 }, (_, i) =>
      upsertRule(workDir, 'personal', {
        ruleId: 'concurrent',
        title: `v${i}`,
        body: `body${i}`,
        createdBy: 'agent_owner',
      }),
    );
    await Promise.all(writes);
    const loaded = await loadRule(workDir, 'personal', 'concurrent');
    expect(loaded).not.toBeNull();
    expect(loaded?.frontmatter.title).toMatch(/^v\d$/);
    // No partial file: should be parseable, which means lock worked.
  });
});

describe('listRules + INDEX.md', () => {
  it('returns summaries sorted by id', async () => {
    await upsertRule(workDir, 'personal', {
      ruleId: 'zeta',
      title: 'Zeta',
      body: '',
      createdBy: 'a',
    });
    await upsertRule(workDir, 'personal', {
      ruleId: 'alpha',
      title: 'Alpha',
      body: '',
      createdBy: 'a',
    });
    const summaries = await listRules(workDir, 'personal');
    expect(summaries.map((s) => s.id)).toEqual(['alpha', 'zeta']);
  });

  it('regenerates INDEX.md to reflect current rules', async () => {
    await upsertRule(workDir, 'personal', {
      ruleId: 'a-rule',
      title: 'Title A',
      body: '',
      tags: ['x'],
      createdBy: 'a',
    });
    const indexPath = join(workDir, 'namespaces', 'personal', 'rules', 'INDEX.md');
    let content = await readFile(indexPath, 'utf8');
    expect(content).toContain('Title A');
    expect(content).toContain('a-rule.md');
    expect(content).toContain('severity:hard');
    expect(content).toContain('tags:x');

    await deleteRule(workDir, 'personal', 'a-rule');
    content = await readFile(indexPath, 'utf8');
    expect(content).not.toContain('Title A');
  });

  it('regenerates INDEX.md lazily when missing', async () => {
    await upsertRule(workDir, 'personal', {
      ruleId: 'rule-1',
      title: 't',
      body: '',
      createdBy: 'a',
    });
    const indexPath = join(workDir, 'namespaces', 'personal', 'rules', 'INDEX.md');
    await rm(indexPath);
    await regenerateIndex(workDir, 'personal');
    const content = await readFile(indexPath, 'utf8');
    expect(content).toContain('rule-1');
  });

  it('skips files with malformed frontmatter rather than failing the list', async () => {
    await upsertRule(workDir, 'personal', {
      ruleId: 'good',
      title: 'Good',
      body: '',
      createdBy: 'a',
    });
    await writeFile(
      join(workDir, 'namespaces', 'personal', 'rules', 'broken.md'),
      'this file has no frontmatter at all',
    );
    const summaries = await listRules(workDir, 'personal');
    expect(summaries.map((s) => s.id)).toEqual(['good']);
  });
});

describe('deleteRule', () => {
  it('removes the file', async () => {
    await upsertRule(workDir, 'personal', {
      ruleId: 'to-delete',
      title: 't',
      body: '',
      createdBy: 'a',
    });
    expect(await loadRule(workDir, 'personal', 'to-delete')).not.toBeNull();
    await deleteRule(workDir, 'personal', 'to-delete');
    expect(await loadRule(workDir, 'personal', 'to-delete')).toBeNull();
  });

  it('throws RuleNotFoundError when the rule does not exist', async () => {
    await expect(
      deleteRule(workDir, 'personal', 'missing'),
    ).rejects.toBeInstanceOf(RuleNotFoundError);
  });
});
