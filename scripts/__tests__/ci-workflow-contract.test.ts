import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// The gate declares the reviewed capacity-action commit; this test reads it
// rather than restating it. When those were two literals they drifted (#3443
// moved this one and left the gate's behind, taking `main` red).
import { REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA } from '../actionlint-gate.mjs';
import {
  resolveAndroidBuildRun,
  sanitizeLookupDiagnostic,
  validateAndroidBuildRun,
} from '../resolve-android-build-run.mjs';

const root = resolve(import.meta.dirname, '../..');

function workflow(name: string) {
  return readFileSync(resolve(root, '.github/workflows', name), 'utf8');
}

/**
 * station#3579: extracts the concatenated bodies of every YAML `run:` step
 * within `yamlSource` — both bare single-line `run: <command>` forms and
 * `run: |` block-scalar forms — after first dropping every `#`-prefixed
 * comment line. Comments and `run:` bodies are otherwise textually
 * indistinguishable to a raw `.toContain`/`.not.toContain` check on a whole
 * workflow file, which cuts both ways:
 *
 * - A `not.toContain('run: <command>')` check only matches a literal
 *   `run: ` prefix, so a regression that re-adds the forbidden command
 *   *inside* a `run: |` block scalar's body (which carries no per-line
 *   `run: ` prefix) slips through silently.
 * - A bare-string `not.toContain('<command>')` check (dropping that prefix
 *   to close the gap above) instead risks reddening a CORRECT tree the
 *   moment a comment explains the constant by name in plain prose, since
 *   the comment's text is otherwise indistinguishable from executed shell.
 *
 * Asserting over this extraction closes both: a bare-command match is
 * strengthened (block-scalar-proof) without becoming comment-sensitive
 * (comment-proof), because comment lines never reach the extracted text at
 * all.
 *
 * This is a line-oriented approximation of the `run:` mapping key, not a
 * YAML parser — verified line-for-line against a real YAML parser (pyyaml)
 * across all 22 checked-in workflows (0 under-extracted, 0 over-extracted
 * on the corpus as it exists today), but its known failure modes matter
 * for what a FUTURE workflow edit could defeat:
 *
 * `run: |`, `run: >`, and their explicit chomping-indicator forms
 * (`run: |-`, `run: |2`, `run: >-`, ...) are all recognized as block
 * scalars (anything starting with `|` or `>`) and collect the following
 * more-indented block until the first blank or dedented line (GitHub
 * Actions' own scalar-block rule); `run: <inline command>` takes the rest
 * of the line; both forms may be preceded by a `- ` sequence-item marker
 * (the `- run: <cmd>` shorthand for a step with no separate `name:` key,
 * used throughout these workflows).
 *
 * Two genuine UNDER-extraction gaps exist, neither present in this repo's
 * workflows today (grepped), and under-extraction is the dangerous
 * direction for a `not.toContain` assertion — a command in a form this
 * helper misses is invisible to every negative check built on it:
 *
 * - `run:` with its value entirely on the FOLLOWING line, no `|`/`>`
 *   indicator (a valid plain-scalar YAML form) — `trimmedRest` is empty,
 *   which does not start with `|`/`>`, so the inline branch runs and
 *   pushes an empty string; the step contributes NOTHING to the extracted
 *   text.
 * - A quoted flow scalar spanning multiple lines (`run: "cmd &&\n  cmd2"`)
 *   — only the first source line is captured; continuation lines are
 *   never visited because block-scalar collection never triggers.
 *
 * A known OVER-extraction gap, also unexercised today: `keyIndent` is the
 * indentation of the `run:` KEY LINE (including a leading `- ` marker's own
 * column, not the column immediately after it), so a `- run: |` shorthand
 * swallows any sibling `env:`/`with:` key written at that same line's
 * indentation, since such a sibling is still more-indented than
 * `keyIndent`. Only step-body-shaped YAML (a `run:` key with siblings
 * indented further than the marker line) exists in this repo's workflows,
 * so this has not manifested — but a future edit combining `- run: |`
 * shorthand with a sibling key at the marker's own column would have its
 * sibling silently absorbed into the extracted "shell" text.
 */
function extractRunBodies(yamlSource: string): string {
  const lines = yamlSource.split('\n').filter((line) => !/^\s*#/.test(line));
  const bodies: string[] = [];
  const runKeyPattern = /^(\s*)(?:- )?run:(\s*)(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const match = runKeyPattern.exec(lines[i]);
    if (!match) continue;
    const [, indent, , rest] = match;
    const trimmedRest = rest.trim();
    if (trimmedRest.startsWith('|') || trimmedRest.startsWith('>')) {
      const keyIndent = indent.length;
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j];
        if (line.trim() === '') {
          bodies.push('');
          j++;
          continue;
        }
        const lineIndent = /^(\s*)/.exec(line)?.[1].length ?? 0;
        if (lineIndent <= keyIndent) break;
        bodies.push(line);
        j++;
      }
      i = j - 1;
    } else {
      bodies.push(trimmedRest);
    }
  }
  return bodies.join('\n');
}

const coordinatedArtifactPaths = [
  '.kontourai/verification-receipts/',
  '.kontourai/verification-output/',
];

const androidRunUrl =
  'https://api.github.com/repos/kontourai/station/actions/runs/123';
const encoder = new TextEncoder();

function androidBuildRun(overrides = {}) {
  return {
    id: 123,
    head_sha: 'a'.repeat(40),
    conclusion: 'success',
    path: '.github/workflows/build-android.yml',
    event: 'push',
    head_branch: 'main',
    head_repository: { full_name: 'kontourai/station' },
    ...overrides,
  };
}

