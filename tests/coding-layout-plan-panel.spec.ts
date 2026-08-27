import { expect, type Page, test } from '@playwright/test';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import {
  installVisualViewportFixture,
  setVisualViewport,
} from './helpers/visual-viewport';

const READINESS_SNAPSHOT = {
  configured: true,
  generatedAt: '2026-06-12T00:00:00.000Z',
  overall: 'not-ready',
  cli: {
    runId: 'veritas-123',
    message: 'Evidence Check completed.',
    reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
    sourceKind: 'working-tree',
    evidenceCheckLabels: ['npm test'],
    evidenceCheckFailure: null,
  },
  requirements: [
    {
      id: 'evidence-check:required-evidence-check',
      kind: 'evidence-check',
      label: 'npm test',
      status: 'satisfied',
      summary: 'Evidence checks passed',
      claimIds: [],
    },
  ],
  counts: {
    satisfied: 1,
    missing: 0,
    stale: 0,
    failing: 0,
    advisory: 0,
    recheckable: 0,
    accepted: 0,
  },
  trustReport: null,
};

/**
 * Seed the three inspector config-detection endpoints. Defaults: readiness
 * configured (so the panel defaults expanded), flow + trust not configured.
 */
async function seedInspectorConfig(
  page: Page,
  opts: {
    readiness?: unknown;
    flow?: unknown;
    bundles?: unknown[];
  } = {},
) {
  const readiness = opts.readiness ?? READINESS_SNAPSHOT;
  const flow = opts.flow ?? { initialized: false, definitions: [] };
  const bundles = opts.bundles ?? [];

  await page.route('**/api/projects/*/readiness**', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: readiness }),
    });
  });
  await page.route('**/api/projects/*/flow/definitions**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: flow }),
    }),
  );
  await page.route('**/api/projects/*/trust-bundles**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: bundles }),
    }),
  );
}

async function seedCommonRoutes(page: Page, opts: { withChat?: boolean } = {}) {
  if (opts.withChat !== false) {
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'codex',
        providerOptions: {},
        projectSlug: 'dev',
        projectName: 'Dev',
        orchestrationSessionStarted: true,
        inputHistory: [],
        ephemeralMessages: [],
        currentModeId: 'plan',
        planArtifact: {
          source: 'reasoning',
          rawText:
            '## Shipping plan\n\n✅ Capture requirements\n⏳ Build workflow panel\n⬜ Verify coding layout visibility',
          steps: [
            { content: 'Capture requirements', status: 'completed' },
            { content: 'Build workflow panel', status: 'in_progress' },
            { content: 'Verify coding layout visibility', status: 'pending' },
          ],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
  } else {
    await seedActiveChats(page, []);
  }
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page);
  await page.route('**/api/fs/browse**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          {
            name: 'src',
            path: '/tmp/test/src',
            type: 'directory',
            children: [
              { name: 'app.ts', path: '/tmp/test/src/app.ts', type: 'file' },
            ],
          },
        ],
      }),
    }),
  );
  await page.route('**/api/coding/diff**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: '@@ -1 +1 @@\n-console.log("old")\n+console.log("new")\n',
      }),
    }),
  );
}

