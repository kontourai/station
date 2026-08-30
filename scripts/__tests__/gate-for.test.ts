import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { gateReport } from '../gate-for.mjs';

// gate:for must stay a COMPOSER of the pre-push deciders, never a parallel
// encoding of their path lists — these tests therefore assert agreement with
// the deciders' own verdicts on representative surfaces, not hardcoded path
// knowledge of this test's own.

const baseSha = 'f'.repeat(40);

describe('gate-for report', () => {
  it('marks every scoped gate RUNS for a surface that feeds all four', () => {
    const report = gateReport({
      changedPaths: [
        'src-ui/src/App.tsx',
        'packages/sdk/src/api.ts',
        'src-ui/src/styles/motion.css',
        'src-server/services/orchestration/orchestration-service.ts',
      ],
      baseSha,
    });
    expect(report).not.toContain('skipped');
    expect(report).toContain('node scripts/check-prepush-ui-bundle.mjs');
    expect(report).toContain('node scripts/check-prepush-sdk-barrel.mjs');
    expect(report).toContain('node scripts/check-prepush-static-gates.mjs');
    expect(report).toContain(
      'node scripts/check-prepush-orchestration-transfer.mjs',
    );
  });

  it('marks every scoped gate skipped for a docs-only surface', () => {
    const report = gateReport({
      changedPaths: ['docs/guides/testing.md'],
      baseSha,
    });
    expect(report).not.toContain('RUNS');
    // The reason lines are the deciders' own, not this script's.
    expect(report).toContain('feed one of these gates');
  });

  it('always names the unconditional checks and the lane ladder', () => {
    const report = gateReport({ changedPaths: [], baseSha });
    for (const always of [
      'lint:check',
      'commit-message-gate.mjs --prepush-stdin',
      'test:changed -- --base=origin/main --explain',
      'ci:fast',
      'full:regression',
      'GitHub merge queue candidate',
      'manual CI workflow_dispatch',
    ]) {
      expect(report).toContain(always);
    }
    expect(report).not.toContain('final checkpoint only');
  });

  it('with no base sha, every decider fails open to RUNS by its own rule', () => {
    const report = gateReport({
      changedPaths: ['docs/guides/testing.md'],
      baseSha: '',
    });
    // Deciders treat an unresolvable base as "cannot scope, so run" — the
    // report must reflect that, not soften it.
    expect(report).not.toContain('skipped');
  });

  it('accepts --base in both = and space form, and both scope the same branch', () => {
    const eq = execFileSync('node', ['scripts/gate-for.mjs', '--base=HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const space = execFileSync(
      'node',
      ['scripts/gate-for.mjs', '--base', 'HEAD'],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    // The space form used to absorb the ref as a changed PATH and answer
    // "nothing applies" about a branch it never looked at — the one output a
    // scoping advisor must never emit.
    expect(space).toBe(eq);
    expect(space).not.toContain('gate:for — 1 changed path(s)');
  });

  it('refuses an unrecognized flag instead of treating it as a path', () => {
    expect(() =>
      execFileSync('node', ['scripts/gate-for.mjs', '--bogus'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow();
  });

  it('the npm entry point exists and prints a report', () => {
    const out = execFileSync(
      'node',
      ['scripts/gate-for.mjs', 'docs/guides/testing.md'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(out).toContain('gate:for — 1 changed path(s)');
  });
});
