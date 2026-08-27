/**
 * The ONE refusal every skill write path shares.
 *
 * Review finding 3: the clash check lived only in the `PUT` handler, so
 * `POST /local` and the markdown import could both create a second skill
 * answering to a `/command` a package or plugin skill already owned, and a
 * frontmatter-declared `command.name` never met the HTTP schema's command-word
 * rule at all. Validity and uniqueness are properties of the skill set, not of
 * one route, so they are decided here and called from every writer.
 *
 * The read side does NOT call this: a declaration already on disk is not a
 * write to refuse, it is a state to describe — `resolveSkillCommands` disables
 * it with a diagnostic instead (`SkillService.listSkills`/`getSkill`).
 */

import type { SkillCommand } from '@kontourai/station-contracts/catalog';
import {
  findSkillCommandClash,
  isValidSkillCommandName,
  resolveSkillCommandName,
  skillCommandNameMissingRefusal,
  skillCommandNameRefusal,
  skillCommandSlug,
} from '@kontourai/station-contracts/skill-command';

export interface SkillCommandRefusal {
  status: 409;
  error: string;
}

/**
 * Thrown by the SERVICE write paths so the refusal cannot be skipped by a
 * caller that forgets to ask. Routes map it to its own status; the import route
 * turns it into that file's result row.
 */
export class SkillCommandRefusedError extends Error {
  readonly status = 409 as const;
  readonly publicMessage: string;
  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = 'SkillCommandRefusedError';
    this.publicMessage = publicMessage;
  }
}

/**
 * Why this write must not land, or `undefined` when it may.
 *
 * `existing` must be every discovered skill across every root — a canonical
 * package skill and a plugin skill own their command words exactly as a local
 * one does, even though neither can be edited here.
 */
export function refuseInvalidSkillCommand(
  skillName: string,
  command: SkillCommand | undefined,
  existing: readonly { name: string; command?: SkillCommand }[],
  /**
   * The skill's IDENTITY in `existing`, when it differs from the name being
   * written — i.e. a rename. Excluding by the NEW name instead hid a genuinely
   * different skill that happens to already carry it: renaming `alpha` to
   * `beta` excluded the package skill actually called `beta` and took its
   * command (review delta-2 finding (b)).
   */
  excludeSkillName: string = skillName,
): SkillCommandRefusal | undefined {
  if (!command?.enabled) return undefined;

  const declared = command.name?.trim();
  const word = declared ? declared : skillCommandSlug(skillName);
  if (word === '') {
    return {
      status: 409,
      error: skillCommandNameMissingRefusal(skillName),
    };
  }
  if (!isValidSkillCommandName(word)) {
    return {
      status: 409,
      error: skillCommandNameRefusal(word),
    };
  }

  const resolvedWord = resolveSkillCommandName({ name: skillName, command });
  const clash =
    resolvedWord === null
      ? undefined
      : findSkillCommandClash(existing, resolvedWord, excludeSkillName);
  if (clash) {
    return {
      status: 409,
      error: `Command '/${resolvedWord}' is already used by the skill '${clash.name}'`,
    };
  }
  return undefined;
}

/** {@link refuseInvalidSkillCommand}, as a throw for the service write paths. */
export function assertSkillCommandAllowed(
  skillName: string,
  command: SkillCommand | undefined,
  existing: readonly { name: string; command?: SkillCommand }[],
  excludeSkillName: string = skillName,
): void {
  const refusal = refuseInvalidSkillCommand(
    skillName,
    command,
    existing,
    excludeSkillName,
  );
  if (refusal) throw new SkillCommandRefusedError(refusal.error);
}
