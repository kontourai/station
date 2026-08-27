import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type {
  ContributionConfig,
  ContributionProjection,
} from '../contribution.js';
import {
  CONTRIBUTION_DIAGNOSTIC_ID,
  CONTRIBUTION_PARTICIPATIONS,
  CONTRIBUTION_PROJECTION_FIELDS,
  CONTRIBUTION_PROJECTION_SCHEMA_VERSION,
  CONTRIBUTION_RESOURCE_AXES,
  contributionFreshness,
  contributionProjectionRefusal,
  contributionScopeKey,
  declaredContributionIds,
  declaredContributionTotal,
  FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS,
  fleetContributionAsScopedConfig,
  foldSourceObservedAt,
  isContributionEnabled,
  isWellFormedContributionProjection,
  isWellFormedContributionScope,
  oldestObservation,
  parseContributionScopeKey,
  resolveScopedContribution,
} from '../contribution.js';
import { FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION } from '../fleet-contribution.js';
import { APP_SETTINGS_REGISTRY } from '../settings-registry.js';

/**
 * station#1500 slice 2.5 — the scoped contribution contract
 * (`docs/design/portable-project-identity.md` §4.2, §9 OQ-11).
 *
 * Every block below pins a DERIVATION, not a spelling: the fail-closed read,
 * the allowlist, the scope key round trip, the two-clock freshness reader, the
 * refusal of a self-asserted identity, and the exact wire key set that keeps
 * §4.4's machinery out while OQ-12 is open.
 */

function projection(
  overrides: Partial<ContributionProjection> = {},
): ContributionProjection {
  return {
    schemaVersion: CONTRIBUTION_PROJECTION_SCHEMA_VERSION,
    scope: { kind: 'project', projectId: 'prj_1' },
    projectedAt: '2026-08-03T00:00:00.000Z',
    sourceObservedAt: '2026-08-03T00:00:00.000Z',
    participation: 'contributing',
    execution: [
      { repoId: 'github.com/kontourai/station', bound: true, verifiedAt: 1 },
    ],
    agents: [{ slug: 'reviewer' }],
    inference: [{ id: 'm1', connectionId: 'ollama-local' }],
    diagnostics: [],
    ...overrides,
  };
}

describe('the opt-in is read fail-closed (decision 1)', () => {
  it.each([
    ['absent config', undefined],
    ['empty object', {}],
    ['enabled: false', { enabled: false }],
    ['the string "true"', { enabled: 'true' as unknown as boolean }],
    ['the number 1', { enabled: 1 as unknown as boolean }],
    ['an object', { enabled: {} as unknown as boolean }],
  ])('%s is OFF', (_label, config) => {
    expect(
      isContributionEnabled(config as ContributionConfig | undefined),
    ).toBe(false);
  });

  it('only an exact `true` is on', () => {
    expect(isContributionEnabled({ enabled: true })).toBe(true);
  });
});

