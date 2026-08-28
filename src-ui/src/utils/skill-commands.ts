import type { Skill } from '@kontourai/station-contracts/catalog';
import {
  resolveSkillCommandName,
  skillCommandSlug,
} from '@kontourai/station-contracts/skill-command';

/** The subset of an agent this derivation reads. */
export interface CommandAgent {
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

/** The part of a declared skill variable substitution reads. */
export interface SubstitutableSkillVariable {
  name: string;
  default?: string;
}

export type SkillVariableSubstitution =
  | { ok: true; content: string }
  | { ok: false; missing: string[] };

/**
 * Substitute a skill's `{{variables}}` — the ONE derivation shared by the
 * Test modal and the slash handler (the two used to disagree, and
 * both would substitute an empty string for a variable nobody supplied).
 *
 * A declared default applies when no value was provided. A CLEARED value
 * (stored as an empty or whitespace string, as the Test modal's inputs do
 * after typing and deleting) means "use the default", not "supply nothing":
 * the field's placeholder IS the default, so an empty field shows the value
 * the preview will use. A variable with neither a usable value nor a usable
 * default is REJECTED and named — never silently substituted, because an
 * empty gap is text the skill's author never wrote and the model cannot know
 * was meant to be blank.
 */
export function substituteSkillVariables(
  body: string,
  variables: readonly SubstitutableSkillVariable[],
  provided: Readonly<Record<string, string>> = {},
): SkillVariableSubstitution {
  const missing: string[] = [];
  let content = body;
  for (const variable of variables) {
    const typed = provided[variable.name];
    // An explicitly empty value is no value: fall to the default (delta
    // review — clearing a Test field used to suppress the default until the
    // modal was closed).
    const value =
      typed !== undefined && typed.trim() !== '' ? typed : variable.default;
    // An empty declared default is not usable either; both read as missing.
    if (value === undefined || value.trim() === '') {
      missing.push(variable.name);
      continue;
    }
    content = content.replaceAll(`{{${variable.name}}}`, value);
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, content };
}

export type ShellWords =
  | { ok: true; words: string[] }
  | { ok: false; error: string };

/**
 * Split a typed command line the way a shell would — the ONE parser every
 * slash-command consumer uses (a plain whitespace split turned
 * `/release "release notes" prod` into three broken words).
 *
 * Double and single quotes group; inside double quotes a backslash escapes
 * the next character; inside single quotes everything is literal (POSIX);
 * outside quotes a backslash escapes the next character. An unterminated
 * quote is an error naming the quote, never a guess.
 */
export function parseShellWords(input: string): ShellWords {
  const words: string[] = [];
  let current = '';
  let hasWord = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (hasWord) {
        words.push(current);
        current = '';
        hasWord = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === '\\' && quote === '"' && i + 1 < input.length) {
          current += input[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        current += c;
        i += 1;
      }
      if (!closed) {
        return {
          ok: false,
          error: `unterminated ${quote === '"' ? 'double' : 'single'} quote (${quote}) — it never closes`,
        };
      }
      hasWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      hasWord = true;
      i += 2;
      continue;
    }
    current += ch;
    hasWord = true;
    i += 1;
  }
  if (hasWord) words.push(current);
  return { ok: true, words };
}

export type SkillVariableArgs =
  | { ok: true; provided: Record<string, string> }
  | { ok: false; error: string };

/**
 * Map parsed command words onto a skill's declared variables (
 * pure positional fill could not skip an earlier defaulted variable).
 *
 * A word whose `name=` prefix names a DECLARED variable assigns by name; every
 * other word is positional and fills the not-yet-named variables in
 * declaration order. A quoted value keeps its `=` bytes (`"a=b"` positional,
 * `env="a=b"` named) — a word that merely CONTAINS `=` is a positional value,
 * not a typo to reject. More positionals than variables left is an error
 * naming the surplus: silently dropping a typed value is the defect this
 * parser exists to close.
 */
export function assignSkillVariableArgs(
  variables: readonly SubstitutableSkillVariable[],
  args: readonly string[],
): SkillVariableArgs {
  const provided: Record<string, string> = {};
  const positional: string[] = [];
  const declared = new Set(variables.map((variable) => variable.name));
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq > 0 && declared.has(arg.slice(0, eq))) {
      provided[arg.slice(0, eq)] = arg.slice(eq + 1);
      continue;
    }
    positional.push(arg);
  }
  const unassigned = variables.filter(
    (variable) => !(variable.name in provided),
  );
  if (positional.length > unassigned.length) {
    return {
      ok: false,
      error: `no variable left for '${positional[unassigned.length]}' — this command takes ${variables.length} value${variables.length === 1 ? '' : 's'}`,
    };
  }
  unassigned.forEach((variable, index) => {
    provided[variable.name] = positional[index];
  });
  return { ok: true, provided };
}
