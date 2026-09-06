import { describe, expect, test } from 'vitest';
import {
  buildSkillListItems,
  buildSkillPayload,
  EMPTY_SKILL_FORM,
  filterSkills,
  formatSkillStatsSummary,
  formCommandWord,
  formVariables,
  SKILLS_SUBTITLE,
  type SkillForm,
  skillDetailToForm,
  skillSourceLabel,
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
  // `origin` is what `/api/system/skills` sends beside `source` for a skill in
  // `<home>/skills`; a fixture carrying only `source` describes no real
  // response and would exercise the unrecorded branch by accident.
  const skills = [
    { name: 'plain-skill', installed: true, source: 'local', origin: 'user' },
    {
      name: 'release-check',
      installed: true,
      source: 'local',
      origin: 'user',
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
      {
        id: 'plain-skill',
        name: 'plain-skill',
        subtitle: '',
        source: 'This machine',
      },
      {
        id: 'release-check',
        name: 'release-check',
        subtitle: '/release-check · 2 runs · 100% success',
        source: 'This machine',
      },
    ]);
  });

  // #1582 D6. The chip and the band both read `source`, so this is the one
  // derivation both surfaces depend on. Every origin the contract defines has a
  // label, and an origin the listing does not carry says so instead of being
  // absorbed into "This machine".
  test('names the root each skill was loaded from, and names the gap', () => {
    expect(skillSourceLabel('package')).toBe('Built in');
    expect(skillSourceLabel('user')).toBe('This machine');
    expect(skillSourceLabel('project')).toBe('This workspace');
    expect(skillSourceLabel('registry')).toBe('Registry');
    expect(skillSourceLabel('plugin')).toBe('Plugin');
    expect(skillSourceLabel('migrated-playbook')).toBe('Migrated playbook');
    expect(skillSourceLabel(undefined)).toBe('Source unrecorded');
  });

  // The pane emits a band header whenever `section` changes, so a row order
  // that interleaves sources emits the same header repeatedly. Input order is
  // deliberately worst-case: built-in first, and two `user` rows split by a
  // `project` row.
  test('orders rows so each source band is contiguous, user roots first', () => {
    const mixed = [
      { name: 'built-a', installed: true, origin: 'package' },
      { name: 'mine-a', installed: true, origin: 'user' },
      { name: 'ours-a', installed: true, origin: 'project' },
      { name: 'mine-b', installed: true, origin: 'user' },
      { name: 'built-b', installed: true, origin: 'package' },
      { name: 'nowhere', installed: true },
    ] as any[];
    const rows = buildSkillListItems(mixed);
    expect(rows.map((row) => row.name)).toEqual([
      'ours-a',
      'mine-a',
      'mine-b',
      'built-a',
      'built-b',
      'nowhere',
    ]);
    // Contiguity is the property, stated as such rather than implied by the
    // order above: a band label may not reappear once a different one has
    // started, because that is when the pane emits a duplicate header.
    const bands = rows.map((row) => row.source);
    const started: string[] = [];
    for (const [index, band] of bands.entries()) {
      if (bands[index - 1] === band) continue;
      expect(started).not.toContain(band);
      started.push(band);
    }
  });

  test('the list subtitle no longer calls every loaded skill a workspace skill', () => {
    expect(SKILLS_SUBTITLE).not.toContain('workspace skills');
    expect(SKILLS_SUBTITLE).toContain('grouped by where it came from');
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