describe('the allowlist is explicit in every direction (decision 1)', () => {
  it.each(CONTRIBUTION_RESOURCE_AXES)(
    'an absent %s axis declares nothing',
    (axis) => {
      expect(declaredContributionIds({ enabled: true }, axis)).toEqual([]);
    },
  );

  it('an enabled config with no axis at all declares nothing', () => {
    expect(declaredContributionTotal({ enabled: true })).toBe(0);
  });

  it('deduplicates, sorts, and drops non-string and empty entries', () => {
    const config = {
      execution: {
        repoIds: [
          'github.com/b/two',
          'github.com/a/one',
          'github.com/b/two',
          '',
          42 as unknown as string,
          null as unknown as string,
        ],
      },
    };
    expect(declaredContributionIds(config, 'execution')).toEqual([
      'github.com/a/one',
      'github.com/b/two',
    ]);
  });

  it('counts every axis, so "nothing named" cannot hide on one of them', () => {
    expect(
      declaredContributionTotal({
        enabled: true,
        execution: { repoIds: ['r'] },
        agents: { slugs: ['a', 'b'] },
        inference: { connectionIds: ['c'] },
      }),
    ).toBe(4);
  });

  it('reads what is marked even when the opt-in is off', () => {
    // The reason `declaredContributionConnectionIds` is independent of the
    // opt-in: a disabled Station must be able to say "you marked 2 repos and
    // they are not being offered" rather than showing nothing.
    expect(
      declaredContributionIds(
        { enabled: false, execution: { repoIds: ['a', 'b'] } },
        'execution',
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('scope keys round-trip, and an unknown key is refused (§4.2)', () => {
  it('keys the fleet scope as "fleet"', () => {
    expect(contributionScopeKey({ kind: 'fleet' })).toBe('fleet');
  });

  it('keys a project scope by its portable manifest id', () => {
    expect(
      contributionScopeKey({ kind: 'project', projectId: 'prj_7f3a' }),
    ).toBe('project:prj_7f3a');
  });

  it.each([
    { kind: 'fleet' as const },
    { kind: 'project' as const, projectId: 'prj_7f3a' },
  ])('round-trips %j', (scope) => {
    expect(parseContributionScopeKey(contributionScopeKey(scope))).toEqual(
      scope,
    );
  });

  it.each([
    ['a future channel key', 'channel:chn_1'],
    ['an empty project id', 'project:'],
    ['an unprefixed string', 'prj_7f3a'],
    ['an empty key', ''],
  ])('refuses %s rather than guessing a scope', (_label, key) => {
    // Fail-closed on purpose: parsing an unknown key "as a project" would
    // attach one space's consent to a different space.
    expect(parseContributionScopeKey(key)).toBeUndefined();
  });

  it('rejects malformed scopes at runtime', () => {
    expect(isWellFormedContributionScope({ kind: 'fleet' })).toBe(true);
    expect(
      isWellFormedContributionScope({ kind: 'project', projectId: 'p' }),
    ).toBe(true);
    expect(isWellFormedContributionScope({ kind: 'project' })).toBe(false);
    expect(
      isWellFormedContributionScope({ kind: 'project', projectId: '' }),
    ).toBe(false);
    expect(isWellFormedContributionScope({ kind: 'channel' })).toBe(false);
    expect(
      // A fleet scope carrying an extra field is a different shape claiming to
      // be this one.
      isWellFormedContributionScope({ kind: 'fleet', projectId: 'p' }),
    ).toBe(false);
    expect(isWellFormedContributionScope(null)).toBe(false);
  });
});

describe('one writable home per scope (§5, the second-copy defect)', () => {
  it('reads the fleet scope from `fleetContribution` alone', () => {
    const selection = resolveScopedContribution(
      { fleetContribution: { enabled: true, connectionIds: ['ollama-local'] } },
      { kind: 'fleet' },
    );
    expect(selection.origin).toBe('fleet-contribution');
    expect(selection.config).toEqual({
      enabled: true,
      inference: { connectionIds: ['ollama-local'] },
    });
    expect(selection.diagnostics).toEqual([]);
  });

  it('REFUSES a shadowing `contribution.fleet` entry and names it', () => {
    const selection = resolveScopedContribution(
      {
        fleetContribution: { enabled: false },
        contribution: {
          fleet: { enabled: true, inference: { connectionIds: ['billable'] } },
        },
      },
      { kind: 'fleet' },
    );
    // Neither merged nor preferred: the shadow contributes NOTHING, which is
    // the only direction decision 1 permits an ambiguity to resolve in.
    expect(isContributionEnabled(selection.config)).toBe(false);
    expect(
      declaredContributionIds(selection.config, 'inference'),
    ).not.toContain('billable');
    expect(selection.diagnostics).toHaveLength(1);
    expect(selection.diagnostics[0]).toMatchObject({
      axis: 'scope',
      code: 'contribution-scope-shadowed',
      resourceId: CONTRIBUTION_DIAGNOSTIC_ID,
    });
    // A refusal that does not say where the authority IS is unactionable.
    expect(selection.diagnostics[0].message).toContain('fleetContribution');
  });

  it('reads a project scope from the map', () => {
    const selection = resolveScopedContribution(
      {
        contribution: {
          'project:prj_1': {
            enabled: true,
            execution: { repoIds: ['github.com/kontourai/station'] },
          },
        },
      },
      { kind: 'project', projectId: 'prj_1' },
    );
    expect(selection.origin).toBe('contribution-map');
    expect(declaredContributionIds(selection.config, 'execution')).toEqual([
      'github.com/kontourai/station',
    ]);
  });

  it('an unconfigured scope is default-off, not a gap', () => {
    const selection = resolveScopedContribution(undefined, {
      kind: 'project',
      projectId: 'prj_missing',
    });
    expect(selection.origin).toBe('absent');
    expect(isContributionEnabled(selection.config)).toBe(false);
    expect(declaredContributionTotal(selection.config)).toBe(0);
  });

  it('a project scope never reads another project’s entry', () => {
    const selection = resolveScopedContribution(
      {
        contribution: {
          'project:prj_other': {
            enabled: true,
            execution: { repoIds: ['github.com/other/repo'] },
          },
        },
      },
      { kind: 'project', projectId: 'prj_1' },
    );
    expect(declaredContributionTotal(selection.config)).toBe(0);
  });

  it('projects the shipped fleet config onto the inference axis only', () => {
    // §10 OQ-5 of `inference-fleet.md`: the fleet contributes MODELS only. The
    // other axes are ABSENT rather than empty-listed — an empty list would read
    // as "the operator considered this axis", and no operator was ever offered
    // the choice.
    const scoped = fleetContributionAsScopedConfig({
      enabled: true,
      connectionIds: ['ollama-local'],
    });
    expect(scoped.execution).toBeUndefined();
    expect(scoped.agents).toBeUndefined();
    expect(scoped.inference).toEqual({ connectionIds: ['ollama-local'] });
    expect(fleetContributionAsScopedConfig(undefined)).toEqual({});
    expect(fleetContributionAsScopedConfig({})).toEqual({});
  });
});

describe('two clocks, and the reader that makes the split load-bearing', () => {
  it('a FRESH projection over a STALE source is a stale claim (decision 3)', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const stale = projection({
      // Produced one millisecond ago...
      projectedAt: new Date(now - 1).toISOString(),
      // ...over an observation from eight days ago.
      sourceObservedAt: '2026-07-26T12:00:00.000Z',
    });
    expect(contributionFreshness(stale, { maxAgeMs: 3_600_000, now })).toBe(
      'stale',
    );
  });

  it('the projection clock cannot rescue a stale source', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const old = '2026-07-26T12:00:00.000Z';
    // Two projections of the SAME observation, produced a week apart, must read
    // identically: `projectedAt` is never consulted.
    const a = contributionFreshness(
      projection({
        projectedAt: '2026-07-26T12:00:00.001Z',
        sourceObservedAt: old,
      }),
      { maxAgeMs: 3_600_000, now },
    );
    const b = contributionFreshness(
      projection({
        projectedAt: new Date(now).toISOString(),
        sourceObservedAt: old,
      }),
      { maxAgeMs: 3_600_000, now },
    );
    expect(a).toBe('stale');
    expect(b).toBe('stale');
  });

  it('is fresh only inside the asking consumer’s own bound', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const observed = new Date(now - 60_000).toISOString();
    expect(
      contributionFreshness(projection({ sourceObservedAt: observed }), {
        maxAgeMs: 120_000,
        now,
      }),
    ).toBe('fresh');
    expect(
      contributionFreshness(projection({ sourceObservedAt: observed }), {
        maxAgeMs: 30_000,
        now,
      }),
    ).toBe('stale');
  });

  it.each([
    ['no observation at all', null],
    ['an unparseable timestamp', 'yesterday'],
    ['an empty string', ''],
  ])('%s is UNKNOWN, never fresh (§6.1)', (_label, sourceObservedAt) => {
    expect(
      contributionFreshness(
        projection({ sourceObservedAt: sourceObservedAt as string | null }),
        { maxAgeMs: Number.MAX_SAFE_INTEGER, now: Date.now() },
      ),
    ).toBe('unknown');
  });

  it('an observation in the reader’s future is UNKNOWN, never fresh', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    expect(
      contributionFreshness(
        projection({ sourceObservedAt: '2027-01-01T00:00:00.000Z' }),
        { maxAgeMs: 1000, now },
      ),
    ).toBe('unknown');
  });

  it('folds several observations to the OLDEST, never the newest', () => {
    expect(
      oldestObservation([
        '2026-08-03T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('drops unparseable candidates rather than ranking them', () => {
    expect(oldestObservation(['not-a-date', null, undefined, ''])).toBeNull();
    expect(oldestObservation(['not-a-date', '2026-08-03T00:00:00.000Z'])).toBe(
      '2026-08-03T00:00:00.000Z',
    );
  });
});

describe('no self-asserted identity in the wire body (decision 4)', () => {
  it('accepts a well-formed projection', () => {
    expect(isWellFormedContributionProjection(projection())).toBe(true);
  });

  it.each(FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS)(
    'REFUSES a body carrying `%s`',
    (field) => {
      // Refused outright rather than stripped: a peer that sends one disagrees
      // with this contract about who attributes what, and quietly deleting the
      // field would leave that disagreement unreported.
      expect(
        isWellFormedContributionProjection({
          ...projection(),
          [field]: 'somebody',
        }),
      ).toBe(false);
    },
  );

  it('names EXACTLY these five fields', () => {
    // station#1503 review, M5: every other assertion in this block ITERATES the
    // list, so deleting `hostname` or `host` would make the loops run one fewer
    // time and leave everything green — the "a list assertion cannot catch an
    // entry being deleted" class. The guard's power lives in the CONTENTS, so
    // the contents are pinned against literals, exactly as
    // `CONTRIBUTION_PROJECTION_FIELDS` and `CONTRIBUTION_PARTICIPATIONS` are.
    expect([...FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS].sort()).toEqual([
      'environmentId',
      'host',
      'hostname',
      'memberId',
      'stationId',
    ]);
  });

  it('carries no identity field itself', () => {
    for (const field of FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS) {
      expect(Object.keys(projection())).not.toContain(field);
    }
  });

  it.each(FORBIDDEN_CONTRIBUTION_IDENTITY_FIELDS)(
    'refuses `%s` AS AN IDENTITY CLAIM, distinctly from an unknown field',
    (field) => {
      // The assertion the first revision of this contract could not make. With
      // the check folded into a boolean, deleting it entirely left every test
      // green — an identity field is also an unknown field, so the exact
      // key-set check caught it and the named guard had no power of its own.
      // Reading the REASON is what proves each check does its own job.
      const identity = contributionProjectionRefusal({
        ...projection(),
        [field]: 'somebody',
      });
      expect(identity).toContain('self-asserted identity');
      expect(identity).toContain(field);

      const unknownField = contributionProjectionRefusal({
        ...projection(),
        requirements: [],
      });
      expect(unknownField).toContain('does not know');
      expect(unknownField).not.toContain('self-asserted identity');
    },
  );

  it('discloses field NAMES and never values', () => {
    // A malformed body may carry a peer's data; a refusal message is the wrong
    // place to widen what it discloses.
    const reason = contributionProjectionRefusal({
      ...projection(),
      stationId: 'kontour-desk.tailnet.example',
    });
    expect(reason).toContain('stationId');
    expect(reason).not.toContain('kontour-desk');
  });

  it('is well formed with no reason at all', () => {
    expect(contributionProjectionRefusal(projection())).toBeUndefined();
  });
});

describe('the wire body is an EXACT key set, not a floor', () => {
  it('is exactly §4.2’s nine fields', () => {
    expect([...CONTRIBUTION_PROJECTION_FIELDS].sort()).toEqual(
      [
        'agents',
        'diagnostics',
        'execution',
        'inference',
        'participation',
        'projectedAt',
        'schemaVersion',
        'scope',
        'sourceObservedAt',
      ].sort(),
    );
    expect(Object.keys(projection()).sort()).toEqual(
      [...CONTRIBUTION_PROJECTION_FIELDS].sort(),
    );
  });

  it.each([
    ['requirements', { requirements: [] }],
    ['an offer-acceptance outcome', { outcome: 'accepted-live' }],
    ['a compliance verdict', { compliance: { met: true } }],
    ['occupancy', { liveSessions: 2 }],
  ])(
    'REFUSES §4.4/§7 machinery arriving from a peer as `%s`',
    (_label, extra) => {
      // OQ-12 is open. A field that reads as a contract and is not one must not
      // reach a consumer through a mixed-version read either.
      expect(
        isWellFormedContributionProjection({ ...projection(), ...extra }),
      ).toBe(false);
    },
  );

  it('refuses a body missing any required field', () => {
    for (const field of CONTRIBUTION_PROJECTION_FIELDS) {
      const body: Record<string, unknown> = { ...projection() };
      delete body[field];
      expect(isWellFormedContributionProjection(body)).toBe(false);
    }
  });
});

describe('the runtime backstop refuses what a compiler cannot see', () => {
  it('gates on schemaVersion rather than casting', () => {
    expect(
      isWellFormedContributionProjection({
        ...projection(),
        schemaVersion: 'station.contribution/v2',
      }),
    ).toBe(false);
    expect(
      isWellFormedContributionProjection({
        ...projection(),
        schemaVersion: FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION,
      }),
    ).toBe(false);
  });

  it.each([
    ['a participation outside the four states', { participation: 'partial' }],
    ['a non-array execution list', { execution: {} }],
    [
      'an execution entry with no repoId',
      { execution: [{ bound: true, verifiedAt: null }] },
    ],
    [
      'an execution entry whose `bound` is a string',
      { execution: [{ repoId: 'r', bound: 'true', verifiedAt: null }] },
    ],
    [
      'an execution entry with no verifiedAt slot at all',
      { execution: [{ repoId: 'r', bound: true }] },
    ],
    ['an agent entry with no slug', { agents: [{}] }],
    ['an inference entry with no connectionId', { inference: [{ id: 'm' }] }],
    [
      'a diagnostic with an unknown axis',
      {
        diagnostics: [
          {
            axis: 'tools',
            resourceId: 'x',
            code: 'contribution-empty',
            message: 'm',
          },
        ],
      },
    ],
    [
      'a diagnostic with an empty message',
      {
        diagnostics: [
          {
            axis: 'scope',
            resourceId: 'x',
            code: 'contribution-empty',
            message: '',
          },
        ],
      },
    ],
    ['a project scope with no projectId', { scope: { kind: 'project' } }],
    [
      'a sourceObservedAt that is neither a string nor null',
      {
        sourceObservedAt: 0,
      },
    ],
  ])('refuses %s', (_label, extra) => {
    expect(
      isWellFormedContributionProjection({ ...projection(), ...extra }),
    ).toBe(false);
  });

  it('accepts a null sourceObservedAt — it is a real answer', () => {
    expect(
      isWellFormedContributionProjection(
        projection({ sourceObservedAt: null, participation: 'disabled' }),
      ),
    ).toBe(true);
  });

  it.each([[null], [undefined], ['string'], [[]], [42]])(
    'refuses the non-object %p',
    (value) => {
      expect(isWellFormedContributionProjection(value)).toBe(false);
    },
  );
});

describe('the four participation states are the fleet’s, unchanged', () => {
  it('names exactly the four', () => {
    expect([...CONTRIBUTION_PARTICIPATIONS].sort()).toEqual([
      'contributed-unavailable',
      'contributing',
      'disabled',
      'nothing-contributed',
    ]);
  });
});

describe('the config field is registered where the fleet’s is (§4.2)', () => {
  it('is a station-scoped composite with no synthesized default', () => {
    const definition = APP_SETTINGS_REGISTRY.find(
      (entry) => entry.key === 'contribution',
    );
    expect(definition).toBeDefined();
    expect(definition?.scope).toBe('station');
    expect(definition?.descriptor).toEqual({ kind: 'composite' });
    // Absent is the OFF state, not a value to synthesize.
    expect(definition && 'defaultValue' in definition).toBe(false);
  });

  it('leaves the shipped fleet setting untouched', () => {
    const fleet = APP_SETTINGS_REGISTRY.find(
      (entry) => entry.key === 'fleetContribution',
    );
    expect(fleet?.scope).toBe('station');
    expect(fleet?.label).toBe('Fleet contribution');
  });

  it('types the AppConfig field as a scope-keyed map', () => {
    const config: Pick<AppConfig, 'contribution'> = {
      contribution: {
        [contributionScopeKey({ kind: 'project', projectId: 'prj_1' })]: {
          enabled: true,
          execution: { repoIds: ['github.com/kontourai/station'] },
        },
      },
    };
    expect(Object.keys(config.contribution ?? {})).toEqual(['project:prj_1']);
  });
});

// ── station#1503 review, M3 — the freshness fold ──────────────────────────

describe('an axis that CONTRIBUTED but observed nothing makes the fold unknown', () => {
  const OBSERVED = '2026-08-03T11:59:00.000Z';

  it('is null when a contributing axis carries no observation', () => {
    // The reported scenario: execution offers a repo on the compat branch
    // (never verified in its life), inference was observed 60s ago. The old
    // fold dropped the unobserved axis and let the observed one speak for the
    // whole body — a projection standing partly on nothing, reading `fresh`.
    expect(
      foldSourceObservedAt([
        { contributed: true, observedAt: null },
        { contributed: true, observedAt: OBSERVED },
      ]),
    ).toBeNull();
  });

  it('IGNORES an axis that contributed nothing, observed or not', () => {
    // The other half of the rule, and the reason `contributed` exists: an axis
    // that put nothing in the body has no bearing on how fresh the body is.
    expect(
      foldSourceObservedAt([
        { contributed: false, observedAt: null },
        { contributed: true, observedAt: OBSERVED },
      ]),
    ).toBe(OBSERVED);
  });

  it('is the OLDEST when every contributing axis observed something', () => {
    expect(
      foldSourceObservedAt([
        { contributed: true, observedAt: '2026-08-03T00:00:00.000Z' },
        { contributed: true, observedAt: '2026-07-01T00:00:00.000Z' },
      ]),
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('is null when nothing contributed at all', () => {
    expect(
      foldSourceObservedAt([{ contributed: false, observedAt: OBSERVED }]),
    ).toBeNull();
    expect(foldSourceObservedAt([])).toBeNull();
  });

  it('reads as UNKNOWN, never fresh, through the freshness reader', () => {
    // Fail-closed end to end: §6.1's "a stale answer is `unknown`, not
    // satisfied".
    const sourceObservedAt = foldSourceObservedAt([
      { contributed: true, observedAt: null },
      { contributed: true, observedAt: OBSERVED },
    ]);
    expect(
      contributionFreshness(
        { sourceObservedAt },
        { maxAgeMs: 3_600_000, now: Date.parse('2026-08-03T12:00:00.000Z') },
      ),
    ).toBe('unknown');
  });
});
