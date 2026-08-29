import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The deploy ledger's workflow contract (station#4572), pinned the same way
 * nightly-build-identity.test.ts pins the nightly's: these workflows cannot
 * be exercised before merge, so the properties that would otherwise be
 * discovered only by an unrecorded ship are proven against their text.
 *
 * The pinned properties are the honesty invariants of the ledger:
 * - a ledger step exists per publish surface and runs AFTER that publish
 *   (publish-first-then-ledger: a ledger failure must never block a ship);
 * - the recorded sha is the workflow's own decided ship SHA, never
 *   re-derived by a git command inside the ledger step;
 * - the changesets action's published-packages output (a compact JSON
 *   array) is parsed by the unit-tested parse script, never text-split;
 * - a ledger failure fails the job (no continue-on-error on the recorder),
 *   while the belt-and-braces artifact upload may fail as infrastructure;
 * - the commit-back (retry, ancestry guard, ephemeral auth, --no-verify)
 *   lives in scripts/lib/deploy-ledger-commit.mjs — checked-in text, pinned
 *   here below — because shell in YAML cannot be unit-tested.
 */

const root = resolve(import.meta.dirname, '../..');
const nightly = readFileSync(
  resolve(root, '.github/workflows/nightly.yml'),
  'utf8',
);
const publishRelease = readFileSync(
  resolve(root, '.github/workflows/publish-release.yml'),
  'utf8',
);
const publishPackages = readFileSync(
  resolve(root, '.github/workflows/publish-packages.yml'),
  'utf8',
);
const commitScript = readFileSync(
  resolve(root, 'scripts/lib/deploy-ledger-commit.mjs'),
  'utf8',
);
const parseScript = readFileSync(
  resolve(root, 'scripts/lib/parse-published-packages.mjs'),
  'utf8',
);

const NIGHTLY_ANDROID_LEDGER_STEP =
  'Record the nightly Android ship in the deploy ledger';
const NIGHTLY_NPM_LEDGER_STEP =
  'Record the nightly CLI npm ship in the deploy ledger';
const NIGHTLY_DESKTOP_LEDGER_STEP =
  'Record the nightly desktop ship in the deploy ledger';
const STABLE_LEDGER_STEP = 'Record the stable release in the deploy ledger';
const NPM_LEDGER_STEP = 'Record published npm packages in the deploy ledger';
const LEDGER_SCRIPT = 'node scripts/deploy-ledger.mjs';
const COMMIT_SCRIPT = 'node scripts/lib/deploy-ledger-commit.mjs';
const LEDGER_RETAIN_STEP = "Retain this run's deploy ledger files";
const OLD_INLINE_COMMIT_STEP = 'Commit the deploy ledger back to main';

/**
 * Slice from a step's `name:` line to the next same-indent step marker,
 * with comment lines stripped: a `#`-commented copy of a literal satisfies
 * (or violates) toContain while the real key was gutted — the delta-review
 * R2 lesson nightly-build-identity.test.ts already records.
 */
