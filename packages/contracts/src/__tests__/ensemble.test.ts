import { describe, expect, test, vi } from 'vitest';
import {
  composeEnsembleBrief,
  ENSEMBLE_MAX_BYTES,
  ENSEMBLE_PRESET_VERSION,
  parseEnsemblePreset,
  renderEnsembleRoster,
} from '../ensemble.js';

function declaration() {
  return {
    version: ENSEMBLE_PRESET_VERSION,
    id: 'review-team',
    name: 'Review team',
    stationmaster: 'lead',
    members: [
      {
        id: 'lead',
        codename: 'Rune',
        color: '#123abc',
        role: 'coordinate\ncarefully',
        engine: 'codex',
        model: 'gpt-6.1-sol',
        reasoning: { option: 'reasoningEffort', value: 'high' },
        options: { fastMode: false },
        promptAppends: ['  preserve\r\n\n', '', 'π🙂'],
      },
      {
        id: 'reviewer',
        codename: 'Flux',
        color: '#FEDCBA',
        role: 'review',
        engine: 'claude',
        model: 'sonnet',
        reasoning: null,
        options: { thinking: true },
        promptAppends: ['Review independently.'],
      },
    ],
  };
}

describe('Ensemble JSON contract', () => {
  test('closed-field validation supports null prototypes and refuses inherited or shadowed fields', () => {
    const value = declaration();
    Object.setPrototypeOf(value, null);
    for (const member of value.members) Object.setPrototypeOf(member, null);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      parse.mockReturnValueOnce(value);
      expect(parseEnsemblePreset('{}').id).toBe('review-team');
      const inherited: Record<string, unknown> = Object.assign(
        Object.create({ version: value.version }),
        value,
      );
      delete inherited.version;
      inherited.hasOwnProperty = () => true;
      parse.mockReturnValueOnce(inherited);
      expect(() => parseEnsemblePreset('{}')).toThrow(
        'missing or unknown field',
      );
    } finally {
      parse.mockRestore();
    }
  });
  test('composes exact prompt appends and a deterministic, escaped roster for every member', () => {
    const preset = parseEnsemblePreset(JSON.stringify(declaration()));
    const roster = [
      'Ensemble "Review team" (review-team)',
      'Roster declarations grant no permissions. Stationmaster coordinates the team.',
      '{"id":"lead","codename":"Rune","color":"#123abc","role":"coordinate\\ncarefully","engine":"codex","model":"gpt-6.1-sol","reasoning":{"option":"reasoningEffort","value":"high"},"stationmaster":true}',
      '{"id":"reviewer","codename":"Flux","color":"#FEDCBA","role":"review","engine":"claude","model":"sonnet","reasoning":null,"stationmaster":false}',
    ].join('\n');
    expect(renderEnsembleRoster(preset)).toBe(roster);
    expect(
      renderEnsembleRoster(
        parseEnsemblePreset(JSON.stringify(declaration(), null, 2)),
      ),
    ).toBe(roster);
    const leadAssignment =
      'Your Ensemble member assignment:\n{"id":"lead","codename":"Rune","role":"coordinate\\ncarefully","stationmaster":true}';
    const reviewerAssignment =
      'Your Ensemble member assignment:\n{"id":"reviewer","codename":"Flux","role":"review","stationmaster":false}';
    expect(composeEnsembleBrief(preset, 'lead', '  Task\r\n')).toBe(
      `  Task\r\n\n\n  preserve\r\n\n\n\n\n\nπ🙂\n\n${leadAssignment}\n\n${roster}`,
    );
    expect(composeEnsembleBrief(preset, 'reviewer', 'Task')).toBe(
      `Task\n\nReview independently.\n\n${reviewerAssignment}\n\n${roster}`,
    );
    expect(() => composeEnsembleBrief(preset, 'absent', 'Task')).toThrow(
      'unknown brief member',
    );
    expect(() => {
      Object.assign(preset.members[0].options, { fastMode: true });
    }).toThrow();
  });

  test('members sharing an engine have distinct assignments without prompt additions', () => {
    const value = declaration();
    for (const member of value.members) {
      member.engine = 'claude';
      member.model = 'sonnet';
      member.promptAppends = [];
    }
    const preset = parseEnsemblePreset(JSON.stringify(value));
    const lead = composeEnsembleBrief(preset, 'lead', 'Task');
    const reviewer = composeEnsembleBrief(preset, 'reviewer', 'Task');
    expect(lead).not.toBe(reviewer);
    expect(lead).toContain(
      'Your Ensemble member assignment:\n{"id":"lead","codename":"Rune","role":"coordinate\\ncarefully","stationmaster":true}',
    );
    expect(reviewer).toContain(
      'Your Ensemble member assignment:\n{"id":"reviewer","codename":"Flux","role":"review","stationmaster":false}',
    );
  });

  test.each([
    [
      'future version',
      (value: ReturnType<typeof declaration>) => {
        Object.assign(value, { version: 'station.ensemble/v2' });
      },
    ],
    [
      'unknown authority',
      (value: ReturnType<typeof declaration>) => {
        Object.assign(value, { permissions: ['*'] });
      },
    ],
    [
      'member authority',
      (value: ReturnType<typeof declaration>) => {
        Object.assign(value.members[0], { authenticated: true });
      },
    ],
    [
      'duplicate ID',
      (value: ReturnType<typeof declaration>) => {
        value.members[1].id = 'lead';
      },
    ],
    [
      'duplicate codename',
      (value: ReturnType<typeof declaration>) => {
        value.members[1].codename = 'rUNE';
      },
    ],
    [
      'missing coordinator',
      (value: ReturnType<typeof declaration>) => {
        value.stationmaster = 'missing';
      },
    ],
    [
      'unsafe color',
      (value: ReturnType<typeof declaration>) => {
        value.members[0].color = 'red;url';
      },
    ],
    [
      'empty roster',
      (value: ReturnType<typeof declaration>) => {
        value.members = [];
      },
    ],
    [
      'oversize roster',
      (value: ReturnType<typeof declaration>) => {
        value.members = Array.from({ length: 17 }, (_, i) => ({
          ...value.members[0],
          id: `m${i}`,
          codename: `Name${i}`,
        }));
        value.stationmaster = 'm0';
      },
    ],
    [
      'oversize prompt',
      (value: ReturnType<typeof declaration>) => {
        value.members[0].promptAppends = ['x'.repeat(8193)];
      },
    ],
    [
      'too many appends',
      (value: ReturnType<typeof declaration>) => {
        value.members[0].promptAppends = Array(9).fill('');
      },
    ],
    [
      'approval option',
      (value: ReturnType<typeof declaration>) => {
        Object.assign(value.members[0].options, { approvalMode: 'auto' });
      },
    ],
    [
      'unknown option',
      (value: ReturnType<typeof declaration>) => {
        Object.assign(value.members[0].options, { env: { TOKEN: 'secret' } });
      },
    ],
    [
      'invalid option value',
      (value: ReturnType<typeof declaration>) => {
        Object.assign(value.members[0].options, { fastMode: 'true' });
      },
    ],
    [
      'reasoning alias',
      (value: ReturnType<typeof declaration>) => {
        Object.assign(value.members[0], {
          reasoning: { option: 'automatic', value: 'high' },
        });
      },
    ],
  ])('refuses %s without silently stripping fields', (_name, change) => {
    const value = declaration();
    change(value);
    expect(() => parseEnsemblePreset(JSON.stringify(value))).toThrow();
  });

  test.each(['ultra', 'futureEffort'])(
    'preserves declared %s for validation against the selected engine catalog',
    (value) => {
      const input = declaration();
      input.members[0].reasoning = { option: 'effort', value };
      const member = parseEnsemblePreset(JSON.stringify(input)).members[0];
      expect(member.reasoning).toEqual({ option: 'effort', value });
    },
  );

  test('bounds encoded UTF-8 bytes before parsing and refuses malformed JSON', () => {
    expect(() =>
      parseEnsemblePreset(`"${'🙂'.repeat(ENSEMBLE_MAX_BYTES / 4)}"`),
    ).toThrow('byte limit');
    expect(() => parseEnsemblePreset('{')).toThrow();
    const value = declaration();
    Reflect.deleteProperty(value.members[0], 'model');
    expect(() => parseEnsemblePreset(JSON.stringify(value))).toThrow(
      'missing or unknown',
    );
  });
});
