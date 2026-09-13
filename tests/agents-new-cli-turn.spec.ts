import { expect, type Page } from '@playwright/test';
import {
  type AgentConnectionRecord,
  createButton,
  deleteAgent,
  openChatWithAgent,
  readyAgentConnections,
  sendComposerTurn,
  startingPoint,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';

/**
 * E3 — "Wrap an installed agent CLI" end to end
 * (`reports/agents-lane/DESIGN.md` §4).
 *
 * The CLI branch has its own gate: `handleStartWithCli` deliberately binds
 * NOTHING, because "binding the first enabled engine would create an agent on
 * an engine nobody named". So Create stays disabled until the second radio
 * list — the engines by their own names, never "ACP" — has an answer, and only
 * then does the agent exist and answer a turn its own CLI produced.
 *
 * `smoke-live`: the turn runs the real `claude` or `codex` binary on this
 * machine. The engine is chosen from what the SERVER reports as ready
 * (`/api/connections/agents`), never guessed; a host with neither installed
 * fails here rather than passing quietly, because a CLI journey with no CLI
 * proves nothing.
 */

const PROMPT = 'Reply with exactly one word: PONG';
const EXPECTED = /PONG/;
const createdSlugs: string[] = [];

test.afterEach(async ({ authenticatedRequest }) => {
  for (const slug of createdSlugs.splice(0)) {
    await deleteAgent(authenticatedRequest, slug);
  }
});

/** Claude Code or Codex, as the server reports them, preferring Claude Code. */
async function requireInstalledCli(
  request: AuthenticatedE2ERequest,
): Promise<AgentConnectionRecord> {
  const named = (await readyAgentConnections(request)).filter((connection) =>
    ['claude', 'codex'].includes(connection.id),
  );
  if (named.length === 0) {
    const response = await request.get('/api/connections/agents');
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      data: Array<
        AgentConnectionRecord & {
          setup?: { state?: string; detected?: boolean };
        }
      >;
    };
    const available = body.data.filter(
      (connection) =>
        ['claude', 'codex'].includes(connection.id) &&
        connection.enabled !== false &&
        connection.setup?.state === 'available' &&
        connection.setup.detected === true,
    );
    const candidate =
      available.find((connection) => connection.id === 'claude') ??
      available[0];
    expect(
      candidate,
      'A real installed Claude Code or Codex engine is required',
    ).toBeDefined();
    // The fresh test home has discovered CLIs but has not added them yet.
    // This is the same real save used by Connections' one-click Add action.
    const saved = await request.put(
      `/api/connections/${encodeURIComponent(candidate!.id)}`,
      { data: candidate },
    );
    expect(
      saved.ok(),
      `Adding the detected CLI returned HTTP ${saved.status()}`,
    ).toBe(true);
    await expect
      .poll(
        async () => {
          const configured = (await readyAgentConnections(request)).filter(
            (connection) => connection.id === candidate!.id,
          );
          named.splice(0, named.length, ...configured);
          return named.length;
        },
        { timeout: 30_000 },
      )
      .toBe(1);
  }
  expect(
    named.map((connection) => connection.id),
    'neither the Claude Code nor the Codex engine connection is ready on this host, so the installed-CLI journey cannot run',
  ).not.toHaveLength(0);
  return named.find((connection) => connection.id === 'claude') ?? named[0];
}

async function createCliAgent(
  page: Page,
  name: string,
  engine: AgentConnectionRecord,
): Promise<string> {
  await page.goto('/agents/new');
  await startingPoint(page, 'cli').click();

  // §4: nothing is bound yet, so Create refuses — the engine is the question
  // that has not been answered, and the button says so before it is pressed.
  const create = createButton(page);
  await expect(create).toBeDisabled({ timeout: 20_000 });

  // §3.2: the CLIs are listed by their OWN names.
  const engineRadio = page.getByRole('radio', {
    name: new RegExp(`^${engine.name}\\b`),
  });
  await expect(engineRadio).toBeVisible();
  await engineRadio.check();

  await page.locator('#ae-name').fill(name);
  await expect(create).toBeEnabled({ timeout: 20_000 });

  await create.click();
  await page.waitForURL(/\/agents\/[^/]+\?created=1$/, { timeout: 30_000 });
  const slug = decodeURIComponent(
    new URL(page.url()).pathname.split('/').pop() ?? '',
  );
  expect(slug.length).toBeGreaterThan(0);
  createdSlugs.push(slug);
  return slug;
}

test.describe('New agent — Wrap an installed agent CLI', () => {
  test('Create waits on a named CLI, and the created agent answers a real turn', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(180_000);
    const engine = await requireInstalledCli(authenticatedRequest);

    const name = `E2E CLI Turn ${Date.now()}`;
    await createCliAgent(page, name, engine);

    // The editor now names the engine the user chose, not a connection id.
    await expect(
      page.locator('.agent-inline-editor').getByText(engine.name).first(),
    ).toBeVisible();

    await openChatWithAgent(page, name);
    await sendComposerTurn(page, PROMPT, EXPECTED, 120_000);
  });
});

test.describe('New agent — Wrap an installed agent CLI at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('the CLI journey completes on a phone with no horizontal scroll', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(180_000);
    const engine = await requireInstalledCli(authenticatedRequest);

    const name = `E2E CLI Turn Mobile ${Date.now()}`;
    await createCliAgent(page, name, engine);

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);

    await openChatWithAgent(page, name);
    await sendComposerTurn(page, PROMPT, EXPECTED, 120_000);
  });
});
