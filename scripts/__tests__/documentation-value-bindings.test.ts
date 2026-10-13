import { describe, expect, it } from 'vitest';
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
