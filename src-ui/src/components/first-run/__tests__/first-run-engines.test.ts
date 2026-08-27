/**
 * The first-run engines chapter's decisions, tested where they live: which
 * engines are listed, which are ticked, which can be ticked at all, what a
 * confirm would actually create, and how a create's result is reported.
 */

import type { ExternalEngineReadinessProjection } from '@kontourai/station-contracts/system-status';
import { describe, expect, test } from 'vitest';
import type { AgentData } from '../../../contexts/AgentsContext';
import {
  buildFirstRunEnableBatch,
  buildFirstRunEngineOptions,
  type FirstRunEnableOutcome,
  failedFirstRunEngineIds,
  firstRunEnableFailureOutcome,
  firstRunEnableOutcomeMessage,
  firstRunEnableSuccessOutcome,
  firstRunEngineChapterHasWork,
  firstRunEngineRowLabel,
  summarizeFirstRunEnableOutcomes,
  unplannableFirstRunEngineOutcomes,
} from '../first-run-engines';

function engine(
  overrides: Partial<ExternalEngineReadinessProjection> & { name: string },
): ExternalEngineReadinessProjection {
  return {
    engineId: overrides.name.toLowerCase(),
    detected: false,
    ready: false,
    source: null,
    ...overrides,
  } as ExternalEngineReadinessProjection;
}

function agent(overrides: Partial<AgentData>): AgentData {
  return {
    slug: 'an-agent',
    name: 'An Agent',
    ...overrides,
  } as AgentData;
}

const READY_CODEX = engine({
  name: 'Codex',
  engineConnectionId: 'codex' as never,
  detected: true,
  ready: true,
  source: 'cli',
});

