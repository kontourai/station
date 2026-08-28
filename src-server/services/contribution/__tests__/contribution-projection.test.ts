import {
  CONTRIBUTION_DIAGNOSTIC_ID,
  CONTRIBUTION_PROJECTION_SCHEMA_VERSION,
  type ContributionConfig,
  contributionFreshness,
  isWellFormedContributionProjection,
} from '@kontourai/station-contracts/contribution';
import { RESOURCE_RESOLUTION_STATES } from '@kontourai/station-contracts/project-identity';
import { describe, expect, it } from 'vitest';
import {
  type ContributionProjectionInput,
  projectContribution,
} from '../contribution-projection.js';

/**
 * archive#1500 — the projection builder
 * (`docs/design/portable-project-identity.md` §4.2).
 */

const PROJECTED_AT = '2026-08-03T12:00:00.000Z';
const SCOPE = { kind: 'project' as const, projectId: 'prj_1' };

function input(
  overrides: Partial<ContributionProjectionInput> = {},
): ContributionProjectionInput {
  return {
    scope: SCOPE,
    projectedAt: PROJECTED_AT,
    config: { enabled: true },
    execution: { readable: true, observedAt: null, observed: {} },
    agents: { readable: true, observedAt: null, observed: {} },
    inference: { readable: true, observedAt: null, observed: {} },
    ...overrides,
  };
}

function codes(projectionResult: {
  diagnostics: { code: string }[];
}): string[] {
  return projectionResult.diagnostics.map((item) => item.code);
}

describe('the projection is well formed and scope-carrying', () => {
  it('stamps this version and the scope it was asked about', () => {
    const result = projectContribution(input());
    expect(result.schemaVersion).toBe(CONTRIBUTION_PROJECTION_SCHEMA_VERSION);
    expect(result.scope).toEqual(SCOPE);
    expect(isWellFormedContributionProjection(result)).toBe(true);
  });

  it('carries the fleet scope through the same builder', () => {
    const result = projectContribution(
      input({
        scope: { kind: 'fleet' },
        config: { enabled: true, inference: { connectionIds: ['ollama'] } },
        inference: {
          readable: true,
          observedAt: PROJECTED_AT,
          observed: { ollama: { modelIds: ['m1'] } },
        },
      }),
    );
    expect(result.scope).toEqual({ kind: 'fleet' });
    expect(result.participation).toBe('contributing');
    expect(isWellFormedContributionProjection(result)).toBe(true);
  });
});

