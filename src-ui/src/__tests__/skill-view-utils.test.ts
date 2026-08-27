import { describe, expect, test } from 'vitest';
import {
  buildSkillListItems,
  buildSkillPayload,
  EMPTY_SKILL_FORM,
  filterSkills,
  formatSkillStatsSummary,
  formCommandWord,
  formVariables,
  type SkillForm,
  skillDetailToForm,
} from '../views/skills/skill-view-utils';

function form(overrides: Partial<SkillForm> = {}): SkillForm {
  return { ...EMPTY_SKILL_FORM, name: 'Release Check', ...overrides };
}

describe('the command a skill form declares', () => {
  test('is null until someone enables it — a body with variables is not a command', () => {
    expect(formCommandWord(form({ body: 'Ship {{ticket}}' }))).toBeNull();
  });

  test('defaults to the name slug and yields to a declared word', () => {
    expect(formCommandWord(form({ commandEnabled: true }))).toBe(
      'release-check',
    );
    expect(
      formCommandWord(form({ commandEnabled: true, commandName: ' ship ' })),
    ).toBe('ship');
  });
});

describe('the variables a skill form has', () => {
  test('come from the body, and a declaration the body dropped disappears', () => {
    expect(
      formVariables(
        form({
          body: 'Ship {{ticket}} now',
          variables: [
            { name: 'ticket', description: 'Jira key' },
            { name: 'stale', description: 'gone' },
          ],
        }),
      ),
    ).toEqual([{ name: 'ticket', description: 'Jira key' }]);
  });
});

describe('buildSkillPayload', () => {
  // Turning a command off is a WRITE. Omitting the field would leave the old
  // declaration on disk and the skill would go on answering to its word.
  test('sends command.enabled false rather than omitting the field', () => {
    expect(buildSkillPayload(form({ body: 'x' })).command).toEqual({
      enabled: false,
    });
  });

  test('carries only declarations that say something', () => {
    const payload = buildSkillPayload(
      form({
        body: 'Ship {{ticket}} to {{env}}',
        commandEnabled: true,
        variables: [{ name: 'ticket', description: 'Jira key' }],
      }),
    );
    expect(payload.variables).toEqual([
      { name: 'ticket', description: 'Jira key' },
    ]);
  });
});

describe('formatSkillStatsSummary', () => {
  // An unreadable counter store is not an unused skill.
  test('says the counters are unavailable rather than reporting zero', () => {
    expect(
      formatSkillStatsSummary({
        name: 'x',
        installed: true,
        statsUnavailable: 'usage file unreadable',
      } as any),
    ).toBe('run count unavailable');
  });

  test('is silent when the store was read and holds nothing for this skill', () => {
    expect(
      formatSkillStatsSummary({ name: 'x', installed: true } as any),
    ).toBeNull();
  });

  test('reports the counters that were actually recorded', () => {
    expect(
      formatSkillStatsSummary({
        name: 'x',
        installed: true,
        stats: { runs: 1, successes: 1, failures: 0, qualityScore: 100 },
      } as any),
    ).toBe('1 run · 100% success');
  });
});

describe('the skills list', () => {
  const skills = [
    { name: 'plain-skill', installed: true, source: 'local' },
    {
      name: 'release-check',
      installed: true,
      source: 'local',
      command: { enabled: true, global: true },
      stats: { runs: 2, successes: 2, failures: 0, qualityScore: 100 },
    },
  ] as any[];

  test('narrows to command skills when asked', () => {
    expect(filterSkills(skills, '', true).map((skill) => skill.name)).toEqual([
      'release-check',
    ]);
    expect(filterSkills(skills, '', false)).toHaveLength(2);
  });

  test('rows carry the command word and the run count', () => {
    expect(buildSkillListItems(skills)).toEqual([
      { id: 'plain-skill', name: 'plain-skill', subtitle: '' },
      {
        id: 'release-check',
        name: 'release-check',
        subtitle: '/release-check · 2 runs · 100% success',
      },
    ]);
  });
});

describe('skillDetailToForm', () => {
  test('reads both command switches as the two facts they are', () => {
    expect(
      skillDetailToForm({
        name: 'release-check',
        body: 'Ship it',
        command: { enabled: true, name: 'ship', global: false },
      }),
    ).toMatchObject({
      commandEnabled: true,
      commandName: 'ship',
      commandGlobal: false,
    });
  });
});
