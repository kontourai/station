/**
 * How a skill becomes a `SKILL.md` file — ONE serializer, shared by the server
 * that writes the package and the UI that exports one.
 *
 * Two writers of this format would be two chances to write a file the reader
 * refuses. The escaping below in particular is not cosmetic: it is what stops
 * a `description` from forging a `command:` block, and a client-side exporter
 * that re-implemented the frontmatter without it would hand the user a `.md`
 * whose re-import declares a command nobody enabled.
 *
 * Deliberately its own module rather than part of `skill-command.ts`: the
 * command SLUG is on Station's eagerly-loaded chat path, and serialization is
 * only reached from the lazily-loaded authoring views.
 */
import type { SkillCommand, SkillVariable } from './catalog.js';

/**
 * A YAML scalar that cannot escape its own value.
 *
 * Quoting alone is not enough for a `---` run. The spec parser locates the
 * CLOSING delimiter with a naive `indexOf('---')`, so three literal dashes
 * inside a perfectly valid double-quoted scalar still truncate the frontmatter
 * and make the whole file unreadable. Escaping the first dash of every dash
 * PAIR (as a `u002D` escape, which YAML double-quoted style decodes back to a
 * plain dash) means no
 * `---` can ever appear literally, while an ordinary `re-check` keeps its dash
 * and stays readable.
 *
 * The newline case is what `JSON.stringify` already covers: an imported file
 * whose `description` decodes to `Summary\ncommand:\n  enabled: true` would
 * otherwise be re-serialized as a real `command` block.
 */
export function yamlScalar(value: string): string {
  return JSON.stringify(value).replace(/-(?=-)/g, '\\u002D');
}

/**
 * `command:` as block YAML. Flow mappings (`{ enabled: true }`) are deliberately
 * NOT used — the skills spec parser this repo reads with rejects flow
 * collections outright, so a flow-style write would make the file unreadable.
 */
export function serializeSkillCommandLines(command: SkillCommand): string[] {
  const lines = ['command:', `  enabled: ${command.enabled}`];
  if (command.name) lines.push(`  name: ${yamlScalar(command.name)}`);
  if (command.global !== undefined) lines.push(`  global: ${command.global}`);
  return lines;
}

/** `variables:` as a block sequence of block mappings. */
export function serializeSkillVariableLines(
  variables: readonly SkillVariable[],
): string[] {
  const lines = ['variables:'];
  for (const variable of variables) {
    lines.push(`  - name: ${yamlScalar(variable.name)}`);
    if (variable.description !== undefined) {
      lines.push(`    description: ${yamlScalar(variable.description)}`);
    }
    if (variable.default !== undefined) {
      lines.push(`    default: ${yamlScalar(variable.default)}`);
    }
  }
  return lines;
}

/** The fields a `SKILL.md` carries about the skill it holds. */
export interface SerializableSkill {
  name: string;
  description?: string;
  category?: string;
  tags?: readonly string[];
  agent?: string;
  global?: boolean;
  command?: SkillCommand;
  variables?: readonly SkillVariable[];
  body: string;
}

/**
 * The whole `SKILL.md`: frontmatter, then the body.
 *
 * `description` is REQUIRED by the skill format, and a package missing it is
 * refused by the very parser discovery uses — so a skill written without one
 * was written into a directory Station could never read back. Every write path
 * reaches this serializer with `description` optional, so the fallback belongs
 * here rather than in each caller. The skill's own name is the only text there
 * is; it is a placeholder the author can replace, not a claim about the skill.
 *
 * `preservedFrontmatter` carries the lines of keys this format does not model,
 * so a round trip through Station does not delete another tool's metadata.
 */
export function serializeSkillMarkdown(
  input: SerializableSkill,
  preservedFrontmatter: readonly string[] = [],
): string {
  // EVERY scalar is quoted — see `yamlScalar`. These fields carry imported and
  // agent-authored text, and a raw one lets that text forge frontmatter.
  const parts = ['---', `name: ${yamlScalar(input.name)}`];
  parts.push(
    `description: ${yamlScalar(input.description?.trim() || input.name)}`,
  );
  if (input.category) parts.push(`category: ${yamlScalar(input.category)}`);
  if (input.tags?.length) {
    parts.push('tags:');
    for (const tag of input.tags) parts.push(`  - ${yamlScalar(tag)}`);
  }
  if (input.agent) parts.push(`agent: ${yamlScalar(input.agent)}`);
  if (input.global) parts.push('global: true');
  if (input.command) {
    parts.push(...serializeSkillCommandLines(input.command));
  }
  if (input.variables?.length) {
    parts.push(...serializeSkillVariableLines(input.variables));
  }
  parts.push(...preservedFrontmatter);
  parts.push('---', '', input.body);
  return parts.join('\n');
}
