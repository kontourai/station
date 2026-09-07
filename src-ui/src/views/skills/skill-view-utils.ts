import type {
  Skill,
  SkillOrigin,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import {
  resolveSkillCommandName,
  skillCommandSlug,
} from '@kontourai/station-contracts/skill-command';
import { mergeSkillVariables } from '@kontourai/station-contracts/skill-variables';

/** The Skills editor's form. */
export interface SkillForm {
  name: string;
  description: string;
  body: string;
  tags: string;
  category: string;
  /** "Runnable as /command" — DECLARED, never inferred from the body. */
  commandEnabled: boolean;
  /** Blank means "derive the word from the name" (`skillCommandSlug`). */
  commandName: string;
  /** "Offer to every agent", not "is a command". See `SkillCommand`. */
  commandGlobal: boolean;
  /**
   * Declarations only. The SET is always derived from the body — these carry
   * the description/default an author attached to a name the body uses.
   */
  variables: SkillVariable[];
}

export const EMPTY_SKILL_FORM: SkillForm = {
  name: '',
  description: '',
  body: '',
  tags: '',
  category: '',
  commandEnabled: false,
  commandName: '',
  commandGlobal: false,
  variables: [],
};

/**
 * What `GET /api/skills/:name` answers with, as far as the editor reads it.
 *
 * Deliberately not `Skill`: the DETAIL read carries authoring fields the
 * LISTING does not (`body`, `category`, `tags`), and typing the form's input as
 * the listing's shape would claim the list rows carry them too.
 */
export interface SkillDetailRecord {
  name?: string;
  description?: string;
  body?: string;
  tags?: string[];
  category?: string;
  command?: Skill['command'];
  variables?: SkillVariable[];
}

/** A detail read (`GET /api/skills/:name`) as the editor's form. */
export function skillDetailToForm(detail: SkillDetailRecord): SkillForm {
  return {
    name: detail.name ?? '',
    description: detail.description ?? '',
    body: detail.body ?? '',
    tags: Array.isArray(detail.tags) ? detail.tags.join(', ') : '',
    category: detail.category ?? '',
    commandEnabled: !!detail.command?.enabled,
    commandName: detail.command?.name ?? '',
    commandGlobal: !!detail.command?.global,
    variables: detail.variables ?? [],
  };
}

/**
 * The variables the editor shows: the body's `{{placeholder}}` set, each
 * carrying whatever description/default the form has declared for that name.
 *
 * The body is the derivation — a declaration for a placeholder the body no
 * longer contains disappears from the editor rather than rendering as a field
 * that substitutes nothing.
 */
export function formVariables(form: SkillForm): SkillVariable[] {
  return mergeSkillVariables(form.body, form.variables);
}

/** The command word this form declares, or `null` when it is not a command. */
export function formCommandWord(form: SkillForm): string | null {
  if (!form.commandEnabled) return null;
  const declared = form.commandName.trim();
  return declared !== '' ? declared : skillCommandSlug(form.name);
}

export function buildSkillPayload(form: SkillForm) {
  const tags = form.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const variables = formVariables(form).filter(
    (variable) =>
      variable.description !== undefined || variable.default !== undefined,
  );
  return {
    name: form.name.trim(),
    body: form.body,
    description: form.description || undefined,
    category: form.category || undefined,
    tags: tags.length > 0 ? tags : undefined,
    // Sent even when disabled: turning a command OFF is a write, and omitting
    // the field would leave the old declaration on disk.
    command: {
      enabled: form.commandEnabled,
      ...(form.commandName.trim() ? { name: form.commandName.trim() } : {}),
      ...(form.commandEnabled ? { global: form.commandGlobal } : {}),
    },
    variables,
  };
}

/**
 * How this skill's usage reads, or `null` when there is nothing to say.
 *
 * An unreadable counter store is NOT an unused skill: `statsUnavailable` is
 * rendered as itself, never as "0 runs" — a number nobody computed.
 */
export function formatSkillStatsSummary(skill: Skill): string | null {
  if (skill.statsUnavailable) return 'run count unavailable';
  const stats = skill.stats;
  if (!stats) return null;
  const runs = stats.runs ?? 0;
  const parts = [`${runs} run${runs === 1 ? '' : 's'}`];
  if (stats.qualityScore != null) parts.push(`${stats.qualityScore}% success`);
  return parts.join(' · ');
}

export function filterSkills(
  skills: readonly Skill[],
  search: string,
  commandsOnly: boolean,
): Skill[] {
  const query = search.toLowerCase();
  return skills.filter(
    (skill) =>
      (!commandsOnly || !!skill.command?.enabled) &&
      (!query ||
        skill.name.toLowerCase().includes(query) ||
        skill.description?.toLowerCase().includes(query) ||
        skill.tags?.some((tag) => tag.toLowerCase().includes(query))),
  );
}

/**
 * The Skills list's one subtitle, shared by the page header and the pane so the
 * two cannot drift. It used to call the whole list "workspace skills" while
 * most rows were built-in package skills and none of them were workspace-scoped
 * — a claim the loader contradicted on every row (#1582 D6).
 */
export const SKILLS_SUBTITLE =
  'Every skill Station loaded, grouped by where it came from. Author your own here; install more from Registry.';

/**
 * Where the loader found a skill, in the user's words.
 *
 * One label per `SkillOrigin` and nothing invented: the server derives the
 * origin from the root a skill was discovered under (or from the record its
 * writer left), so every label here is backed by a value something computed.
 * An origin the listing does not carry renders as a NAMED gap rather than
 * silently joining "This machine" — the listing not saying where a skill came
 * from is a different fact from it coming from here (#1582 D6).
 */
export function skillSourceLabel(origin: SkillOrigin | undefined): string {
  switch (origin) {
    case 'project':
      return 'This workspace';
    case 'user':
      return 'This machine';
    case 'registry':
      return 'Registry';
    case 'plugin':
      return 'Plugin';
    case 'migrated-playbook':
      return 'Migrated playbook';
    case 'package':
      return 'Built in';
    default:
      return 'Source unrecorded';
  }
}

/**
 * Group order. The roots a user authored or installed into come first because
 * those are the rows they act on; the read-only built-in bulk sorts last so it
 * cannot push a user's own two skills below the fold. `undefined` is last of
 * all — an unrecorded source is the least useful band to land in first.
 */
const SKILL_SOURCE_ORDER: readonly (SkillOrigin | undefined)[] = [
  'project',
  'user',
  'migrated-playbook',
  'registry',
  'plugin',
  'package',
  undefined,
];

function skillSourceRank(origin: SkillOrigin | undefined): number {
  const index = SKILL_SOURCE_ORDER.indexOf(origin);
  return index === -1 ? SKILL_SOURCE_ORDER.length : index;
}

/**
 * The list rows say what the skill IS: where it came from, its `/command` when
 * it has one, then how much it has been used.
 *
 * Rows are ordered by source so `section` bands stay contiguous — the pane
 * emits a header whenever `section` changes, so a scrambled order would emit
 * the same header repeatedly.
 */
export function buildSkillListItems(skills: readonly Skill[]) {
  const ordered = skills
    .map((skill, index) => ({ skill, index }))
    .sort(
      (a, b) =>
        skillSourceRank(a.skill.origin) - skillSourceRank(b.skill.origin) ||
        a.index - b.index,
    )
    .map((entry) => entry.skill);
  return ordered.map((skill) => {
    const commandWord = resolveSkillCommandName(skill);
    // Only facts the LISTING carries: it has no `category`/`tags`, and a row
    // that printed an always-absent field would be a permanent blank.
    const subtitle = [
      commandWord ? `/${commandWord}` : null,
      formatSkillStatsSummary(skill),
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      id: skill.name,
      name: skill.name,
      subtitle,
      source: skillSourceLabel(skill.origin),
    };
  });
}

export function buildSkillFilename(name: string) {
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`;
}