function apiResponse({
  body = JSON.stringify(androidBuildRun()),
  bodyReadError,
  headers = {},
  keepOpen = false,
  onCancel,
  redirected = false,
  status = 200,
  statusText = 'OK',
  url = androidRunUrl,
}: {
  body?: string | Uint8Array[];
  bodyReadError?: unknown;
  headers?: Record<string, string>;
  keepOpen?: boolean;
  onCancel?: () => void;
  redirected?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
} = {}) {
  const chunks = typeof body === 'string' ? [encoder.encode(body)] : body;
  const contentLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (bodyReadError) controller.error(bodyReadError);
        else if (!keepOpen) controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    headers: new Headers({
      'content-length': String(contentLength),
      ...headers,
    }),
    ok: status >= 200 && status < 300,
    redirected,
    status,
    statusText,
    url,
  } as Response;
}

function resolverInput(overrides = {}) {
  return {
    appendFile: vi.fn(),
    env: { GH_TOKEN: 'test-token' },
    fetchImpl: async () => apiResponse(),
    outputPath: 'unused',
    repository: 'kontourai/station',
    runId: '123',
    ...overrides,
  };
}

describe('CI verification workflow contracts', () => {
  it('keeps always-on secret scanning independent from heavy CI concurrency', () => {
    const ci = workflow('ci.yml');
    const secretScan = workflow('secret-scan.yml');

    expect(secretScan).toMatch(/^name: Secret Scan$/m);
    expect(secretScan).toContain('    name: Secret Scan');
    expect(secretScan).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    expect(secretScan).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(secretScan).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(secretScan).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(secretScan).toContain('cancel-in-progress: true');
    expect(secretScan).toContain(
      'secret-scan.yml@02f40a67901a79ce4004c44d91e350b93782644c',
    );
    expect(secretScan).toContain('runner: \'"ubuntu-22.04"\'');
    expect(secretScan).not.toContain('capacity-coordination-root:');
    expect(secretScan).not.toContain('capacity-host-id:');
    expect(secretScan).toContain(
      `group: station-secret-scan-\${{ github.ref }}`,
    );
    expect(secretScan).not.toContain('group: ci-');
    expect(secretScan).not.toContain('group: container-smoke-');
    expect(ci).not.toContain('paths-ignore:');
    expect(ci).toContain('Exact full-diff classification');
    expect(ci).toContain('needs.classify.outputs.heavy');
    expect(ci).not.toContain('  secret-scan:');
  });

  it('classifies the complete push diff before entering independent heavy concurrency groups', () => {
    const ci = workflow('ci.yml');
    const containerSmoke = workflow('container-smoke.yml');

    for (const source of [ci, containerSmoke]) {
      expect(source).toContain('push:');
      expect(source).toContain('branches: [main]');
      expect(source).not.toContain('paths-ignore:');
      expect(source).toContain('Exact full-diff classification');
      expect(source).toContain('fetch-depth: 0');
      expect(source).toContain('scripts/classify-ci-change.mjs');
      expect(source).toContain('workflow_dispatch:');
    }
    expect(ci).toContain('runs-on: ubuntu-22.04');
    expect(ci).not.toContain('runs-on: [self-hosted, Linux');
    const containerClassify = containerSmoke.slice(
      containerSmoke.indexOf('  classify:'),
      containerSmoke.indexOf('  smoke:'),
    );
    expect(containerClassify).toContain('runs-on: ubuntu-22.04');
    expect(containerClassify).not.toContain('self-hosted');
    expect(ci).toContain(
      `group: ci-fast-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}`,
    );
    expect(ci).toContain(
      `group: ci-full-regression-\${{ github.event_name }}-\${{ github.ref }}`,
    );
    expect(ci).toContain(
      `group: ci-browser-smoke-\${{ github.event_name }}-\${{ github.ref }}`,
    );
    expect(containerSmoke).toContain(
      `group: container-smoke-\${{ github.ref }}`,
    );
    expect(ci).not.toMatch(/^concurrency:/m);
    expect(containerSmoke).not.toMatch(/^concurrency:/m);
  });

  it('pins remaining desktop-win capacity leases to a bounded shared lifetime', () => {
    const reviewedSha = REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA;
    const performance = workflow('interactive-workspace-performance.yml');
    expect(
      performance.match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(3);
    expect(performance.match(/owner-lifetime-seconds: "7800"/g)).toHaveLength(
      3,
    );
    expect(
      workflow('windows-verification.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(1);
    expect(
      workflow('windows-vitest-diagnostic.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(1);
    expect(
      workflow('container-smoke.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(1);
    expect(
      workflow('ci-extended.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(2);
    expect(
      workflow('nightly-gallery.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(1);

    for (const name of [
      'android-test.yml',
      'build-android.yml',
      'ci.yml',
      'nightly.yml',
      'publish-packages.yml',
      'backlog-priority-policy.yml',
    ]) {
      expect(workflow(name), name).not.toContain('physical-host-capacity@');
    }

    const android = workflow('android-test.yml');
    const resolveBuild = android.slice(
      android.indexOf('  resolve-build:'),
      android.indexOf('  mobile-playwright:'),
    );
    const emulatorSmoke = android.slice(android.indexOf('  emulator-smoke:'));
    expect(resolveBuild).toContain('timeout-minutes: 90');
    expect(emulatorSmoke).toContain('timeout-minutes: 90');
  });

  it('keeps CI Extended as the weekly and manual full-browser surface without rerunning ci:fast', () => {
    const ci = workflow('ci.yml');
    const extended = workflow('ci-extended.yml');
    const coverage = extended.slice(
      extended.indexOf('  coverage:'),
      extended.indexOf('  playwright-full:'),
    );
    const playwrightFull = extended.slice(
      extended.indexOf('  playwright-full:'),
    );

    expect(ci).not.toContain('playwright-full:');
    expect(ci).toContain('browser-smoke:');
    expect(extended).toContain('coverage:');
    expect(extended).toContain('playwright-full:');
    expect(extended).not.toContain('run: npm run ci:extended');
    expect(extended).not.toContain('run: npm run ci:fast');
    expect(extended).toContain('run: npm run test:coverage');
    expect(extended).toContain('run: npm run verify:e2e:full');
    expect(extended).toContain("- cron: '30 11 * * 6'");
    expect(extended).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(coverage).toContain('needs: playwright-full');
    expect(coverage).toContain(
      "always() && !cancelled() && github.event_name != 'pull_request'",
    );
    expect(playwrightFull).not.toContain('needs: coverage');
    expect(coverage).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host]',
    );
    expect(playwrightFull).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, playwright]',
    );
    for (const job of [coverage, playwrightFull]) {
      expect(job).toContain("github.event_name != 'pull_request'");
      expect(job).toContain('runner-preflight@');
      expect(job).toContain('physical-host-capacity@');
      expect(job).toContain('owner-lifetime-seconds: "7800"');
    }
  });

  it('runs only the exact screenshot bucket nightly and fails on baseline drift (#518, #875)', () => {
    const gallery = workflow('nightly-gallery.yml');
    const runBodies = extractRunBodies(gallery);

    expect(gallery).toMatch(/^name: Nightly gallery$/m);
    expect(gallery).toContain("- cron: '30 7 * * *'");
    expect(gallery).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(gallery).toContain(`group: nightly-gallery-\${{ github.ref }}`);
    expect(gallery).toContain('cancel-in-progress: true');
    expect(gallery).toContain("if: github.event_name != 'pull_request'");
    expect(gallery).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, playwright]',
    );
    expect(gallery).toContain('runner-preflight@');
    expect(gallery).toContain('physical-host-capacity@');
    expect(gallery).toContain('lease-weight: "5"');
    expect(gallery).toContain('owner-lifetime-seconds: "7800"');
    expect(runBodies).toContain(
      'node scripts/run-e2e-coverage.mjs --only=screenshot',
    );
    expect(runBodies).toContain('npm run screenshot:diff');
    expect(runBodies.indexOf('--only=screenshot')).toBeLessThan(
      runBodies.indexOf('npm run screenshot:diff'),
    );
    expect(runBodies).not.toContain('npm run verify:e2e:full');
    expect(runBodies).not.toContain('npm run test:coverage');
    expect(gallery).toContain('name: Upload gallery and pixel diffs');
    expect(gallery).toContain('if: always()');
    expect(gallery).toContain('continue-on-error: true');
    expect(gallery).toContain('gallery/');
    expect(gallery).toContain('gallery/diffs/');
  });

  it('runs browser smoke only after the full completion gate releases capacity', () => {
    const ci = workflow('ci.yml');
    const browserSmoke = ci.slice(ci.indexOf('  browser-smoke:'));

    expect(browserSmoke).toContain('needs: [classify, full-regression]');
    expect(browserSmoke).toContain(
      "if: github.event_name != 'pull_request_target'",
    );
    expect(browserSmoke).toContain(
      'Start browser smoke only after the completion gate',
    );
    expect(browserSmoke).toContain(
      'GitHub skips failed dependencies by default',
    );
  });

  it('keeps fast feedback bounded and composes the full merge gate separately', () => {
    const ci = workflow('ci.yml');
    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  fork-smoke:'),
    );
    const fullRegression = ci.slice(
      ci.indexOf('  full-regression:'),
      ci.indexOf('  browser-smoke:'),
    );

    expect(fastChecks).toContain('timeout-minutes: 45');
    expect(fastChecks).toContain('timeout-minutes: 20');
    expect(fastChecks).toContain('run: npm run ci:fast');
    expect(fastChecks).toContain("needs.classify.outputs.heavy == 'true'");
    expect(fastChecks).toContain('runs-on: ubuntu-22.04');
    expect(fastChecks).not.toContain('self-hosted');
    expect(fastChecks).not.toContain('physical-host-capacity@');
    expect(fastChecks).toContain('STATION_CI_FAST_BASE');
    expect(fastChecks).toContain('run: npm run ci:fast');
    expect(fastChecks).toContain('name: Enforce candidate UI bundle budget');
    expect(fastChecks).toContain(
      'run: npm run build:connect && npm run build:ui',
    );
    expect(fastChecks.indexOf('run: npm run ci:fast')).toBeLessThan(
      fastChecks.indexOf('name: Enforce candidate UI bundle budget'),
    );
    expect(
      fastChecks.indexOf('name: Enforce candidate UI bundle budget'),
    ).toBeLessThan(
      fastChecks.indexOf('name: Upload bounded fast-feedback diagnostics'),
    );
    expect(fastChecks).not.toContain('run: npm run full:regression');
    expect(fastChecks).not.toContain('test:connected-agents');

    expect(fullRegression).toContain('needs: [classify, fast-checks]');
    expect(fullRegression).toMatch(
      /if: \$\{\{ always\(\) && !cancelled\(\) && github\.event_name != 'pull_request_target' && github\.event_name == 'workflow_dispatch' \}\}/,
    );
    expect(fullRegression).not.toContain(
      "needs.classify.outputs.heavy == 'true'",
    );
    expect(fullRegression).toContain('timeout-minutes: 90');
    expect(fullRegression).toContain('runs-on: ubuntu-22.04');
    expect(fullRegression).not.toContain('self-hosted');
    expect(fullRegression).not.toContain('physical-host-capacity@');
    const desktopWinLeaseWeights = [
      'interactive-workspace-performance.yml',
      'windows-verification.yml',
      'windows-vitest-diagnostic.yml',
      'container-smoke.yml',
    ].flatMap((name) =>
      [...workflow(name).matchAll(/^\s+lease-weight: ["']?(\d+)["']?$/gm)].map(
        ([, weight]) => Number(weight),
      ),
    );
    expect(desktopWinLeaseWeights).toEqual([6, 6, 6, 5, 9, 9]);
    expect(Math.max(...desktopWinLeaseWeights)).toBeLessThanOrEqual(9);
    expect(workflow('secret-scan.yml')).not.toContain('capacity-lease-weight:');
    expect(fullRegression).toContain('run: npm run full:regression');
    expect(fullRegression).toContain('run: npm run test:connected-agents');
  });

  it('validates pull-request titles from exact base policy before either candidate checkout', () => {
    const ci = workflow('ci.yml');
    const trigger = ci.slice(
      ci.indexOf('  pull_request_target:'),
      ci.indexOf('  workflow_dispatch:'),
    );
    expect(trigger).toContain('types: [opened, synchronize, reopened, edited]');

    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  fork-smoke:'),
    );
    const forkSmoke = ci.slice(
      ci.indexOf('  fork-smoke:'),
      ci.indexOf('  full-regression:'),
    );
    for (const [job, candidateRepository, conditional] of [
      [
        fastChecks,
        `repository: \${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name || github.repository }}`,
        `if: \${{ github.event_name == 'pull_request_target' }}`,
      ],
      [
        forkSmoke,
        `repository: \${{ github.event.pull_request.head.repo.full_name }}`,
        undefined,
      ],
    ] as const) {
      const baseCheckout = job.indexOf(
        'name: Check out base policy for pull-request title gate',
      );
      const titleGate = job.indexOf(
        'name: Validate base-controlled pull-request title',
      );
      const candidateCheckout = job.indexOf(candidateRepository);
      expect(baseCheckout).toBeGreaterThan(-1);
      expect(titleGate).toBeGreaterThan(baseCheckout);
      expect(candidateCheckout).toBeGreaterThan(titleGate);
      expect(job).toContain(`repository: \${{ github.repository }}`);
      expect(job).toContain(`ref: \${{ github.event.pull_request.base.sha }}`);
      expect(job).toContain(
        `PULL_REQUEST_TITLE: \${{ github.event.pull_request.title }}`,
      );
      expect(job).toContain(
        `PULL_REQUEST_NUMBER: \${{ github.event.pull_request.number }}`,
      );
      expect(job).toContain(
        'node scripts/commit-message-gate.mjs --pull-request-title "$PULL_REQUEST_TITLE" "$PULL_REQUEST_NUMBER"',
      );
      if (conditional) expect(job).toContain(conditional);
    }
  });

  it('keeps coordinated lane receipts and failure artifacts downloadable', () => {
    for (const name of [
      'ci.yml',
      'ci-extended.yml',
      'windows-verification.yml',
    ]) {
      const source = workflow(name);
      expect(source, name).toContain('if: always()');
      expect(source, name).toContain('if-no-files-found: ignore');
      expect(source, name).not.toContain('actions/cache');
      for (const artifactPath of coordinatedArtifactPaths)
        expect(source, name).toContain(artifactPath);
    }

    const extended = workflow('ci-extended.yml');
    const playwrightUpload = extended.slice(
      extended.indexOf(
        '      - name: Upload Playwright verification diagnostics',
      ),
    );
    expect(extended).toContain('coverage/');
    expect(extended).toContain('playwright-report/');
    expect(extended).toContain('test-results/');
    expect(extended).toContain('.kontourai/e2e-latest/');
    expect(playwrightUpload).toMatch(
      /name: Upload Playwright verification diagnostics\n\s+if: always\(\)\n\s+uses: actions\/upload-artifact@/,
    );
    expect(playwrightUpload).toContain('.kontourai/e2e-latest/');
  });

  it('installs Playwright browsers to $HOME, not node_modules, in every job npm run dependencies:ci would otherwise wipe (station#3517, station#3555)', () => {
    const envExport =
      'echo "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright" >> "$GITHUB_ENV"';
    const inNodeModulesPathZero = /PLAYWRIGHT_BROWSERS_PATH=0/;

    const ci = workflow('ci.yml');
    const fullRegression = ci.slice(
      ci.indexOf('  full-regression:'),
      ci.indexOf('  browser-smoke:'),
    );
    const browserSmoke = ci.slice(ci.indexOf('  browser-smoke:'));
    const extended = workflow('ci-extended.yml');
    const coverage = extended.slice(
      extended.indexOf('  coverage:'),
      extended.indexOf('  playwright-full:'),
    );
    const playwrightFull = extended.slice(
      extended.indexOf('  playwright-full:'),
    );

    // `npm run dependencies:ci` deletes and reinstalls all of `node_modules`, taking
    // `node_modules/playwright-core/.local-browsers` with it — but never
    // touches `$HOME`. Both jobs below export `PLAYWRIGHT_BROWSERS_PATH` to
    // a `$HOME`-rooted path job-wide (via `$GITHUB_ENV`) and call
    // `playwright install` directly, never through `npm run
    // install:playwright[:ci]` — those scripts hardcode
    // `PLAYWRIGHT_BROWSERS_PATH=0` (in-node_modules) as a package.json
    // prefix, which would silently override the exported path.
    for (const [job, name, installLine] of [
      [fullRegression, 'full-regression', 'npx playwright install chromium'],
      [
        playwrightFull,
        'playwright-full',
        'npx playwright install chromium --with-deps',
      ],
    ] as const) {
      const jobRunBody = extractRunBodies(job);
      // Both jobs' install steps are `run: |` block scalars — proven by
      // this non-vacuous check (station#3579: comment-stripping must not
      // reduce the asserted-over text to something that would pass any
      // negative check regardless of content).
      expect(jobRunBody, name).toContain(installLine);
      // station#3579 review round MEDIUM-1: this positive `envExport` check
      // stayed on raw `job` text only, so commenting out the REAL export
      // line inside the `run: |` block (the exact regression this test's
      // headline claims to guard) left it — and the ordering assertion
      // below it, which then compared against the comment's offset — both
      // green, because the substring survives as a shell comment. Checking
      // the extracted run body closes it the same way LOW-A/LOW-B did.
      expect(jobRunBody, name).toContain(envExport);
      expect(job, name).toContain(envExport);
      expect(job, name).toContain(installLine);
      // Dropped the `run: ` prefix and moved to the extracted run-body text
      // (station#3579 LOW-A): the old prefixed check on raw file text never
      // saw a regression re-added *inside* this block scalar's body (no
      // per-line `run: ` prefix there), and the bare string now also
      // appears in this file's own explanatory comments — asserting over
      // comment-stripped run bodies instead catches the block-scalar case
      // without being defeated by, or reddening on, prose.
      expect(jobRunBody, name).not.toContain('npm run install:playwright');
      // station#3579 LOW-B: same move for the raw-path literal — a future
      // author explaining the constant in plain prose must not red this.
      expect(jobRunBody, name).not.toMatch(inNodeModulesPathZero);
      // Exported before installed — an install that runs before the
      // export would read whatever PLAYWRIGHT_BROWSERS_PATH the job
      // already had (unset, defaulting every downstream reader to '0').
      // Asserted over the run body now that both operands are proven
      // present there (immediately above), not raw `job` text.
      expect(jobRunBody.indexOf(envExport), name).toBeLessThan(
        jobRunBody.indexOf(installLine),
      );
      // Installed after npm run dependencies:ci — installing before it would place browsers
      // under a still-to-be-wiped `node_modules` state on a first-ever
      // checkout, and more importantly would run before `npm run dependencies:ci` puts the
      // `playwright` CLI on disk for `npx` to find.
      //
      // station#3579 review round MEDIUM-2: `job.indexOf('run: npm run dependencies:ci')`
      // returns -1 when the string is absent (e.g. `npm run dependencies:ci` moved into a
      // `run: |` block scalar, or reordered after the install step), and
      // `expect(-1).toBeLessThan(N)` is vacuously true — the exact
      // regression this line exists to catch would pass. Pinned as its own
      // non-vacuous presence check first, then compared on the run body.
      const npmCiIndex = jobRunBody.indexOf('npm run dependencies:ci');
      expect(npmCiIndex, name).toBeGreaterThanOrEqual(0);
      expect(npmCiIndex, name).toBeLessThan(jobRunBody.indexOf(envExport));
    }

    // browser-smoke already used this convention before this change and is
    // unaffected by it — asserted here so a future edit that regresses it
    // back toward node_modules is caught by the same test.
    const browserSmokeRunBody = extractRunBodies(browserSmoke);
    expect(browserSmokeRunBody).toContain(envExport);
    expect(browserSmoke).toContain(envExport);
    expect(browserSmokeRunBody).not.toMatch(inNodeModulesPathZero);
    // coverage (ci-extended.yml) installs no browsers at all. Its run
    // bodies are non-empty (`npm run dependencies:ci`, `npm run test:coverage`) so this
    // absence check has something real to check against, not a body
    // emptied by comment-stripping.
    const coverageRunBody = extractRunBodies(coverage);
    expect(coverageRunBody).toContain('npm run dependencies:ci');
    expect(coverageRunBody).not.toContain('playwright install');
    expect(coverageRunBody).not.toMatch(inNodeModulesPathZero);
  });

  it('checks out enough history for exact Veritas PR evidence', () => {
    const ci = workflow('ci.yml');
    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  browser-smoke:'),
    );

    expect(fastChecks).toContain('fetch-depth: 0');
    expect(fastChecks).toContain('--changed-from "$BASE_REF"');
    expect(fastChecks).toContain('--changed-to "$HEAD_REF"');
    expect(fastChecks).toContain('run: npm run test:connected-agents');
    expect(ci).not.toContain('  connected-agents:');
  });

  it('runs Android viewport coverage through the public isolated suite', () => {
    const android = workflow('android-test.yml');
    const resolver = readFileSync(
      resolve(root, 'scripts/resolve-android-build-run.mjs'),
      'utf8',
    );

    expect(
      android.match(
        /ref: \$\{\{ needs\.resolve-build\.outputs\.head_sha \}\}/g,
      ),
    ).toHaveLength(2);
    expect(android).toContain('run_id:');
    expect(android).toContain('required: true');
    expect(android).toContain('Resolve exact build revision');
    expect(android).toContain('node scripts/resolve-android-build-run.mjs');
    expect(resolver).toContain('.github/workflows/build-android.yml');
    expect(resolver).toContain('fetchImpl = fetch');
    expect(resolver).toContain("redirect: 'error'");
    expect(resolver).not.toContain("from 'node:child_process'");
    expect(resolver).not.toContain('spawnSync(');
    expect(resolver).not.toContain('response.json()');
    expect(resolver).not.toContain('response.text()');
    expect(android).toContain('persist-credentials: false');
    expect(android).not.toContain(
      'github.event.workflow_run.head_sha || github.sha',
    );
    // station#3579: moved from a raw-file `toContain` to the extracted
    // run-body text — the file already asserts this exact verbatim shell
    // line, and a raw-text positive check has the mirror-image risk of the
    // negative checks fixed above: a comment merely *mentioning* the
    // literal would satisfy it too, without the real command being present
    // at all. Checking the run body instead proves it's actually executed
    // shell.
    expect(extractRunBodies(android)).toContain(
      'PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"',
    );
    expect(android).toContain('runs-on: ubuntu-22.04');
    expect(android).not.toContain('self-hosted');
    expect(android).toContain('reactivecircus/android-emulator-runner@');
    expect(android).toContain('run: npm run test:android');
    expect(android).not.toContain('npx vite preview');
    expect(android).not.toContain('npx playwright test --project=android');
    expect(android).toContain('test-results/');
  });

  it('keeps Linux CI on GitHub-hosted runners and desktop-win for hardware reference', () => {
    const linuxWorkflows = [
      'ci.yml',
      'android-test.yml',
      'build-android.yml',
      'secret-scan.yml',
      'nightly.yml',
      'publish-packages.yml',
      'backlog-priority-policy.yml',
    ];
    for (const name of linuxWorkflows) {
      const source = workflow(name);
      expect(source, name).not.toContain('runs-on: [self-hosted, Linux');
      expect(source, name).not.toMatch(/runs-on:.*fast-feedback/);
    }

    const performance = workflow('interactive-workspace-performance.yml');
    expect(performance).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(workflow('windows-verification.yml')).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(workflow('container-smoke.yml')).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, docker, playwright]',
    );
    expect(workflow('ci-extended.yml')).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, playwright]',
    );
    expect(workflow('nightly-gallery.yml')).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, playwright]',
    );
    const recovery = workflow('recover-terminal-capacity-owner.yml');
    expect(recovery).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host]',
    );
    expect(recovery).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
  });

  it('accepts only trusted same-repository main Android build runs', () => {
    const valid = androidBuildRun();
    expect(validateAndroidBuildRun(valid, 'kontourai/station')).toEqual({
      headSha: valid.head_sha,
      runId: '123',
      conclusion: 'success',
    });

    for (const untrusted of [
      { ...valid, event: 'pull_request' },
      {
        ...valid,
        head_repository: { full_name: 'attacker/station' },
      },
      { ...valid, head_branch: 'feature/untrusted' },
    ]) {
      expect(() =>
        validateAndroidBuildRun(untrusted, 'kontourai/station'),
      ).toThrow();
    }
  });

  it('resolves an exact Android build through authenticated REST without gh', async () => {
    const run = androidBuildRun();
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe(androidRunUrl);
        expect(init?.headers).toMatchObject({
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer test-token',
          'X-GitHub-Api-Version': '2022-11-28',
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.redirect).toBe('error');
        return apiResponse({ body: JSON.stringify(run) });
      },
    );
    const appendFile = vi.fn();

    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl,
        }),
      ),
    ).resolves.toEqual({
      headSha: run.head_sha,
      runId: '123',
      conclusion: 'success',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(appendFile).toHaveBeenCalledWith(
      'unused',
      `head_sha=${run.head_sha}\nrun_id=123\nconclusion=success\n`,
    );
  });

  it('fails honestly when the authenticated run lookup returns an API error', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({
              body: JSON.stringify({ message: 'capacity exhausted' }),
              status: 503,
              statusText: 'Service Unavailable',
            }),
        }),
      ),
    ).rejects.toThrow(
      'GitHub run lookup failed with HTTP 503 Service Unavailable: capacity exhausted',
    );
    expect(appendFile).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP', 'http://api.github.com', 'GITHUB_API_URL must use HTTPS'],
    [
      'credentials',
      'https://user:pass@api.github.com',
      'GITHUB_API_URL must not include credentials',
    ],
    [
      'query',
      'https://api.github.com?redirect=elsewhere',
      'GITHUB_API_URL must not include a query string',
    ],
    [
      'fragment',
      'https://api.github.com#elsewhere',
      'GITHUB_API_URL must not include a fragment',
    ],
  ])(
    'rejects an unsafe %s API URL before fetching',
    async (_kind, apiUrl, message) => {
      const appendFile = vi.fn();
      const fetchImpl = vi.fn();
      await expect(
        resolveAndroidBuildRun(
          resolverInput({
            appendFile,
            env: { GH_TOKEN: 'test-token', GITHUB_API_URL: apiUrl },
            fetchImpl,
          }),
        ),
      ).rejects.toThrow(message);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(appendFile).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing token before fetching or exporting output', async () => {
    const appendFile = vi.fn();
    const fetchImpl = vi.fn();
    await expect(
      resolveAndroidBuildRun(resolverInput({ appendFile, env: {}, fetchImpl })),
    ).rejects.toThrow('GH_TOKEN is required');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects a redirected or cross-origin response before reading its body', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({ url: 'https://unexpected.example/actions/runs/123' }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup response URL did not match request');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects a response run ID that does not match the normalized request', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({ body: JSON.stringify(androidBuildRun({ id: 124 })) }),
          runId: '000123',
        }),
      ),
    ).rejects.toThrow(
      "selected Android build run ID '124' does not match requested run ID '123'",
    );
    expect(appendFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a declared oversized body',
      apiResponse({
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
    ],
    [
      'a streamed oversized body',
      apiResponse({
        body: [new Uint8Array(2 * 1024 * 1024), new Uint8Array(1)],
        headers: { 'content-length': '0' },
      }),
    ],
  ])('rejects %s without exporting output', async (_description, response) => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({ appendFile, fetchImpl: async () => response }),
      ),
    ).rejects.toThrow(
      'GitHub run lookup response body exceeds 2097152 byte limit',
    );
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('cancels a declared oversized response before acquiring a reader', async () => {
    const appendFile = vi.fn();
    const onCancel = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({
              headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
              keepOpen: true,
              onCancel,
            }),
        }),
      ),
    ).rejects.toThrow(
      'GitHub run lookup response body exceeds 2097152 byte limit',
    );
    expect(onCancel).toHaveBeenCalledOnce();
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('classifies an aborted body read as a timeout without leaking output', async () => {
    const appendFile = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          createAbortSignal: () => controller.signal,
          fetchImpl: async () =>
            apiResponse({ bodyReadError: new Error('body reader aborted') }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup body read timed out after 15000ms');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('classifies an AbortError from the body reader without leaking output', async () => {
    const appendFile = vi.fn();
    const abortError = new Error('request aborted');
    abortError.name = 'AbortError';
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () => apiResponse({ bodyReadError: abortError }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup body read aborted');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects malformed successful response schema without exporting output', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({
              body: JSON.stringify(androidBuildRun({ path: 'unexpected.yml' })),
            }),
        }),
      ),
    ).rejects.toThrow("selected run belongs to 'unexpected.yml'");
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects malformed successful JSON without exporting output', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () => apiResponse({ body: '{not json' }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup returned invalid JSON');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('renders token-safe, single-line diagnostics', () => {
    const token = 'secret-token';
    const diagnostic = sanitizeLookupDiagnostic(
      `lookup failed\n${token}\u0000${'x'.repeat(2_000)}`,
      token,
    );
    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).not.toContain(token);
    expect(diagnostic).not.toContain('\r');
    expect(diagnostic).not.toContain('\n');
    expect(diagnostic).not.toContain('\u0000');
    expect(diagnostic.length).toBeLessThanOrEqual(1_024);
  });

  it('provides the supported post-merge Windows fallback without pretending E2E is covered', () => {
    const windows = workflow('windows-verification.yml');

    expect(windows).toContain('workflow_dispatch:');
    expect(windows).toContain('push:');
    expect(windows).toContain('branches: [main]');
    expect(windows).not.toContain('pull_request:');
    expect(windows).toContain('paths:');
    expect(windows).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(windows).toContain('run: npm run verification:policy:gate');
    expect(windows).toContain('run: npm run typecheck');
    expect(windows).toContain('run: npm run test:windows:portable');
    expect(windows).toContain('no full Vitest/E2E');
    expect(windows).toContain('#1420');
    expect(windows).not.toContain('run: npm run test:full');
    expect(windows).not.toContain('verify:e2e:full');
    expect(windows).not.toContain('test:android');
  });

  it('runs the bounded Windows floor on every PR head from base-controlled hosted policy', () => {
    const windows = workflow('windows-pr-verification.yml');
    expect(windows).toContain('pull_request_target:');
    expect(windows).not.toContain('  pull_request:\n');
    expect(windows).toContain('branches: [main]');
    expect(windows).not.toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toContain('self-hosted');
    expect(windows).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the workflow's literal GitHub expression
      "repository: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name || github.repository }}",
    );
    expect(windows).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the workflow's literal GitHub expression
      "ref: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || github.sha }}",
    );
    expect(windows).toContain('run: npm run verification:policy:gate');
    expect(windows).toContain('run: npm run test:windows:portable');
    expect(windows).toContain('name: Compile desktop Rust tests');
    expect(windows).toContain(
      'cargo test --manifest-path src-desktop/Cargo.toml --no-run',
    );
    expect(windows).toContain('run: npm run typecheck');
  });

  it('keeps full Windows Vitest diagnostics complete, manual, and honestly red', () => {
    const diagnostic = workflow('windows-vitest-diagnostic.yml');

    expect(diagnostic).toMatch(/^name: Windows Full Vitest Diagnostic$/m);
    expect(diagnostic).toContain('workflow_dispatch:');
    expect(diagnostic).not.toContain('push:');
    expect(diagnostic).not.toContain('continue-on-error');
    expect(diagnostic).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(diagnostic).toContain('run: npm run test:windows:diagnostic');
    expect(diagnostic).toContain('if: always()');
    expect(diagnostic).toContain('.kontourai/windows-vitest/');
    expect(diagnostic).toContain('if-no-files-found: error');
  });

  it('keeps terminal capacity recovery manual, owner-scoped, and exact', () => {
    const recovery = workflow('recover-terminal-capacity-owner.yml');

    expect(recovery).toMatch(
      /^name: Recover terminal physical-host capacity owner$/m,
    );
    expect(recovery).toContain('workflow_dispatch:');
    expect(recovery).not.toContain('push:');
    expect(recovery).not.toContain('pull_request:');
    expect(recovery).toContain('actions: read');
    expect(recovery).toContain('contents: read');
    expect(recovery).toContain(
      'recover-terminal-capacity-owner@563effe7ec559c6f4fcc6c80b3532acb71d86373',
    );
    expect(recovery).toContain(
      'owner-repository: $' + '{{ github.repository }}',
    );
    expect(recovery).toContain('github-token: $' + '{{ github.token }}');
    expect(recovery).not.toContain('physical-host-capacity@');
    expect(recovery).toContain('cancel-in-progress: false');
  });
});

