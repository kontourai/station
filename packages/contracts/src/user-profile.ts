/**
 * user-profile — the two answers Station's first run asks about the person
 * using it (station#2652 chapter 2), and the single authored context block
 * derived from them.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **A skipped question injects nothing.** There is no default role and no
 *    default comfort level. `buildUserProfileContextBlock` returns `null` for
 *    an absent profile, an unrecognised value, or a profile whose fields are
 *    empty — it never substitutes an assumed answer. A block that says "the
 *    user is an engineer" when nobody said so is a fabricated observation, and
 *    the model would treat it exactly like a stated one.
 *
 * 2. **The block is derived here and nowhere else.** The server injects the
 *    string this function returns; the first-run UI shows the user the same
 *    string. One derivation, so the preview cannot drift from what is sent.
 *
 * Reach (deliberately narrow, see `USER_PROFILE_ENGINE_REACH_NOTE`): the only
 * consumer is Station's own engine, whose turns pass through
 * `prepareChatRequest`. External engines (Claude Code, Codex, ACP-connected
 * CLIs) own their own context assembly and never reach that seam, so this
 * profile has no effect on them. Any UI copy about this setting has to say
 * that rather than imply the profile follows the user everywhere.
 */

/** What the person does. No default — absent means they did not answer. */
export const USER_PROFILE_ROLES = [
  'engineer',
  'manager',
  'researcher',
  'operator',
  'other',
] as const;

export type UserProfileRole = (typeof USER_PROFILE_ROLES)[number];

/** How much technical detail they want back. No default. */
export const USER_PROFILE_COMFORT_LEVELS = [
  'new-to-this',
  'comfortable',
  'expert',
] as const;

export type UserProfileComfort = (typeof USER_PROFILE_COMFORT_LEVELS)[number];

/**
 * The persisted answers. Both fields optional: the first-run step can be
 * skipped entirely, and a user may answer one question and not the other.
 */
export interface UserProfileSettings {
  role?: UserProfileRole;
  comfort?: UserProfileComfort;
}

export function isUserProfileRole(value: unknown): value is UserProfileRole {
  return (
    typeof value === 'string' &&
    (USER_PROFILE_ROLES as readonly string[]).includes(value)
  );
}

export function isUserProfileComfort(
  value: unknown,
): value is UserProfileComfort {
  return (
    typeof value === 'string' &&
    (USER_PROFILE_COMFORT_LEVELS as readonly string[]).includes(value)
  );
}

/** Human-readable labels for the first-run questions and the settings row. */
export const USER_PROFILE_ROLE_LABELS: Readonly<
  Record<UserProfileRole, string>
> = {
  engineer: 'Engineer',
  manager: 'Manager or lead',
  researcher: 'Researcher',
  operator: 'Operator or analyst',
  other: 'Something else',
};

export const USER_PROFILE_COMFORT_LABELS: Readonly<
  Record<UserProfileComfort, string>
> = {
  'new-to-this': 'New to agent tools',
  comfortable: 'Comfortable with them',
  expert: 'I build them',
};

/**
 * What the model is told to do with each answer. These sentences are the whole
 * payoff of asking, so they are authored here as data rather than assembled
 * from the label strings — a label is what the user reads, an instruction is
 * what the model acts on, and they are not the same sentence.
 */
const ROLE_INSTRUCTIONS: Readonly<Record<UserProfileRole, string>> = {
  engineer:
    'They are an engineer: lead with the concrete change, code, or command, and keep the framing short.',
  manager:
    'They lead a team: lead with the outcome and the trade-off, and keep implementation detail available but secondary.',
  researcher:
    'They do research: show the evidence and how a claim was derived before the conclusion.',
  operator:
    'They are an operator or analyst: lead with what to run or check and what the result will mean.',
  other:
    'They did not pick one of the offered roles, so do not assume a background — ask when the answer would differ by one.',
};

const COMFORT_INSTRUCTIONS: Readonly<Record<UserProfileComfort, string>> = {
  'new-to-this':
    'They are new to agent tools: name each unfamiliar concept the first time it appears, and do not assume Station vocabulary.',
  comfortable:
    'They are comfortable with agent tools: use the normal vocabulary without re-explaining the basics.',
  expert:
    'They build agent tools: skip the introductions and go straight to specifics, including internals when relevant.',
};

/**
 * Explains the one honest limit of this setting, in the words the UI must use
 * too. Exported so the copy and this module cannot drift.
 */
export const USER_PROFILE_ENGINE_REACH_NOTE =
  'Applies to chats run by Station’s own engine. External engines (such as Claude Code or Codex) build their own context, so this has no effect there.';

/**
 * The `[USER PROFILE]` block, or `null` when there is nothing the user
 * actually told us.
 *
 * Returns `null` — never a partial block, never a default — when the profile
 * is absent, empty, or carries values outside the declared vocabularies. A
 * profile with exactly one answered question yields a block with exactly that
 * one line.
 */
export function buildUserProfileContextBlock(
  profile: UserProfileSettings | null | undefined,
): string | null {
  if (!profile || typeof profile !== 'object') return null;

  const lines: string[] = [];
  if (isUserProfileRole(profile.role)) {
    lines.push(`- ${ROLE_INSTRUCTIONS[profile.role]}`);
  }
  if (isUserProfileComfort(profile.comfort)) {
    lines.push(`- ${COMFORT_INSTRUCTIONS[profile.comfort]}`);
  }
  if (lines.length === 0) return null;

  return [
    '[USER PROFILE]',
    'The person you are answering told Station this about themselves. Tune the shape of your answer to it; it does not change what is true.',
    ...lines,
    '[/USER PROFILE]',
  ].join('\n');
}

/** True when the user has answered at least one first-run profile question. */
export function hasAnsweredUserProfile(
  profile: UserProfileSettings | null | undefined,
): boolean {
  return buildUserProfileContextBlock(profile) !== null;
}