describe('buildFirstRunEngineOptions — what the checklist may offer', () => {
  test('a ready, addressable engine is offered and pre-ticked', () => {
    const [option] = buildFirstRunEngineOptions({
      engines: [READY_CODEX],
      agents: [],
    });
    expect(option).toMatchObject({
      engineId: 'codex',
      name: 'Codex',
      state: 'available',
      defaultChecked: true,
      selectable: true,
    });
  });

  test('an engine that already has an authored Agent is ticked and locked', () => {
    // Idempotency has to be VISIBLE, not merely safe: a second device against
    // the same home must show the user what they already have.
    const [option] = buildFirstRunEngineOptions({
      engines: [READY_CODEX],
      agents: [
        agent({
          name: 'Codex Agent',
          execution: { agentConnectionId: 'codex' } as never,
        }),
      ],
    });
    expect(option).toMatchObject({
      state: 'enabled',
      defaultChecked: true,
      selectable: false,
    });
    expect(option.note).toContain('Codex Agent');
  });

  test('a project-OWNED Agent does not make an engine read as already enabled', () => {
    // First run has no project context, and §3.3 A1 says an owned Agent never
    // appears outside its own project. Counting one here would claim "Already
    // set up as X" for an Agent this context cannot reach, while the global
    // picker still offers Enable for the same engine (#3027 M2, the defect
    // the picker already paid a review round to fix).
    const [option] = buildFirstRunEngineOptions({
      engines: [READY_CODEX],
      agents: [
        agent({
          name: 'Codex Agent',
          project: 'some-project',
          execution: { agentConnectionId: 'codex' } as never,
        }),
      ],
    });
    expect(option.state).toBe('available');
    expect(option.selectable).toBe(true);
  });

  test('a global Agent bound to the engine still counts', () => {
    // The other direction, so the scoping cannot pass by excluding everything.
    const [option] = buildFirstRunEngineOptions({
      engines: [READY_CODEX],
      agents: [
        agent({
          name: 'Codex Agent',
          execution: { agentConnectionId: 'codex' } as never,
        }),
      ],
    });
    expect(option.state).toBe('enabled');
  });

  test('the engine-default alias row itself never counts as already enabled', () => {
    // The alias carries the same binding as the authored Agent would, so the
    // FIND has to exclude it — otherwise every engine reads as done and the
    // chapter creates nothing, ever.
    const [option] = buildFirstRunEngineOptions({
      engines: [READY_CODEX],
      agents: [
        agent({
          name: 'Codex',
          engineDefault: true,
          execution: { agentConnectionId: 'codex' } as never,
        }),
      ],
    });
    expect(option.state).toBe('available');
  });

  test('an already-enabled engine that is no longer ready says both things', () => {
    const [option] = buildFirstRunEngineOptions({
      engines: [
        engine({
          name: 'Codex',
          engineConnectionId: 'codex' as never,
          detected: true,
          reason: 'sign_in_required',
        }),
      ],
      agents: [
        agent({
          name: 'Codex Agent',
          execution: { agentConnectionId: 'codex' } as never,
        }),
      ],
    });
    expect(option.state).toBe('enabled');
    expect(option.note).toContain('Codex Agent');
    expect(option.note).toContain('Sign in to Codex');
  });

  test('a detected but unready engine is shown with its reason and cannot be ticked', () => {
    // The server withholds the alias row's `enable` signal for exactly these,
    // so offering one would offer a click that could not succeed.
    const [option] = buildFirstRunEngineOptions({
      engines: [
        engine({
          name: 'Claude Code',
          engineConnectionId: 'claude' as never,
          detected: true,
          reason: 'sign_in_required',
        }),
      ],
      agents: [],
    });
    expect(option).toMatchObject({
      state: 'blocked',
      defaultChecked: false,
      selectable: false,
    });
    expect(option.note).toBe('Sign in to Claude Code to use it here.');
  });

  test.each([
    ['disabled' as const, 'Codex is turned off in Connections.'],
    ['cannot_verify' as const, 'Station could not verify Codex is ready.'],
    ['missing_prerequisites' as const, 'Codex needs its setup finished first.'],
    [undefined, 'Codex is not ready yet.'],
  ])('states the reason for %s', (reason, expected) => {
    const [option] = buildFirstRunEngineOptions({
      engines: [
        engine({
          name: 'Codex',
          engineConnectionId: 'codex' as never,
          detected: true,
          ...(reason ? { reason } : {}),
        }),
      ],
      agents: [],
    });
    expect(option.note).toBe(expected);
  });

  test('an unverifiable engine is shown even though nothing was detected', () => {
    // Mirrors `setupBannerVariant`'s existing rule: an adapter Station could
    // not probe is an unknown, not an absence.
    const [option] = buildFirstRunEngineOptions({
      engines: [
        engine({
          name: 'Plugin Engine',
          engineConnectionId: 'plugin' as never,
          reason: 'cannot_verify',
        }),
      ],
      agents: [],
    });
    expect(option.state).toBe('blocked');
  });

  test('a ready engine with no connection identity is shown, not offered', () => {
    // `resolveEngineConnectionId` returns undefined for an adapter the
    // registry does not know. There is nothing an Agent could bind to, and
    // dropping the row would be indistinguishable from Station not supporting
    // the engine at all.
    const [option] = buildFirstRunEngineOptions({
      engines: [engine({ name: 'Unbound', detected: true, ready: true })],
      agents: [],
    });
    expect(option).toMatchObject({ state: 'blocked', selectable: false });
    expect(option.note).toBe('Station has no connection for Unbound yet.');
  });

  test('an undetected engine is secondary and never ticked', () => {
    const [option] = buildFirstRunEngineOptions({
      engines: [
        engine({
          name: 'Codex',
          engineConnectionId: 'codex' as never,
          reason: 'missing_prerequisites',
        }),
      ],
      agents: [],
    });
    expect(option).toMatchObject({
      state: 'undetected',
      defaultChecked: false,
      selectable: false,
      note: 'Not found on this machine.',
    });
  });

  test('orders actionable rows first and keeps the producer order inside a group', () => {
    const options = buildFirstRunEngineOptions({
      engines: [
        engine({ name: 'Gone', engineConnectionId: 'gone' as never }),
        engine({
          name: 'Blocked',
          engineConnectionId: 'blocked' as never,
          detected: true,
        }),
        { ...READY_CODEX, engineId: 'codex' as never, name: 'Codex' },
        engine({
          name: 'Second Ready',
          engineId: 'second' as never,
          engineConnectionId: 'second' as never,
          detected: true,
          ready: true,
        }),
      ],
      agents: [],
    });
    expect(options.map((option) => option.name)).toEqual([
      'Codex',
      'Second Ready',
      'Blocked',
      'Gone',
    ]);
  });
});

