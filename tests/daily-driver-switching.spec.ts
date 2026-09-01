import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import {
  CONVERSATION_HANDOFF_CARRIED_FIELDS,
  CONVERSATION_HANDOFF_DISCLOSURE_LABELS,
  CONVERSATION_HANDOFF_RESET_FIELDS,
} from '@kontourai/station-contracts/orchestration';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { createDailyDriverScenarioObservation } from '../scripts/lib/daily-driver-scenario-observation.mjs';
import {
  completeDispatchedTurn,
  expectSettled,
  seedDailyDriverChats,
  seedDailyDriverShell,
  transcriptLocator,
} from './helpers/daily-driver-shell';
import { foregroundMessageReceipt } from './helpers/execution-receipt';
import {
  dismissSetupLauncher,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

/**
 * Mid-conversation switching journeys (archive#3307, mechanism map from the
 * issue's "what the mechanism should assert" section):
 *
 * 1. In-place model switch: the composer's model picker sets a per-turn
 *    override, the next dispatch carries it, and the switched turn's
 *    provenance card reports the new model. The deterministic backend stamps
 *    `effectiveModel`/`reportedModel` event metadata FROM THE CAPTURED
 *    DISPATCH REQUEST, and the card renders through the real shared
 *    provenance fold (`turn-provenance-fold.ts`) — so a UI that fails to
 *    carry the switch produces a card naming the old model and the test
 *    reds. Server-side `resolveModelLaunchPlan` enforcement is covered by
 *    `execution-target-execution.test.ts`; this spec binds the browser half:
 *    picker → dispatch payload → event metadata → rendered provenance.
 *
 * 2. Agent/engine handoff: the actual composer action opens the Continue-with
 *    dialog, discloses carried/reset state, confirms a configured target,
 *    dispatches the explicit handoff route, keeps the conversation identity,
 *    and renders the durable boundary returned by the conversation event
 *    window. Fork remains a separate feature and is not credited here.
 */

const MODEL_ALPHA = 'claude-sonnet-4-20250514';
const MODEL_BRAVO = 'claude-haiku-mid-switch';

const SWITCH_CONVERSATION = 'dd-switch-model';
const HANDOFF_CONVERSATION = 'dd-agent-handoff';
const FORK_CONVERSATION = 'dd-fork-source';
const HANDOFF_SESSION = 'dd-agent-handoff:session:1';
const OBSERVATION_DIR_ENV = 'STATION_DAILY_DRIVER_SCENARIO_OBSERVATION_DIR';
const WRAPPER_ENV = 'STATION_DAILY_DRIVER_SCENARIO_OBSERVATION_WRAPPER';
const SOURCE_REVISION_ENV = 'STATION_DAILY_DRIVER_SCENARIO_SOURCE_REVISION';

async function attachHandoffObservation(
  testInfo: TestInfo,
  observation: Record<string, unknown>,
) {
  const artifact = createDailyDriverScenarioObservation({
    sourceRevision: process.env[SOURCE_REVISION_ENV] ?? 'unverified',
    observations: [observation],
  });
  const serialized = JSON.stringify(artifact);
  await testInfo.attach('daily-driver-scenario-agent-engine-handoff', {
    body: serialized,
    contentType: 'application/json',
  });
  const directory = process.env[OBSERVATION_DIR_ENV];
  if (process.env[WRAPPER_ENV] === '1' && directory)
    writeFileSync(join(directory, 'agent-engine-handoff.json'), serialized, {
      encoding: 'utf8',
      flag: 'wx',
    });
}

const SHELL_AGENTS = [
  {
    agentSlug: 'claude',
    provider: 'claude',
    runtimeName: 'Claude Runtime',
    connectionId: 'claude',
    models: [
      { id: MODEL_ALPHA, name: 'Claude Sonnet 4' },
      { id: MODEL_BRAVO, name: 'Claude Haiku Mid Switch' },
    ],
    defaultModel: MODEL_ALPHA,
  },
  {
    agentSlug: 'codex',
    provider: 'codex',
    runtimeName: 'Codex Runtime',
    connectionId: 'codex',
    models: [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }],
    defaultModel: 'gpt-5-codex',
  },
];