describe('participation: the empty list is NEVER the signal (decision 2)', () => {
  it('OFF is `disabled`, and names how many are withheld', () => {
    const result = projectContribution(
      input({
        config: {
          enabled: false,
          execution: { repoIds: ['github.com/a/one'] },
          agents: { slugs: ['reviewer'] },
        },
      }),
    );
    expect(result.participation).toBe('disabled');
    expect(result.execution).toEqual([]);
    expect(codes(result)).toEqual(['contribution-disabled']);
    expect(result.diagnostics[0].message).toContain('2 named resources');
  });

  it('ON with nothing named is `nothing-contributed`', () => {
    const result = projectContribution(input({ config: { enabled: true } }));
    expect(result.participation).toBe('nothing-contributed');
    expect(codes(result)).toEqual(['contribution-empty']);
  });

  it('ON, named, nothing serveable is `contributed-unavailable`', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['github.com/a/one'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            'github.com/a/one': { state: 'missing', verifiedAt: 1_700_000 },
          },
        },
      }),
    );
    expect(result.participation).toBe('contributed-unavailable');
    // The offer is still NAMED — §4.2's "offering something it cannot currently
    // serve" is a different sentence from "offers nothing", and §6.1 rejects it
    // BY NAME in a dispatch receipt.
    expect(result.execution).toEqual([
      { repoId: 'github.com/a/one', bound: false, verifiedAt: 1_700_000 },
    ]);
    expect(codes(result)).toEqual(['contribution-unavailable-resource']);
  });

  it('the three empty states are structurally distinct from each other', () => {
    const disabled = projectContribution(input({ config: { enabled: false } }));
    const nothing = projectContribution(input({ config: { enabled: true } }));
    const unavailable = projectContribution(
      input({
        config: { enabled: true, agents: { slugs: ['reviewer'] } },
        agents: {
          readable: true,
          observedAt: null,
          observed: { reviewer: { available: false } },
        },
      }),
    );
    // Same empty lists; three different participations and three different
    // diagnostic codes. That is what makes the empty non-signalling.
    for (const result of [disabled, nothing, unavailable]) {
      expect(result.execution).toEqual([]);
      expect(result.agents).toEqual([]);
      expect(result.inference).toEqual([]);
    }
    expect(
      new Set([
        disabled.participation,
        nothing.participation,
        unavailable.participation,
      ]).size,
    ).toBe(3);
    expect(
      new Set([codes(disabled)[0], codes(nothing)[0], codes(unavailable)[0]])
        .size,
    ).toBe(3);
  });

  it('`contributing` counts SERVEABLE resources, not entries', () => {
    // Three offered repos, none bound: `execution[]` has three entries and the
    // Station can serve nothing. Counting entries would report it contributing.
    const result = projectContribution(
      input({
        config: {
          enabled: true,
          execution: { repoIds: ['a', 'b', 'c'] },
        },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            a: { state: 'missing', verifiedAt: null },
            b: { state: 'drifted', verifiedAt: null },
            c: { state: 'stale', verifiedAt: null },
          },
        },
      }),
    );
    expect(result.execution).toHaveLength(3);
    expect(result.participation).toBe('contributed-unavailable');
  });

  it('one serveable resource among failures is `contributing`, with the rest named', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['a', 'b'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            a: { state: 'bound', verifiedAt: 1_700_000 },
            b: { state: 'missing', verifiedAt: null },
          },
        },
      }),
    );
    expect(result.participation).toBe('contributing');
    expect(result.execution).toEqual([
      { repoId: 'a', bound: true, verifiedAt: 1_700_000 },
      { repoId: 'b', bound: false, verifiedAt: null },
    ]);
    expect(codes(result)).toEqual(['contribution-unavailable-resource']);
  });
});

describe('allowlist only: nothing the operator did not name is offered', () => {
  it('does NOT project an observed resource that was never declared', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['declared'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            declared: { state: 'bound', verifiedAt: 1 },
            // Present, bound, and NEVER NAMED by the operator.
            'github.com/private/secret': { state: 'bound', verifiedAt: 1 },
          },
        },
        agents: {
          readable: true,
          observedAt: null,
          observed: { 'undeclared-agent': { available: true } },
        },
        inference: {
          readable: true,
          observedAt: null,
          observed: { 'undeclared-connection': { modelIds: ['m1'] } },
        },
      }),
    );
    expect(result.execution.map((entry) => entry.repoId)).toEqual(['declared']);
    expect(result.agents).toEqual([]);
    expect(result.inference).toEqual([]);
    // And nothing about them leaks into the diagnostics either.
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('undeclared');
  });

  it('an enabled config with an EMPTY axis list offers nothing on it', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: [] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: { anything: { state: 'bound', verifiedAt: 1 } },
        },
      }),
    );
    expect(result.participation).toBe('nothing-contributed');
    expect(result.execution).toEqual([]);
  });
});

