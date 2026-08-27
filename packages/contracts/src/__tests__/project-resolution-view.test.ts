/**
 * station#1502 slice 4 — `ProjectResolutionView` and its honesty predicate
 * (`docs/design/portable-project-identity.md` §3.6 preamble, §4.1).
 */

import { describe, expect, test } from 'vitest';
import {
  isWellFormedProjectResolutionView,
  isWellFormedProjectResourceBindOutcome,
  localProjectResourceId,
  PROJECT_RESOLUTION_POSTURES,
  type ProjectResolutionPosture,
  type ProjectResolutionView,
  type ResourceResolutionResult,
} from '../project-identity.js';

const BOUND: ResourceResolutionResult = {
  state: 'bound',
  resourceId: 'github.com/kontourai/station',
  path: '/Users/dev/code/station',
};

/** The single-resource `backing` view, which is every project today. */
function backing(
  resources: ResourceResolutionResult[] = [BOUND],
  primary: unknown = { named: true, resourceId: resources[0]?.resourceId },
): Record<string, unknown> {
  return { posture: 'backing', resources, primary };
}

describe('PROJECT_RESOLUTION_POSTURES', () => {
  test('names every posture exactly once', () => {
    expect([...PROJECT_RESOLUTION_POSTURES].sort()).toEqual([
      'backing',
      'not-backing',
      'unreadable',
    ]);
    expect(new Set(PROJECT_RESOLUTION_POSTURES).size).toBe(
      PROJECT_RESOLUTION_POSTURES.length,
    );
  });

  test('is the runtime membership set the predicate checks against', () => {
    // Not a tautology: this asserts the array is what gates an off-the-wire
    // value, which is the whole reason it exists alongside the union.
    for (const posture of PROJECT_RESOLUTION_POSTURES) {
      const view =
        posture === 'backing'
          ? backing()
          : posture === 'unreadable'
            ? { posture, reason: 'the sidecar is zero-length' }
            : { posture };
      expect(isWellFormedProjectResolutionView(view)).toBe(true);
    }
  });
});

describe('isWellFormedProjectResolutionView — accepts', () => {
  test('the three well-formed postures', () => {
    const accepted: ProjectResolutionView[] = [
      { posture: 'not-backing' },
      backing() as ProjectResolutionView,
      { posture: 'unreadable', reason: 'schema version 99 is not readable' },
    ];
    for (const view of accepted) {
      expect(isWellFormedProjectResolutionView(view)).toBe(true);
    }
  });

  test('every emittable resource state under `backing`', () => {
    const resources: ResourceResolutionResult[] = [
      BOUND,
      { state: 'unbound', resourceId: 'r', reason: 'nothing records it here' },
      {
        state: 'missing',
        resourceId: 'r',
        reason: 'the declared path is gone',
        record: 'working-directory',
        declaredPath: '~/code/gone',
      },
      {
        state: 'stale',
        resourceId: 'r',
        reason: 'git could not be run',
        unverifiedPath: '/Users/dev/code/station',
      },
      {
        state: 'drifted',
        resourceId: 'r',
        reason: 'the remotes do not intersect',
        unverifiedPath: '/Users/dev/code/other',
      },
      { state: 'ambiguous', resourceId: '', reason: 'two primaries' },
      { state: 'unresolvable', resourceId: 'r', reason: 'denied' },
      { state: 'not-portable', resourceId: 'r', reason: 'local-only' },
    ];
    for (const resource of resources) {
      expect(
        isWellFormedProjectResolutionView(
          backing(
            [resource],
            resource.state === 'ambiguous'
              ? // `ambiguous` names no resource, so a primary cannot name it
                // either — the pairing the predicate enforces.
                { named: false, reason: 'two primaries' }
              : { named: true, resourceId: resource.resourceId },
          ),
        ),
      ).toBe(true);
    }
  });

  // ── station#1503 slice 5 ────────────────────────────────────────────────
  test('a PARTIALLY BOUND multi-repo project — 2 of 3', () => {
    const view = backing(
      [
        BOUND,
        { state: 'bound', resourceId: 'github.com/acme/web', path: '/w' },
        {
          state: 'unbound',
          resourceId: 'github.com/acme/docs',
          reason: 'nothing here records a location for it',
        },
      ],
      { named: true, resourceId: 'github.com/kontourai/station' },
    );
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
  });

  test('an EMPTY resource list is legal ONLY beside an unnamed primary', () => {
    expect(
      isWellFormedProjectResolutionView(
        backing([], {
          named: false,
          reason: 'this manifest names no resources',
        }),
      ),
    ).toBe(true);
  });
});