async function selectWorkspacePane(page: Page, descriptorId: string) {
  const tab = page
    .getByRole('tablist', { name: 'Workspace panes' })
    .getByRole('tab', { name: descriptorId, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

test.describe('Coding Layout Inspector — expanded (a tool configured)', () => {
  test.beforeEach(async ({ page }) => {
    await seedCommonRoutes(page);
    await seedInspectorConfig(page);
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
  });

  test('defaults expanded and renders the workflow plan on the Plan tab', async ({
    page,
  }) => {
    await selectWorkspacePane(page, 'pane:builtin:evidence:plan');
    const planPanel = page.locator('.workflow-plan-panel');
    await expect(planPanel.getByText('Workflow plan')).toBeVisible();
    await expect(
      planPanel.getByRole('heading', { name: 'Shipping plan' }),
    ).toBeVisible();
    await expect(planPanel.getByText('Build workflow panel')).toBeVisible();
  });

  test('switches to the Readiness tab and shows the verdict', async ({
    page,
  }) => {
    await selectWorkspacePane(page, 'pane:builtin:evidence:readiness');
    await expect(page.getByText('Merge readiness')).toBeVisible();
    await expect(page.getByText('Not ready')).toBeVisible();
    // Inactive panes remain mounted for state continuity but are not visible.
    await expect(page.locator('.workflow-plan-panel')).toBeHidden();
  });

  test('verdict StatusBadge uses the tone contrast color (not muted)', async ({
    page,
  }) => {
    // Regression for the Console Kit `.status`/`.tone-*` source-order bug: the
    // `.status` base set `color: var(--k-text-muted)` declared after the tone
    // rules, so it clobbered the tone's contrast color — rendering a
    // low-contrast badge (light-grey text on a saturated tone background). The
    // verdict text must resolve to the tone's `--k-brand-contrast`, not muted.
    await selectWorkspacePane(page, 'pane:builtin:evidence:readiness');
    const verdict = page.locator('.status.tone-negative').first();
    await expect(verdict).toBeVisible();
    const { color, contrast, muted } = await verdict.evaluate((el) => {
      const cs = getComputedStyle(el);
      const probe = (name: string) => {
        const d = document.createElement('span');
        d.style.color = `var(${name})`;
        el.appendChild(d);
        const v = getComputedStyle(d).color;
        el.removeChild(d);
        return v;
      };
      return {
        color: cs.color,
        contrast: probe('--k-brand-contrast'),
        muted: probe('--k-text-muted'),
      };
    });
    expect(color).toBe(contrast);
    expect(color).not.toBe(muted);
  });

  test('hosts coding and inspector surfaces as independently selectable panes', async ({
    page,
  }) => {
    const tabs = page.getByRole('tablist', { name: 'Workspace panes' });
    await expect(
      tabs.getByRole('tab', { name: 'pane:builtin:code:coding', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await selectWorkspacePane(page, 'pane:builtin:evidence:plan');
    await expect(page.locator('.workflow-plan-panel')).toBeVisible();
  });

  test('switches between inspector panes without duplicating either surface', async ({
    page,
  }) => {
    await selectWorkspacePane(page, 'pane:builtin:evidence:plan');
    await expect(page.locator('.workflow-plan-panel')).toBeVisible();
    await selectWorkspacePane(page, 'pane:builtin:evidence:readiness');
    await expect(page.getByText('Merge readiness')).toBeVisible();
    await expect(page.locator('.workflow-plan-panel')).toHaveCount(1);
  });

  test('surfaces runtime approval state on the plan panel', async ({
    page,
  }) => {
    await selectWorkspacePane(page, 'pane:builtin:evidence:plan');
    const planPanel = page.locator('.workflow-plan-panel');
    await waitForMockOrchestrationSse(page);
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId: 'session-1',
        createdAt: '2026-04-05T12:00:05.000Z',
        method: 'request.opened',
        requestId: 'req-1',
        requestType: 'permission',
        title: 'Approve permissions',
        description: 'Needs network access',
        payload: { toolName: 'shell_exec' },
      },
    });

    await expect(planPanel.getByText('Approval required (1)')).toBeVisible();
  });
});

test.describe('Coding Layout Inspector — setup CTA (not configured)', () => {
  test('Plan tab shows the "Add a delivery flow" setup CTA behind a confirm', async ({
    page,
  }) => {
    // No seeded chat → no plan artifact, so the Plan tab shows the empty CTA.
    await seedCommonRoutes(page, { withChat: false });
    // Readiness configured (so the panel defaults expanded), flow not.
    await seedInspectorConfig(page, {
      flow: { initialized: false, definitions: [] },
    });
    let flowInitCalled = false;
    await page.route('**/api/projects/*/flow/init', (route) => {
      flowInitCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { outcome: 'created', initialized: true, definitions: [] },
        }),
      });
    });

    // Seed without a chat plan artifact so the Plan tab shows the empty CTA.
    await page.goto('/projects/dev/layouts/code');

    await selectWorkspacePane(page, 'pane:builtin:evidence:plan');
    await expect(page.getByText('No delivery flow')).toBeVisible();
    await page.getByRole('button', { name: 'Add a delivery flow' }).click();

    // Confirm modal protects the file-writing action.
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(flowInitCalled).toBe(false);
    await page.getByRole('button', { name: 'Add flow' }).click();
    await expect.poll(() => flowInitCalled).toBe(true);
  });

  test('keeps the unconfigured Plan pane explicit in the workspace catalog', async ({
    page,
  }) => {
    await seedCommonRoutes(page, { withChat: false });
    await seedInspectorConfig(page, {
      readiness: { configured: false, reason: 'no-veritas-dir' },
      flow: { initialized: false, definitions: [] },
      bundles: [],
    });
    await page.goto('/projects/dev/layouts/code');

    await selectWorkspacePane(page, 'pane:builtin:evidence:plan');
    await expect(page.getByText('No delivery flow')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Add a delivery flow' }),
    ).toBeVisible();
  });
});

