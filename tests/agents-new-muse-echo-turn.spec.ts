import { expect, type Page } from '@playwright/test';
import {
  type AgentConnectionRecord,
  createButton,
  deleteAgent,
  openChatWithAgent,
  readyAgentConnections,
  startingPoint,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';

/**
 * #550 — muse's real-turn journey, over the binary's own `echo` provider.
 *
 * Muse was the one engine family where creating an agent and running a turn
 * was covered by nothing: `agents-new-cli-turn.spec.ts` deliberately picks
 * `claude` or `codex`, and a muse turn used to require a live Meta key and a
 * network round trip because the adapter never passed `--provider`, so muse's
 * own default (`meta`) always applied.
 *
 * `STATION_E2E_MUSE_PROVIDER=echo` — set for this bucket's server in
 * `scripts/run-e2e-suite.mjs` — makes every muse turn of that server run
 * `muse exec --provider echo`, which answers from the prompt alone: no key,
 * no network, and a deterministic reply. So this is a REAL turn through the
 * real binary and the real HTTP path; only the model behind it is replaced by
 * one whose answer can be asserted.
 *
 * `smoke-live`, and a host that cannot run muse fails here rather than passing
 * quietly — for the same reason the installed-CLI journey does: a muse journey
 * with no muse proves nothing. Note what the precondition actually demands:
 * `readyAgentConnections` keeps only connections the SERVER reports `ready`,
 * and muse's readiness includes its AUTH prerequisite (`museCredentialState`
 * observes `META_API_KEY` or a `~/.config/muse/auth.json`), so an installed
 * but unauthenticated muse is NOT ready and this spec will not run — even
 * though the echo turn it performs needs no key at all. That is a real
 * precondition of the journey as written, not of the echo provider.
 *
 * The assertion is discriminating in both directions. `echo: ` is a prefix
 * ONLY the echo provider produces, and the typed token is what proves the
 * prompt reached the binary and its answer came back; requiring the token to
 * appear AFTER an `echo:` rules out the user's own composer bubble, which
 * carries the same token and would otherwise satisfy a bare token match. If
 * the override failed to reach argv, muse would answer from `meta` (or refuse
 * for want of a key) and no `echo:` would ever appear.
 */

const createdSlugs: string[] = [];

test.afterEach(async ({ authenticatedRequest }) => {
  for (const slug of createdSlugs.splice(0)) {
    await deleteAgent(authenticatedRequest, slug);
  }
});

/** The muse engine connection, as the SERVER reports it — never guessed. */
async function requireMuseEngine(
  request: AuthenticatedE2ERequest,
): Promise<AgentConnectionRecord> {
  const ready = await readyAgentConnections(request);
  const muse = ready.find((connection) => connection.id === 'muse');
  expect(
    muse,
    `the muse engine connection is not ready on this host (ready: ${ready
      .map((connection) => connection.id)
      .join(', ')}), so the muse real-turn journey cannot run`,
  ).toBeTruthy();
  return muse as AgentConnectionRecord;
}

async function createMuseAgent(
  page: Page,
  name: string,
  engine: AgentConnectionRecord,
): Promise<string> {
  await page.goto('/agents/new');
  await startingPoint(page, 'cli').click();

  // The CLI branch binds nothing until an engine is named, so Create refuses
  // until the second radio list has an answer (DESIGN §4).
  const create = createButton(page);
  await expect(create).toBeDisabled({ timeout: 20_000 });

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

/**
 * Sends one turn and waits for the ECHO PROVIDER's own answer, retrying
 * through Station's own capacity refusal exactly as a user would.
 *
 * Reads the whole chat pane's text rather than a single element: the reply is
 * whatever muse echoed back, which on a first turn is the composed prompt and
 * may render as several blocks. `echo:` preceding the token is what makes the
 * match the assistant's reply and not the user's message above it.
 *
 * The retry is not a tolerance for a flaky assertion — the assertion below is
 * unchanged and still demands the echoed token. It answers ONE measured
 * condition: on a shared host, Station refuses to start the engine and says so
 * ("Host is at capacity: This Station's host is at 98% load, so the engine
 * could not start. Wait for load to drop, then retry."), keeping a `Retry`
 * control beside the banner rather than retrying itself. Observed live here at
 * 1 run in 8; the other seven answered. `waitForDispatchThroughCapacityRetries`
 * in `helpers/agents-journey` exists for the same disclosed condition and
 * documents it as "not a defect in the journey using this" — this is that
 * pattern applied to a composer turn, bounded by one overall deadline rather
 * than looping forever, so a genuine engine failure still fails the spec.
 */
async function sendTurnAndExpectEcho(
  page: Page,
  prompt: string,
  token: string,
  overallTimeoutMs = 120_000,
): Promise<void> {
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(prompt);
  await composer.press('Enter');

  // `allInnerTexts` rather than one element's `innerText`: the composer can be
  // mounted in either the dock or the workspace pane, and a reply rendered as
  // several blocks would defeat a single-element text match.
  const panes = page.locator('#chat-dock, #chat-workspace-pane');
  const paneText = async () => (await panes.allInnerTexts()).join('\n');
  const echoed = new RegExp(`echo:[\\s\\S]*${token}`);
  const retry = page.getByRole('button', { name: 'Retry' });

  const deadline = Date.now() + overallTimeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1_000, deadline - Date.now());
    try {
      await expect
        .poll(paneText, { timeout: Math.min(15_000, remaining) })
        .toMatch(echoed);
      return;
    } catch {
      // The product does not auto-retry a capacity refusal; it offers the
      // control. Press it the way the banner tells the user to, then keep
      // waiting on the same unchanged assertion.
      if (
        await retry
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await retry
          .first()
          .click()
          .catch(() => undefined);
      }
    }
  }

  // Out of budget: assert once more so the failure names what was on screen.
  expect(
    await paneText(),
    'the chat pane never showed an `echo:` reply carrying the sent token; the muse turn did not round-trip through the echo provider',
  ).toMatch(echoed);
}

test.describe('New agent — a muse agent answers a real turn over echo', () => {
  test('the created muse agent round-trips a real turn through the muse binary', async ({
    page,
    authenticatedRequest,
  }) => {
    // Covers this spec's OWN declared worst case rather than the suite
    // default: the create flow alone budgets 20s + 20s + 30s, the editor
    // guard 20s, opening the chat 15s + 20s + 10s, and the turn itself 120s —
    // ~255s. At 180s the harness could kill the test before its own final,
    // informative assertion was ever reached, turning a diagnosable failure
    // into a bare timeout.
    test.setTimeout(300_000);
    const engine = await requireMuseEngine(authenticatedRequest);

    const name = `E2E Muse Echo Turn ${Date.now()}`;
    await createMuseAgent(page, name, engine);

    // The editor names the engine the user chose, not a connection id — which
    // is also this spec's guard that the turn below is genuinely a MUSE turn
    // and not some other engine's. Given the same 20s allowance as every other
    // wait in this file rather than the 5s default: the assertion is a settle
    // on a freshly created agent, and this suite shares a host with whatever
    // else is running on it.
    await expect(
      page.locator('.agent-inline-editor').getByText(engine.name).first(),
    ).toBeVisible({ timeout: 20_000 });

    await openChatWithAgent(page, name);

    const token = `muse-echo-${Date.now()}`;
    await sendTurnAndExpectEcho(
      page,
      `Return this token unchanged: ${token}`,
      token,
    );
  });
});