describe('isWellFormedProjectResolutionView — rejects', () => {
  test('`resources` or `primary` on a NON-backing posture', () => {
    // §4.1's per-resource row smuggled through the posture that exists to
    // guarantee its absence.
    expect(
      isWellFormedProjectResolutionView({
        posture: 'not-backing',
        resources: [BOUND],
      }),
    ).toBe(false);
    expect(
      isWellFormedProjectResolutionView({
        posture: 'not-backing',
        primary: { named: true, resourceId: 'r' },
      }),
    ).toBe(false);
    expect(
      isWellFormedProjectResolutionView({
        posture: 'unreadable',
        reason: 'unreadable',
        resources: [BOUND],
      }),
    ).toBe(false);
  });

  test('a missing `resources` or `primary` on `backing`', () => {
    expect(isWellFormedProjectResolutionView({ posture: 'backing' })).toBe(
      false,
    );
    expect(
      isWellFormedProjectResolutionView({
        posture: 'backing',
        resources: undefined,
        primary: { named: false, reason: 'x' },
      }),
    ).toBe(false);
    expect(
      isWellFormedProjectResolutionView({ posture: 'backing', resources: [] }),
    ).toBe(false);
    // Not an array — a single result where a list belongs.
    expect(
      isWellFormedProjectResolutionView({
        posture: 'backing',
        resources: BOUND,
        primary: { named: true, resourceId: BOUND.resourceId },
      }),
    ).toBe(false);
  });

  // ── station#1503 slice 5: the list and the selection must agree ──────────
  test('a primary naming a resource the list never resolved', () => {
    // It would send every no-`resourceId` consumer at a resource this view
    // never answered for.
    expect(
      isWellFormedProjectResolutionView(
        backing([BOUND], { named: true, resourceId: 'github.com/acme/ghost' }),
      ),
    ).toBe(false);
  });

  test('a NAMED primary beside an empty list', () => {
    expect(
      isWellFormedProjectResolutionView(
        backing([], { named: true, resourceId: 'github.com/acme/api' }),
      ),
    ).toBe(false);
  });

  test('a DUPLICATED resourceId — answering twice for one resource', () => {
    expect(
      isWellFormedProjectResolutionView(
        backing([BOUND, { ...BOUND, path: '/elsewhere' }]),
      ),
    ).toBe(false);
  });

  test('a malformed `primary`', () => {
    const malformed: unknown[] = [
      undefined,
      null,
      {},
      { named: true, resourceId: 'github.com/acme/not-in-the-list' },
      { named: true },
      { named: true, resourceId: '' },
      // Two answers to one question.
      { named: true, resourceId: 'r', reason: 'and also this' },
      { named: false },
      { named: false, reason: '' },
      { named: false, resourceId: 'r', reason: 'x' },
      { named: 'true', resourceId: 'r' },
    ];
    for (const primary of malformed) {
      // Built inline, NOT through `backing()`: its `primary ?? default` would
      // substitute a valid selection for the `undefined` case and quietly turn
      // that row of the table into a test of the helper.
      expect(
        isWellFormedProjectResolutionView({
          posture: 'backing',
          resources: [BOUND],
          primary,
        }),
      ).toBe(false);
    }
  });

  test('an ill-formed `resource` on `backing` — delegated to isWellFormedResolution', () => {
    const malformed: unknown[] = [
      // A path on a non-`bound` state: the answer-slot leak slice 1 forbids.
      { state: 'unbound', resourceId: 'r', reason: 'x', path: '/somewhere' },
      // A repair state with no reason.
      { state: 'drifted', resourceId: 'r', unverifiedPath: '/somewhere' },
      // `missing` without its record.
      { state: 'missing', resourceId: 'r', reason: 'x', declaredPath: '~/a' },
      // `ambiguous` naming a resource the state says does not exist.
      { state: 'ambiguous', resourceId: 'r', reason: 'x' },
      // A state outside the union.
      { state: 'pending', resourceId: 'r', reason: 'x' },
      'not an object',
      null,
    ];
    for (const resource of malformed) {
      expect(
        isWellFormedProjectResolutionView(
          backing([resource as ResourceResolutionResult]),
        ),
      ).toBe(false);
    }
  });

  // station#1503 review, M4.
  test('the LEGACY singular `resource` field, on every posture', () => {
    // The rename made this field just another unknown key, and the predicate
    // is not an exact-key-set check — so it silently started passing, for the
    // exact producer this predicate exists to police (a build against an older
    // version of this package).
    expect(
      isWellFormedProjectResolutionView({
        posture: 'not-backing',
        resource: BOUND,
      }),
    ).toBe(false);
    expect(
      isWellFormedProjectResolutionView({
        posture: 'unreadable',
        reason: 'unreadable',
        resource: BOUND,
      }),
    ).toBe(false);
    // Including alongside a well-formed new-shape body: a server emitting both
    // is telling two stories about one project.
    expect(
      isWellFormedProjectResolutionView({
        ...backing([BOUND]),
        resource: BOUND,
      }),
    ).toBe(false);
  });

  test('an empty or absent `reason` on `unreadable`', () => {
    expect(isWellFormedProjectResolutionView({ posture: 'unreadable' })).toBe(
      false,
    );
    expect(
      isWellFormedProjectResolutionView({ posture: 'unreadable', reason: '' }),
    ).toBe(false);
    expect(
      isWellFormedProjectResolutionView({ posture: 'unreadable', reason: 7 }),
    ).toBe(false);
  });

  test('a `reason` on a posture that has nothing to explain', () => {
    expect(
      isWellFormedProjectResolutionView({
        posture: 'not-backing',
        reason: 'this Station backs nothing',
      }),
    ).toBe(false);
  });

  test('an unknown posture', () => {
    const rejected: unknown[] = [
      { posture: 'partially-backing' },
      { posture: '' },
      { posture: 7 },
      {},
      { resources: [BOUND] },
      null,
      undefined,
      'backing',
      ['backing'],
    ];
    for (const value of rejected) {
      expect(isWellFormedProjectResolutionView(value)).toBe(false);
    }
  });
});

