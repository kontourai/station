import { describe, expect, test } from 'vitest';
import {
  critiquesFromTrustBundle,
  filterCritiquesForSlug,
  handoffBlockers,
  hasUnresolvedLiveCritique,
} from '../workflow-process-projection-mirror.js';

describe('handoffBlockers', () => {
  test('filters blank entries and returns undefined when nothing remains', () => {
    expect(
      handoffBlockers({
        schema_version: '1.0',
        task_slug: 'demo',
        summary: 's',
        next_steps: [],
        blockers: ['  ', ''],
      }),
    ).toBeUndefined();
  });

  test('returns non-empty trimmed-nonblank entries unchanged', () => {
    expect(
      handoffBlockers({
        schema_version: '1.0',
        task_slug: 'demo',
        summary: 's',
        next_steps: [],
        blockers: ['real blocker'],
      }),
    ).toEqual(['real blocker']);
  });

  test('null handoff returns undefined', () => {
    expect(handoffBlockers(null)).toBeUndefined();
  });
});

function critiqueClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    value: 'not_verified',
    metadata: { origin: 'critique' },
    ...overrides,
  };
}

describe('critiquesFromTrustBundle', () => {
  test('extracts only claims stamped metadata.origin === "critique"', () => {
    const bundle = {
      claims: [
        critiqueClaim({ value: 'not_verified' }),
        { id: 'check-1', value: 'pass', metadata: { origin: 'check' } },
        { id: 'accept-1', value: 'pass', metadata: { origin: 'acceptance' } },
      ],
    };
    const result = critiquesFromTrustBundle(bundle);
    expect(result.critiques).toEqual([
      {
        verdict: 'not_verified',
        superseded_by: undefined,
        workflow_subject_ref: undefined,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  test('defaults a nullish verdict to "not_verified"', () => {
    const bundle = { claims: [critiqueClaim({ value: undefined })] };
    expect(critiquesFromTrustBundle(bundle).critiques[0]?.verdict).toBe(
      'not_verified',
    );
  });

  test('passes through superseded_by and workflow_subject_ref unchanged', () => {
    const bundle = {
      claims: [
        critiqueClaim({
          metadata: {
            origin: 'critique',
            superseded_by: 'claim-2',
            workflow_subject_ref: 'flow-agents://session/demo-task',
          },
        }),
      ],
    };
    expect(critiquesFromTrustBundle(bundle).critiques[0]).toMatchObject({
      superseded_by: 'claim-2',
      workflow_subject_ref: 'flow-agents://session/demo-task',
    });
  });

  test('is defensive against every non-suspicious malformed shape: never throws, no warnings, empty critiques', () => {
    expect(critiquesFromTrustBundle(null)).toEqual({
      critiques: [],
      warnings: [],
    });
    expect(critiquesFromTrustBundle(undefined)).toEqual({
      critiques: [],
      warnings: [],
    });
    expect(critiquesFromTrustBundle('not an object')).toEqual({
      critiques: [],
      warnings: [],
    });
    expect(critiquesFromTrustBundle({})).toEqual({
      critiques: [],
      warnings: [],
    });
    expect(critiquesFromTrustBundle({ claims: 'not an array' })).toEqual({
      critiques: [],
      warnings: [],
    });
    expect(critiquesFromTrustBundle({ claims: [null, 42, 'x'] })).toEqual({
      critiques: [],
      warnings: [],
    });
    // pure absence — an object claim with no `metadata` key at all is not
    // suspicious, silently skipped, no warning.
    expect(
      critiquesFromTrustBundle({ claims: [{ id: 'no-metadata' }] }),
    ).toEqual({ critiques: [], warnings: [] });
    // pure absence of the `origin` key inside a present metadata object —
    // also not suspicious.
    expect(
      critiquesFromTrustBundle({
        claims: [{ id: 'no-origin-key', metadata: {} }],
      }),
    ).toEqual({ critiques: [], warnings: [] });
  });

  test('a present metadata key that is not an object is SUSPICIOUS — warned, skipped', () => {
    const bundle = {
      claims: [{ id: 'weird-1', value: 'fail', metadata: 'not-an-object' }],
    };
    const result = critiquesFromTrustBundle(bundle);
    expect(result.critiques).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/weird-1/);
    expect(result.warnings[0]).toMatch(/present-but-non-object metadata/);
  });

  test('a present but malformed metadata.origin (non-string) is SUSPICIOUS — warned, skipped', () => {
    const bundle = {
      claims: [{ id: 'weird-2', value: 'fail', metadata: { origin: 42 } }],
    };
    const result = critiquesFromTrustBundle(bundle);
    expect(result.critiques).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/weird-2/);
    expect(result.warnings[0]).toMatch(
      /present-but-malformed metadata\.origin/,
    );
  });

  test('a present but empty-string metadata.origin is SUSPICIOUS — warned, skipped', () => {
    const bundle = {
      claims: [{ id: 'weird-3', value: 'fail', metadata: { origin: '' } }],
    };
    const result = critiquesFromTrustBundle(bundle);
    expect(result.critiques).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/weird-3/);
  });

  test('a valid non-critique origin (e.g. "check") is NOT suspicious — no warning', () => {
    const bundle = {
      claims: [{ id: 'check-1', value: 'pass', metadata: { origin: 'check' } }],
    };
    const result = critiquesFromTrustBundle(bundle);
    expect(result.critiques).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('labels a warning with claims[index] when the claim has no usable id', () => {
    const bundle = { claims: [{ metadata: { origin: 123 } }] };
    const result = critiquesFromTrustBundle(bundle);
    expect(result.warnings[0]).toMatch(/claims\[0\]/);
  });
});

/**
 * Behavioral pin (trip-wire b, station worker instructions for this
 * retirement task): `hasUnresolvedLiveCritique`/`filterCritiquesForSlug`
 * asserted against representative fixtures pinned to the upstream
 * `@kontourai/flow-agents@5.3.0` `src/lib/workflow-process-projection.ts`
 * semantics they mirror. If a future flow-agents version changes either
 * function's behavior, this pin does NOT auto-detect the drift (there is no
 * importable "real" export to diff against — see this file's sibling
 * `console-contract-tripwire` test for the export-surface half of the
 * trip-wire) — it instead gives a manual re-sync (bumping the pin, reading
 * the new source, updating both the mirror and these fixtures) a concrete
 * regression suite to update alongside the mirror.
 */
describe('hasUnresolvedLiveCritique (behavioral pin, flow-agents@5.3.0)', () => {
  test('true when a live critique has a non-pass verdict', () => {
    expect(hasUnresolvedLiveCritique([{ verdict: 'not_verified' }])).toBe(true);
  });

  test('false when the only critique passed', () => {
    expect(hasUnresolvedLiveCritique([{ verdict: 'pass' }])).toBe(false);
  });

  test('false when the only non-passing critique is superseded', () => {
    expect(
      hasUnresolvedLiveCritique([
        { verdict: 'not_verified', superseded_by: 'claim-2' },
      ]),
    ).toBe(false);
  });

  test('false for an empty critique list', () => {
    expect(hasUnresolvedLiveCritique([])).toBe(false);
  });

  test('true when at least one of several critiques is live and non-passing', () => {
    expect(
      hasUnresolvedLiveCritique([
        { verdict: 'pass' },
        { verdict: 'not_verified', superseded_by: 'claim-3' },
        { verdict: 'fail' },
      ]),
    ).toBe(true);
  });
});

describe('filterCritiquesForSlug (behavioral pin, flow-agents@5.3.0)', () => {
  test('keeps a critique with no workflow_subject_ref (unattributable, passed through)', () => {
    const result = filterCritiquesForSlug([{ verdict: 'fail' }], 'demo-task');
    expect(result.critiques).toEqual([{ verdict: 'fail' }]);
    expect(result.warnings).toEqual([]);
  });

  test('keeps a session-form ref that names this exact slug', () => {
    const critique = {
      verdict: 'fail',
      workflow_subject_ref: 'flow-agents://session/demo-task',
    };
    const result = filterCritiquesForSlug([critique], 'demo-task');
    expect(result.critiques).toEqual([critique]);
    expect(result.warnings).toEqual([]);
  });

  test('drops a session-form ref naming a different slug, with a warning', () => {
    const critique = {
      verdict: 'fail',
      workflow_subject_ref: 'flow-agents://session/other-task',
    };
    const result = filterCritiquesForSlug([critique], 'demo-task');
    expect(result.critiques).toEqual([]);
    expect(result.warnings[0]).toMatch(/other-task/);
  });

  test("keeps a work-item ref that is among this session's own work_item_refs", () => {
    const critique = {
      verdict: 'fail',
      workflow_subject_ref: 'github:kontourai/station#753',
    };
    const result = filterCritiquesForSlug([critique], 'demo-task', [
      'github:kontourai/station#753',
    ]);
    expect(result.critiques).toEqual([critique]);
    expect(result.warnings).toEqual([]);
  });

  test("drops a foreign work-item ref not among this session's own work_item_refs, with a warning", () => {
    const critique = {
      verdict: 'fail',
      workflow_subject_ref: 'github:kontourai/station#999',
    };
    const result = filterCritiquesForSlug([critique], 'demo-task', [
      'github:kontourai/station#753',
    ]);
    expect(result.critiques).toEqual([]);
    expect(result.warnings[0]).toMatch(/999/);
  });

  test('drops a present-but-empty workflow_subject_ref, with a warning', () => {
    const critique = { verdict: 'fail', workflow_subject_ref: '' };
    const result = filterCritiquesForSlug([critique], 'demo-task');
    expect(result.critiques).toEqual([]);
    expect(result.warnings[0]).toMatch(/present-but-empty/);
  });
});
