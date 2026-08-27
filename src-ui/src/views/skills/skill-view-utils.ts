import type {
  Skill,
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
 * The list rows say what the skill IS: its `/command` when it has one, then
 * how much it has been used.
 */
export function buildSkillListItems(skills: readonly Skill[]) {
  return skills.map((skill) => {
    const commandWord = resolveSkillCommandName(skill);
    // Only facts the LISTING carries: it has no `category`/`tags`, and a row
    // that printed an always-absent field would be a permanent blank.
    const subtitle = [
      commandWord ? `/${commandWord}` : null,
      formatSkillStatsSummary(skill),
    ]
      .filter(Boolean)
      .join(' · ');
    return { id: skill.name, name: skill.name, subtitle };
  });
}

export function buildSkillFilename(name: string) {
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`;
}