describe('firstRunEngineChapterHasWork — when the chapter is worth showing', () => {
  test('nothing detected anywhere means no card at all', () => {
    const options = buildFirstRunEngineOptions({
      engines: [
        engine({ name: 'Codex', engineConnectionId: 'codex' as never }),
        engine({ name: 'Claude Code', engineConnectionId: 'claude' as never }),
      ],
      agents: [],
    });
    expect(firstRunEngineChapterHasWork(options)).toBe(false);
  });

  test('an empty server answer means no card', () => {
    expect(firstRunEngineChapterHasWork([])).toBe(false);
  });

  test('a detected-but-blocked engine is still worth showing', () => {
    const options = buildFirstRunEngineOptions({
      engines: [
        engine({
          name: 'Codex',
          engineConnectionId: 'codex' as never,
          detected: true,
          reason: 'sign_in_required',
        }),
      ],
      agents: [],
    });
    expect(firstRunEngineChapterHasWork(options)).toBe(true);
  });
});

describe('buildFirstRunEnableBatch — what a confirm actually creates', () => {
  const options = buildFirstRunEngineOptions({
    engines: [
      READY_CODEX,
      engine({
        name: 'Claude Code',
        engineId: 'claude-code' as never,
        engineConnectionId: 'claude' as never,
        detected: true,
        ready: true,
      }),
      engine({
        name: 'Kiro',
        engineId: 'kiro' as never,
        engineConnectionId: 'kiro' as never,
        detected: true,
        reason: 'sign_in_required',
      }),
    ],
    agents: [
      agent({
        name: 'Claude Code Agent',
        execution: { agentConnectionId: 'claude' } as never,
      }),
    ],
  });

  test('plans one materialize per newly selected engine, carrying only the engine binding', () => {
    // No draft, and deliberately so: a name invented here is what produced a
    // "<engine> Agent" row beside the engine's own. The server names it.
    const plan = buildFirstRunEnableBatch(options, ['codex']);
    expect(plan).toEqual([
      {
        engineId: 'codex',
        name: 'Codex',
        engineConnectionId: 'codex',
      },
    ]);
  });

  test('creates nothing for an engine that is already enabled', () => {
    // The already-enabled row renders CHECKED, so its id is in the selection
    // set. `selectable` — not the selection — is what may authorise a create;
    // this is the second-run duplicate the chapter must never produce.
    expect(buildFirstRunEnableBatch(options, ['claude-code'])).toEqual([]);
  });

  test('creates nothing for a blocked engine even if its id is selected', () => {
    expect(buildFirstRunEnableBatch(options, ['kiro'])).toEqual([]);
  });

  test('an untouched checklist still only creates the ticked engines', () => {
    const plan = buildFirstRunEnableBatch(
      options,
      options.filter((o) => o.defaultChecked).map((o) => o.engineId),
    );
    expect(plan.map((item) => item.engineId)).toEqual(['codex']);
  });

  test('an empty selection creates nothing', () => {
    expect(buildFirstRunEnableBatch(options, [])).toEqual([]);
  });
});

