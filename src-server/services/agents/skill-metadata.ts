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
import { MAX_DESCRIPTION_LENGTH, parseFrontmatter } from 'agent-skills-ts-sdk';
import { load as loadYaml } from 'js-yaml';
import { isRecord } from '../../utils/is-record.js';

const SKILL_ORIGINS: readonly SkillOrigin[] = [
  'user',
  'project',
  'registry',
  'plugin',
  'package',
  'migrated-playbook',
];

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
export { serializeSkillMarkdown } from '@kontourai/station-contracts/skill-markdown';

/** A leading `---` … `---` block and the text after it, or nothing. */
function leadingFrontmatterBlock(
  content: string,
): { yaml: string; body: string } | undefined {
  const match =
    /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(
      content,
    );
  if (!match) return undefined;
  return {
    yaml: match[1] ?? '',
    body: content.slice(match[0].length).trim(),
  };
}

/**
 * C0/C1 controls and the bidirectional formatting marks. Text holding one can
 * read as something it is not, so the Codex importer refuses such file names
 * and the lenient reader below refuses such descriptions.
 */
const CONTROL_OR_BIDI = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export function hasControlOrBidiCharacters(text: string): boolean {
  return CONTROL_OR_BIDI.test(text);
}

/**
 * A `description:` line read as plain text, for a block that is not YAML at
 * all (Codex documents `argument-hint: [FILE=<path>] [FOCUS=<area>]`, which
 * no YAML parser accepts). Only a one-line value is read; a block scalar or
 * a value continued on later lines stays unread.
 */
function lineDescription(block: string): string | undefined {
  const match = /^description:[ \t]*(.*?)[ \t]*$/m.exec(block);
  const raw = match?.[1] ?? '';
  if (raw === '' || raw.startsWith('|') || raw.startsWith('>'))
    return undefined;
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  return quoted ? quoted[2] : raw;
}

/**
 * `description` from a block the spec parser refused, when it is plain text
 * the skills format allows: at most its description length, with no control
 * or direction-changing character. Anything else is refused, not trimmed to
 * fit, and the file name stands alone.
 */
function lenientDescription(block: string): string | undefined {
  let description: unknown;
  try {
    const value = loadYaml(block, { maxAliases: 0 });
    description =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).description
        : undefined;
  } catch {
    description = lineDescription(block);
  }
  if (typeof description !== 'string') return undefined;
  const text = description.trim();
  if (
    text === '' ||
    text.length > MAX_DESCRIPTION_LENGTH ||
    hasControlOrBidiCharacters(text)
  )
    return undefined;
  return text;
}

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
    // No frontmatter, or frontmatter the spec parser refuses. Neither means
    // "this file is broken": its text is still a good skill body. A refused
    // block is still a block, though. Codex prompts open with `description:`
    // and `argument-hint:` and no `name`, which the spec parser refuses; the
    // block is not part of the instructions, so it is removed from the body
    // and only a plain-text `description` is read from it. Nothing else in a
    // refused block (name, command, variables) is trusted.
    const refused = leadingFrontmatterBlock(content);
    if (refused) {
      body = refused.body;
      const description = lenientDescription(refused.yaml);
      if (description !== undefined) frontmatter = { description };
    }
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

export type {
  SkillPackageDirectoryCondition,
  SkillPackageDirectoryReport,
} from '../../domain/skill-paths.js';
export {
  assertSafeSkillName,
  assertSkillPackageDirectory,
  isDirectoryWithin,
  isSafeSkillName,
  resolveSkillDirectory,
  skillPackageDirectoryReport,
  skillsRootDir,
} from '../../domain/skill-paths.js';
