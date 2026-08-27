/**
 * What command word a skill answers to — ONE derivation, shared by the server,
 * the SDK and the UI, so a client can never offer a `/command` the server does
 * not match. The slug is lifted verbatim from
 * `src-ui/src/slashCommands/utils.ts`, which now imports it from here.
 *
 * Variable extraction lives in the sibling `skill-variables.ts`; see its
 * docblock for why the two are separate modules.
 */
import type { SkillCommand, SkillOrigin } from './catalog.js';

/**
 * The shape a command word must have: what a user can actually type after a
 * `/`. Declared here, next to the derivation, so the HTTP schema, the
 * frontmatter reader and the UI all check the SAME rule instead of three.
 */
export const SKILL_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The rule in one sentence, said the same way everywhere it is enforced: the
 * HTTP schema's rejection, and the editor field that must not offer a word
 * that rejection will refuse (station#3737).
 */
/**
 * Deliberately says "the slash" rather than quoting the character: the
 * server's own deep redaction reads a quoted "/" as a filesystem path and
 * rewrites it, so an HTTP refusal carrying this sentence reached the client as
 * `... the text typed after "[REDACTED_PATH]"`. Caught by the import route's
 * test once every surface started asserting the same sentence.
 */
export const SKILL_COMMAND_NAME_RULE =
  'A command word is lowercase letters, digits and dashes — the text typed after the slash.';

/** The other half of the same rule: there has to BE a word. */
export const SKILL_COMMAND_NAME_REQUIRED =
  'A command word is needed before this skill can be typed as a command.';

export function isValidSkillCommandName(name: string): boolean {
  return SKILL_COMMAND_NAME_PATTERN.test(name);
}

/** Why this word cannot be a command word, or `null` when it can. */
export function skillCommandNameError(word: string): string | null {
  const trimmed = word.trim();
  if (trimmed === '') return SKILL_COMMAND_NAME_REQUIRED;
  return isValidSkillCommandName(trimmed) ? null : SKILL_COMMAND_NAME_RULE;
}

/**
 * The same refusal, naming the value that broke the rule.
 *
 * The editor field says the rule with nothing to point at; a write path and a
 * read-side diagnostic are talking ABOUT a particular skill or word, so they
 * name it first and then say the rule — the SAME rule sentence, not a
 * paraphrase. `skill-command-validation.ts` carried its own wording, so a
 * markdown import and an HTTP refusal disagreed about what the rule is and
 * either could drift away from the field (sol review, LOW).
 */
export function skillCommandNameRefusal(word: string): string {
  return `'${word}' cannot be a command word. ${SKILL_COMMAND_NAME_RULE}`;
}

export function skillCommandNameMissingRefusal(skillName: string): string {
  return `'${skillName}' has no typable command word. ${SKILL_COMMAND_NAME_REQUIRED}`;
}

/** A skill name reduced to the command word it defaults to. */
export function skillCommandSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The command word a skill answers to, or `null` when it is not command-enabled.
 * `null` is the honest answer for "this skill is not a command" — callers must
 * not fall back to the slug for a skill nobody enabled.
 */
export function resolveSkillCommandName(skill: {
  name: string;
  command?: SkillCommand;
}): string | null {
  if (!skill.command?.enabled) return null;
  const declared = skill.command.name?.trim();
  return declared ? declared : skillCommandSlug(skill.name);
}

/**
 * The command-enabled skill already answering to `commandName`, if any, ignoring
 * `excludeSkillName` (the skill being written). Used to refuse a clash at save
 * time rather than letting two skills answer to one `/command`.
 */
export function findSkillCommandClash<
  T extends { name: string; command?: SkillCommand },
>(
  skills: readonly T[],
  commandName: string,
  excludeSkillName: string,
): T | undefined {
  return skills.find(
    (skill) =>
      skill.name !== excludeSkillName &&
      resolveSkillCommandName(skill) === commandName,
  );
}

/**
 * What a declared command actually DOES, per skill.
 *
 * A declaration is not an outcome: a command word nobody can type, or one two
 * skills both claim, cannot be honoured. This is the single place that turns
 * declarations into behaviour, so a listing, a detail read and a save-time
 * refusal cannot disagree — and a skill whose declaration is not in effect
 * always carries the reason, rather than appearing enabled and doing nothing.
 */
export interface ResolvedSkillCommand {
  /** The command as it will behave — `enabled: false` when it cannot be. */
  command?: SkillCommand;
  /** Why an enabled declaration is not in effect, when it is not. */
  commandDiagnostic?: string;
}

/**
 * Resolve every skill's command at once, by name.
 *
 * Clashes are decided by the lexicographically smallest skill name, NOT by
 * discovery order: discovery order changes when a plugin is installed or a
 * package updates, and a `/command` that silently moves between skills because
 * a directory was scanned earlier is worse than one that never moves. The loser
 * keeps its declaration visible with `enabled: false` and a diagnostic naming
 * the winner.
 */
export function resolveSkillCommands<
  T extends { name: string; command?: SkillCommand; origin?: SkillOrigin },
>(skills: readonly T[]): Map<string, ResolvedSkillCommand> {
  const resolved = new Map<string, ResolvedSkillCommand>();
  const claims = new Map<string, T[]>();

  for (const skill of skills) {
    const declared = skill.command;
    if (!declared) {
      resolved.set(skill.name, {});
      continue;
    }
    if (!declared.enabled) {
      resolved.set(skill.name, { command: declared });
      continue;
    }
    const word = declared.name?.trim()
      ? declared.name.trim()
      : skillCommandSlug(skill.name);
    if (word === '') {
      resolved.set(skill.name, {
        command: { ...declared, enabled: false },
        commandDiagnostic: skillCommandNameMissingRefusal(skill.name),
      });
      continue;
    }
    if (!isValidSkillCommandName(word)) {
      resolved.set(skill.name, {
        command: { ...declared, enabled: false },
        commandDiagnostic: skillCommandNameRefusal(word),
      });
      continue;
    }
    resolved.set(skill.name, { command: declared });
    claims.set(word, [...(claims.get(word) ?? []), skill]);
  }

  for (const [word, claimants] of claims) {
    if (claimants.length < 2) continue;
    const [winner, ...losers] = [...claimants].sort(compareCommandClaim);
    for (const loser of losers) {
      const current = resolved.get(loser.name);
      resolved.set(loser.name, {
        command: current?.command
          ? { ...current.command, enabled: false }
          : undefined,
        commandDiagnostic: `'/${word}' is already used by the skill '${winner.name}'`,
      });
    }
  }

  return resolved;
}

/**
 * Which of two skills claiming one command word keeps it.
 *
 * SOURCE first, and in the same order discovery already resolves a name
 * collision by (`SkillService.discoverSkills` scans canonical package roots
 * FIRST so a locally installed or project skill overrides them). Deciding a
 * command clash on the skill's NAME alone contradicted that: a package update
 * shipping `alpha-release` took `/ship` away from a user's own
 * `zebra-release` purely because `a` sorts before `z` (review delta finding 1).
 *
 * An unrecognised origin sits between `registry` and `plugin`: Station found it
 * somewhere it can write, but nothing recorded what put it there — so it
 * outranks the read-only roots and yields to anything explicitly authored or
 * installed here. Name is the tiebreak WITHIN a tier, which keeps the result
 * stable against discovery order.
 */
const COMMAND_CLAIM_PRECEDENCE: Record<SkillOrigin, number> = {
  user: 0,
  'migrated-playbook': 0,
  registry: 1,
  plugin: 3,
  package: 4,
};
const UNKNOWN_ORIGIN_PRECEDENCE = 2;

function claimPrecedence(origin: SkillOrigin | undefined): number {
  return origin === undefined
    ? UNKNOWN_ORIGIN_PRECEDENCE
    : COMMAND_CLAIM_PRECEDENCE[origin];
}

function compareCommandClaim(
  a: { name: string; origin?: SkillOrigin },
  b: { name: string; origin?: SkillOrigin },
): number {
  const byOrigin = claimPrecedence(a.origin) - claimPrecedence(b.origin);
  return byOrigin !== 0 ? byOrigin : a.name.localeCompare(b.name);
}
