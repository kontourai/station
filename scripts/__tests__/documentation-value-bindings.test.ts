import { describe, expect, it } from 'vitest';
import { checkDocumentationFreshness } from '../lib/documentation-freshness.mjs';
import { createReviewInputComparator } from '../lib/review-history.mjs';
import {
  check,
  commit,
  editRecord,
  fixture,
  git,
  record_,
  run,
  scoped,
  stale,
  strict,
} from './helpers/documentation-freshness-fixture.js';
import { forbidAmbientFreshnessMode } from './helpers/freshness-env.js';

forbidAmbientFreshnessMode();

function reviewedLock() {
  const f = fixture();
  const migrated = run(f.root, 'migrate-review-ledger.mjs', ['--path-only']);
  expect(migrated.status, migrated.stderr).toBe(0);
  f.write(
    'pnpm-lock.yaml',
    'packages:\n  yaml@2.9.1:\n    resolution:\n      integrity: reviewed-resolution\nimporters:\n  .:\n    specifier: ^0.8.0\n',
  );
  commit(f.root, 'add lock data');
  editRecord(f.root, 'docs/pkg.md', (data) => {
    data.sources = ['pnpm-lock.yaml#/packages/yaml@2.9.1/resolution/integrity'];
  });
  commit(f.root, 'cite the resolution claim');
  const result = record_(f.root, [
    'docs/pkg.md',
    '--note',
    'Reviewed the cited resolution, independently of workspace version labels.',
  ]);
  expect(result.status, JSON.stringify(result.error)).toBe(0);
  commit(f.root, 'record the reviewed resolution');
  return f;
}

describe('value-bound reviews through the maintained recorder and freshness CLI', () => {
  it('keeps a reviewed YAML resolution fresh across workspace version edits, but refuses a changed resolution until recorded', () => {
    const f = reviewedLock();
    git(f.root, ['switch', '-qc', 'version']);
    f.write(
      'pnpm-lock.yaml',
      f.read('pnpm-lock.yaml').replace('^0.8.0', '^0.9.0'),
    );
    commit(f.root, 'version a workspace dependency');
    for (const mode of [scoped, strict])
      expect(check(f.root, mode).status).toBe(0);
    f.write(
      'pnpm-lock.yaml',
      f
        .read('pnpm-lock.yaml')
        .replace('reviewed-resolution', 'different-resolution'),
    );
    commit(f.root, 'change the claimed resolution');
    const refused = check(f.root, scoped);
    expect(refused.status).toBe(1);
    expect(refused.blocking).toEqual([
      stale('review', 'docs/pkg.md', [
        'pnpm-lock.yaml#/packages/yaml@2.9.1/resolution/integrity',
      ]),
    ]);
    const reviewed = record_(f.root, [
      'docs/pkg.md',
      '--note',
      'Reviewed the actual changed resolution.',
    ]);
    expect(reviewed.status, JSON.stringify(reviewed.error)).toBe(0);
    commit(f.root, 'record the new resolution review');
    expect(check(f.root, scoped).status).toBe(0);
    expect(check(f.root, strict).status).toBe(0);
  });

  it.each([
    'packages: [',
    'packages: { yaml@2.9.1: first, yaml@2.9.1: second }',
    'packages: &p { yaml@2.9.1: { resolution: { integrity: reviewed-resolution } } }\ncopy: *p',
    'packages: { yaml@2.9.1: { resolution: { integrity: !unknown value } } }',
    'packages: { yaml@2.9.1: { resolution: { integrity: .nan } } }',
    'packages: { yaml@2.9.1: { resolution: {} } }',
  ])(
    'refuses an unreadable or missing cited YAML value without recording approval (%s)',
    (invalid) => {
      const f = reviewedLock();
      git(f.root, ['switch', '-qc', 'invalid']);
      f.write('pnpm-lock.yaml', invalid);
      commit(f.root, 'invalidate the cited source');
      expect(check(f.root, scoped).status).toBe(1);
      const result = record_(f.root, [
        'docs/pkg.md',
        '--note',
        'This must not approve an unreadable value.',
      ]);
      expect(result.status).toBe(1);
      expect(result.error?.code).toBe('missing-value');
    },
  );

  it('does not let two unreadable values compare equal and escape the changed-PR scope', () => {
    const f = reviewedLock();
    f.write('pnpm-lock.yaml', 'packages: [');
    commit(f.root, 'corrupt the base source');
    git(f.root, ['switch', '-qc', 'another-invalid-edit']);
    f.write('pnpm-lock.yaml', 'packages: {');
    commit(f.root, 'make another unreadable edit');
    const refused = check(f.root, scoped);
    expect(refused.status).toBe(1);
    expect(refused.blocking).toEqual([
      stale('review', 'docs/pkg.md', [
        'pnpm-lock.yaml#/packages/yaml@2.9.1/resolution/integrity',
      ]),
    ]);
  });
});

