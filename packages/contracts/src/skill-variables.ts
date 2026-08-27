/**
 * What variables a skill body substitutes — ONE derivation, shared by the
 * server, the SDK and the UI.
 *
 * The set is derived from the body's `{{placeholder}}`s, never from a
 * declaration list, which can drift from the text it claims to describe.
 * Frontmatter declarations only attach `description`/`default` to a name the
 * body already uses.
 *
 * Deliberately a separate module from `skill-command.ts`: Station's UI reaches
 * the command SLUG from its eagerly-loaded chat surface and these two functions
 * only from the lazily-loaded authoring views. One module for both would place
 * the whole surface in the entry bundle (measured: +93 gzip bytes) for code the
 * first paint never runs.
 */
import type { SkillVariable } from './catalog.js';

/**
 * The `{{name}}` placeholders a body substitutes, de-duplicated, in order of
 * first appearance. The single derivation every authoring surface shares.
 */
export function extractTemplateVariables(content: string): string[] {
  const matches = content.match(/\{\{([\w.-]+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((match) => match.slice(2, -2)))];
}

/**
 * The variables a skill actually has: the body's placeholder set, each carrying
 * the `description`/`default` of a matching declaration when one exists.
 *
 * A declaration naming a placeholder the body does not contain is deliberately
 * NOT returned — it would render as a fillable field that substitutes nothing.
 * The body is the derivation; declarations are metadata about it.
 */
export function mergeSkillVariables(
  body: string | undefined,
  declared: readonly SkillVariable[] | undefined,
): SkillVariable[] {
  const declarations = new Map(
    (declared ?? [])
      .filter((entry) => typeof entry?.name === 'string' && entry.name !== '')
      .map((entry) => [entry.name, entry]),
  );
  return extractTemplateVariables(body ?? '').map((name) => {
    const declaration = declarations.get(name);
    return {
      name,
      ...(declaration?.description !== undefined
        ? { description: declaration.description }
        : {}),
      ...(declaration?.default !== undefined
        ? { default: declaration.default }
        : {}),
    };
  });
}