const SHELL_CONVERSATIONS = [
  { id: SWITCH_CONVERSATION, title: 'Model switch chat', agentSlug: 'claude' },
  {
    id: HANDOFF_CONVERSATION,
    title: 'Agent handoff chat',
    agentSlug: 'claude',
  },
  { id: FORK_CONVERSATION, title: 'Fork source chat', agentSlug: 'claude' },
];

async function openChat(page: Page, conversationId: string) {
  await page.goto(`/?dock=open&maximize=true&chat=${conversationId}`);
  await dismissSetupLauncher(page);
  await waitForMockOrchestrationSse(page);
}

function provenanceCardForTurn(page: Page, turnId: string) {
  return page.locator(
    `section[aria-label="Answer provenance for turn ${turnId}"]`,
  );
}

async function expectCardReportsModel(
  page: Page,
  turnId: string,
  model: string,
) {
  const card = provenanceCardForTurn(page, turnId);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.locator('.turn-provenance__summary').click();
  const reportedRow = card.locator('.turn-provenance__row', {
    hasText: 'Model reported by engine',
  });
  await expect(
    reportedRow,
    `TurnProvenanceCard for '${turnId}' must report the model the dispatch actually carried`,
  ).toContainText(model);
  const requestedRow = card.locator('.turn-provenance__row', {
    hasText: 'Model requested',
  });
  await expect(requestedRow).toContainText(model);
  await card.locator('.turn-provenance__summary').click();
}

/** Picks a model through the composer's real picker. */
async function selectComposerModel(page: Page, optionName: RegExp) {
  const modelButton = page.getByRole('button', { name: /^Model:/ });
  await expect(modelButton).toBeEnabled({ timeout: 10_000 });
  await modelButton.click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await expect(picker).toBeVisible({ timeout: 5_000 });
  await picker.getByRole('option', { name: optionName }).click();
  await expect(picker).toBeHidden({ timeout: 5_000 });
}

/**
 * `TurnActionsMenu.tsx` renders "Fork from here…" as a `menuitem` behind the
 * per-turn "More answer actions" overflow trigger — there is no directly
 * clickable button by this name (`MessageBubble.sessionLineageIdentity.
 * test.tsx:179` asserts exactly that negative). Open the overflow first.
 */
async function forkFromHere(page: Page) {
  await page.getByRole('button', { name: 'More answer actions' }).click();
  await page.getByRole('menuitem', { name: 'Fork from here' }).click();
}