describe('a named resource that cannot be served is NAMED, never dropped', () => {
  it('reports a declared repo the Station does not know at all', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['github.com/a/one'] } },
      }),
    );
    expect(result.execution).toEqual([]);
    expect(codes(result)).toEqual(['contribution-unknown-resource']);
    expect(result.diagnostics[0].resourceId).toBe('github.com/a/one');
    expect(result.diagnostics[0].axis).toBe('execution');
  });

  it('reports an agent that exists but cannot run, distinctly from one that does not exist', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, agents: { slugs: ['gone', 'broken'] } },
        agents: {
          readable: true,
          observedAt: null,
          observed: { broken: { available: false } },
        },
      }),
    );
    expect(result.agents).toEqual([]);
    expect(
      result.diagnostics.map((item) => [item.resourceId, item.code]),
    ).toEqual([
      ['broken', 'contribution-unavailable-resource'],
      ['gone', 'contribution-unknown-resource'],
    ]);
  });

  it('reports a connection that yields no model, and projects one that does', () => {
    const result = projectContribution(
      input({
        config: {
          enabled: true,
          inference: { connectionIds: ['live', 'dry'] },
        },
        inference: {
          readable: true,
          observedAt: '2026-08-03T11:00:00.000Z',
          observed: {
            live: { modelIds: ['m2', 'm1'] },
            dry: { modelIds: [] },
          },
        },
      }),
    );
    expect(result.inference).toEqual([
      { id: 'm1', connectionId: 'live' },
      { id: 'm2', connectionId: 'live' },
    ]);
    expect(codes(result)).toEqual(['contribution-unavailable-resource']);
  });

  it('an UNREADABLE axis is unknown, not empty', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, agents: { slugs: ['reviewer'] } },
        agents: { readable: false, reason: 'agent registry unreadable' },
      }),
    );
    expect(result.participation).toBe('contributed-unavailable');
    expect(codes(result)).toEqual(['contribution-source-unreadable']);
    expect(result.diagnostics[0].message).toContain(
      'unknown rather than empty',
    );
  });

  it('does not report an unreadable axis nobody offered anything on', () => {
    // Silence here is honest: an axis with no declared resource is not degraded
    // by its source being unreadable, because it was offering nothing either
    // way. Reporting it would train an operator to ignore the diagnostic.
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['a'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: { a: { state: 'bound', verifiedAt: 1 } },
        },
        agents: { readable: false, reason: 'agent registry unreadable' },
      }),
    );
    expect(result.participation).toBe('contributing');
    expect(result.diagnostics).toEqual([]);
  });

  it('names a distinct sentence for every resolution state', () => {
    // A guardrail whose rejection path has never executed is unproven, and a
    // `default:` arm here would give three different faults one sentence.
    const nonBound = RESOURCE_RESOLUTION_STATES.filter(
      (state) => state !== 'bound',
    );
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: [...nonBound] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: Object.fromEntries(
            nonBound.map((state) => [state, { state, verifiedAt: null }]),
          ),
        },
      }),
    );
    const messages = result.diagnostics.map((item) => item.message);
    expect(messages).toHaveLength(nonBound.length);
    expect(new Set(messages).size).toBe(nonBound.length);
  });
});

describe('presence and freshness, NEVER a path (§4.2, §3.5)', () => {
  it('projects no path even when the caller hands one through', () => {
    // The observation type has no path slot, so an untyped caller is the only
    // way one could arrive. It must not survive the projection.
    const leaky = {
      state: 'bound',
      verifiedAt: 1_700_000,
      path: '/Users/someone/dev/private-checkout',
      reason:
        'The binding for github.com/a/one points at "/Users/someone/dev/private-checkout"',
      unverifiedPath: '/Users/someone/dev/private-checkout',
      declaredPath: '~/dev/private-checkout',
    } as unknown as { state: 'bound'; verifiedAt: number };
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['github.com/a/one'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: { 'github.com/a/one': leaky },
        },
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/Users/someone');
    expect(serialized).not.toContain('private-checkout');
    expect(result.execution[0]).toEqual({
      repoId: 'github.com/a/one',
      bound: true,
      verifiedAt: 1_700_000,
    });
  });

  it('does not report occupancy or liveness, and has no slot for it (§7)', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['a'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: { a: { state: 'bound', verifiedAt: 1 } },
        },
      }),
    );
    expect(Object.keys(result.execution[0]).sort()).toEqual([
      'bound',
      'repoId',
      'verifiedAt',
    ]);
    expect(isWellFormedContributionProjection(result)).toBe(true);
  });
});

