import yaml from 'yaml';
import { ruleFrontmatterSchema, type Rule, type RuleFrontmatter } from './types.js';

const FRONTMATTER_DELIMITER = '---';

export class FrontmatterParseError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'FrontmatterParseError';
  }
}

export function parseRuleFile(raw: string): Rule {
  if (!raw.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    throw new FrontmatterParseError(
      'Rule file must begin with "---" frontmatter delimiter',
    );
  }
  const rest = raw.slice(FRONTMATTER_DELIMITER.length + 1);
  const closingIdx = rest.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (closingIdx === -1) {
    throw new FrontmatterParseError(
      'Rule file missing closing "---" frontmatter delimiter',
    );
  }
  const yamlBlock = rest.slice(0, closingIdx);
  const bodyStart = closingIdx + FRONTMATTER_DELIMITER.length + 1;
  // Skip the newline immediately after closing delimiter, if present.
  const body = rest.slice(bodyStart).replace(/^\n/, '');

  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlBlock);
  } catch (err) {
    throw new FrontmatterParseError('Frontmatter YAML is invalid', err);
  }
  const validation = ruleFrontmatterSchema.safeParse(parsed);
  if (!validation.success) {
    throw new FrontmatterParseError(
      `Frontmatter validation failed: ${validation.error.message}`,
      validation.error,
    );
  }

  return { frontmatter: validation.data, body };
}

export function serializeRuleFile(rule: Rule): string {
  const validation = ruleFrontmatterSchema.safeParse(rule.frontmatter);
  if (!validation.success) {
    throw new FrontmatterParseError(
      `Cannot serialize rule with invalid frontmatter: ${validation.error.message}`,
      validation.error,
    );
  }
  const fm = validation.data;
  const ordered: RuleFrontmatter = {
    id: fm.id,
    title: fm.title,
    tags: fm.tags,
    applies_to: fm.applies_to,
    severity: fm.severity,
    created_at: fm.created_at,
    updated_at: fm.updated_at,
    created_by: fm.created_by,
  };
  const yamlBlock = yaml.stringify(ordered, {
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });
  const trailingBody = rule.body.endsWith('\n') ? rule.body : `${rule.body}\n`;
  return `${FRONTMATTER_DELIMITER}\n${yamlBlock}${FRONTMATTER_DELIMITER}\n${trailingBody}`;
}
