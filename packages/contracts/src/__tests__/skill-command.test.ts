import { describe, expect, test } from 'vitest';
import {
  findSkillCommandClash,
  isValidSkillCommandName,
  resolveSkillCommandName,
  resolveSkillCommands,
  SKILL_COMMAND_NAME_PATTERN,
  SKILL_COMMAND_NAME_RULE,
  skillCommandNameError,
  skillCommandSlug,
} from '../skill-command.js';
import {
  extractTemplateVariables,
  mergeSkillVariables,
} from '../skill-variables.js';

describe('extractTemplateVariables', () => {
  test('returns each placeholder once, in order of first appearance', () => {
    expect(
      extractTemplateVariables(
        'Ship {{ticket}} then re-check {{ticket}}/{{env}}',
      ),
    ).toEqual(['ticket', 'env']);
  });

  test('accepts dots and dashes, ignores non-placeholders', () => {
    expect(
      extractTemplateVariables('{{a.b}} {{c-d}} {no} {{ spaced }} {{}}'),
    ).toEqual(['a.b', 'c-d']);
  });

  test('a body with no placeholders has no variables', () => {
    expect(extractTemplateVariables('plain text')).toEqual([]);
  });
});

describe('mergeSkillVariables', () => {
  test('declarations attach description/default to body-derived names', () => {
    expect(
      mergeSkillVariables('Release {{ticket}} to {{env}}', [
        { name: 'ticket', description: 'Issue key', default: 'ABC-1' },
      ]),
    ).toEqual([
      { name: 'ticket', description: 'Issue key', default: 'ABC-1' },
      { name: 'env' },
    ]);
  });

  test('a declaration the body never uses is not returned', () => {
    expect(
      mergeSkillVariables('Release {{ticket}}', [
        { name: 'ticket' },
        { name: 'unused', description: 'nothing substitutes this' },
      ]),
    ).toEqual([{ name: 'ticket' }]);
  });

  test('an undefined body has no variables', () => {
    expect(mergeSkillVariables(undefined, [{ name: 'ticket' }])).toEqual([]);
  });
});

describe('skillCommandSlug', () => {
  test('reduces a name to what a user can type after a slash', () => {
    expect(skillCommandSlug('Release Check (v2)')).toBe('release-check-v2');
    expect(skillCommandSlug('--Edge--')).toBe('edge');
  });
});

describe('resolveSkillCommandName', () => {
  test('is null for a skill nobody enabled as a command', () => {
    expect(resolveSkillCommandName({ name: 'Release Check' })).toBeNull();
    expect(
      resolveSkillCommandName({
        name: 'Release Check',
        command: { enabled: false, name: 'release' },
      }),
    ).toBeNull();
  });

  test('prefers the declared name, else the slug', () => {
    expect(
      resolveSkillCommandName({
        name: 'Release Check',
        command: { enabled: true },
      }),
    ).toBe('release-check');
    expect(
      resolveSkillCommandName({
        name: 'Release Check',
        command: { enabled: true, name: 'ship' },
      }),
    ).toBe('ship');
  });
});

describe('findSkillCommandClash', () => {
  const skills = [
    { name: 'release-check', command: { enabled: true } },
    { name: 'ship-it', command: { enabled: true, name: 'ship' } },
    { name: 'quiet', command: { enabled: false, name: 'ship' } },
    { name: 'no-command' },
  ];

  test('names the skill already answering to that command', () => {
    expect(findSkillCommandClash(skills, 'ship', 'other')?.name).toBe(
      'ship-it',
    );
    expect(findSkillCommandClash(skills, 'release-check', 'other')?.name).toBe(
      'release-check',
    );
  });

  test('a skill does not clash with itself', () => {
    expect(findSkillCommandClash(skills, 'ship', 'ship-it')).toBeUndefined();
  });

  test('a command-disabled skill holds no command word', () => {
    expect(
      findSkillCommandClash(
        [{ name: 'quiet', command: { enabled: false, name: 'ship' } }],
        'ship',
        'other',
      ),
    ).toBeUndefined();
  });
});

