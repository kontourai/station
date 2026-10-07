import type { Skill } from '@kontourai/station-contracts/catalog';
import {
  resolveSkillCommandName,
  skillCommandSlug,
} from '@kontourai/station-contracts/skill-command';

/** The subset of an agent this derivation reads. */
interface CommandAgent {
  slug: string;
  skills?: readonly string[];
}

/**
 * Whether an agent is offered this command skill.
 *
 * Two ways in, and they are different facts: `command.global` means "offered in
 * every agent's chat without being attached", while `agent.skills` naming the
 * skill is the attachment itself. This replaces a derivation that read the
 * authored record's own `agent` field and ignored the agent's own binding list
 * entirely — so attaching a record to an agent saved a setting that changed
 * nothing (CAT-R08).
 */
export function isSkillCommandOfferedTo(
  skill: Skill,
  agent: CommandAgent | null | undefined,
): boolean {
  if (!skill.command?.enabled) return false;
  if (skill.command.global) return true;
  return !!agent?.skills?.includes(skill.name);
}

/** Every command-enabled skill this agent can type, in list order. */
export function agentCommandSkills(
  skills: readonly Skill[] | undefined,
  agent: CommandAgent | null | undefined,
): Skill[] {
  return (skills ?? []).filter((skill) =>
    isSkillCommandOfferedTo(skill, agent),
  );
}

/**
 * The word a skill's command DECLARATION names, whether or not it is in
 * effect. A row explaining why a declaration is not in effect (a clash
 * loser) still prints the word its author meant the user to type — the same
 * declared-name-else-name-slug rule `resolveSkillCommandName` applies, minus
 * the enabled gate.
 */
export function declaredSkillCommandWord(skill: Skill): string | null {
  if (!skill.command) return null;
  const declared = skill.command.name?.trim();
  return declared ? declared : skillCommandSlug(skill.name);
}

/**
 * The command skill a typed word runs.
 *
 * The SERVER decides clashes (`resolveSkillCommands`): exactly one skill per
 * word comes back `command.enabled`, and every loser carries
 * `command.enabled: false` plus the `commandDiagnostic` saying why. The client
 * does not re-arbitrate — attaching the losing skill does not move the word to
 * it, because attachment cannot give a skill a word the server awarded to
 * another skill. So this is just "the one skill that is both enabled against
 * this word and offered to this agent" (`isSkillCommandOfferedTo`), with no
 * second precedence rule of its own.
 */
export function findMatchingSkillCommand(
  skills: readonly Skill[] | undefined,
  cmd: string,
  agent: CommandAgent | null | undefined,
): Skill | undefined {
  return (skills ?? []).find(
    (skill) =>
      resolveSkillCommandName(skill) === cmd &&
      isSkillCommandOfferedTo(skill, agent),
  );
}