describe('the two clocks stay separable (decision 3)', () => {
  it('derives sourceObservedAt from the OLDEST observation across axes', () => {
    const result = projectContribution(
      input({
        config: {
          enabled: true,
          execution: { repoIds: ['a'] },
          inference: { connectionIds: ['live'] },
        },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            a: {
              state: 'bound',
              verifiedAt: Date.parse('2026-07-01T00:00:00.000Z'),
            },
          },
        },
        inference: {
          readable: true,
          observedAt: '2026-08-03T11:59:59.000Z',
          observed: { live: { modelIds: ['m1'] } },
        },
      }),
    );
    expect(result.projectedAt).toBe(PROJECTED_AT);
    expect(result.sourceObservedAt).toBe('2026-07-01T00:00:00.000Z');
    // A projection produced NOW over a binding verified a month ago is a stale
    // claim, and the reader must say so.
    expect(
      contributionFreshness(result, {
        maxAgeMs: 3_600_000,
        now: Date.parse(PROJECTED_AT),
      }),
    ).toBe('stale');
  });

  it('never substitutes projectedAt for a missing observation', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['a'] } },
        execution: {
          readable: true,
          observedAt: null,
          // The compat branch has no binding row, so there is no observation.
          observed: { a: { state: 'bound', verifiedAt: null } },
        },
      }),
    );
    expect(result.participation).toBe('contributing');
    expect(result.sourceObservedAt).toBeNull();
    expect(result.execution[0].verifiedAt).toBeNull();
    expect(
      contributionFreshness(result, { maxAgeMs: 1, now: Date.now() }),
    ).toBe('unknown');
  });

  it('a disabled projection stands on no observation at all', () => {
    const result = projectContribution(input({ config: { enabled: false } }));
    expect(result.sourceObservedAt).toBeNull();
  });

  it('drops a non-finite verifiedAt rather than serializing it', () => {
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['a'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            a: {
              state: 'bound',
              verifiedAt: Number.NaN as unknown as number,
            },
          },
        },
      }),
    );
    expect(result.execution[0].verifiedAt).toBeNull();
    expect(isWellFormedContributionProjection(result)).toBe(true);
  });
});

describe('caller diagnostics are carried, not swallowed', () => {
  it('includes a shadowed-scope refusal in the projection a reader reads', () => {
    const result = projectContribution(
      input({
        config: { enabled: false } satisfies ContributionConfig,
        configDiagnostics: [
          {
            axis: 'scope',
            resourceId: CONTRIBUTION_DIAGNOSTIC_ID,
            code: 'contribution-scope-shadowed',
            message: 'shadowed',
          },
        ],
      }),
    );
    expect(codes(result).sort()).toEqual([
      'contribution-disabled',
      'contribution-scope-shadowed',
    ]);
  });
});

describe('output is deterministic', () => {
  it('sorts every list and de-duplicates diagnostics', () => {
    const config: ContributionConfig = {
      enabled: true,
      execution: { repoIds: ['b', 'a'] },
      agents: { slugs: ['z', 'y'] },
      inference: { connectionIds: ['n', 'm'] },
    };
    const result = projectContribution(
      input({
        config,
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            a: { state: 'bound', verifiedAt: 2 },
            b: { state: 'bound', verifiedAt: 1 },
          },
        },
        agents: {
          readable: true,
          observedAt: null,
          observed: { y: { available: true }, z: { available: true } },
        },
        inference: {
          readable: true,
          observedAt: null,
          observed: { m: { modelIds: ['m2'] }, n: { modelIds: ['n1'] } },
        },
      }),
    );
    expect(result.execution.map((entry) => entry.repoId)).toEqual(['a', 'b']);
    expect(result.agents.map((entry) => entry.slug)).toEqual(['y', 'z']);
    expect(result.inference.map((entry) => entry.connectionId)).toEqual([
      'm',
      'n',
    ]);
  });
});

// ── archive#1503 review, M3 — the MIXED case the suite never covered ───────