test.describe('daily-driver mid-conversation switching (station#3307)', () => {
  test('in-place model switch: the switched turn dispatches and reports the new model in one conversation', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const shell = await seedDailyDriverShell(page, {
      agents: SHELL_AGENTS,
      conversations: SHELL_CONVERSATIONS,
    });
    await seedDailyDriverChats(page, [
      {
        conversationId: SWITCH_CONVERSATION,
        agentSlug: 'claude',
        title: 'Model switch chat',
        model: MODEL_ALPHA,
      },
    ]);
    await openChat(page, SWITCH_CONVERSATION);
    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    const transcript = transcriptLocator(page);

    // Turn 1 runs on a model this test picked through the same picker the
    // switch will use. Establishing the pre-switch model explicitly (rather
    // than inheriting whatever the reopened session resolved) keeps the
    // before/after comparison a fact about the switch.
    await selectComposerModel(page, /Claude Sonnet 4/);
    await textarea.fill('First turn on the picked model.');
    await textarea.press('Enter');
    await expect
      .poll(() => shell.executionRequests.length, { timeout: 10_000 })
      .toBe(1);
    const firstRequest = shell.executionRequests[0]!;
    expect(
      firstRequest.target?.model?.override,
      'turn 1 must dispatch the model picked before the switch',
    ).toBe(MODEL_ALPHA);
    const firstModel = firstRequest.target?.model?.override ?? '';
    await completeDispatchedTurn(page, {
      threadId: SWITCH_CONVERSATION,
      turnId: 'dd-switch-turn-1',
      provider: 'claude',
      userText: 'First turn on the picked model.',
      reply: 'First reply before the switch.',
      metadata: { effectiveModel: firstModel, reportedModel: firstModel },
    });
    await expect(
      transcript.getByText('First reply before the switch.', { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    await expectSettled(page);
    await expectCardReportsModel(page, 'dd-switch-turn-1', MODEL_ALPHA);
    // The shared shell's dispatch table (`daily-driver-shell.ts`) mirrors the
    // real product's one-Session-per-turn continuation contract: it 409s
    // ("Current Session is not terminal") a second dispatch on the same
    // conversation until the prior turn's Session is marked terminal, exactly
    // the transition `conversation-agreement` and `performance-stress` drive
    // explicitly after every turn. Switching models in place still dispatches
    // the next turn as a continuation, so it needs the same step.
    await shell.markCurrentSessionTerminal(SWITCH_CONVERSATION);

    // Switch the model IN PLACE through the composer's model picker.
    await selectComposerModel(page, /Claude Haiku Mid Switch/);
    // The composer names the switched model, so the switch is visible session
    // state rather than a silent per-turn side effect.
    await expect(
      page.getByRole('button', { name: /^Model:/ }),
      'the composer must name the model the next turn will ask for',
    ).toHaveAccessibleName(/Claude Haiku Mid Switch/, { timeout: 5_000 });

    // Turn 2 in the SAME conversation must dispatch the new model, and the
    // switched turn's provenance card must report it.
    await textarea.fill('Second turn after the switch.');
    await textarea.press('Enter');
    await expect
      .poll(() => shell.executionRequests.length, { timeout: 10_000 })
      .toBe(2);
    const secondRequest = shell.executionRequests[1]!;
    expect(
      secondRequest.conversationId,
      'the model switch must stay in the same conversation',
    ).toBe(SWITCH_CONVERSATION);
    expect(
      secondRequest.target?.model?.override,
      'turn 2 must dispatch the switched model override',
    ).toBe(MODEL_BRAVO);
    const secondModel = secondRequest.target?.model?.override ?? '';
    // Continuation assigns a NEW child Session id (the shell's dispatch
    // table never reuses the predecessor's), so turn 2's events must be
    // stamped with that id — not the terminal turn-1 Session — or they
    // target a Session the currently-open tab no longer points at.
    const secondSessionId = shell.sessionIds(SWITCH_CONVERSATION).at(-1);
    if (!secondSessionId)
      throw new Error('model-switch dispatch returned no child Session');
    await completeDispatchedTurn(page, {
      threadId: secondSessionId,
      turnId: 'dd-switch-turn-2',
      provider: 'claude',
      userText: 'Second turn after the switch.',
      reply: 'Second reply after the switch.',
      metadata: { effectiveModel: secondModel, reportedModel: secondModel },
    });
    await expect(
      transcript.getByText('Second reply after the switch.', { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    await expectSettled(page);
    await expectCardReportsModel(page, 'dd-switch-turn-2', MODEL_BRAVO);
    // The earlier turn's provenance still names the model IT ran on — a
    // switch must not rewrite history.
    await expectCardReportsModel(page, 'dd-switch-turn-1', MODEL_ALPHA);
  });

  test('same-provider fork retries idempotently, opens one child, and then diverges without replacing its parent', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const childId = 'dd-fork-child-same-provider';
    const forkBodies: Array<Record<string, unknown>> = [];
    const childMessages: Record<string, Array<Record<string, unknown>>> = {};
    let attempt = 0;
    const shell = await seedDailyDriverShell(page, {
      agents: SHELL_AGENTS,
      conversations: SHELL_CONVERSATIONS,
      messagesByConversation: childMessages,
      extraRoutes: async (path, route) => {
        if (
          path ===
            `/api/agents/claude/conversations/${FORK_CONVERSATION}/fork` &&
          route.request().method() === 'POST'
        ) {
          forkBodies.push(route.request().postDataJSON());
          attempt += 1;
          childMessages[childId] = [
            {
              id: 'fork-child-user',
              role: 'user',
              parts: [{ type: 'text', text: 'Parent branch prompt.' }],
            },
            {
              id: 'fork-child-answer',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Parent branch answer.' }],
              metadata: {
                turnId: 'dd-fork-source-turn',
                answerEligible: true,
              },
            },
          ];
          if (attempt === 1) {
            // The server committed the deterministic child, but the response
            // was lost. Retrying must reuse the same key and resolve that one
            // child rather than create another.
            await route.abort('failed');
            return true;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                conversationId: childId,
                branchPointTurnId: 'dd-fork-source-turn',
                continuation: 'replay-seed',
                disclosure:
                  'Station replay carries the selected transcript only. Engine cursor, tool state, and approval state do not carry.',
                idempotent: true,
              },
            }),
          });
          return true;
        }
        return false;
      },
    });
    await seedDailyDriverChats(page, [
      {
        conversationId: FORK_CONVERSATION,
        agentSlug: 'claude',
        title: 'Fork source chat',
        model: MODEL_BRAVO,
      },
    ]);
    await openChat(page, FORK_CONVERSATION);
    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await textarea.fill('Parent branch prompt.');
    await textarea.press('Enter');
    await expect.poll(() => shell.executionRequests.length).toBe(1);
    await completeDispatchedTurn(page, {
      threadId: FORK_CONVERSATION,
      turnId: 'dd-fork-source-turn',
      provider: 'claude',
      userText: 'Parent branch prompt.',
      reply: 'Parent branch answer.',
      metadata: { effectiveModel: MODEL_BRAVO, reportedModel: MODEL_BRAVO },
    });
    await expectSettled(page);

    await forkFromHere(page);
    const dialog = page.getByRole('dialog', { name: 'Fork from here' });
    await expect(dialog).toContainText('New independent conversation');
    await expect(dialog).toContainText('Engine cursor');
    await expect(dialog).toContainText('tool state');
    await expect(dialog).toContainText('approval state do not carry');
    const sourceAgent = dialog.locator('button[data-agent-slug="claude"]');
    await expect(sourceAgent).toHaveClass(/new-chat-modal__agent--selected/);
    await sourceAgent.click();
    await expect(dialog.getByRole('alert')).toContainText(/failed|fetch/i);
    await sourceAgent.click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBe(childId);
    expect(forkBodies).toHaveLength(2);
    expect(forkBodies[0]?.idempotencyKey).toBe(forkBodies[1]?.idempotencyKey);
    expect(forkBodies[1]).toMatchObject({
      targetAgent: 'claude',
      branchPointTurnId: 'dd-fork-source-turn',
    });
    await expect(
      transcriptLocator(page).getByText('Parent branch answer.', {
        exact: true,
      }),
    ).toBeVisible();

    await textarea.fill('Child-only divergent turn.');
    await textarea.press('Enter');
    await expect.poll(() => shell.executionRequests.length).toBe(2);
    expect(shell.executionRequests[1]?.conversationId).toBe(childId);
    expect(shell.executionRequests[1]?.target?.model?.override).toBe(
      MODEL_BRAVO,
    );
    expect(shell.executionRequests[0]?.conversationId).toBe(FORK_CONVERSATION);
    await page.goto(`/?dock=open&maximize=true&chat=${FORK_CONVERSATION}`);
    await expect(
      transcriptLocator(page).getByText('Parent branch answer.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('alternate-Agent fork is explicitly replay fallback and opens the returned child', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const childId = 'dd-fork-child-alternate';
    const forkBodies: Array<Record<string, unknown>> = [];
    const childMessages: Record<string, Array<Record<string, unknown>>> = {};
    const shell = await seedDailyDriverShell(page, {
      agents: SHELL_AGENTS,
      conversations: SHELL_CONVERSATIONS,
      messagesByConversation: childMessages,
      extraRoutes: async (path, route) => {
        if (
          path === `/api/agents/claude/conversations/${FORK_CONVERSATION}/fork`
        ) {
          forkBodies.push(route.request().postDataJSON());
          childMessages[childId] = [
            {
              id: 'alternate-fork-user',
              role: 'user',
              parts: [{ type: 'text', text: 'Cross-engine parent.' }],
            },
            {
              id: 'alternate-fork-answer',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Cross-engine answer.' }],
              metadata: {
                turnId: 'dd-alternate-fork-turn',
                answerEligible: true,
              },
            },
          ];
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                conversationId: childId,
                continuation: 'replay-seed',
                disclosure:
                  'Station replay carries the selected transcript only. Engine cursor, tool state, and approval state do not carry.',
                idempotent: false,
              },
            }),
          });
          return true;
        }
        return false;
      },
    });
    await seedDailyDriverChats(page, [
      {
        conversationId: FORK_CONVERSATION,
        agentSlug: 'claude',
        title: 'Fork source chat',
        model: MODEL_ALPHA,
      },
    ]);
    await openChat(page, FORK_CONVERSATION);
    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await textarea.fill('Cross-engine parent.');
    await textarea.press('Enter');
    await expect.poll(() => shell.executionRequests.length).toBe(1);
    await completeDispatchedTurn(page, {
      threadId: FORK_CONVERSATION,
      turnId: 'dd-alternate-fork-turn',
      provider: 'claude',
      userText: 'Cross-engine parent.',
      reply: 'Cross-engine answer.',
    });
    await expectSettled(page);
    await forkFromHere(page);
    const dialog = page.getByRole('dialog', { name: 'Fork from here' });
    await dialog.locator('button[data-agent-slug="codex"]').click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBe(childId);
    expect(forkBodies[0]).toMatchObject({
      targetAgent: 'codex',
      branchPointTurnId: 'dd-alternate-fork-turn',
    });
  });

  test('Agent handoff uses the Continue-with dialog, reset disclosure, explicit route, and durable boundary', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const handoffRequests: Array<Record<string, unknown>> = [];
    let handoffAccepted = false;
    let idempotencyKey = '';
    let acceptedSessionId = '';
    await seedDailyDriverShell(page, {
      agents: SHELL_AGENTS,
      conversations: SHELL_CONVERSATIONS,
      conversationLineageWindow: false,
      extraRoutes: async (path, route) => {
        if (
          path ===
            `/api/orchestration/conversations/${HANDOFF_CONVERSATION}/handoff` &&
          route.request().method() === 'POST'
        ) {
          const body = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
          handoffRequests.push(body);
          idempotencyKey = String(body.idempotencyKey);
          handoffAccepted = true;
          const receipt = foregroundMessageReceipt({
            conversationId: HANDOFF_CONVERSATION,
            sessionId: HANDOFF_SESSION,
            providerTurnId: 'dd-handoff-turn',
            agent: 'codex',
            resolution: {
              environmentId: environmentId(
                '11111111-1111-4111-8111-111111111111',
              ),
              engine: {
                kind: 'connection',
                connectionId: engineConnectionId('codex'),
              },
              provider: 'codex',
            },
          });
          acceptedSessionId = receipt.sessionId;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                ...receipt,
                handoff: {
                  predecessorSessionId: HANDOFF_CONVERSATION,
                  sessionId: HANDOFF_SESSION,
                  currentSessionId: HANDOFF_SESSION,
                  outcome: 'created',
                  target: {
                    agentId: 'codex',
                    engine: {
                      kind: 'connection',
                      connectionId: 'codex',
                    },
                    modelId: 'gpt-5-codex',
                  },
                  carried: [...CONVERSATION_HANDOFF_CARRIED_FIELDS],
                  reset: [...CONVERSATION_HANDOFF_RESET_FIELDS],
                },
              },
            }),
          });
          return true;
        }
        if (
          path.startsWith(
            `/api/orchestration/conversations/${HANDOFF_CONVERSATION}/event-window`,
          )
        ) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                protocolVersion: 1,
                conversationId: HANDOFF_CONVERSATION,
                currentSessionId: handoffAccepted
                  ? HANDOFF_SESSION
                  : HANDOFF_CONVERSATION,
                events: [],
                handoffs: handoffAccepted
                  ? [
                      {
                        predecessorSessionId: HANDOFF_CONVERSATION,
                        sessionId: HANDOFF_SESSION,
                        idempotencyKey,
                        targetAgentId: 'codex',
                        targetConnectionId: 'codex',
                        targetModelId: 'gpt-5-codex',
                        createdAt: '2026-08-24T00:00:00.000Z',
                        carried: [...CONVERSATION_HANDOFF_CARRIED_FIELDS],
                        reset: [...CONVERSATION_HANDOFF_RESET_FIELDS],
                      },
                    ]
                  : [],
                hasMore: false,
                watermark: 0,
              },
            }),
          });
          return true;
        }
        return false;
      },
    });
    await seedDailyDriverChats(page, [
      {
        conversationId: HANDOFF_CONVERSATION,
        agentSlug: 'claude',
        title: 'Agent handoff chat',
        model: MODEL_ALPHA,
      },
    ]);
    await openChat(page, HANDOFF_CONVERSATION);

    await page.getByRole('button', { name: 'Composer actions' }).click();
    await page.getByRole('menuitem', { name: /Continue with/ }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Continue with another Agent',
    });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('radio', { name: /Codex Runtime/ }).check();
    await expect(dialog).toContainText('Conversation transcript');
    await expect(dialog).toContainText('Provider-native cursor');
    await expect(dialog).toContainText('Tool state');
    await expect(dialog).toContainText('Session approvals');
    await expect(dialog).toContainText('Queued requests');
    await dialog
      .getByLabel('First message to Codex Runtime')
      .fill('Continue on Codex and retain the conversation context.');
    await dialog
      .getByRole('button', { name: /Continue with Codex Runtime/ })
      .click();

    await expect
      .poll(() => handoffRequests.length, { timeout: 10_000 })
      .toBe(1);
    expect(handoffRequests[0]).toMatchObject({
      message: 'Continue on Codex and retain the conversation context.',
      target: {
        environment: { kind: 'current' },
        agent: 'codex',
      },
    });
    expect(handoffRequests[0]?.idempotencyKey).toEqual(expect.any(String));

    const boundary = page.getByRole('region', {
      name: /Continued with Codex Runtime/,
    });
    await expect(boundary).toBeVisible({ timeout: 10_000 });
    await boundary.getByText('What carried and reset').click();
    await expect(boundary).toContainText('Conversation transcript');
    await expect(boundary).toContainText('Provider-native cursor');
    const disclosureLabels = [
      ...CONVERSATION_HANDOFF_CARRIED_FIELDS,
      ...CONVERSATION_HANDOFF_RESET_FIELDS,
    ].map((field) => CONVERSATION_HANDOFF_DISCLOSURE_LABELS[field]);
    const disclosureComplete = (
      await Promise.all(
        disclosureLabels.map((label) =>
          boundary.getByText(label, { exact: true }).isVisible(),
        ),
      )
    ).every(Boolean);
    await attachHandoffObservation(testInfo, {
      profile: 'claude-default',
      surface: 'ui',
      scenario: 'agent-engine-handoff',
      capability: 'agent-engine-handoff',
      repetition: 1,
      targetProfile: 'codex-default',
      explicitRouteUsed: handoffRequests.length === 1,
      conversationStable:
        new URL(page.url()).searchParams.get('chat') === HANDOFF_CONVERSATION,
      targetSessionDistinct: acceptedSessionId !== HANDOFF_CONVERSATION,
      disclosureComplete,
      targetAgentApplied:
        (handoffRequests[0]?.target as { agent?: string })?.agent === 'codex',
      persistedMarker: await boundary.isVisible(),
      markerExactlyOnce: (await boundary.count()) === 1,
    });
  });
});