describe('the type-level exhaustiveness proof', () => {
  test('every posture in the union is in the array', () => {
    // The compile-time proof lives in the module; this is its runtime mirror,
    // so a member added to the type and forgotten in the array fails here too
    // for anyone reading test output rather than tsc output.
    const fromUnion: ProjectResolutionPosture[] = [
      'not-backing',
      'backing',
      'unreadable',
    ];
    for (const posture of fromUnion) {
      expect(PROJECT_RESOLUTION_POSTURES).toContain(posture);
    }
    expect(PROJECT_RESOLUTION_POSTURES.length).toBe(fromUnion.length);
  });
});

// ── station#1502 fix round ────────────────────────────────────────────────

describe('localProjectResourceId', () => {
  test('is the one spelling of the compat id both sides join on', () => {
    // The resolver MINTS it; the settings surface must recognise it in order
    // not to print it. Two spellings would drift, which is exactly what the
    // resolver's DISCLOSED GAP warns about for this id.
    expect(localProjectResourceId('acme')).toBe('local:acme');
  });
});

describe('isWellFormedProjectResourceBindOutcome', () => {
  const VIEW = backing() as ProjectResolutionView;

  test('accepts a recorded write carrying the re-derived view', () => {
    expect(
      isWellFormedProjectResourceBindOutcome({ recorded: true, view: VIEW }),
    ).toBe(true);
  });

  test('accepts a recorded write carrying a NAMED gap', () => {
    expect(
      isWellFormedProjectResourceBindOutcome({
        recorded: true,
        gap: 'The binding was recorded. This Station could not then re-read it: EIO',
      }),
    ).toBe(true);
  });

  test('rejects the shapes that would let a client misreport a write', () => {
    const rejected: unknown[] = [
      // `recorded` must be asserted, not inferred.
      { view: VIEW },
      { recorded: false, view: VIEW },
      { recorded: 'true', view: VIEW },
      // Neither: the surface would render an empty body with no named gap.
      { recorded: true },
      // Both: two answers to one question.
      { recorded: true, view: VIEW, gap: 'something' },
      // An empty gap is an unnamed absence, which is the thing this forbids.
      { recorded: true, gap: '' },
      // The view's own invariants stay delegated whole to its predicate.
      { recorded: true, view: { posture: 'not-backing', resources: [BOUND] } },
      { recorded: true, view: { posture: 'invented' } },
      { recorded: true, view: null },
      null,
      undefined,
      'recorded',
      ['recorded'],
    ];
    for (const value of rejected) {
      expect(isWellFormedProjectResourceBindOutcome(value)).toBe(false);
    }
  });
});