/**
 * The org's artifact retention default is 90 days. A ~169 MB debug APK per
 * push at that retention held 3.8 GB across 23 runs and filled the org's
 * storage quota, after which every upload step failed. Two properties keep
 * that from recurring, and neither is visible in a passing CI run — so pin
 * them here rather than rediscover them the next time uploads start failing
 * (station#2218).
 */
describe('artifact storage does not accumulate or gate verdicts', () => {
  it('bounds the debug APK, the largest recurring artifact', () => {
    const step =
      /name:\s*station-android-debug[\s\S]*?retention-days:\s*(\d+)/.exec(
        workflow('build-android.yml'),
      );
    expect(
      step,
      'the debug APK upload must declare a retention',
    ).not.toBeNull();
    expect(Number(step?.[1])).toBeLessThanOrEqual(14);
  });

  it.each([
    ['ci.yml', 'ci-fast-verification'],
    ['ci.yml', 'full-regression-verification'],
    ['ci-extended.yml', 'coverage-verification'],
    ['nightly-gallery.yml', 'nightly-gallery'],
  ])('%s: the %s diagnostic upload cannot fail its job', (file, artifact) => {
    // A diagnostic that cannot be stored is an infrastructure condition, not
    // a verdict on the code. Read backwards from the artifact name to the
    // step that uploads it, since `continue-on-error` sits above `with:`.
    const source = workflow(file);
    const at = source.indexOf(`name: ${artifact}`);
    expect(at, `${artifact} not found in ${file}`).toBeGreaterThan(-1);
    const stepStart = source.lastIndexOf('- name:', at);
    expect(source.slice(stepStart, at)).toContain('continue-on-error: true');
  });
});