function stepBlock(workflow: string, stepName: string): string {
  const start = workflow.indexOf(`name: ${stepName}`);
  expect(start, `step must exist: ${stepName}`).toBeGreaterThanOrEqual(0);
  const nameLineStart = workflow.lastIndexOf('\n', start) + 1;
  const rest = workflow.slice(start + stepName.length);
  const nextIndex = rest.match(/\n\s+- (?:name:|uses:|run:)/)?.index;
  const end =
    nextIndex === undefined ? undefined : start + stepName.length + nextIndex;
  const block = workflow.slice(nameLineStart, end);
  return block
    .split('\n')
    .filter((line: string) => !/^\s*#/.test(line))
    .join('\n');
}

describe('the nightly workflow records what it ships', () => {
  it('records the Android ship only after publication and the rolling tag', () => {
    const playUpload = nightly.indexOf(
      'name: Upload to Play internal testing track',
    );
    const rollingTag = nightly.indexOf('name: Advance the rolling nightly tag');
    const androidLedger = nightly.indexOf(
      `name: ${NIGHTLY_ANDROID_LEDGER_STEP}`,
    );
    expect(playUpload).toBeGreaterThanOrEqual(0);
    expect(rollingTag).toBeGreaterThan(playUpload);
    expect(androidLedger).toBeGreaterThan(rollingTag);
    const step = stepBlock(nightly, NIGHTLY_ANDROID_LEDGER_STEP);
    expect(step).toContain(COMMIT_SCRIPT);
    expect(step).toContain(LEDGER_SCRIPT);
    expect(step).toContain('--channel nightly-android');
    // The decided ship SHA — the same one the gate verdicted and the build
    // shipped — never a re-derivation.
    expect(step).toContain(
      'DEPLOY_LEDGER_SHA: $' + '{{ steps.decide.outputs.head_sha }}',
    );
    expect(step).toContain('--sha "$DEPLOY_LEDGER_SHA"');
    expect(step).not.toMatch(/git rev-parse/);
    // LOW-2: the version is the identity step's derived version, not
    // github.ref or a re-derived one.
    expect(step).toContain(
      'DEPLOY_LEDGER_VERSION: $' + '{{ steps.identity.outputs.version }}',
    );
    // Mirrors the publish condition: no signing material, no ship, no row.
    expect(step).toContain(
      "steps.android_signing.outputs.keystore_base64 != ''",
    );
    // The commit subject is what the changelog exclusion rule keys on.
    expect(step).toMatch(/docs\(ledger\):/);
  });

  it('records the npm ship after the publish and after the Android record', () => {
    const npmPublish = nightly.indexOf(
      'name: Publish @kontourai/station-cli to the nightly dist-tag',
    );
    const androidLedger = nightly.indexOf(
      `name: ${NIGHTLY_ANDROID_LEDGER_STEP}`,
    );
    const npmLedger = nightly.indexOf(`name: ${NIGHTLY_NPM_LEDGER_STEP}`);
    expect(npmPublish).toBeGreaterThanOrEqual(0);
    expect(npmLedger).toBeGreaterThan(npmPublish);
    expect(npmLedger).toBeGreaterThan(androidLedger);
    const step = stepBlock(nightly, NIGHTLY_NPM_LEDGER_STEP);
    expect(step).toContain(COMMIT_SCRIPT);
    expect(step).toContain(LEDGER_SCRIPT);
    expect(step).toContain('--channel nightly-npm');
    expect(step).toContain(
      'DEPLOY_LEDGER_SHA: $' + '{{ steps.decide.outputs.head_sha }}',
    );
    // LOW-2: the nightly CLI's OWN identity step, not the Android's.
    expect(step).toContain(
      'DEPLOY_LEDGER_VERSION: $' + '{{ steps.cli_identity.outputs.version }}',
    );
    expect(step).not.toMatch(/git rev-parse/);
    // Records only what actually published, and cannot be suppressed by an
    // unrelated later-step failure.
    expect(step).toContain(
      "always() && steps.decide.outputs.build == 'true' && steps.cli_npm_publish.outcome == 'success'",
    );
    expect(step).toMatch(/docs\(ledger\):/);
  });

  it('lets a ledger failure redden the job without blocking any ship', () => {
    // The recorders themselves carry no continue-on-error; only the
    // belt-and-braces artifact upload does (infrastructure, station#2218).
    for (const stepName of [
      NIGHTLY_ANDROID_LEDGER_STEP,
      NIGHTLY_NPM_LEDGER_STEP,
    ]) {
      expect(stepBlock(nightly, stepName)).not.toContain('continue-on-error');
    }
    const retain = stepBlock(nightly, LEDGER_RETAIN_STEP);
    expect(retain).toContain('continue-on-error: true');
    expect(retain).toContain('deploy-ledger-nightly-');
    expect(retain).toContain('always()');
  });
});

describe('the desktop nightly workflow records what it ships (station#575)', () => {
  // Bounded to the next top-level job key, not EOF (station#575 fix round
  // L8): a future job appended after this one must not leak into these
  // indexOf-based assertions.
  const desktopJobStart = nightly.indexOf('\n  nightly-desktop:');
  const desktopNextJob = nightly
    .slice(desktopJobStart + 1)
    .match(/\n {2}[A-Za-z0-9_-]+:\s*\n/);
  const desktopJobEnd = desktopNextJob
    ? desktopJobStart + 1 + (desktopNextJob.index ?? 0)
    : nightly.length;
  const desktopJob = nightly.slice(desktopJobStart, desktopJobEnd);

  it('records the desktop ship only after the rolling prerelease publish', () => {
    const publish = desktopJob.indexOf(
      'name: Publish the rolling desktop nightly prerelease',
    );
    const ledger = desktopJob.indexOf(`name: ${NIGHTLY_DESKTOP_LEDGER_STEP}`);
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeGreaterThan(publish);
    const step = stepBlock(desktopJob, NIGHTLY_DESKTOP_LEDGER_STEP);
    expect(step).toContain(COMMIT_SCRIPT);
    expect(step).toContain(LEDGER_SCRIPT);
    expect(step).toContain('--channel nightly-desktop');
    // The same decided ship SHA the gate verdicted and the build shipped —
    // this job's OWN decide step, never a re-derivation.
    expect(step).toContain(
      'DEPLOY_LEDGER_SHA: $' + '{{ steps.decide.outputs.head_sha }}',
    );
    expect(step).toContain('--sha "$DEPLOY_LEDGER_SHA"');
    expect(step).not.toMatch(/git rev-parse/);
    expect(step).toContain(
      'DEPLOY_LEDGER_VERSION: $' + '{{ steps.identity.outputs.version }}',
    );
    expect(step).toMatch(/docs\(ledger\):/);
  });

  it('lets a ledger failure redden the job without blocking any ship', () => {
    expect(stepBlock(desktopJob, NIGHTLY_DESKTOP_LEDGER_STEP)).not.toContain(
      'continue-on-error',
    );
    const retain = stepBlock(desktopJob, LEDGER_RETAIN_STEP);
    expect(retain).toContain('continue-on-error: true');
    expect(retain).toContain('deploy-ledger-nightly-desktop-');
    expect(retain).toContain('always()');
  });

  it('uses the DEPLOY_LEDGER_CHANNELS vocabulary, not a literal string only the workflow knows', () => {
    const ledgerScript = readFileSync(
      resolve(root, 'scripts/deploy-ledger.mjs'),
      'utf8',
    );
    expect(ledgerScript).toContain("'nightly-desktop'");
  });
});

describe('the stable release ledger record', () => {
  it('records at the publish moment in publish-release.yml, not the draft assembly', () => {
    // release.yml only assembles a DRAFT; a row recorded there would claim
    // a deploy that may never be published. The pin: the ledger step must
    // exist in publish-release.yml after the actual publish step.
    expect(publishRelease).toContain(`name: ${STABLE_LEDGER_STEP}`);
    expect(
      readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
    ).not.toContain('deploy-ledger.mjs');
    const publishStep = publishRelease.indexOf(
      'name: Publish release and compensate to draft until feed verifies',
    );
    const ledgerStep = publishRelease.indexOf(`name: ${STABLE_LEDGER_STEP}`);
    expect(publishStep).toBeGreaterThanOrEqual(0);
    expect(ledgerStep).toBeGreaterThan(publishStep);
    const step = stepBlock(publishRelease, STABLE_LEDGER_STEP);
    expect(step).toContain(COMMIT_SCRIPT);
    expect(step).toContain(LEDGER_SCRIPT);
    expect(step).toContain('--channel stable-desktop');
    // MED-1: the sha every producer built and every attestation names is
    // needs.resolve.outputs.sha — the reviewer's swap to github.sha went
    // uncaught by the previous pins. Scoped to the PUBLISH job's env block:
    // the release-availability job also defines RELEASE_SHA from
    // needs.resolve, so a whole-file toContain keeps passing after the
    // publish job's source is swapped (proven by re-running that injection
    // against this test).
    const publishJob = publishRelease.slice(
      publishRelease.indexOf('  publish:'),
      publishRelease.indexOf('  release-availability:'),
    );
    expect(publishJob.indexOf('  publish:')).toBeGreaterThanOrEqual(0);
    expect(publishJob).toContain(
      'RELEASE_SHA: $' + '{{ needs.resolve.outputs.sha }}',
    );
    expect(publishJob).not.toMatch(/RELEASE_SHA:[^\n]*github\.sha/);
    expect(step).toContain('--sha "$RELEASE_SHA"');
    expect(step).not.toContain('github.sha');
    expect(step).not.toMatch(/git rev-parse/);
    expect(step).toContain('github.token');
    // MED-4: the commit-back refuses before pushing anything when the
    // release SHA is not an ancestor of main — a tag cut off-main must
    // never have its commits pushed to main as a ledger side effect.
    expect(step).toContain('--require-ancestor "$RELEASE_SHA"');
    // LOW-3: an empty release-assets download must refuse, not record a
    // literal glob string as an artifact.
    expect(step).toContain('shopt -s nullglob');
    expect(step).toMatch(/\$\{#assets\[@\]\}" -eq 0/);
  });

  it('retains with the same fail-loud shape, on failure too', () => {
    expect(stepBlock(publishRelease, STABLE_LEDGER_STEP)).not.toContain(
      'continue-on-error',
    );
    const retain = stepBlock(publishRelease, LEDGER_RETAIN_STEP);
    expect(retain).toContain('continue-on-error: true');
    expect(retain).toContain('always()');
  });
});

describe('the npm stable ledger record', () => {
  it('parses the changesets JSON output with the tested script, never text-split', () => {
    const changesets = publishPackages.indexOf('id: changesets');
    const ledger = publishPackages.indexOf(`name: ${NPM_LEDGER_STEP}`);
    expect(changesets).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeGreaterThan(changesets);
    const step = stepBlock(publishPackages, NPM_LEDGER_STEP);
    expect(step).toContain("steps.changesets.outputs.published == 'true'");
    expect(step).toContain('PUBLISHED_PACKAGES');
    // HIGH-2: the parse must go through the unit-tested script. The
    // reviewer's fabricated-parse injection (replacing the whole parse with
    // hardcoded values) kept 'PUBLISHED_PACKAGES' present and stayed green
    // against the old pin; requiring the parse script by name is what reds
    // that injection now.
    expect(step).toContain(
      'node scripts/lib/parse-published-packages.mjs "$PUBLISHED_PACKAGES"',
    );
    // The old text-splitting shapes are gone.
    expect(step).not.toContain('$' + '{spec%@*}');
    expect(step).not.toContain('$' + '{spec##*@}');
    expect(step).not.toMatch(/read -r spec/);
    // The parse script itself documents and enforces the JSON contract.
    expect(parseScript).toContain('published-packages');
    expect(step).toContain(COMMIT_SCRIPT);
    expect(step).toContain(LEDGER_SCRIPT);
    expect(step).toContain('--channel stable-npm');
    expect(step).toContain('--sha "$GITHUB_SHA"');
    expect(step).not.toMatch(/git rev-parse/);
    expect(step).not.toContain('continue-on-error');
    expect(step).toMatch(/docs\(ledger\):/);
  });

  it('retains after the record step so a failed push still uploads the files', () => {
    const record = publishPackages.indexOf(`name: ${NPM_LEDGER_STEP}`);
    const retain = publishPackages.indexOf(`name: ${LEDGER_RETAIN_STEP}`);
    expect(retain).toBeGreaterThan(record);
    const retainStep = stepBlock(publishPackages, LEDGER_RETAIN_STEP);
    expect(retainStep).toContain('continue-on-error: true');
    expect(retainStep).toContain('always()');
  });
});

describe('the npm ledger loop records only registry-confirmed ships', () => {
  it('registry-confirms each package before recording (changesets lists tag-only private packages as published)', () => {
    expect(publishPackages).toContain('if ! npm view "$name@$version" version');
    expect(publishPackages).toContain(
      'not on the npm registry (tag-only or private publish) — no ledger row',
    );
  });

  it('passes the package name into the ledger identity', () => {
    expect(publishPackages).toContain('--package "$name"');
  });
});

describe('the shared commit-back script (MED-2)', () => {
  it('authenticates with the ephemeral token and never a persisted credential', () => {
    expect(commitScript).toContain("'http.https://github.com/.extraheader'");
    expect(commitScript).toContain('GIT_CONFIG_COUNT');
    expect(commitScript).toContain("'push', '--no-verify', REMOTE");
    expect(commitScript).toMatch(/HEAD:refs\/heads\/\$\{BRANCH\}/);
    // No credential is ever embedded in a URL (the rolling-tag advance's
    // shape); auth is an AUTHORIZATION header built in-process.
    expect(commitScript).not.toMatch(/https:\/\/x-access-token/);
    expect(commitScript).not.toMatch(/git\s+config\b.*(token|auth)/i);
    expect(commitScript).not.toMatch(/\bset\s+-x\b/);
  });

  it('implements bounded re-derive-and-retry with a stated safety basis', () => {
    expect(commitScript).toContain('LEDGER_COMMIT_MAX_ATTEMPTS = 3');
    // Every attempt re-derives from freshly fetched main, and the ledger
    // commit is created ON origin/main (checkout --detach) so there is no
    // rebase to conflict — a race can only reject the push, which the
    // bounded retry then handles.
    expect(commitScript).toMatch(/'checkout', '--detach'/);
    expect(commitScript).toMatch(/'fetch', REMOTE, BRANCH/);
    expect(commitScript).not.toMatch(/'rebase'/);
    expect(commitScript).toMatch(/refuses a true duplicate/);
    // Retry exhaustion fails loud and names the artifact fallback.
    expect(commitScript).toMatch(/could not commit the deploy ledger back/);
    expect(commitScript).toMatch(/Retain this run's deploy ledger files/);
  });

  it('guards required-ancestor before any commit or push', () => {
    expect(commitScript).toMatch(/'merge-base', '--is-ancestor'/);
    expect(commitScript).toMatch(/not an ancestor/);
    expect(commitScript).toMatch(/off.main|off-main/);
  });

  it('has replaced the per-workflow inline commit shells entirely', () => {
    for (const [name, workflow] of [
      ['nightly.yml', nightly],
      ['publish-release.yml', publishRelease],
      ['publish-packages.yml', publishPackages],
    ] as const) {
      expect(workflow, name).not.toContain(`name: ${OLD_INLINE_COMMIT_STEP}`);
      expect(workflow, name).not.toContain('ledger_git()');
      expect(workflow, name).not.toContain('unset -f ledger_git');
    }
  });
});
