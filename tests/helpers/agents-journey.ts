import { expect, type Locator, type Page } from '@playwright/test';
import type { AuthenticatedE2ERequest } from './authenticated-request';

/**
 * Shared seeding and locators for the redone Agents surfaces
 * (`reports/agents-lane/DESIGN.md` §2 the readiness board, §3 the editor,
 * §4 New agent, §5 the New Chat picker).
 *
 * Every seed goes through the LIVE Station API rather than `page.route`: the
 * whole point of these journeys is that the row state, the fixing verb and the
 * Create gate are the SERVER's answers rendered verbatim (DESIGN P4). A mocked
 * `unavailableReason` would prove the renderer and nothing about the
 * derivation, so the specs that consume this helper are all classified
 * `shared-instance-exclusive` in `tests/e2e-manifest.mjs`.
 */

/** DESIGN.md §2 band labels, as `src-ui/src/components/agent-provenance.ts` spells them. */
export const ENGINE_BAND_LABEL = 'Engines on this machine';
export const AUTHORED_BAND_LABEL = 'Your agents';

/**
 * The four verbs `agentFixLabel` can speak. A row renders exactly one of them
 * or none (it is Ready); a fifth verb anywhere is the defect this list exists
 * to catch.
 */
export const FIX_VERBS = ['Enable', 'Connect', 'Set up', 'Edit agent'] as const;

export interface SeededAgent {
  slug: string;
  name: string;
}

interface AgentSeedInput {
  slug: string;
  name: string;
  prompt?: string;
  description?: string;
  execution?: Record<string, unknown>;
}

/**
 * `POST /agents` (the management route) — note the bare path: the enriched
 * read surface is `/api/agents`, but creation and update are mounted on
 * `/agents` (`src-server/runtime/routes/runtime-routes.ts`).
 */
export async function seedAgent(
  request: AuthenticatedE2ERequest,
  input: AgentSeedInput,
): Promise<SeededAgent> {
  const response = await request.post('/agents', {
    data: {
      slug: input.slug,
      name: input.name,
      prompt: input.prompt ?? 'You are a seeded end-to-end fixture.',
      ...(input.description ? { description: input.description } : {}),
      ...(input.execution ? { execution: input.execution } : {}),
    },
  });
  expect(
    response.ok(),
    `seeding agent ${input.slug} failed with HTTP ${response.status()}`,
  ).toBe(true);
  return { slug: input.slug, name: input.name };
}

export async function deleteAgent(
  request: AuthenticatedE2ERequest,
  slug: string,
): Promise<void> {
  await request.delete(`/agents/${encodeURIComponent(slug)}`);
}

export interface AgentReadRecord {
  name?: string;
  description?: string;
  prompt?: string;
  execution?: {
    agentConnectionId?: string;
    modelConnectionId?: string;
    credentialProfileRef?: string;
  };
}

export async function readAgent(
  request: AuthenticatedE2ERequest,
  slug: string,
): Promise<AgentReadRecord> {
  const response = await request.get(`/api/agents/${encodeURIComponent(slug)}`);
  expect(
    response.ok(),
    `reading agent ${slug} failed with HTTP ${response.status()}`,
  ).toBe(true);
  const body = (await response.json()) as { data?: AgentReadRecord };
  expect(body.data, `agent ${slug} was not returned`).toBeTruthy();
  return body.data as AgentReadRecord;
}

export interface CatalogAgent {
  slug: string;
  name: string;
  available?: boolean;
  unavailableReason?: string;
  unavailableFix?: { kind?: string; target?: string };
  enable?: unknown;
}

/** `GET /api/agents` — the enriched catalog the Agents rail actually renders. */
export async function readAgentCatalog(
  request: AuthenticatedE2ERequest,
): Promise<CatalogAgent[]> {
  const response = await request.get('/api/agents');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data?: CatalogAgent[] };
  return body.data ?? [];
}

/**
 * `GET /api/agents` WITH the envelope's own staleness flag.
 *
 * The route serves `lastStableCatalog` — a snapshot captured BEFORE this
 * seed — whenever the runtime's agent-configuration revision is still moving
 * (`src-server/routes/agents/enriched-agents.ts`, "Agent catalog unstable
 * after retries; serving the last stable catalog"), and marks it
 * `catalogState: 'reconciling'`. `fetchAgentsEnriched` drops that flag
 * (`packages/sdk/src/client/agents.ts`), so the rail renders the snapshot with
 * nothing saying so. A spec that seeds through the API and then opens the page
 * has to read the flag itself.
 */