/**
 * The Tauri CLI DISCOVERS a config when none is given, by walking the tree —
 * and `experiments/browser-host/*\/tauri.conf.json` sorts before
 * `src-desktop/`. Those spike configs declare `"version": "0.0.0"`, which the
 * Android packager rejects outright, so build-android produced no APK for four
 * days after the spike landed (station#2306). Nothing in the repo's own config
 * changed; a file added elsewhere silently captured every unpinned invocation.
 */
describe('every Tauri invocation is rooted at the app directory', () => {
  const DISCOVERY_EXPOSED = [
    'build-android.yml',
    'build-ios.yml',
    'nightly.yml',
    'release.yml',
  ];

  it.each(DISCOVERY_EXPOSED)(
    '%s runs tauri from src-desktop, not the repo root',
    (file) => {
      // --config supplies the config VALUES; the discovered directory still
      // supplies the app ROOT. Pinning only --config left `frontendDist:
      // ../dist-ui` resolving against experiments/browser-host/ (station#2306).
      const source = workflow(file);
      const steps = source
        .split(/\n {6}- /)
        .filter((step) => step.includes('npx tauri'));
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(
          step,
          `tauri step without an app-directory cwd in ${file}`,
        ).toContain('working-directory: src-desktop');
        expect(step).toContain('--config');
      }
    },
  );

  it('keeps the spike configs recognisable as the hazard they are', () => {
    // These are legitimate cargo spikes whose build.rs needs a config, so they
    // stay. That is exactly why the real lanes must never resolve by discovery.
    const spike = JSON.parse(
      readFileSync(
        resolve(
          root,
          'experiments/browser-host/tauri-child-webview/tauri.conf.json',
        ),
        'utf8',
      ),
    );
    expect(spike.version).toBe('0.0.0');
    expect(spike.build.frontendDist).toBe('../fixture');
  });
});

