import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  E2E_AUDIT_PATTERN,
  E2E_BUCKETS,
  E2E_INVALID_TEST_INFO_PATTERN,
  E2E_TARGET_AUDIT_PATTERN,
  E2E_VACUOUS_ASSERTION_PATTERN,
  e2eArtifactPathErrors,
  e2eManifest,
  FOREGROUND_RECEIPT_FIXTURE,
  foregroundReceiptFixtureErrors,
  getProductE2EExecutionPhases,
  getSpecsForSuite,
  listSpecFiles,
  PR_BROWSER_SMOKE_CONTRACT,
  PRODUCT_E2E_EXECUTION_PROFILE,
  validateE2EManifest,
} from '../../tests/e2e-manifest.mjs';
import {
  foregroundMessageReceipt,
  foregroundMessageReceiptEnvelope,
} from '../../tests/helpers/execution-receipt';
import { withValidatedNodePath } from '../lib/e2e-runner-options.mjs';

function isUiCrudSmoke(filePath: string) {
  return filePath.replaceAll('\\', '/').endsWith('tests/ui-crud-smoke.spec.ts');
}

describe('e2e manifest', () => {
  it('rejects spec-local API target resolution and reserved-port fallbacks', () => {
    expect(
      E2E_TARGET_AUDIT_PATTERN.test(
        "const api = process.env.PW_API_BASE_URL ?? 'http://localhost:3141';",
      ),
    ).toBe(true);
    expect(
      E2E_TARGET_AUDIT_PATTERN.test(
        "const port = process.env.STATION_PORT || '3141';",
      ),
    ).toBe(true);
    expect(
      E2E_TARGET_AUDIT_PATTERN.test("const API = 'http://127.0.0.1:3141';"),
    ).toBe(true);
    expect(E2E_AUDIT_PATTERN.test('await page.waitForTimeout(100);')).toBe(
      true,
    );
  });

  it('enforces safe API targets outside the product bucket', () => {
    const result = validateE2EManifest({
      rootDir: process.cwd(),
      readFile: (filePath) =>
        isUiCrudSmoke(filePath)
          ? "const API = 'http://localhost:3141';"
          : readFileSync(filePath, 'utf8'),
    });

    expect(result.errors).toContain(
      'tests/ui-crud-smoke.spec.ts has unsafe E2E target resolution.',
    );
  });

  it('rejects vacuous browser assertions in every bucket', () => {
    expect(E2E_VACUOUS_ASSERTION_PATTERN.test('expect(true).toBe(true)')).toBe(
      true,
    );
    const result = validateE2EManifest({
      rootDir: process.cwd(),
      readFile: (filePath) =>
        isUiCrudSmoke(filePath)
          ? 'expect(true).toBe(true);'
          : readFileSync(filePath, 'utf8'),
    });

    expect(result.errors).toContain(
      'tests/ui-crud-smoke.spec.ts contains a vacuous always-pass assertion.',
    );
  });

  it('rejects shared artifact paths and invalid testInfo fixture wiring', () => {
    expect(
      e2eArtifactPathErrors(
        'tests/fixture.spec.ts',
        "await page.screenshot({ path: '/tmp/shared.png' });",
      ),
    ).toHaveLength(1);
    for (const unsafe of [
      "page.screenshot({ path: join('test-results', 'shared.png') });",
      "const shared = 'test-results/shared.png'; page.screenshot({ path: shared });",
      "elementHandle.screenshot({ path: 'test-results/shared.png' });",
      'page.screenshot(options);',
      "const path = 'test-results/shared.png'; page.screenshot({ path });",
      "page.screenshot({ ['path']: 'test-results/shared.png' });",
      "page.screenshot({ [key]: 'test-results/shared.png' });",
      "page.screenshot({ get path() { return 'test-results/shared.png'; } });",
    ]) {
      expect(
        e2eArtifactPathErrors('tests/helpers/screenshot.ts', unsafe),
      ).toHaveLength(1);
    }
    expect(
      e2eArtifactPathErrors(
        'tests/fixture.spec.ts',
        "page.screenshot({ path: testInfo.outputPath('owned.png') });",
      ),
    ).toEqual([]);
    expect(
      E2E_INVALID_TEST_INFO_PATTERN.test(
        'async ({ page, testInfo }) => testInfo.outputPath("x")',
      ),
    ).toBe(true);
    const fixedPath = validateE2EManifest({
      rootDir: process.cwd(),
      readFile: (filePath) =>
        isUiCrudSmoke(filePath)
          ? "await page.screenshot({ path: 'test-results/shared.png' });"
          : readFileSync(filePath, 'utf8'),
    });
    expect(fixedPath.errors).toContain(
      'tests/ui-crud-smoke.spec.ts screenshot path must use testInfo.outputPath(...).',
    );
  });

  it('assigns every Playwright spec to exactly one bucket', () => {
    const result = validateE2EManifest({
      rootDir: process.cwd(),
      readFile: (filePath) => readFileSync(filePath, 'utf8'),
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(e2eManifest).toHaveLength(listSpecFiles().length);
  });

  it('keeps active product, smoke, extended, screenshot, and android buckets explicit', () => {
    const buckets = new Set(e2eManifest.map((entry) => entry.bucket));

    for (const bucket of E2E_BUCKETS.filter(
      (candidate) => candidate !== 'quarantine',
    )) {
      expect(buckets.has(bucket)).toBe(true);
    }
  });

  it('selects runner suites from manifest buckets', () => {
    expect(getSpecsForSuite('product')).toContain(
      'tests/project-lifecycle.spec.ts',
    );
    expect(getSpecsForSuite('smoke-live')).toEqual([
      'tests/agents-new-model-turn.spec.ts',
      'tests/paired-device-chat.spec.ts',
      'tests/pr-smoke-live-chat-send.spec.ts',
      'tests/agents-new-cli-turn.spec.ts',
      'tests/agents-new-muse-echo-turn.spec.ts',
      'tests/csp-shell.spec.ts',
      'tests/plugin-bundle-csp.spec.ts',
      'tests/bundled-plugin-registry-lifecycle.spec.ts',
      'tests/ui-crud-smoke.spec.ts',
      'tests/knowledge-onboarding-smoke.spec.ts',
      'tests/task-workspace.spec.ts',
      'tests/project-task-room-collaboration.spec.ts',
      'tests/interactive-workspace-performance-bridge.spec.ts',
    ]);
    expect(getSpecsForSuite('extended')).toContain('tests/settings.spec.ts');
    expect(getSpecsForSuite('starter-clean-install')).toEqual([
      'tests/starter-clean-install.spec.ts',
    ]);
    expect(getSpecsForSuite('screenshot')).toEqual([
      'tests/screenshots.spec.ts',
    ]);
  });

  it('classifies every product spec exactly once for bounded parallel execution', () => {
    const productSpecs = getSpecsForSuite('product');
    const classified = [
      ...PRODUCT_E2E_EXECUTION_PROFILE.parallelSafe,
      ...PRODUCT_E2E_EXECUTION_PROFILE.sharedInstanceExclusive,
    ];

    expect(PRODUCT_E2E_EXECUTION_PROFILE.parallelWorkers).toBe(2);
    expect(PRODUCT_E2E_EXECUTION_PROFILE.parallelSafetyExceptions).toEqual({
      'tests/sidebar-geometry.spec.ts': expect.any(String),
      'tests/mobile-dock-clearance.spec.ts': expect.any(String),
      'tests/flow-gate-verdicts.spec.ts': expect.any(String),
      'tests/cross-runtime-chat-switching.spec.ts': expect.any(String),
      'tests/daily-driver-scenarios.spec.ts': expect.any(String),
      'tests/daily-driver-switching.spec.ts': expect.any(String),
      // M3: read-only against the shared instance; its only write is the
      // browser context's own ambient dock document in localStorage.
      'tests/activity-pane.spec.ts': expect.any(String),
      // The picker also writes only its browser-local dock/config fixture;
      // retain exact enumeration of the already-reviewed manifest exception.
      'tests/dock-occupant-picker.spec.ts': expect.any(String),
    });
    expect(new Set(classified).size).toBe(classified.length);
    expect(new Set(classified)).toEqual(new Set(productSpecs));
    expect(PRODUCT_E2E_EXECUTION_PROFILE.sharedInstanceExclusive).toEqual([
      'tests/agents-readiness-board.spec.ts',
      // station#3843: seeds a live non-ready agent and opens a second browser
      // context holding the runner's own browser-session credential.
      'tests/paired-device-presentation.spec.ts',
      'tests/agents-copy-existing.spec.ts',
      'tests/agents-editor-roundtrip.spec.ts',
      'tests/skills-command-surface.spec.ts',
      'tests/mobile-surface-sweep.spec.ts',
      'tests/device-pairing-mobile.spec.ts',
      'tests/connection-lost-access-request.spec.ts',
      'tests/plugin-preview.spec.ts',
      'tests/plugin-rejection-visibility.spec.ts',
      'tests/workspace-search-exact-message.spec.ts',
      'tests/plugin-system.spec.ts',
      'tests/survey-review-workbench.spec.ts',
      'tests/fieldwork-review.spec.ts',
      'tests/plugin-dev-hot-reload.spec.ts',
      'tests/external-session-follow.spec.ts',
      'tests/builder-delivery-viewer.spec.ts',
      'tests/meeting-notes.spec.ts',
      'tests/knowledge-library.spec.ts',
      // Both mutate shared instance state through the real API rather than
      // isolating with `page.route` (station#3736/#3743 both hid behind a
      // mocked suite), so neither can share an instance with a sibling spec.
      'tests/agents-editor-gates.spec.ts',
      'tests/skills-command-routes.spec.ts',
      // UX audit D9/D8: both reset instance-wide state (the notification
      // store and attention acknowledgements; two fixed project slugs).
      'tests/notifications-attention.spec.ts',
      'tests/board-visibility.spec.ts',
      // Creates and revision-checks a real personal Board through the shared
      // instance API, so it cannot run beside another stateful product spec.
      'tests/work-board.spec.ts',
    ]);
  });

  it('partitions focused product selections without losing manifest order', () => {
    expect(
      getProductE2EExecutionPhases([
        'tests/plugin-system.spec.ts',
        'tests/task-first-home.spec.ts',
        'tests/command-palette.spec.ts',
      ]),
    ).toEqual([
      {
        name: 'parallel-safe',
        workers: 2,
        specs: [
          'tests/command-palette.spec.ts',
          'tests/task-first-home.spec.ts',
        ],
      },
      {
        name: 'shared-instance-exclusive',
        workers: 1,
        specs: ['tests/plugin-system.spec.ts'],
      },
    ]);
  });

  it('keeps the PR browser-smoke contract bounded and explicit', () => {
    expect(PR_BROWSER_SMOKE_CONTRACT).toMatchObject({
      budgetMinutes: 10,
      workers: 1,
      retries: 0,
      isolation: 'temp-home-and-dynamic-loopback-ports',
      flakePolicy: 'fail-and-fix-no-retry',
    });
    expect(PR_BROWSER_SMOKE_CONTRACT.journeys).toEqual([
      expect.objectContaining({ path: 'tests/csp-shell.spec.ts' }),
      expect.objectContaining({ path: 'tests/ui-crud-smoke.spec.ts' }),
      expect.objectContaining({
        path: 'tests/orchestration-chat-flow.spec.ts',
      }),
      expect.objectContaining({
        path: 'tests/cross-runtime-chat-switching.spec.ts',
      }),
      expect.objectContaining({
        path: 'tests/pr-smoke-live-chat-send.spec.ts',
      }),
    ]);
    expect(getSpecsForSuite('pr-smoke')).toEqual(
      PR_BROWSER_SMOKE_CONTRACT.journeys.map((journey) => journey.path),
    );
  });

  it('documents quarantine replacement coverage', () => {
    const quarantined = e2eManifest.filter(
      (entry) => entry.bucket === 'quarantine',
    );

    // #574: chat-multi-turn-context.spec.ts is RED BY DESIGN — it
    // proves a real multi-turn context-retention defect, not spec rot — so it
    // cannot sit in a running bucket (smoke-live / verify:e2e:full) without
    // permanently redding the gate. Quarantine is the manifest's own home for
    // exactly this; `replacement` must still name the tracking issue.
    expect(quarantined).toEqual([
      expect.objectContaining({
        path: 'tests/chat-multi-turn-context.spec.ts',
        replacement: '#574',
      }),
    ]);
  });

  it('lets the runner list supported suites without starting Station', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-e2e-suite.mjs', '--suite=extended', '--list'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.suite).toBe('extended');
    expect(parsed.specs).toContain('tests/settings.spec.ts');
  });

  it('lists the isolated PR smoke suite without starting Station', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-e2e-suite.mjs', '--suite=pr-smoke', '--list'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      suite: 'pr-smoke',
      specs: PR_BROWSER_SMOKE_CONTRACT.journeys.map((journey) => journey.path),
    });
  });

  it('keeps focused specs inside the selected suite and preserves manifest order', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/run-e2e-suite.mjs',
        '--suite=product',
        '--spec=tests/task-first-home.spec.ts',
        '--spec=./tests/mobile-chat-composer.spec.ts',
        '--grep=delegated work',
        '--list',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      suite: 'product',
      specs: [
        'tests/mobile-chat-composer.spec.ts',
        'tests/task-first-home.spec.ts',
      ],
      grep: 'delegated work',
    });
  });

  it('rejects focused specs outside the selected manifest suite', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/run-e2e-suite.mjs',
        '--suite=product',
        '--spec=tests/screenshots.spec.ts',
        '--list',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Focused spec 'tests/screenshots.spec.ts' is not a member of the product E2E suite.",
    );
  });

  it('rejects empty focused spec and grep options', () => {
    for (const option of ['--spec=', '--grep=']) {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-e2e-suite.mjs', '--suite=product', option, '--list'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `${option.slice(0, -1)} requires a value.`,
      );
    }
  });

  it('pins child commands to the Node executable validated by the runner', () => {
    const separator = process.platform === 'win32' ? ';' : ':';
    const node =
      process.platform === 'win32'
        ? 'C:\\validated\\node\\node.exe'
        : '/validated/node/bin/node';
    const nodeDirectory =
      process.platform === 'win32'
        ? 'C:\\validated\\node'
        : '/validated/node/bin';
    const env = withValidatedNodePath(
      { PATH: ['/usr/local/bin', nodeDirectory, '/usr/bin'].join(separator) },
      node,
    );

    expect(env.PATH).toBe(
      [nodeDirectory, '/usr/local/bin', '/usr/bin'].join(separator),
    );
  });

  it('requires the bounded smoke lane on pull requests with diagnostics', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('browser-smoke:');
    expect(workflow).toContain('name: Deterministic Browser Smoke');
    expect(workflow).toContain('timeout-minutes: 10');
    expect(workflow).toContain('run: npm run test:e2e:pr-smoke');
    expect(workflow).toContain('playwright-report/');
    expect(workflow).toContain('test-results/');
    expect(workflow).toContain('if: always()');
  });

  it('refuses an inline foreground chat receipt and an unfixtured chat-route mock (station#3800)', () => {
    const inline = foregroundReceiptFixtureErrors(
      'tests/fixture.spec.ts',
      "page.route('**/api/orchestration/chat', (route) => route.fulfill({ json: { success: true, data: { conversationId: 'c', sessionId: 'c', target: { kind: 'agent', id: 'station' }, resolution: {} } } }));",
    );
    expect(inline).toEqual([
      `tests/fixture.spec.ts:1 builds a foreground chat receipt inline; use foregroundMessageReceipt()/foregroundMessageReceiptEnvelope() from ${FOREGROUND_RECEIPT_FIXTURE}.`,
      `tests/fixture.spec.ts mocks /api/orchestration/chat without the shared foreground-receipt fixture (${FOREGROUND_RECEIPT_FIXTURE}).`,
    ]);

    // A path-router mock (the shape tests/helpers/daily-driver-shell.ts uses)
    // is a mock of the same route, not an exempt form.
    expect(
      foregroundReceiptFixtureErrors(
        'tests/helpers/shell.ts',
        "if (path === '/api/orchestration/chat') return route.fulfill(json(body));",
      ),
    ).toEqual([
      `tests/helpers/shell.ts mocks /api/orchestration/chat without the shared foreground-receipt fixture (${FOREGROUND_RECEIPT_FIXTURE}).`,
    ]);

    // A real journey may observe the foreground response to prove the
    // accepted receipt. Comparing its path is not a route interception.
    expect(
      foregroundReceiptFixtureErrors(
        'tests/live-journey.spec.ts',
        "page.waitForResponse((response) => new URL(response.url()).pathname === '/api/orchestration/chat');",
      ),
    ).toEqual([]);

    expect(
      foregroundReceiptFixtureErrors(
        'tests/fixture.spec.ts',
        "import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';\npage.route('**/api/orchestration/chat', (route) => route.fulfill({ json: foregroundMessageReceiptEnvelope({ conversationId: 'c' }) }));",
      ),
    ).toEqual([]);
  });

  it('gives the shared fixture the provider turn identity an accepted receipt requires', () => {
    const receipt = foregroundMessageReceipt({ conversationId: 'conv-1' });

    // `readExecutionReceipt` (packages/sdk/src/client/execution.ts:126-137)
    // reads a receipt as accepted only when this is a non-empty string.
    expect(typeof receipt.providerTurnId).toBe('string');
    expect(receipt.providerTurnId.length).toBeGreaterThan(0);
    expect(receipt.sessionId).toBe('conv-1');

    const envelope = foregroundMessageReceiptEnvelope({
      conversationId: 'conv-2',
      agent: 'dev-agent',
    });
    expect(envelope.success).toBe(true);
    expect(envelope.data.target).toEqual({ kind: 'agent', id: 'dev-agent' });
    expect(envelope.data.providerTurnId).not.toBe(receipt.providerTurnId);
  });

  it('rejects unknown runner suites with an actionable message', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-e2e-suite.mjs', '--suite=unknown', '--list'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Unknown E2E suite 'unknown'. Use pr-smoke, product, first-run, starter-clean-install, smoke-live, extended, screenshot, android.",
    );
  });
});
