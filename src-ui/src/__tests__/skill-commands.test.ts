import { describe, expect, test } from 'vitest';
import {
  agentCommandSkills,
  assignSkillVariableArgs,
  findMatchingSkillCommand,
  isSkillCommandOfferedTo,
  parseShellWords,
  substituteSkillVariables,
} from '../utils/skill-commands';

const global = {
  name: 'release-check',
  installed: true,
  command: { enabled: true, global: true },
} as any;
const attachedOnly = {
  name: 'deploy-notes',
  installed: true,
  command: { enabled: true, global: false },
} as any;
const notACommand = { name: 'plain-skill', installed: true } as any;

// CAT-R08. The rule this replaces read the authored record's own `agent`
// field, so the binding the agent editor wrote was never consulted and
// attaching a record to an agent changed nothing. `agent.skills` is now both
// the record the editor writes and the record this reads.
describe('skill command offers', () => {
  test('a global command skill is offered without being attached', () => {
    expect(isSkillCommandOfferedTo(global, { slug: 'station' })).toBe(true);
  });

  test('a non-global command skill is offered only where it is attached', () => {
    expect(
      isSkillCommandOfferedTo(attachedOnly, {
        slug: 'station',
        skills: ['deploy-notes'],
      }),
    ).toBe(true);
    expect(
      isSkillCommandOfferedTo(attachedOnly, { slug: 'station', skills: [] }),
    ).toBe(false);
  });

  test('a skill nobody enabled is never a command, attached or not', () => {
    expect(
      isSkillCommandOfferedTo(notACommand, {
        slug: 'station',
        skills: ['plain-skill'],
      }),
    ).toBe(false);
  });

  test('with no agent, only global command skills are offered', () => {
    expect(
      agentCommandSkills([global, attachedOnly, notACommand], null).map(
        (skill) => skill.name,
      ),
    ).toEqual(['release-check']);
  });
});

describe('findMatchingSkillCommand', () => {
  test('matches the declared word, not the skill name slug', () => {
    const renamed = {
      name: 'release-check',
      installed: true,
      command: { enabled: true, global: true, name: 'ship' },
    } as any;
    expect(findMatchingSkillCommand([renamed], 'ship', null)?.name).toBe(
      'release-check',
    );
    expect(
      findMatchingSkillCommand([renamed], 'release-check', null),
    ).toBeUndefined();
  });

  // The SERVER resolves clashes (`resolveSkillCommands`, then
  // `SkillService.listSkills`): exactly one skill per command word comes back
  // enabled, and each loser carries `command.enabled: false` plus a
  // `commandDiagnostic` naming the winner. This fixture is that response
  // shape, verbatim — a listing with TWO enabled skills on one word is not a
  // production shape, and the client must not invent a precedence for it.
  test('a clash loser stays unrunnable even where the agent attached it', () => {
    const clashingWinner = {
      name: 'ship-global',
      installed: true,
      command: { enabled: true, global: true, name: 'ship' },
    } as any;
    const clashingLoser = {
      name: 'ship-local',
      installed: true,
      command: { enabled: false, name: 'ship' },
      commandDiagnostic: "'/ship' is already used by the skill 'ship-global'",
    } as any;
    const agentWithLoserAttached = {
      slug: 'station',
      skills: ['ship-local'],
    };

    // Attaching the loser does not move the word: the server's winner runs.
    expect(
      findMatchingSkillCommand(
        [clashingLoser, clashingWinner],
        'ship',
        agentWithLoserAttached,
      )?.name,
    ).toBe('ship-global');
    // And the loser is offered nowhere, attachment included — its declaration
    // is not in effect.
    expect(isSkillCommandOfferedTo(clashingLoser, agentWithLoserAttached)).toBe(
      false,
    );
  });

  test('an enabled command is typable only where it is offered', () => {
    const attachedOnlyCommand = {
      name: 'deploy-notes',
      installed: true,
      command: { enabled: true, global: false, name: 'deploy' },
    } as any;

    expect(
      findMatchingSkillCommand([attachedOnlyCommand], 'deploy', {
        slug: 'station',
        skills: ['deploy-notes'],
      })?.name,
    ).toBe('deploy-notes');
    expect(
      findMatchingSkillCommand([attachedOnlyCommand], 'deploy', {
        slug: 'station',
        skills: [],
      }),
    ).toBeUndefined();
  });

  test('a command-disabled skill never matches its own would-be word', () => {
    expect(
      findMatchingSkillCommand([notACommand], 'plain-skill', {
        slug: 'station',
        skills: ['plain-skill'],
      }),
    ).toBeUndefined();
  });
});