describe('isValidSkillCommandName', () => {
  test('accepts only what a user can type after a slash', () => {
    expect(isValidSkillCommandName('release-check')).toBe(true);
    expect(isValidSkillCommandName('a1')).toBe(true);
    for (const bad of ['', 'Release', 'ship it', '-lead', 'ship!', 'ünï']) {
      expect(isValidSkillCommandName(bad)).toBe(false);
    }
  });
});

describe('resolveSkillCommands', () => {
  test('an untypable derived word is disabled with the reason, not enabled', () => {
    const resolved = resolveSkillCommands([
      { name: '🎉🎉', command: { enabled: true } },
    ]);
    expect(resolved.get('🎉🎉')).toEqual({
      command: { enabled: false },
      commandDiagnostic: expect.stringContaining('no typable command word'),
    });
  });

  test('an invalid declared word is disabled with the reason', () => {
    const resolved = resolveSkillCommands([
      { name: 'shipper', command: { enabled: true, name: 'Ship It' } },
    ]);
    expect(resolved.get('shipper')?.command?.enabled).toBe(false);
    expect(resolved.get('shipper')?.commandDiagnostic).toContain(
      SKILL_COMMAND_NAME_RULE,
    );
  });

  test('a clash is decided by skill name, not by discovery order', () => {
    const skills = [
      { name: 'zebra', command: { enabled: true, name: 'ship' } },
      { name: 'alpha', command: { enabled: true, name: 'ship' } },
    ];
    const forward = resolveSkillCommands(skills);
    const reversed = resolveSkillCommands([...skills].reverse());

    for (const resolved of [forward, reversed]) {
      expect(resolved.get('alpha')?.command?.enabled).toBe(true);
      expect(resolved.get('alpha')?.commandDiagnostic).toBeUndefined();
      expect(resolved.get('zebra')?.command?.enabled).toBe(false);
      expect(resolved.get('zebra')?.commandDiagnostic).toContain("'alpha'");
    }
  });

  test('a skill that declares nothing gets no command and no diagnostic', () => {
    expect(resolveSkillCommands([{ name: 'plain' }]).get('plain')).toEqual({});
  });

  test('a deliberately disabled declaration is kept as authored, undiagnosed', () => {
    const resolved = resolveSkillCommands([
      { name: 'quiet', command: { enabled: false, name: 'ship' } },
      { name: 'loud', command: { enabled: true, name: 'ship' } },
    ]);
    expect(resolved.get('quiet')).toEqual({
      command: { enabled: false, name: 'ship' },
    });
    expect(resolved.get('loud')?.command?.enabled).toBe(true);
  });
});