describe('unplannableFirstRunEngineOutcomes — asked for, cannot be attempted', () => {
  const options = buildFirstRunEngineOptions({
    engines: [
      READY_CODEX,
      engine({
        name: 'Claude Code',
        engineId: 'claude-code' as never,
        engineConnectionId: 'claude' as never,
        detected: true,
        ready: true,
      }),
      engine({
        name: 'Kiro',
        engineId: 'kiro' as never,
        engineConnectionId: 'kiro' as never,
        detected: true,
        reason: 'sign_in_required',
      }),
    ],
    agents: [
      agent({
        name: 'Claude Code Agent',
        execution: { agentConnectionId: 'claude' } as never,
      }),
    ],
  });

  test('an engine that CAN be planned is not reported here', () => {
    expect(unplannableFirstRunEngineOutcomes(options, ['codex'])).toEqual([]);
  });

  test('an already-enabled engine is a resolution, not a failure', () => {
    // It has no plan entry because the Agent exists. Reporting it as failed
    // would make the second-device case — the one the whole find-or-create
    // exists for — read as a broken run.
    expect(unplannableFirstRunEngineOutcomes(options, ['claude-code'])).toEqual(
      [],
    );
  });

  test('a blocked engine is reported with the row’s OWN reason', () => {
    const [outcome] = unplannableFirstRunEngineOutcomes(options, ['kiro']);
    expect(outcome).toMatchObject({
      engineId: 'kiro',
      name: 'Kiro',
      status: 'failed',
      message: 'Sign in to Kiro to use it here.',
    });
    expect(firstRunEnableOutcomeMessage(outcome)).toBe(
      'Kiro: could not be set up. Sign in to Kiro to use it here.',
    );
  });

  test('an engine that has left the catalog keeps the name the report gave it', () => {
    const [outcome] = unplannableFirstRunEngineOutcomes(
      options,
      ['muse'],
      new Map([['muse', 'Muse Code']]),
    );
    expect(outcome).toMatchObject({
      engineId: 'muse',
      name: 'Muse Code',
      status: 'failed',
      message: 'Station is no longer offering it here.',
    });
  });

  test('with no name known at all it still reports rather than dropping the request', () => {
    // A raw id in the copy is worse than a good name and better than silence:
    // the alternative is the run completing over an engine nothing mentions.
    expect(unplannableFirstRunEngineOutcomes(options, ['muse'])).toMatchObject([
      { engineId: 'muse', name: 'muse', status: 'failed' },
    ]);
  });

  test('a duplicate request is reported once', () => {
    expect(
      unplannableFirstRunEngineOutcomes(options, ['muse', 'muse']),
    ).toHaveLength(1);
  });
});

describe('per-engine outcomes', () => {
  const item = buildFirstRunEnableBatch(
    buildFirstRunEngineOptions({ engines: [READY_CODEX], agents: [] }),
    ['codex'],
  )[0];

  test('a clean create reports the name the SERVER assigned', () => {
    // Not a name this chapter predicted: materialize is find-or-create, so on
    // a second device the reported name is the row that already existed.
    expect(firstRunEnableSuccessOutcome(item, 'Codex', true)).toEqual({
      engineId: 'codex',
      name: 'Codex',
      agentName: 'Codex',
      status: 'created',
    });
  });

  test('a find that created nothing says so rather than claiming a set-up', () => {
    // `created: false` is the endpoint's own answer — the Agent was already
    // there. It is a SUCCESS (the engine the user asked for exists), and it
    // must not be worded as work this run performed.
    const outcome = firstRunEnableSuccessOutcome(item, 'Codex', false);
    expect(outcome.status).toBe('existing');
    expect(firstRunEnableOutcomeMessage(outcome)).toBe(
      'Codex: already set up as “Codex”.',
    );
    expect(failedFirstRunEngineIds([outcome])).toEqual([]);
  });

  test('a warned create is NOT reported as a plain success', () => {
    // The save is 2xx even when the Agent cannot launch. Reporting that as
    // "ready" would be a false statement about what the user now has.
    const outcome = firstRunEnableSuccessOutcome(item, 'Codex', true, [
      'Agent saved but not launchable: codex is signed out.',
    ]);
    expect(outcome.status).toBe('warned');
    expect(firstRunEnableOutcomeMessage(outcome)).toBe(
      'Codex: Agent saved but not launchable: codex is signed out.',
    );
  });

  test('an empty warnings array is still a clean success', () => {
    expect(firstRunEnableSuccessOutcome(item, 'Codex', true, []).status).toBe(
      'created',
    );
  });

  test('a failure carries the server message', () => {
    const outcome = firstRunEnableFailureOutcome(item, new Error('name taken'));
    expect(outcome).toMatchObject({ status: 'failed', message: 'name taken' });
    expect(firstRunEnableOutcomeMessage(outcome)).toBe(
      'Codex: could not be set up. name taken',
    );
  });

  test('a non-Error rejection is still reported', () => {
    expect(firstRunEnableFailureOutcome(item, 'offline')).toMatchObject({
      status: 'failed',
      message: 'offline',
    });
  });
});

