import { z } from 'zod';

export const RULE_ID_REGEX = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

export const ruleSeveritySchema = z.enum(['hard', 'soft']);
export type RuleSeverity = z.infer<typeof ruleSeveritySchema>;

export const ruleFrontmatterSchema = z.object({
  id: z.string().regex(RULE_ID_REGEX, 'Rule ID must be kebab-case, 3-64 chars'),
  title: z.string().min(1).max(200),
  tags: z.array(z.string().min(1)).default([]),
  applies_to: z.array(z.string().min(1)).default([]),
  severity: ruleSeveritySchema.default('hard'),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: z.string().min(1),
});

export type RuleFrontmatter = z.infer<typeof ruleFrontmatterSchema>;

export interface Rule {
  frontmatter: RuleFrontmatter;
  body: string;
}

export interface RuleSummary {
  id: string;
  title: string;
  severity: RuleSeverity;
  tags: string[];
  updated_at: string;
}

export function ruleToSummary(rule: Rule): RuleSummary {
  return {
    id: rule.frontmatter.id,
    title: rule.frontmatter.title,
    severity: rule.frontmatter.severity,
    tags: [...rule.frontmatter.tags],
    updated_at: rule.frontmatter.updated_at,
  };
}

export function ruleUri(namespaceId: string, ruleId: string): string {
  return `mem://${namespaceId}/rules/${ruleId}`;
}

export function rulesIndexUri(namespaceId: string): string {
  return `mem://${namespaceId}/rules/`;
}
