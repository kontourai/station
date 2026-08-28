import { expect, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

/**
 * archive#3781: `/projects/:slug/layouts/:layout` used to re-render forever
 * while nobody touched it. The workspace-pane host announced its document to
 * the layout on every render rather than on every document change, the layout
 * answered by storing a freshly built `Set` of the same instance ids, and the
 * committed state change rendered the host again — ~1,300 iterations a second.
 * The visible cost was elsewhere: React's Suspense retry lane was starved, so
 * a lazily-mounted modal whose chunk had already arrived committed up to 9.3s
 * later (archive#3770).
 *
 * A commit that changes nothing is invisible except on an <input>, whose
 * `name`/`type` React re-assigns every time — so DOM mutation records are the
 * cheapest honest detector of "this route is still rendering". This spec
 * counts them on a settled route.
 *
 * The ceiling is measured, not guessed. Post-fix steady state in this harness
 * is 0 records per 2s sample; reverting the fix on this same tree produced
 * 8,810 (desktop) and 7,044 (390x844) in the same window, and 24,541 records
 * over 9s on a live instance. 60 leaves room for incidental chrome — a poll
 * tick, a banner, a caret — while staying ~120x below the smallest figure the
 * loop produced, so a loaded sampling host cannot lift it into range.
 */
const SAMPLE_MS = 2_000;
const SETTLE_MS = 3_000;
const MUTATION_CEILING = 60;

const CHAT = {
  sessionId: 'session-1',
  conversationId: 'conv-1',
  agentSlug: 'dev-agent',
  model: 'claude-sonnet',
  provider: 'bedrock',
  providerOptions: {},
  orchestrationSessionStarted: false,
  ephemeralMessages: [],
  inputHistory: [],
};

/**
 * Browser-local isolation: nothing this spec measures may depend on the shared
 * product instance answering, and a command POST arriving mid-sample would be
 * a mutation this spec did not cause.
 */
async function stubOrchestrationCommands(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.route('**/api/orchestration/commands', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: null }),
    }),
  );
}

async function sampleSteadyStateMutations(
  page: import('@playwright/test').Page,
): Promise<number> {
  return page.evaluate(
    async ({ settleMs, sampleMs }) => {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      let records = 0;
      const observer = new MutationObserver((mutations) => {
        records += mutations.length;
      });
      observer.observe(document.body, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      await new Promise((resolve) => setTimeout(resolve, sampleMs));
      observer.disconnect();
      return records;
    },
    { settleMs: SETTLE_MS, sampleMs: SAMPLE_MS },
  );
}

test.describe('Project layout render storm', () => {
  test.beforeEach(async ({ page }) => {
    await seedActiveChats(page, [CHAT]);
    await seedOrchestrationRoutes(page);
    await stubOrchestrationCommands(page);
  });

  test('the settled project-layout route stops rendering', async ({ page }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);

    // The detector only means something if the surface it detects is mounted.
    await expect(page.locator('.workspace-pane-host')).toBeVisible();
    await expect(page.locator('.file-tree-panel__search-input')).toHaveCount(1);

    const records = await sampleSteadyStateMutations(page);
    console.log(
      `[render-storm] ${records} DOM mutation records in ${SAMPLE_MS}ms (ceiling ${MUTATION_CEILING})`,
    );
    expect(records).toBeLessThanOrEqual(MUTATION_CEILING);
  });

  test('the settled route stops rendering at 390x844', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await seedActiveChats(page, [CHAT]);
      await seedOrchestrationRoutes(page);
      await stubOrchestrationCommands(page);
      await page.goto('/projects/dev/layouts/code?chat=conv-1');
      await dismissSetupLauncher(page);

      await expect(page.locator('.workspace-pane-host')).toBeVisible();

      const records = await sampleSteadyStateMutations(page);
      console.log(
        `[render-storm][mobile] ${records} DOM mutation records in ${SAMPLE_MS}ms (ceiling ${MUTATION_CEILING})`,
      );
      expect(records).toBeLessThanOrEqual(MUTATION_CEILING);
    } finally {
      await context.close();
    }
  });
});