describe('resolveSkillCommands source precedence (delta finding 1)', () => {
  test("a package skill cannot take a user skill's command word", () => {
    // The reviewer's exact scenario: the package name sorts FIRST, so a
    // name-only tiebreak handed it the user's `/ship`.
    const resolved = resolveSkillCommands([
      {
        name: 'zebra-release',
        origin: 'user',
        command: { enabled: true, name: 'ship' },
      },
      {
        name: 'alpha-release',
        origin: 'package',
        command: { enabled: true, name: 'ship' },
      },
    ]);

    expect(resolved.get('zebra-release')?.command?.enabled).toBe(true);
    expect(resolved.get('zebra-release')?.commandDiagnostic).toBeUndefined();
    expect(resolved.get('alpha-release')?.command?.enabled).toBe(false);
    expect(resolved.get('alpha-release')?.commandDiagnostic).toContain(
      "'zebra-release'",
    );
  });

  test('precedence runs local > registry > unknown > plugin > package', () => {
    const tiers = [
      { name: 'z-user', origin: 'user' as const },
      { name: 'y-migrated', origin: 'migrated-playbook' as const },
      { name: 'x-registry', origin: 'registry' as const },
      { name: 'w-unknown', origin: undefined },
      { name: 'v-plugin', origin: 'plugin' as const },
      { name: 'u-package', origin: 'package' as const },
    ];
    // Winner at each depth: drop the top tier and the next one must take over.
    const expectedWinners = [
      'y-migrated',
      'x-registry',
      'w-unknown',
      'v-plugin',
      'u-package',
    ];
    for (const [index, expected] of expectedWinners.entries()) {
      const resolved = resolveSkillCommands(
        tiers.slice(index + 1).map((tier) => ({
          ...tier,
          command: { enabled: true, name: 'ship' },
        })),
      );
      expect(resolved.get(expected)?.command?.enabled).toBe(true);
    }
    // `user` and `migrated-playbook` share a tier, so name breaks the tie.
    const sameTier = resolveSkillCommands([
      { name: 'z-user', origin: 'user', command: { enabled: true, name: 's' } },
      {
        name: 'y-migrated',
        origin: 'migrated-playbook',
        command: { enabled: true, name: 's' },
      },
    ]);
    expect(sameTier.get('y-migrated')?.command?.enabled).toBe(true);
  });

  test('the winner is the same whichever order discovery reports them in', () => {
    const skills = [
      {
        name: 'zebra-release',
        origin: 'user' as const,
        command: { enabled: true, name: 'ship' },
      },
      {
        name: 'alpha-release',
        origin: 'package' as const,
        command: { enabled: true, name: 'ship' },
      },
    ];
    for (const order of [skills, [...skills].reverse()]) {
      const resolved = resolveSkillCommands(order);
      expect(resolved.get('zebra-release')?.command?.enabled).toBe(true);
      expect(resolved.get('alpha-release')?.command?.enabled).toBe(false);
    }
  });
});

describe('findSkillCommandClash exclusion identity', () => {
  test('excluding by a NEW name would hide the skill that already carries it', () => {
    const skills = [
      { name: 'beta', command: { enabled: true } },
      { name: 'alpha', command: { enabled: true } },
    ];
    // Renaming `alpha` to `beta`: the claim to check is `/beta`, and the
    // skill to ignore is `alpha` — the one being renamed — not `beta`.
    expect(findSkillCommandClash(skills, 'beta', 'alpha')?.name).toBe('beta');
    // Excluding by the new name is the bug: it hides the real holder.
    expect(findSkillCommandClash(skills, 'beta', 'beta')).toBeUndefined();
  });
});

/**
 * station#3737: `Ship It` was refused by the HTTP schema with the rule it
 * broke, and the editor went on offering it. One rule, one sentence.
 */
describe('skill command word rule', () => {
  test('names the rule a word breaks, and says nothing when it keeps it', () => {
    expect(skillCommandNameError('Ship It')).toBe(SKILL_COMMAND_NAME_RULE);
    expect(skillCommandNameError('SHIP')).toBe(SKILL_COMMAND_NAME_RULE);
    expect(skillCommandNameError('-ship')).toBe(SKILL_COMMAND_NAME_RULE);
    expect(skillCommandNameError('ship-it')).toBeNull();
    expect(skillCommandNameError('  ship-it  ')).toBeNull();
  });

  test('an absent word is its own answer, not the shape rule', () => {
    expect(skillCommandNameError('')).toBe(
      'A command word is needed before this skill can be typed as a command.',
    );
  });

  // The sentence and the test are the same rule the pattern is.
  test('the rule agrees with the pattern it describes', () => {
    for (const word of ['ship-it', 'a', 'x9', '0-9-a']) {
      expect(SKILL_COMMAND_NAME_PATTERN.test(word)).toBe(true);
      expect(skillCommandNameError(word)).toBeNull();
    }
    for (const word of ['Ship It', '-x', 'a_b', 'a b']) {
      expect(SKILL_COMMAND_NAME_PATTERN.test(word)).toBe(false);
      expect(skillCommandNameError(word)).toBe(SKILL_COMMAND_NAME_RULE);
    }
  });
});