// Review M3: the Test modal and the slash handler share ONE substitution
// derivation. Its contract: declared defaults apply; a variable with neither
// a provided value nor a usable default is REJECTED and named — never
// silently substituted with an empty string.
describe('substituteSkillVariables', () => {
  // In production the variables list is derived FROM the body
  // (`mergeSkillVariables`), so each case's list names only placeholders its
  // body actually contains.
  test('applies provided values and declared defaults', () => {
    expect(
      substituteSkillVariables(
        'Ship {{ticket}} to {{env}}',
        [{ name: 'ticket' }, { name: 'env', default: 'staging' }],
        { ticket: 'ABC-1' },
      ),
    ).toEqual({ ok: true, content: 'Ship ABC-1 to staging' });
  });

  test('rejects a missing no-default variable, naming it', () => {
    expect(
      substituteSkillVariables(
        'Ship {{ticket}} to {{env}}',
        [{ name: 'ticket' }, { name: 'env', default: 'staging' }],
        {},
      ),
    ).toEqual({ ok: false, missing: ['ticket'] });
  });

  test('an empty declared default is not a usable value', () => {
    expect(
      substituteSkillVariables('Notes: {{notes}}', [
        { name: 'notes', default: '' },
      ]),
    ).toEqual({ ok: false, missing: ['notes'] });
  });

  // Delta review: a CLEARED field (stored '') means "use the default", not
  // "supply nothing" — the placeholder is the default, the preview agrees.
  test('a cleared value falls back to the declared default', () => {
    expect(
      substituteSkillVariables(
        'Ship to {{env}}',
        [{ name: 'env', default: 'staging' }],
        { env: '' },
      ),
    ).toEqual({ ok: true, content: 'Ship to staging' });
  });

  test('a cleared value with no default is still missing', () => {
    expect(
      substituteSkillVariables('Ship {{ticket}}', [{ name: 'ticket' }], {
        ticket: '',
      }),
    ).toEqual({ ok: false, missing: ['ticket'] });
  });

  test('a whitespace-only provided value is no value', () => {
    expect(
      substituteSkillVariables('Ship {{ticket}}', [{ name: 'ticket' }], {
        ticket: '   ',
      }),
    ).toEqual({ ok: false, missing: ['ticket'] });
  });

  test('never substitutes an empty string for a missing variable', () => {
    const result = substituteSkillVariables(
      'Ship {{ticket}} now',
      [{ name: 'ticket' }],
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['ticket']);
    }
  });

  test('substitutes every occurrence, and values keep their spaces', () => {
    expect(
      substituteSkillVariables('{{a}} then {{a}}', [{ name: 'a' }], {
        a: 'two words',
      }),
    ).toEqual({ ok: true, content: 'two words then two words' });
  });
});

// Delta review: the ONE shell-style parser every slash-command consumer
// uses. Quotes group, backslash escapes, an unterminated quote is an error
// naming it — never a guess.
describe('parseShellWords', () => {
  test('groups double- and single-quoted words', () => {
    expect(parseShellWords('release "release notes" prod')).toEqual({
      ok: true,
      words: ['release', 'release notes', 'prod'],
    });
    expect(parseShellWords("release 'stage two' prod")).toEqual({
      ok: true,
      words: ['release', 'stage two', 'prod'],
    });
  });

  test('backslash escapes the next character outside and inside double quotes; single quotes are literal', () => {
    expect(parseShellWords('say \\"hi\\"')).toEqual({
      ok: true,
      words: ['say', '"hi"'],
    });
    expect(parseShellWords('env "a\\"b\\\\c"')).toEqual({
      ok: true,
      words: ['env', 'a"b\\c'],
    });
    // POSIX single quotes: no escapes inside, backslash is a literal.
    expect(parseShellWords("path 'a\\b'")).toEqual({
      ok: true,
      words: ['path', 'a\\b'],
    });
  });

  test('an unterminated quote is an error naming the quote', () => {
    expect(parseShellWords('release "unclosed')).toEqual({
      ok: false,
      error: 'unterminated double quote (") — it never closes',
    });
    expect(parseShellWords("release 'unclosed")).toEqual({
      ok: false,
      error: "unterminated single quote (') — it never closes",
    });
  });

  test('an explicitly quoted empty word is a word', () => {
    expect(parseShellWords('a "" b')).toEqual({
      ok: true,
      words: ['a', '', 'b'],
    });
  });
});

// Delta review: `name=value` assigns by name so an earlier defaulted variable
// can be skipped; positionals fill the unnamed variables in declaration
// order.
describe('assignSkillVariableArgs', () => {
  const vars = [{ name: 'notes', default: 'none' }, { name: 'env' }];

  test('positionals fill unnamed variables in declaration order', () => {
    expect(assignSkillVariableArgs(vars, ['release notes', 'prod'])).toEqual({
      ok: true,
      provided: { notes: 'release notes', env: 'prod' },
    });
  });

  test('a named assignment supplies a later variable while the earlier keeps its default', () => {
    expect(assignSkillVariableArgs(vars, ['env=prod'])).toEqual({
      ok: true,
      provided: { env: 'prod' },
    });
  });

  test('mixed: one named, one positional', () => {
    expect(assignSkillVariableArgs(vars, ['some notes', 'env=prod'])).toEqual({
      ok: true,
      provided: { notes: 'some notes', env: 'prod' },
    });
  });

  test('a named value keeps equals bytes; a non-declared prefix stays positional', () => {
    // `env=a=b` splits at the FIRST equals: env gets 'a=b'.
    expect(assignSkillVariableArgs(vars, ['env=a=b'])).toEqual({
      ok: true,
      provided: { env: 'a=b' },
    });
    // `foo=x` names no declared variable, so it is a positional value —
    // a word that merely CONTAINS '=' is not a typo to reject.
    expect(assignSkillVariableArgs(vars, ['foo=x', 'prod'])).toEqual({
      ok: true,
      provided: { notes: 'foo=x', env: 'prod' },
    });
  });

  test('more positionals than variables left is an error naming the surplus', () => {
    expect(assignSkillVariableArgs(vars, ['a', 'b', 'c'])).toEqual({
      ok: false,
      error: "no variable left for 'c' — this command takes 2 values",
    });
  });
});