describe('value comparisons over captured Git objects', () => {
  it('distinguishes blob contents and full selectors and returns a fresh touched array', () => {
    const f = fixture();
    f.write('values.yaml', 'first: 1\nsecond: 2\na/b: 3\n');
    const before = commit(f.root, 'add comparison values');
    f.write('values.yaml', 'first: 1\nsecond: 4\na/b: 3\n');
    const after = commit(f.root, 'change only the second value');
    const compare = createReviewInputComparator(f.root);
    const paths = [
      'values.yaml#/first',
      'values.yaml#/second',
      'values.yaml#/a~1b',
    ];
    const changed = new Set(['values.yaml']);
    const touched = compare(paths, changed, before, after);
    expect(touched).toEqual(['values.yaml#/second']);
    touched.push('caller-owned.md');
    expect(compare(paths, changed, before, after)).toEqual([
      'values.yaml#/second',
    ]);
    f.write('values.yaml', 'first: 5\nsecond: 2\na/b: 3\n');
    const later = commit(f.root, 'change only the first value');
    expect(compare(paths, changed, before, later)).toEqual([
      'values.yaml#/first',
    ]);
    const duplicateKeys = '{"value": 1, "value": 2}';
    f.write('values.json', duplicateKeys);
    f.write('ambiguous.yaml', duplicateKeys);
    const sameBytes = commit(f.root, 'cite identical JSON and YAML bytes');
    expect(
      compare(
        ['values.json#/value', 'ambiguous.yaml#/value'],
        new Set(['values.json', 'ambiguous.yaml']),
        sameBytes,
        sameBytes,
      ),
    ).toEqual(['ambiguous.yaml#/value']);
  });

  it('keeps malformed, missing-value and missing-blob comparisons changed after reuse', () => {
    const f = fixture();
    f.write('values.yaml', 'value: 1\n');
    const before = commit(f.root, 'add a valid comparison value');
    const compare = createReviewInputComparator(f.root);
    const paths = ['values.yaml#/value'];
    const changed = new Set(['values.yaml']);
    f.write('values.yaml', 'value: [');
    const malformed = commit(f.root, 'make the value unreadable');
    expect(compare(paths, changed, before, malformed)).toEqual(paths);
    expect(compare(paths, changed, malformed, malformed)).toEqual(paths);
    f.write('values.yaml', 'other: 2\n');
    const absentValue = commit(f.root, 'remove the cited selector');
    expect(compare(paths, changed, absentValue, absentValue)).toEqual(paths);
    git(f.root, ['rm', 'values.yaml']);
    const absentBlob = commit(f.root, 'remove the cited file');
    expect(compare(paths, changed, before, absentBlob)).toEqual(paths);
    expect(compare(paths, changed, absentBlob, absentBlob)).toEqual(paths);
  });

  it('rereads mutable HEAD and branch refs instead of reusing their previous blobs', () => {
    const f = fixture();
    f.write('values.yaml', 'value: 1\n');
    const before = commit(f.root, 'add the initial ref value');
    const compare = createReviewInputComparator(f.root);
    const paths = ['values.yaml#/value'];
    const changed = new Set(['values.yaml']);
    git(f.root, ['update-ref', 'refs/remotes/origin/main', before]);
    expect(compare(paths, changed, before, 'HEAD')).toEqual([]);
    expect(compare(paths, changed, before, 'origin/main')).toEqual([]);
    f.write('values.yaml', 'value: 2\n');
    const after = commit(f.root, 'advance the ref value');
    git(f.root, ['update-ref', 'refs/remotes/origin/main', after]);
    expect(compare(paths, changed, before, 'HEAD')).toEqual(paths);
    expect(compare(paths, changed, before, 'origin/main')).toEqual(paths);
    expect(
      createReviewInputComparator(f.root)(paths, changed, before, after),
    ).toEqual(paths);
  });

  it('recomputes scoped policy when the base and source change between resolver invocations', async () => {
    const f = reviewedLock();
    git(f.root, ['switch', '-qc', 'value-change']);
    f.write(
      'pnpm-lock.yaml',
      f.read('pnpm-lock.yaml').replace('reviewed-resolution', 'new-resolution'),
    );
    const changedHead = commit(f.root, 'change the cited resolution');
    const first = await checkDocumentationFreshness({
      root: f.root,
      env: scoped,
    });
    expect(first.blocking.map((entry) => entry.path)).toEqual(['docs/pkg.md']);
    const sameHeadBase = await checkDocumentationFreshness({
      root: f.root,
      env: { ...scoped, STATION_DOCS_FRESHNESS_BASE: changedHead },
    });
    expect(sameHeadBase.blocking).toEqual([]);
    f.write(
      'pnpm-lock.yaml',
      f.read('pnpm-lock.yaml').replace('new-resolution', 'third-resolution'),
    );
    commit(f.root, 'advance the source beyond the selected base');
    const advanced = await checkDocumentationFreshness({
      root: f.root,
      env: { ...scoped, STATION_DOCS_FRESHNESS_BASE: changedHead },
    });
    expect(advanced.blocking.map((entry) => entry.path)).toEqual([
      'docs/pkg.md',
    ]);
  });
});
