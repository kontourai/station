/**
 * Coercions for the Station-owned skill metadata that lives in `SKILL.md`
 * frontmatter and its `skill.json` mirror.
 *
 * Both files are user-editable on disk, so every field is validated here rather
 * than trusted from `JSON.parse`/the YAML reader. A malformed value is dropped,
 * not guessed at: `command.enabled` in particular must be an actual boolean an
 * author wrote — a truthy string never becomes "this is a command".
 */

import type {
  SkillCommand,
  SkillOrigin,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import { parseFrontmatter } from 'agent-skills-ts-sdk';

const SKILL_ORIGINS: readonly SkillOrigin[] = [
  'user',
  'project',
  'registry',
  'plugin',
  'package',
  'migrated-playbook',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readSkillCommand(value: unknown): SkillCommand | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.enabled !== 'boolean') return undefined;
  const command: SkillCommand = { enabled: value.enabled };
  if (typeof value.name === 'string' && value.name.trim() !== '') {
    command.name = value.name.trim();
  }
  if (typeof value.global === 'boolean') {
    command.global = value.global;
  }
  return command;
}

export function readSkillVariables(
  value: unknown,
): SkillVariable[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const variables: SkillVariable[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name !== 'string' || entry.name.trim() === '') continue;
    const variable: SkillVariable = { name: entry.name.trim() };
    if (typeof entry.description === 'string') {
      variable.description = entry.description;
    }
    if (typeof entry.default === 'string') {
      variable.default = entry.default;
    }
    variables.push(variable);
  }
  return variables.length > 0 ? variables : undefined;
}

export function readSkillLegacyIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  );
  return ids.length > 0 ? ids : undefined;
}

export function readSkillOrigin(value: unknown): SkillOrigin | undefined {
  return typeof value === 'string' &&
    (SKILL_ORIGINS as readonly string[]).includes(value)
    ? (value as SkillOrigin)
    : undefined;
}

/**
 * The `SKILL.md` serializers, re-exported under their historical names rather
 * than re-implemented: `@kontourai/station-contracts/skill-markdown` is the one
 * writer of this format, shared with the UI's `.md` export. A second copy here
 * would be a second chance to emit a file the spec parser refuses — or, worse,
 * one whose unescaped `description` forges a `command:` block.
 */
export {
  serializeSkillCommandLines,
  serializeSkillMarkdown,
  serializeSkillVariableLines,
  yamlScalar,
} from '@kontourai/station-contracts/skill-markdown';

/** What an imported `.md` file contributes to a new local skill. */
export interface ImportedSkillMarkdown {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  agent?: string;
  global?: boolean;
  command?: SkillCommand;
  variables?: SkillVariable[];
  body: string;
}

/**
 * Read one uploaded markdown file into the fields a local skill is created
 * from.
 *
 * A file with usable frontmatter contributes its declarations (including
 * `command`, so a command skill exported as markdown imports back AS a
 * command);
 * a file without frontmatter — or with frontmatter this repo's spec parser
 * refuses — is taken as a plain body under a filename-derived name, which is
 * the honest reading rather than an error the user cannot act on.
 */
export function parseImportedSkillMarkdown(
  filename: string,
  content: string,
): ImportedSkillMarkdown {
  const fallbackName = filename
    .replace(/\.mdx?$/i, '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  let frontmatter: Record<string, unknown> = {};
  let body = content.trim();
  try {
    const parsed = parseFrontmatter(content);
    frontmatter = parsed.metadata as unknown as Record<string, unknown>;
    body = parsed.body;
  } catch {
    // No frontmatter, or frontmatter the spec parser refuses. Both mean "this
    // file declares nothing" — never "this file is broken", since its text is
    // still a perfectly good skill body.
  }

  const declaredName =
    typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  return {
    name: declaredName !== '' ? declaredName : fallbackName,
    ...(typeof frontmatter.description === 'string'
      ? { description: frontmatter.description }
      : {}),
    ...(typeof frontmatter.category === 'string'
      ? { category: frontmatter.category }
      : {}),
    ...(Array.isArray(frontmatter.tags)
      ? {
          tags: frontmatter.tags.filter(
            (tag): tag is string => typeof tag === 'string',
          ),
        }
      : {}),
    ...(typeof frontmatter.agent === 'string'
      ? { agent: frontmatter.agent }
      : {}),
    ...(typeof frontmatter.global === 'boolean'
      ? { global: frontmatter.global }
      : {}),
    ...(readSkillCommand(frontmatter.command)
      ? { command: readSkillCommand(frontmatter.command) }
      : {}),
    ...(readSkillVariables(frontmatter.variables)
      ? { variables: readSkillVariables(frontmatter.variables) }
      : {}),
    body,
  };
}

export {
  assertSafeSkillName,
  isDirectoryPhysicallyWithin,
  isDirectoryWithin,
  isSafeSkillName,
  PROTOTYPE_AFFECTING_KEYS,
  resolveSkillDirectory,
  skillsRootDir,
} from '../../domain/skill-paths.js';
