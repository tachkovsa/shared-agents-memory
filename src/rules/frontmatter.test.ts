import { describe, expect, it } from 'vitest';
import {
  FrontmatterParseError,
  parseRuleFile,
  serializeRuleFile,
} from './frontmatter.js';
import type { Rule } from './types.js';

const sampleRule: Rule = {
  frontmatter: {
    id: 'no-bot-comments-on-github',
    title: 'Do not post review comments to GitHub under bot identity',
    tags: ['github', 'review', 'security'],
    applies_to: ['agent:claude-code', 'agent:codex'],
    severity: 'hard',
    created_at: '2026-05-27T10:00:00.000Z',
    updated_at: '2026-05-27T10:00:00.000Z',
    created_by: 'agent_bootstrap',
  },
  body: '# Body\n\nDo not.\n',
};

describe('serializeRuleFile + parseRuleFile', () => {
  it('round-trips a valid rule', () => {
    const serialized = serializeRuleFile(sampleRule);
    const parsed = parseRuleFile(serialized);
    expect(parsed.frontmatter).toEqual(sampleRule.frontmatter);
    expect(parsed.body).toBe(sampleRule.body);
  });

  it('produces human-readable YAML frontmatter delimited by ---', () => {
    const serialized = serializeRuleFile(sampleRule);
    expect(serialized.startsWith('---\n')).toBe(true);
    expect(serialized).toContain('\n---\n');
    expect(serialized).toContain('id: no-bot-comments-on-github');
    expect(serialized).toContain('title: Do not post review comments');
  });

  it('rejects files without an opening delimiter', () => {
    expect(() => parseRuleFile('no frontmatter\nhere')).toThrow(FrontmatterParseError);
  });

  it('rejects files without a closing delimiter', () => {
    expect(() => parseRuleFile('---\nid: foo\nno closing\n')).toThrow(
      FrontmatterParseError,
    );
  });

  it('rejects frontmatter that fails Zod validation', () => {
    const bad = `---\nid: Bad-ID\ntitle: t\nseverity: weird\n---\nbody\n`;
    expect(() => parseRuleFile(bad)).toThrow(FrontmatterParseError);
  });

  it('refuses to serialize a rule with an invalid id', () => {
    expect(() =>
      serializeRuleFile({
        ...sampleRule,
        frontmatter: { ...sampleRule.frontmatter, id: 'Has Capitals' },
      }),
    ).toThrow(FrontmatterParseError);
  });

  it('defaults empty body to a single trailing newline', () => {
    const r: Rule = { ...sampleRule, body: '' };
    const out = serializeRuleFile(r);
    expect(out.endsWith('---\n\n')).toBe(true);
  });
});