describe('iOS verification proves packaged runtime readiness', () => {
  const ios = workflow('build-ios.yml');

  it('uses the free public macOS 26 runner on affected pull requests', () => {
    expect(ios).toContain('pull_request_target:');
    expect(ios).toContain("- 'src-desktop/**'");
    expect(ios).toContain("- 'src-ui/**'");
    expect(ios).toContain('runs-on: macos-26');
    expect(ios).toContain('/Applications/Xcode_26.6.app/Contents/Developer');
    expect(ios).not.toContain('self-hosted');
    expect(ios).toContain('persist-credentials: false');
    expect(ios).toContain("github.event_name == 'pull_request_target'");
  });

  it('runs the native accessibility smoke and always retains its evidence', () => {
    expect(ios).toContain('npm run test:ios-runtime-smoke --');
    expect(ios).toContain('station-ios-simulator-runtime');
    const evidence = ios.indexOf('name: Upload iOS runtime evidence');
    expect(evidence).toBeGreaterThan(-1);
    expect(ios.slice(evidence - 120, evidence + 500)).toContain('if: always()');
  });
});

/**
 * Gradle's generated BuildTask.kt re-invokes the CLI as
 * `npm run -- tauri android android-studio-script`, and npm runs a script from
 * the package.json directory — the repo ROOT. From there the CLI discovers
 * `experiments/browser-host/*\/tauri.conf.json` and derived the experiment's
 * identifier, so it looked for a socket-address file named after the SPIKE and
 * aborted (station#2306):
 *
 *   failed to read missing addr file
 *   /tmp/io.kontour.station.browser-host-child-experiment-server-addr
 *
 * That file is generated into `src-desktop/gen/android` by `tauri android
 * init`, so the fix cannot live there — it would be overwritten. It lives in
 * the script npm actually runs.
 */
describe('the root tauri script roots itself at the app directory', () => {
  it('changes into src-desktop before invoking the CLI', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const script: string = pkg.scripts.tauri;
    expect(script).toMatch(/(^|\s|&&)cd\s+src-desktop(\s|$|&)/);
    expect(script).toContain('tauri');
  });

  it('is the invocation gradle actually uses', () => {
    // If the generated task stops calling `npm run`, this guard is protecting
    // a path nothing takes and should be revisited rather than trusted.
    const buildTask = readFileSync(
      resolve(
        root,
        'src-desktop/gen/android/buildSrc/src/main/java/io/kontourai/station/kotlin/BuildTask.kt',
      ),
      'utf8',
    );
    expect(buildTask).toContain('"run"');
    expect(buildTask).toContain('"tauri"');
  });
});