test.describe('Coding Layout — mobile single-panel workspace', () => {
  test.use({ viewport: { width: 412, height: 915 } }); // Pixel 7

  test.beforeEach(async ({ page }) => {
    await installVisualViewportFixture(page);
    await seedCommonRoutes(page);
    await seedInspectorConfig(page);
    // The file tree fetches its contents from /api/coding/files; seed a small
    // tree so file rows exist once expanded.
    await page.route('**/api/coding/files**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            { name: 'src', path: 'src', type: 'directory', children: [] },
            { name: 'README.md', path: 'README.md', type: 'file' },
          ],
        }),
      }),
    );
    // Coding layouts use the project-bound preview route, which accepts only
    // workspace-relative paths rather than a caller-supplied filesystem root.
    await page.route('**/api/projects/dev/file-preview', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            path: 'README.md',
            status: 'ready',
            renderKind: 'text',
            content: '# Mobile workspace\n\nState stays here.',
          },
        }),
      }),
    );
  });

  test('switches file, plan, and terminal panes without losing the selected file', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');

    const surfaces = page.getByRole('tablist', { name: 'Workspace panes' });
    await expect(surfaces).toBeVisible();
    const dock = page.locator('#chat-dock');
    if (
      await dock.evaluate((element) =>
        element.classList.contains('is-maximized'),
      )
    ) {
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: 'Collapse chat' })
        .click();
      await expect(dock).not.toHaveClass(/is-maximized/);
    }
    const work = surfaces.getByRole('tab', {
      name: 'pane:builtin:code:coding',
      exact: true,
    });
    await expect(work).toHaveAttribute('aria-selected', 'true');

    for (const tab of await surfaces.getByRole('tab').all()) {
      const bounds = await tab.boundingBox();
      expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }

    await surfaces
      .getByRole('tab', {
        name: 'pane:builtin:coding:file-browser',
        exact: true,
      })
      .click();
    await expect(page.getByText('README.md', { exact: true })).toBeVisible();
    const readme = page.getByRole('button', { name: 'README.md' });
    await readme.click();
    await expect(readme).toHaveClass(/file-tree-row--selected/);

    await page.getByRole('button', { name: 'Back to pane tabs' }).click();
    await surfaces
      .getByRole('tab', {
        name: 'pane:builtin:evidence:plan',
        exact: true,
      })
      .click();
    await expect(page.getByText('Workflow plan')).toBeVisible();

    await page.getByRole('button', { name: 'Back to pane tabs' }).click();
    await surfaces
      .getByRole('tab', {
        name: 'pane:builtin:coding:file-browser',
        exact: true,
      })
      .click();
    await expect(readme).toHaveClass(/file-tree-row--selected/);
    await page.getByRole('button', { name: 'Back to pane tabs' }).click();
    await surfaces
      .getByRole('tab', {
        name: 'pane:builtin:coding:terminal',
        exact: true,
      })
      .click();
    const terminal = page.getByRole('tabpanel').filter({ hasText: 'Terminal' });
    await expect(terminal).toBeVisible();
    await setVisualViewport(page, 480, 12);
    const hostBox = await page
      .locator('.workspace-pane-host--compact')
      .boundingBox();
    expect(hostBox).not.toBeNull();
    expect(hostBox!.y + hostBox!.height).toBeLessThanOrEqual(492);
    await terminal.getByTitle('New terminal').click();
    const terminalPicker = page.getByRole('dialog', { name: 'New terminal' });
    await expect(terminalPicker).toBeVisible();
    await expect(
      terminalPicker.getByPlaceholder('Select terminal type...'),
    ).not.toBeFocused();
    const closeTerminalPicker = terminalPicker.getByRole('button', {
      name: 'Close new terminal',
    });
    const closeTerminalBox = await closeTerminalPicker.boundingBox();
    expect(closeTerminalBox?.height ?? 0).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET_PX,
    );
    await closeTerminalPicker.click();
    await expect(terminalPicker).toHaveCount(0);
    await terminal.getByTitle('New terminal').click();
    await page
      .getByRole('dialog', { name: 'New terminal' })
      .getByRole('button', { name: /Shell/ })
      .click();
    const fallbackTerminal = terminal.locator('.coding-terminal-fallback');
    const fallbackInput =
      fallbackTerminal.getByPlaceholder('Type a command...');
    if ((await fallbackTerminal.count()) > 0) {
      await expect(fallbackInput).not.toBeFocused();
      await expect(fallbackInput).toHaveCSS('font-size', '16px');
      await fallbackTerminal.click({ position: { x: 20, y: 20 } });
      await expect(fallbackInput).toBeFocused();
    } else {
      const xterm = terminal.getByRole('application', { name: 'Terminal' });
      const xtermInput = xterm.getByRole('textbox', { name: 'Terminal input' });
      await expect(xtermInput).not.toBeFocused();
      await xterm.click({ position: { x: 20, y: 20 } });
      await expect(xtermInput).toBeFocused();
    }
    await page.evaluate(() =>
      (
        window as typeof window & {
          __setTestVisualViewport: (height: number, offsetTop: number) => void;
        }
      ).__setTestVisualViewport(915, 0),
    );

    await expect(dock).toBeVisible();

    for (const width of [390, 412, 430]) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
      ).toBe(false);
    }
  });
});