export async function readAgentCatalogEnvelope(
  request: AuthenticatedE2ERequest,
): Promise<{ agents: CatalogAgent[]; reconciling: boolean }> {
  const response = await request.get('/api/agents');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    data?: CatalogAgent[];
    catalogState?: string;
  };
  return {
    agents: body.data ?? [],
    reconciling: body.catalogState === 'reconciling',
  };
}

/** Block until the SERVER reports `slug` on a read it calls stable. */
export async function waitForSeededAgent(
  request: AuthenticatedE2ERequest,
  slug: string,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { agents, reconciling } = await readAgentCatalogEnvelope(request);
        return !reconciling && agents.some((agent) => agent.slug === slug);
      },
      {
        timeout,
        message: `/api/agents never reported ${slug} on a stable read; the rail can only render what that read returns`,
      },
    )
    .toBe(true);
}

/** The mirror image, for teardown: the delete is visible on a stable read. */
export async function waitForAgentRemoved(
  request: AuthenticatedE2ERequest,
  slug: string,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { agents, reconciling } = await readAgentCatalogEnvelope(request);
        return !reconciling && !agents.some((agent) => agent.slug === slug);
      },
      {
        timeout,
        message: `/api/agents still reports ${slug} after its delete; the next spec would inherit it`,
      },
    )
    .toBe(true);
}

export interface AgentConnectionRecord {
  id: string;
  name: string;
  setup?: { state?: string };
  enabled?: boolean;
}

/**
 * The engine connections the SERVER reports, so a CLI journey names a real
 * installed CLI instead of guessing one. The caller asserts at least one is
 * ready — an environment with no engine is a failure of the run, never a
 * reason for the spec to pass quietly.
 */
export async function readyAgentConnections(
  request: AuthenticatedE2ERequest,
): Promise<AgentConnectionRecord[]> {
  const response = await request.get('/api/connections/agents');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data?: AgentConnectionRecord[] };
  return (body.data ?? []).filter(
    (connection) =>
      connection.enabled !== false && connection.setup?.state === 'ready',
  );
}

/** The rail row for `name`, as one `.split-pane__item-row` (row + trailing). */
export function agentRow(page: Page, name: string): Locator {
  return page
    .locator('.split-pane__item-row')
    .filter({ has: page.locator('.split-pane__item', { hasText: name }) });
}

/** The row's ONE server-derived state word (`AgentReadinessCell` part="status"). */
export function agentRowStatus(page: Page, name: string): Locator {
  return agentRow(page, name).locator('.agent-readiness__status');
}

/** The row's trailing action cell: Chat when Ready, otherwise the one repair. */
export function agentRowAction(page: Page, name: string): Locator {
  return agentRow(page, name).locator('.split-pane__item-trailing button');
}

/**
 * Wait for the rail to have rendered rows. `SplitPaneLayout` paints a skeleton
 * while `useAgentsQuery` is in flight, and every assertion below reads row
 * content, so a spec that starts asserting too early measures the skeleton.
 */
