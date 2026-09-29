import {
  resolveSkillCommands,
  SKILL_COMMAND_NAME_REQUIRED,
  SKILL_COMMAND_NAME_RULE,
  skillCommandNameError,
} from '@kontourai/station-contracts/skill-command';
import { redactDeep } from '@kontourai/station-shared/redaction';
import { describe, expect, test } from 'vitest';
import { localSkillUpdateSchema } from '../../../routes/schemas/schema-definitions/content.js';
import { refuseInvalidSkillCommand } from '../skill-command-validation.js';

/**
 * sol review, LOW: the command-word rule was single-sourced into the HTTP
 * schema and the editor field, while `skill-command-validation.ts` — the guard
 * every write path shares, including the markdown import — kept wording of its
 * own. A direct service caller and an HTTP refusal therefore told a person two
 * different things about one rule, and either could drift.
 *
 * Four surfaces refuse the same word here. All four have to say the same rule.
 */
const UNTYPABLE = 'Ship It';

function schemaRefusal(word: string): string {
  const parsed = localSkillUpdateSchema.safeParse({
    command: { enabled: true, name: word },
  });
  expect(parsed.success).toBe(false);
  return parsed.success
    ? ''
    : parsed.error.issues.map((issue) => issue.message).join(' ');
}

describe('the command-word rule is one sentence', () => {
  test('the write guard, the HTTP schema, the read diagnostic and the field agree', () => {
    const guard = refuseInvalidSkillCommand(
      'ship-it',
      { enabled: true, name: UNTYPABLE },
      [],
    );
    expect(guard?.error).toContain(SKILL_COMMAND_NAME_RULE);

    expect(schemaRefusal(UNTYPABLE)).toContain(SKILL_COMMAND_NAME_RULE);

    const resolved = resolveSkillCommands([
      { name: 'ship-it', command: { enabled: true, name: UNTYPABLE } },
    ] as never);
    expect(resolved.get('ship-it')?.commandDiagnostic).toContain(
      SKILL_COMMAND_NAME_RULE,
    );

    expect(skillCommandNameError(UNTYPABLE)).toBe(SKILL_COMMAND_NAME_RULE);
  });

  test('and so is the other half of it — there has to BE a word', () => {
    const guard = refuseInvalidSkillCommand('!!!', { enabled: true }, []);
    expect(guard?.error).toContain(SKILL_COMMAND_NAME_REQUIRED);

    const resolved = resolveSkillCommands([
      { name: '!!!', command: { enabled: true } },
    ] as never);
    expect(resolved.get('!!!')?.commandDiagnostic).toContain(
      SKILL_COMMAND_NAME_REQUIRED,
    );

    expect(skillCommandNameError('')).toBe(SKILL_COMMAND_NAME_REQUIRED);
  });

  // A refusal carried through `redactDeep` (route-error `details`, recorded
  // tool results) has anything shaped like a filesystem path rewritten, so a
  // rule that quoted the slash itself would arrive as `[REDACTED_PATH]`.
  test('the rule survives the server redaction', () => {
    const refusals = {
      guard: refuseInvalidSkillCommand(
        'ship-it',
        { enabled: true, name: UNTYPABLE },
        [],
      )?.error,
      schema: schemaRefusal(UNTYPABLE),
      diagnostic: resolveSkillCommands([
        { name: 'ship-it', command: { enabled: true, name: UNTYPABLE } },
      ] as never).get('ship-it')?.commandDiagnostic,
    };
    for (const refusal of Object.values(refusals)) {
      expect(refusal).toContain(SKILL_COMMAND_NAME_RULE);
    }

    expect(redactDeep(refusals)).toEqual(refusals);
  });
});
