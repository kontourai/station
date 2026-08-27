import { describe, expect, it } from 'vitest';
import { evaluate } from '../check-merge-base-fresh.mjs';

describe('merge-base freshness', () => {
  it('blocks a branch that does not contain the base', () => {
    expect(
      evaluate({ headSha: 'a', baseSha: 'b', behind: 3, allowStale: false }),
    ).toEqual({ ok: false, behind: 3 });
  });

  it('allows a deliberate exception', () => {
    // The escape hatch has to exist, or the first legitimate case teaches
    // people to reach for --no-verify, which skips every hook rather than one.
    expect(
      evaluate({ headSha: 'a', baseSha: 'b', behind: 3, allowStale: true }).ok,
    ).toBe(true);
  });

  it('is a no-op where the base ref does not exist', () => {
    // A fresh clone, a detached CI checkout, or a repo without that remote must
    // be unaffected rather than blocked.
    const r = evaluate({
      headSha: 'a',
      baseSha: null,
      behind: 0,
      allowStale: false,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/no base ref/);
  });

  it('allows pushing the base branch itself', () => {
    expect(
      evaluate({ headSha: 'a', baseSha: 'a', behind: 0, allowStale: false }).ok,
    ).toBe(true);
  });
});

describe('repo hook wiring', () => {
  it('ships an executable pre-push hook that runs the check', async () => {
    const { readFileSync, statSync } = await import('node:fs');
    const hook = readFileSync('.githooks/pre-push', 'utf8');
    expect(hook).toContain('check-merge-base-fresh.mjs');
    // Executable, or git silently ignores it.
    expect(statSync('.githooks/pre-push').mode & 0o111).toBeGreaterThan(0);
  });

  it('exposes a one-command activation that actually sets core.hooksPath', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    // Lifecycle scripts stay globally inert. The supported dependency runner
    // owns checkout hook arming after it has completed its reviewed phase.
    expect(pkg.scripts['hooks:install']).toContain('install-git-hooks.mjs');
    expect(pkg.scripts.prepare).toBeUndefined();
    const lifecycle = readFileSync('scripts/dependency-lifecycle.mjs', 'utf8');
    expect(lifecycle).toContain("['scripts/install-git-hooks.mjs']");
    const installer = readFileSync('scripts/install-git-hooks.mjs', 'utf8');
    expect(installer).toContain("'core.hooksPath'");
    expect(installer).toContain("'.githooks'");
  });
});