export async function waitForAgentsRail(page: Page): Promise<void> {
  await page.waitForSelector('.split-pane', { timeout: 20_000 });
  await expect(page.locator('.split-pane__item').first()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * DESIGN.md §4 beat one: the three starting points. Named so a spec reads as
 * the journey rather than as a regex.
 */
export function startingPoint(
  page: Page,
  which: 'model' | 'cli' | 'copy',
): Locator {
  const label = {
    model: /^Chat with a model/,
    cli: /^Wrap an installed agent CLI/,
    copy: /^Copy an existing agent/,
  }[which];
  return page.getByRole('button', { name: label });
}

/** The one primary action in the editor's DetailHeader while creating. */
export function createButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Create Agent' });
}

/**
 * Open a chat with `agentName` the way the product does: the editor's Chat
 * action opens the New Chat picker (DESIGN §5), and the agent's row in it
 * starts the conversation.
 */
/**
 * Expands the chat dock if a picker/new-chat flow left it collapsed.
 *
 * Fix round (review MED-8/MED-7): the earlier `/^Expand chat/` regex matched
 * THREE distinct controls — this dock's own 'Expand chat dock', the
 * unrelated sidebar inbox toggle 'Expand chat list'
 * (`dock-mode-preference.spec.ts`), and a mobile menu item 'Expand chat'
 * (`mobile-chat-composer.spec.ts`, `task-first-home.spec.ts`) — and the
 * surrounding `.catch(() => false)` silently swallowed the resulting
 * strict-mode violation as "not visible," turning a real ambiguity into a
 * no-op rather than a loud failure. Matches the dock's exact control name
 * only (`ChatDockHeader.tsx`'s `!isDockOpen ? 'Expand chat dock' :
 * 'Collapse chat dock'` — one button, two labels, never two controls).
 *
 * What actually leaves the dock collapsed on this path is only PARTLY
 * diagnosed: `useChatDockActions.ts`'s `openChatForAgent` defaults
 * `revealDock` to `true` and calls `navigation.setDockState(true,
 * lastDockMaximized)`, which should already open it — station#82's
 * webdriver-gated first-run auto-open nudge is confirmed disabled in this
 * environment, but it is not the only mechanism in play, and it is not
 * confirmed to be the (or the only) reason the dock is sometimes still
 * collapsed when these journeys reach this point. Treat this helper as a
 * tolerant settle, not a diagnosis.
 */
export async function ensureChatDockOpen(page: Page): Promise<void> {
  // BOTH legitimate dock toggles, and only those: desktop's 'Expand chat
  // dock' (`ChatDockHeader.tsx`) and the mobile header's 'Expand chat'
  // (`ChatDockMobileHeader.tsx`). Anchored alternation so the sidebar
  // inbox toggle 'Expand chat list' can never match — an exact
  // desktop-only name here broke every 390x844 phone-viewport journey
  // (caught live in the smoke-live gate: the mobile control has no
  // ' dock' suffix, so the helper silently never expanded the dock).
  const expand = page.getByRole('button', {
    name: /^Expand chat( dock)?$/,
  });
  if (await expand.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await expand.click();
    // Settled-state guard (review LOW-3): the SAME button relabels to its
    // 'Collapse …' form on toggle — asserting the NEW label directly
    // proves the dock reached its open state, rather than merely that the
    // old label's count dropped to zero, which a removed-and-replaced
    // element could also satisfy without the dock actually being open.
    await expect(
      page.getByRole('button', { name: /^Collapse chat( dock)?$/ }),
    ).toBeVisible({ timeout: 10_000 });
  }
}

/**
 * Waits for `targetCount` requests, retrying through Station's own "Host is
 * at capacity" refusal (a real, disclosed shared-host condition, not a
 * defect in the journey using this): the product's own composer keeps a
 * `Retry` control alongside that banner rather than auto-retrying, so this
 * clicks it exactly like a real user would, bounded by an overall deadline
 * rather than looping forever.
 */
export async function waitForDispatchThroughCapacityRetries(
  page: Page,
  requests: unknown[],
  targetCount: number,
  overallTimeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + overallTimeoutMs;
  const retryButton = page.getByRole('button', { name: 'Retry' });
  while (Date.now() < deadline) {
    if (requests.length >= targetCount) return;
    const remaining = Math.max(1_000, deadline - Date.now());
    const pollTimeout = Math.min(10_000, remaining);
    try {
      await expect
        .poll(() => requests.length, { timeout: pollTimeout })
        .toBeGreaterThanOrEqual(targetCount);
      return;
    } catch {
      if (
        await retryButton
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await retryButton
          .first()
          .click()
          .catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `dispatch never reached ${targetCount} request(s) (host at capacity with no visible Retry, or a genuine failure) within ${overallTimeoutMs}ms`,
        );
    }
  }
  expect(
    requests.length,
    'final dispatch count after retrying through capacity refusals',
  ).toBeGreaterThanOrEqual(targetCount);
}

export async function openChatWithAgent(
  page: Page,
  agentName: string,
): Promise<void> {
  await page
    .locator('.agent-inline-editor')
    .getByRole('button', { name: 'Chat', exact: true })
    .click();
  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await picker.getByRole('button', { name: new RegExp(agentName) }).click();
  await ensureChatDockOpen(page);
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible({
    timeout: 20_000,
  });
}

/** Send `text` through the real composer and wait for the assistant's reply. */
export async function sendComposerTurn(
  page: Page,
  text: string,
  expected: RegExp,
  timeout = 90_000,
): Promise<void> {
  const composer = page.getByPlaceholder('Type a message...');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(
    page.locator('#chat-dock, #chat-workspace-pane').getByText(expected),
  ).toBeVisible({ timeout });
}