describe('summarizeFirstRunEnableOutcomes — what must be read', () => {
  const base = { engineId: 'codex', name: 'Codex', agentName: 'Codex Agent' };

  test('an all-clean batch needs no acknowledgement', () => {
    const outcomes: FirstRunEnableOutcome[] = [
      { ...base, status: 'created' },
      { ...base, engineId: 'claude', status: 'created' },
    ];
    expect(summarizeFirstRunEnableOutcomes(outcomes)).toEqual({
      needsAcknowledgement: false,
      message: '2 set up.',
    });
  });

  test('a warning must be acknowledged', () => {
    expect(
      summarizeFirstRunEnableOutcomes([
        { ...base, status: 'warned', warnings: ['not launchable'] },
      ]),
    ).toEqual({
      needsAcknowledgement: true,
      message: '1 saved with warnings.',
    });
  });

  test('a partial failure is counted beside the successes', () => {
    expect(
      summarizeFirstRunEnableOutcomes([
        { ...base, status: 'created' },
        { ...base, engineId: 'claude', status: 'failed', message: 'nope' },
      ]),
    ).toEqual({
      needsAcknowledgement: true,
      message: '1 set up · 1 could not be set up.',
    });
  });

  test('an already-set-up engine is counted as done, and needs no acknowledgement', () => {
    expect(
      summarizeFirstRunEnableOutcomes([
        { ...base, status: 'created' },
        { ...base, engineId: 'claude', status: 'existing' },
      ]),
    ).toEqual({
      needsAcknowledgement: false,
      message: '1 set up · 1 already set up.',
    });
  });

  test('an empty batch says so rather than claiming a count', () => {
    expect(summarizeFirstRunEnableOutcomes([])).toEqual({
      needsAcknowledgement: false,
      message: 'Nothing to set up.',
    });
  });
});

describe('AC4 — item order and copy are stable across renders', () => {
  const engines = [
    engine({
      name: 'Kiro',
      engineConnectionId: 'kiro' as never,
      detected: true,
      reason: 'sign_in_required',
    }),
    engine({ name: 'OpenCode', reason: 'missing_prerequisites' }),
    READY_CODEX,
    engine({
      name: 'Claude Code',
      engineId: 'claude-code' as never,
      engineConnectionId: 'claude' as never,
      detected: true,
      ready: true,
      source: 'cli',
    }),
  ];

  test('identical data renders the identical list, twice', () => {
    // SHELL-12 caught the same card rendering a different order and different
    // copy on two routes seconds apart. This is the property that makes that
    // impossible: the listing is a pure function of the engine rows and the
    // agent catalog, with no clock, no probe and no render counter in it.
    const first = buildFirstRunEngineOptions({ engines, agents: [] });
    const second = buildFirstRunEngineOptions({ engines, agents: [] });
    expect(second).toEqual(first);
    expect(second.map(firstRunEngineRowLabel)).toEqual(
      first.map(firstRunEngineRowLabel),
    );
  });

  test('actionable first, and the producer’s own order inside each group', () => {
    expect(
      buildFirstRunEngineOptions({ engines, agents: [] }).map(
        (option) => option.engineId,
      ),
    ).toEqual(['codex', 'claude-code', 'kiro', 'opencode']);
  });

  test('the row’s sentence is derived from its state, not written per call site', () => {
    const options = buildFirstRunEngineOptions({
      engines,
      agents: [
        agent({
          slug: 'claude-agent',
          name: 'Claude Code Agent',
          execution: { agentConnectionId: 'claude' },
        } as Partial<AgentData>),
      ],
    });
    const labels = Object.fromEntries(
      options.map((option) => [
        option.engineId,
        firstRunEngineRowLabel(option),
      ]),
    );
    expect(labels.codex).toBe('Enable Codex');
    expect(labels['claude-code']).toBe('Ready — Claude Code');
    // Nothing Station cannot act on is dressed up as an action.
    expect(labels.kiro).toBe('Kiro');
    expect(labels.opencode).toBe('OpenCode');
  });
});