describe('a partially-unobserved projection is UNKNOWN, never fresh', () => {
  it('is null when one axis contributed without an observation', () => {
    // Covered before: all-null and both-present. Never MIXED — which is the
    // only shape in which the defect could show.
    const result = projectContribution(
      input({
        config: {
          enabled: true,
          execution: { repoIds: ['a'] },
          inference: { connectionIds: ['live'] },
        },
        execution: {
          readable: true,
          observedAt: null,
          // The compat branch: bound, and never verified in its life.
          observed: { a: { state: 'bound', verifiedAt: null } },
        },
        inference: {
          readable: true,
          observedAt: '2026-08-03T11:59:00.000Z',
          observed: { live: { modelIds: ['m1'] } },
        },
      }),
    );

    expect(result.participation).toBe('contributing');
    expect(result.sourceObservedAt).toBeNull();
    expect(
      contributionFreshness(result, {
        maxAgeMs: 3_600_000,
        now: Date.parse(PROJECTED_AT),
      }),
    ).toBe('unknown');
    // The per-resource clock is unaffected — that is what §6.1's constraint
    // reads, and an unobservable sibling axis must not veto it.
    expect(result.execution[0].verifiedAt).toBeNull();
  });

  it('is null when ONE of several repos was never verified', () => {
    // Same rule one level down: a sibling repo's recent verification must not
    // speak for a repo that has never been verified.
    const result = projectContribution(
      input({
        config: { enabled: true, execution: { repoIds: ['a', 'b'] } },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            a: {
              state: 'bound',
              verifiedAt: Date.parse('2026-08-03T11:59:00.000Z'),
            },
            b: { state: 'bound', verifiedAt: null },
          },
        },
      }),
    );

    expect(result.sourceObservedAt).toBeNull();
  });

  it('an AGENTS-only projection reports the READ time, not null (N1)', () => {
    // The premise this test used to assert — "agents have no clock" — was
    // wrong, and the M3 fix is what made it matter: once the fold counts a
    // contributing axis's null instead of dropping it, an agents axis
    // reporting `null` would make EVERY Station that offers an agent publish
    // `sourceObservedAt: null` forever, killing the whole-projection clock for
    // exactly the Stations that contribute most. A live read has an
    // observation time: the instant of the read.
    const readAt = '2026-08-03T11:59:30.000Z';
    const result = projectContribution(
      input({
        config: { enabled: true, agents: { slugs: ['reviewer'] } },
        agents: {
          readable: true,
          observedAt: readAt,
          observed: { reviewer: { available: true } },
        },
      }),
    );

    expect(result.participation).toBe('contributing');
    expect(result.sourceObservedAt).toBe(readAt);
    expect(
      contributionFreshness(result, {
        maxAgeMs: 3_600_000,
        now: Date.parse(PROJECTED_AT),
      }),
    ).toBe('fresh');
  });

  it('an agents axis that genuinely cannot date its answer is still unknown', () => {
    // `null` stays available and stays decisive — it is reserved for a source
    // that truly carries no observation (a cached answer of unknown age), and
    // it still fails closed.
    const result = projectContribution(
      input({
        config: { enabled: true, agents: { slugs: ['reviewer'] } },
        agents: {
          readable: true,
          observedAt: null,
          observed: { reviewer: { available: true } },
        },
      }),
    );

    expect(result.participation).toBe('contributing');
    expect(result.sourceObservedAt).toBeNull();
    expect(
      contributionFreshness(result, {
        maxAgeMs: 3_600_000,
        now: Date.parse(PROJECTED_AT),
      }),
    ).toBe('unknown');
  });

  it('still reports the oldest when every contributing axis was observed', () => {
    const result = projectContribution(
      input({
        config: {
          enabled: true,
          execution: { repoIds: ['a'] },
          inference: { connectionIds: ['live'] },
        },
        execution: {
          readable: true,
          observedAt: null,
          observed: {
            a: {
              state: 'bound',
              verifiedAt: Date.parse('2026-07-01T00:00:00.000Z'),
            },
          },
        },
        inference: {
          readable: true,
          observedAt: '2026-08-03T11:59:00.000Z',
          observed: { live: { modelIds: ['m1'] } },
        },
      }),
    );

    expect(result.sourceObservedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('two connections yielding the same model id both appear (L11)', () => {
    // Nothing de-duplicates: both offers are true, and dropping one would hide
    // a real offer. The obligation to supply unique RECORD ids sits on the
    // producer, and is documented on the input type.
    const result = projectContribution(
      input({
        config: { enabled: true, inference: { connectionIds: ['x', 'y'] } },
        inference: {
          readable: true,
          observedAt: '2026-08-03T11:59:00.000Z',
          observed: {
            x: { modelIds: ['llama3'] },
            y: { modelIds: ['llama3'] },
          },
        },
      }),
    );

    expect(result.inference).toEqual([
      { id: 'llama3', connectionId: 'x' },
      { id: 'llama3', connectionId: 'y' },
    ]);
  });
});
