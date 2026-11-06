import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  AdoptedSessionResult,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import type {
  ProjectSharedTaskHistory,
  ProjectSharedTaskSummary,
} from '@kontourai/station-contracts/project-shared-task';
import type { ProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { expect } from '@playwright/test';
import {
  buildLongSessionTurns,
  createLongSessionEventWindowHandler,
} from './fixtures/long-session';
import { rejectUnexpectedFixtureRequest } from './helpers/fixture-audit';
import { installMockOrchestrationSse } from './helpers/orchestration';
import {
  addDirectReceiver,
  captureConnectionState,
  ensureConnectionInboxOpen,
  startConnectionChat,
  stationJson,
  test,
} from './helpers/peer-chat-stations';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';

test.use({ hostModel: true });
test.setTimeout(600_000);

test('host and peer dock adopt the same writable conversation controls', async ({
  page,
  stations,
}, testInfo) => {
  test.setTimeout(600_000);
  const { streams } = stations;
  await startConnectionChat(page, 'host', 'Check the local project.');
  const transcript = page.getByRole('log', { name: 'Conversation transcript' });
  await expect.poll(() => streams.length).toBe(1);
  expect(streams[0]!.station).toBe('source');
  streams[0]!.stream.text('Local text arrives while the provider is running.');
  await expect(transcript).toContainText(
    'Local text arrives while the provider is running.',
  );
  await captureConnectionState(page, testInfo, 'host-streaming');
  expect(streams[0]!.offeredTools).toContain(
    'stationDocs_listStationDocsTopics',
  );
  streams[0]!.stream.tool(
    'stationDocs_listStationDocsTopics',
    {},
    'host-topics',
  );
  streams[0]!.stream.finish('tool_calls');
  await expect(
    transcript.getByRole('button', { name: 'Allow Once', exact: true }),
  ).toBeEnabled();
  await captureConnectionState(page, testInfo, 'host-approval');
  await page.getByRole('button', { name: 'Allow Once', exact: true }).click();
  await expect.poll(() => streams.length).toBe(2);
  streams[1]!.stream.text('Local approval completed.');
  streams[1]!.stream.finish();
  await expect(transcript).toContainText('Local approval completed.');
  await expect(page.getByPlaceholder(/^Type a message/)).toBeEditable();
  await captureConnectionState(page, testInfo, 'host-idle');
  const localDraft = 'Keep the local draft while receiver events arrive.';
  await page.getByPlaceholder(/^Type a message/).fill(localDraft);
  await startConnectionChat(
    page,
    'relay',
    'Use the receiver with the same composer.',
  );
  await expect.poll(() => streams.length).toBe(3);
  expect(streams[2]!.station).toBe('receiver');
  streams[2]!.stream.text('Receiver uses the shared conversation body.');
  streams[2]!.stream.finish();
  await expect(transcript).toContainText(
    'Receiver uses the shared conversation body.',
  );
  await expect(page.getByPlaceholder(/^Type a message/)).toBeEditable();
  await expect(page.getByText('Via Receiver', { exact: true })).toBeVisible();
  const paired = await addDirectReceiver(page, stations.receiver);
  const composer = page.getByPlaceholder(/^Type a message/);
  const stillRelayed = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname.includes(
        '/chat-api/api/orchestration/chat',
      ),
  );
  await composer.fill('Keep the existing relay principal.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await stillRelayed;
  await expect.poll(() => streams.length).toBe(4);
  streams[3]!.stream.text('Existing chat stayed on its relay.');
  streams[3]!.stream.finish();
  await expect(transcript).toContainText('Existing chat stayed on its relay.');
  const directRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url() === `${stations.receiver.api}/api/orchestration/chat`,
  );
  await startConnectionChat(
    page,
    'relay',
    'Prefer the independently paired direct route.',
  );
  const direct = await directRequest;
  // Reduce credential comparison to a boolean so assertion output cannot disclose it.
  expect(
    (await direct.headerValue('authorization')) ===
      `Bearer ${paired.credential}`,
  ).toBe(true);
  await expect.poll(() => streams.length).toBe(5);
  streams[4]!.stream.text('The new chat uses the direct receiver Device.');
  await expect(transcript).toContainText(
    'The new chat uses the direct receiver Device.',
  );
  await expect(
    page.getByText('Via Direct Receiver', { exact: true }),
  ).toBeVisible();
  await captureConnectionState(page, testInfo, 'direct-streaming');
  streams[4]!.stream.finish();
  await expect(composer).toBeEditable();
  await captureConnectionState(page, testInfo, 'direct-idle');
  const inbox = await ensureConnectionInboxOpen(page);
  await inbox
    .getByRole('button', { name: /^Check the local project\.,/ })
    .click();
  await expect(transcript).toContainText('Local approval completed.');
  await expect(transcript).not.toContainText(
    'The new chat uses the direct receiver Device.',
  );
  await expect(composer).toHaveValue(localDraft);
  await page.evaluate(() => {
    window.stationConnectionFaults.holdEventReconnects();
    window.stationConnectionFaults.disconnectObservation(true);
    window.stationConnectionFaults.holdDeliveryLookups();
  });
  await page.evaluate(() => window.stationConnectionFaults.loseNextSend());
  await composer.fill('Check this local lost acknowledgement.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => streams.length).toBe(6);
  await expect(
    page.getByRole('button', { name: 'Check', exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText('Check this local lost acknowledgement.', {
      exact: true,
    }),
  ).toHaveCount(1);
  await captureConnectionState(page, testInfo, 'host-uncertain');
  streams[5]!.stream.text('The local uncertain turn ran once.');
  streams[5]!.stream.finish();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.evaluate(() =>
    window.stationConnectionFaults.releaseDeliveryLookups(),
  );
  await expect(
    page.getByRole('button', { name: 'Check', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.stationConnectionFaults.disconnectObservation(false);
    window.stationConnectionFaults.releaseEventReconnects();
  });
  await expect(transcript).toContainText('The local uncertain turn ran once.');
  await stationJson(
    stations.source,
    `/api/pairing/devices/${encodeURIComponent(stations.sourceDeviceId)}/scope`,
    'POST',
    { scope: ['orchestration:read'] },
  );
  await composer.fill('Keep this local refused message editable.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript).toContainText("didn't accept this message.");
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue(
    'Keep this local refused message editable.',
  );
  await expect(transcript).not.toContainText('could not confirm');
  await expect(
    page.getByText('insufficient_scope', { exact: true }),
  ).not.toBeVisible();
  await captureConnectionState(page, testInfo, 'host-refused');
  expect(streams).toHaveLength(6);
});

test('Activity uses the shared record composer and immediate turn interrupt', async ({
  page,
  stations,
}) => {
  const receipt = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/orchestration/chat',
  );
  await startConnectionChat(
    page,
    'host',
    'Read this conversation in Activity.',
  );
  const accepted: { data: { sessionId: string } } = await (
    await receipt
  ).json();
  await expect.poll(() => stations.streams.length).toBe(1);
  stations.streams[0]!.stream.text(
    'Activity retains the same Markdown and composer.',
  );
  stations.streams[0]!.stream.finish();
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('Activity retains the same Markdown and composer.');
  await page.goto(
    new URL(
      activityDeepLink({ sessionId: accepted.data.sessionId }),
      stations.source.ui,
    ).href,
  );
  const detail = page.getByTestId('session-detail');
  await expect(
    detail.locator('[data-conversation-density="record"]'),
  ).toBeVisible();
  await expect(
    detail.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('Activity retains the same Markdown and composer.');
  const composer = detail.getByRole('textbox', {
    name: 'Message',
    exact: true,
  });
  await expect(composer).toBeEditable();
  await composer.fill('Continue from Activity.');
  await detail.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => stations.streams.length).toBe(2);
  stations.streams[1]!.stream.text('This reply started from Activity.');
  await expect(detail.getByRole('log')).toContainText(
    'This reply started from Activity.',
  );
  const interrupted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/orchestration/commands' &&
      request.postDataJSON().type === 'interruptTurn',
  );
  await detail.getByRole('button', { name: 'Stop the current turn' }).click();
  expect((await interrupted).postDataJSON().threadId).toBe(
    accepted.data.sessionId,
  );
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('attached record fixture requires consent and opens the owned child in the real dock', async ({
  page,
  stations,
}) => {
  // Typed domain fixtures qualify the parent UI handoff, not provider adoption/authentication.
  const sourceId = 'external:claude:shared-record-fixture';
  const childId = 'shared-record-owned-child';
  const source: OrchestrationSessionSummary = {
    threadId: sourceId,
    provider: 'claude',
    controlMode: 'read-only-attached',
    status: 'ready',
    lifecycleState: 'idle',
    hasActiveTurn: false,
    answerability: { answerable: true },
    attachedSource: {
      kind: 'claude-transcript',
      externalSessionId: 'shared-record-fixture',
      affinity: { kind: 'fixture-home', ref: 'shared-record-home' },
    },
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:01Z',
  };
  const child: OrchestrationSessionSummary = {
    ...source,
    threadId: childId,
    conversationId: childId,
    provider: 'station-agent',
    controlMode: 'station-owned',
    attachedSource: undefined,
    assignedAgentSlug: agentId('connection-qualification'),
    answerability: { answerable: true },
  };
  const adoption: AdoptedSessionResult = {
    threadId: childId,
    provider: child.provider,
    controlMode: 'station-owned',
    status: 'ready',
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
  };
  let continued = false;
  const commands: string[] = [];
  await installMockOrchestrationSse(page);
  await page.route(
    '**/api/orchestration/sessions/read-model',
    async (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      await route.fulfill({
        json: { success: true, data: continued ? [source, child] : [source] },
      });
    },
  );
  for (const session of [source, child]) {
    const encoded = encodeURIComponent(session.threadId);
    await page.route(`**/api/orchestration/sessions/${encoded}`, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: { success: true, data: { session, events: [] } },
          })
        : rejectUnexpectedFixtureRequest(route),
    );
    await page.route(
      `**/api/orchestration/sessions/${encoded}/event-window**`,
      createLongSessionEventWindowHandler({
        threadId: session.threadId,
        provider: session.provider,
        availableTurns: () =>
          buildLongSessionTurns({
            threadId: session.threadId,
            provider: session.provider,
            turnCount: 1,
            promptText: () => 'Read the original conversation.',
            replyText: () => 'The original transcript stays available.',
          }),
      }),
    );
  }
  await mockRuntimeConversation(page, {
    id: childId,
    agentSlug: 'connection-qualification',
    title: 'Owned continuation',
    provider: 'station-agent',
    model: 'station-connection-qualification:latest',
    canContinue: true,
    turns: () =>
      buildLongSessionTurns({
        threadId: childId,
        provider: 'station-agent',
        turnCount: 1,
        promptText: () => 'Continue this exact draft.',
        replyText: () => 'The owned child is open.',
      }),
  });
  await page.route('**/api/starter-work/continue-session', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            success: true,
            data: {
              state: 'bound',
              binding: {
                schemaVersion: 1,
                starterId: 'continue-session',
                targetRef: { kind: 'session', id: sourceId },
                operationId: 'starter-session:shared-record',
                boundAt: source.createdAt,
              },
            },
          },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  await page.route('**/api/orchestration/commands', async (route) => {
    if (route.request().method() !== 'POST')
      return rejectUnexpectedFixtureRequest(route);
    const command: { type: string; sourceThreadId?: string } = route
      .request()
      .postDataJSON();
    commands.push(command.type);
    if (command.type !== 'adoptSession' || command.sourceThreadId !== sourceId)
      return rejectUnexpectedFixtureRequest(route);
    continued = true;
    await route.fulfill({
      status: 201,
      json: { success: true, data: adoption },
    });
  });
  await page.route(`**/api/orchestration/chat/${childId}/continue`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          json: {
            success: true,
            data: {
              conversationId: childId,
              sessionId: childId,
              providerTurnId: 'owned-turn',
            },
          },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  await page.goto(
    new URL(activityDeepLink({ sessionId: sourceId }), stations.source.ui).href,
  );
  const detail = page.getByTestId('session-detail');
  await expect(
    detail.locator('[data-conversation-density="record"]'),
  ).toBeVisible();
  await expect(detail.getByRole('log')).toContainText(
    'The original transcript stays available.',
  );
  await expect(
    detail.getByRole('button', { name: 'Stop the current turn' }),
  ).toHaveCount(0);
  await detail
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Continue this exact draft.');
  await detail
    .getByRole('button', { name: 'Continue in Station', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Continue here?' }),
  ).toBeVisible();
  expect(commands).toEqual([]);
  await page.getByRole('button', { name: 'Continue and send' }).click();
  await expect.poll(() => commands).toEqual(['adoptSession']);
  await expect(
    page
      .getByRole('log', { name: 'Conversation transcript' })
      .filter({ hasText: 'The owned child is open.' }),
  ).toBeVisible();
});

// Consumer fixtures prove shared rendering and paging. The real guest access
// boundary remains in project-guest-shared-task-live.spec.ts (smoke-live).
for (const access of ['owner', 'member', 'guest'] as const) {
  test(
    access + ' history keeps admitted records through a failed page and Retry',
    async ({ page, stations }, testInfo) => {
      const created = await stationJson<{ data: { id: string; slug: string } }>(
        stations.source,
        '/api/projects',
        'POST',
        { name: 'History ' + access, slug: 'history-' + access },
      );
      const project = created.data;
      const task = (
        await stationJson<{ data: { id: string; createdAt: string } }>(
          stations.source,
          '/api/tasks',
          'POST',
          { projectId: project.slug, title: 'Shared connection history' },
        )
      ).data;
      const summary: ProjectSharedTaskSummary = {
        version: 'station.shared-project-task/v1',
        project: {
          stationId: 'history-station',
          localProjectId: project.id,
          localProjectSlug: project.slug,
          portableProjectId: 'portable-history',
        },
        task: {
          id: task.id,
          createdAt: task.createdAt,
          title: 'Shared connection history',
          status: 'in_progress',
        },
        shareId: '11111111-1111-4111-8111-111111111111',
        sharedAt: '2026-11-05T00:00:00Z',
      };
      const checkpoint = {
        throughSeq: 2,
        checkpointDigest: 'b'.repeat(64),
        retainedAnchorSeq: 0,
        retainedAnchorDigest: 'c'.repeat(64),
      };
      const first: ProjectSharedTaskHistory & { kind: 'available' } = {
        kind: 'available',
        records: [
          {
            sequence: 1,
            actor: { kind: 'human', label: 'Brian' },
            body: { kind: 'human-message', text: 'A **published decision**' },
            integrity: 'L0',
            digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
          },
        ],
        checkpoint,
        hasMore: true,
        nextCursor: 'fixed-history-two',
      };
      const second: ProjectSharedTaskHistory & { kind: 'available' } = {
        ...first,
        records: [
          {
            ...first.records[0]!,
            sequence: 2,
            body: {
              kind: 'human-message',
              text: 'The next published decision',
            },
          },
        ],
        hasMore: false,
        nextCursor: undefined,
      };
      let pageAttempts = 0;
      const historyPath =
        access === 'owner'
          ? '/api/tasks/' + encodeURIComponent(task.id) + '/room/history'
          : '/api/projects/' +
            project.slug +
            '/shared-work/' +
            encodeURIComponent(task.id) +
            '/history';
      await page.route('**' + historyPath + '**', async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        if (access === 'owner') {
          // The real initial room snapshot invalidates history. Admit the
          // fixture checkpoint only after that snapshot has reached its UI.
          await expect(
            page.locator(
              '[data-station-performance-surface="task-room-presence"]',
            ),
          ).toHaveAttribute('data-viewer-actor-id', /.+/);
        }
        const cursor = new URL(route.request().url()).searchParams.get(
          'cursor',
        );
        if (cursor) {
          expect(cursor).toBe('fixed-history-two');
          if (++pageAttempts === 1)
            return route.fulfill({
              status: 503,
              json: {
                success: false,
                error: 'private_history_machine_code',
              },
            });
        }
        const data = cursor ? second : first;
        const ownerPage: ProjectTaskRoomBrowserHistory = {
          ...data,
          integrity: 'L0',
        };
        return route.fulfill({
          json: { success: true, data: access === 'owner' ? ownerPage : data },
        });
      });
      if (access === 'owner') {
        await stationJson(
          stations.source,
          '/api/tasks/' + encodeURIComponent(task.id) + '/room',
        );
        await page.goto(
          stations.source.ui + '/tasks/' + encodeURIComponent(task.id),
        );
        await page
          .getByRole('tab', { name: 'Conversation', exact: true })
          .click();
      } else {
        const memberProject = {
          version: 'station.member-project/v1',
          kind: 'member-project',
          id: project.id,
          slug: project.slug,
          name: 'Shared history Project',
          actions: ['view'],
        };
        await page.route('**/api/projects/' + project.slug, (route) =>
          route.request().method() === 'GET'
            ? route.fulfill({ json: { success: true, data: memberProject } })
            : rejectUnexpectedFixtureRequest(route),
        );
        await page.route(
          '**/api/projects/' + project.slug + '/shared-work',
          (route) =>
            route.request().method() === 'GET'
              ? route.fulfill({ json: { success: true, data: [summary] } })
              : rejectUnexpectedFixtureRequest(route),
        );
        await page.route(
          '**/api/projects/' +
            project.slug +
            '/shared-work/' +
            encodeURIComponent(task.id) +
            '/publication',
          (route) =>
            route.fulfill({
              json: {
                success: true,
                data: { kind: 'shared', publication: summary },
              },
            }),
        );
        await page.route(
          '**/api/projects/' +
            project.slug +
            '/shared-work/' +
            encodeURIComponent(task.id) +
            '/document',
          (route) =>
            route.fulfill({
              json: { success: true, data: { kind: 'unavailable' } },
            }),
        );
        if (access === 'guest') {
          // The guest entry must not retain the owner's Device cookie.
          await page.context().clearCookies();
          await page.route('**/api/account-auth', (route) =>
            route.fulfill({
              json: {
                version: 'station.authentication/v1',
                issuer: 'station:test',
                displayName: 'Shared Station',
                sessionCookies: ['account_session'],
                endpoints: [],
              },
            }),
          );
          await page.route('**/api/account-auth/session', (route) =>
            route.fulfill({
              json: {
                data: {
                  principal: {
                    id: 'human:deployment:' + 'a'.repeat(64),
                    kind: 'human',
                    display: 'Guest',
                  },
                  issuer: 'station:test',
                  expiresAt: '2099-01-01T00:00:00Z',
                  contacts: [],
                },
              },
            }),
          );
          await page.route('**/api/auth/authority', (route) =>
            route.request().method() === 'GET'
              ? route.fulfill({
                  json: {
                    schemaVersion: 'station.authority-observation/v1',
                    environmentId: 'history-station',
                    principal: {
                      kind: 'human',
                      id: 'human:deployment:' + 'a'.repeat(64),
                    },
                    grant: {
                      kind: 'device',
                      deviceId: 'history-guest-device',
                      grantedScopes: ['orchestration:read'],
                    },
                  },
                })
              : rejectUnexpectedFixtureRequest(route),
          );
          await page.route(
            '**/api/projects/' + project.slug + '/access',
            (route) =>
              route.request().method() === 'GET'
                ? route.fulfill({
                    status: 403,
                    json: {
                      success: false,
                      error: 'project_access_forbidden',
                      code: 'project_access_forbidden',
                    },
                  })
                : rejectUnexpectedFixtureRequest(route),
          );
          await page.route('**/api/projects', (route) =>
            route.request().method() === 'GET'
              ? route.fulfill({
                  json: { success: true, data: [memberProject] },
                })
              : rejectUnexpectedFixtureRequest(route),
          );
          await page.goto(stations.source.ui + '/account');
          await page
            .getByRole('button', { name: 'Read Project details' })
            .click();
          await page.getByRole('button', { name: 'Read shared Task' }).click();
          await expect(
            page.getByRole('region', { name: 'People and access' }),
          ).toContainText(
            'People and invitation management is limited to Project admins.',
          );
          await expect(
            page.getByText(/This browser’s approval changed/),
          ).toHaveCount(0);
        } else {
          await page.goto(
            stations.source.ui + '/projects/' + project.slug + '?section=tasks',
          );
          await page
            .getByRole('button', {
              name: 'Read shared item: Shared connection history',
            })
            .click();
        }
      }
      const list = page.getByRole('list', {
        name:
          access === 'owner' ? 'Task room history' : 'Shared history records',
      });
      await expect(
        list.getByText('published decision', { exact: true }),
      ).toBeVisible();
      if (access !== 'owner')
        await page
          .getByRole('button', { name: 'Load earlier messages' })
          .click();
      await expect(
        page.getByRole('button', { name: 'Retry', exact: true }),
      ).toBeVisible();
      await expect(list).toContainText('A published decision');
      await expect(
        page.getByText('private_history_machine_code', { exact: true }),
      ).toHaveCount(0);
      await expect(list.locator('pre')).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(list).toContainText('The next published decision');
      expect(pageAttempts).toBe(2);
      await captureConnectionState(
        page,
        testInfo,
        access + '-paged-history',
        'history',
      );
      if (access === 'member') {
        await page.route(
          '**/api/projects/' +
            project.slug +
            '/shared-work/' +
            encodeURIComponent(task.id) +
            '/publication',
          (route) =>
            route.fulfill({
              json: {
                success: true,
                data: {
                  kind: 'unshared',
                  project: summary.project,
                  task: summary.task,
                },
              },
            }),
        );
        await page
          .getByRole('button', { name: 'Refresh publication status' })
          .click();
        await expect(list).toHaveCount(0);
        await expect(
          page.getByText('A published decision', { exact: true }),
        ).toHaveCount(0);
      }
    },
  );
}

for (const layout of ['desktop', 'mobile'] as const) {
  test(
    layout +
      ' Inbox search and keyboard selection retain the latest reader after a stale response',
    async ({ page, stations }, testInfo) => {
      await page.setViewportSize({
        width: layout === 'mobile' ? 390 : 1440,
        height: 900,
      });
      await startConnectionChat(
        page,
        'host',
        'Keep the current chat available.',
      );
      await expect.poll(() => stations.streams.length).toBe(1);
      stations.streams[0]!.stream.text('Current chat is ready.');
      stations.streams[0]!.stream.finish();
      await expect(
        page.getByRole('log', { name: 'Conversation transcript' }),
      ).toContainText('Current chat is ready.');
      const existing = await stationJson<{
        data: OrchestrationSessionSummary[];
      }>(stations.source, '/api/orchestration/sessions/read-model');
      const summaries: OrchestrationSessionSummary[] = ['first', 'latest'].map(
        (name, index) => ({
          threadId: 'external:claude:inbox-' + name,
          provider: 'claude',
          controlMode: 'read-only-attached',
          status: 'ready',
          lifecycleState: 'idle',
          hasActiveTurn: false,
          answerability: { answerable: true },
          attachedSource: {
            kind: 'claude-transcript',
            externalSessionId: 'inbox-' + name,
            affinity: { kind: 'fixture-home', ref: 'inbox-fixture' },
          },
          isLoaded: true,
          isPersisted: true,
          eventCount: 2,
          displayTitle:
            name === 'first' ? 'First cold selection' : 'Latest cold selection',
          createdAt: '2026-11-05T00:00:00Z',
          updatedAt: '2026-11-05T00:00:0' + index + 'Z',
        }),
      );
      await page.route('**/api/orchestration/sessions/read-model', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              json: { success: true, data: [...existing.data, ...summaries] },
            })
          : rejectUnexpectedFixtureRequest(route),
      );
      let releaseFirst: () => void = () => {};
      let firstRequestObserved = false;
      const released = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      for (const [index, session] of summaries.entries()) {
        const id = encodeURIComponent(session.threadId);
        const turns = buildLongSessionTurns({
          threadId: session.threadId,
          provider: 'claude',
          turnCount: 1,
          replyText: () =>
            index === 0 ? 'Old reader response' : 'Latest reader response',
        });
        await mockRuntimeConversation(page, {
          id: session.threadId,
          agentSlug: 'connection-qualification',
          title: session.displayTitle!,
          provider: 'claude',
          model: 'fixture',
          canContinue: false,
          turns: () => turns,
        });
        await page.route(
          '**/api/orchestration/sessions/' + id,
          async (route) => {
            if (route.request().method() !== 'GET')
              return rejectUnexpectedFixtureRequest(route);
            if (index === 0) {
              firstRequestObserved = true;
              await released;
            }
            return route.fulfill({
              json: { success: true, data: { session, events: [] } },
            });
          },
        );
        await page.route(
          '**/api/orchestration/sessions/' + id + '/event-window**',
          createLongSessionEventWindowHandler({
            threadId: session.threadId,
            provider: 'claude',
            availableTurns: () => turns,
          }),
        );
      }
      await page.reload();
      await expect(
        page.getByRole('log', { name: 'Conversation transcript' }),
      ).toContainText('Current chat is ready.');
      const inbox = await ensureConnectionInboxOpen(page);
      if (layout === 'mobile')
        await inbox.getByRole('button', { name: 'Search inbox' }).click();
      const search = inbox.getByRole('searchbox', {
        name: 'Search chats and tasks',
      });
      if (layout === 'mobile') await expect(search).toBeFocused();
      await search.fill('First cold');
      await expect(
        inbox.getByRole('button', { name: /Latest cold selection,/ }),
      ).toHaveCount(0);
      await inbox
        .getByRole('button', { name: /First cold selection,/ })
        .focus();
      await page.keyboard.press('Enter');
      try {
        await expect.poll(() => firstRequestObserved).toBe(true);
        if (layout === 'mobile') await ensureConnectionInboxOpen(page);
        await search.fill('Latest cold');
        const latest = inbox.getByRole('button', {
          name: /Latest cold selection,/,
        });
        await latest.focus();
        await expect(latest).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('session-detail')).toContainText(
          'Latest reader response',
        );
        const committedUrl = page.url();
        const oldResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            '/api/orchestration/sessions/' +
              encodeURIComponent(summaries[0]!.threadId),
        );
        releaseFirst();
        expect((await oldResponse).status()).toBe(200);
        await expect(page.getByTestId('session-detail')).toContainText(
          'Latest reader response',
        );
        await expect(page.getByTestId('session-detail')).not.toContainText(
          'Old reader response',
        );
        expect(page.url()).toBe(committedUrl);
        expect(
          await page.evaluate(
            () =>
              document.activeElement?.isConnected &&
              document.activeElement !== document.body,
          ),
        ).toBe(true);
        if (layout === 'mobile') await ensureConnectionInboxOpen(page);
        await search.fill('First cold');
        const firstTitle = 'First cold selection';
        const firstRow = inbox.getByRole('button', {
          name: /First cold selection,/,
        });
        await expect(firstRow).toBeVisible();
        if (layout === 'mobile') {
          await inbox
            .getByRole('button', { name: 'Details for ' + firstTitle })
            .click();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '1 hour', exact: true })
            .click();
        } else {
          await firstRow.hover();
          await inbox
            .getByRole('button', { name: 'Snooze ' + firstTitle, exact: true })
            .click();
          await page
            .getByRole('menuitem', { name: '1 hour', exact: true })
            .click();
        }
        const snoozed = inbox.getByRole('button', { name: /^Snoozed/ });
        await expect(snoozed).toContainText('1');
        await snoozed.click();
        if (layout === 'desktop') {
          await firstRow.hover();
          await inbox
            .getByRole('button', {
              name: 'Unsnooze ' + firstTitle,
              exact: true,
            })
            .click();
        } else {
          await inbox
            .getByRole('button', { name: 'Details for ' + firstTitle })
            .click();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: 'Unsnooze', exact: true })
            .click();
        }
        await expect(firstRow).toBeVisible();
        if (layout === 'mobile') {
          const details = inbox.getByRole('button', {
            name: 'Details for ' + firstTitle,
          });
          const bounds = await details.boundingBox();
          expect(bounds?.width).toBeGreaterThanOrEqual(44);
          expect(bounds?.height).toBeGreaterThanOrEqual(44);
          await details.click();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: 'Dismiss from inbox', exact: true })
            .click();
        } else {
          await firstRow.hover();
          await inbox
            .getByRole('button', {
              name: 'Dismiss ' + firstTitle + ' from inbox',
              exact: true,
            })
            .click();
        }
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(firstRow).toBeVisible();
        await search.fill('');
        await captureConnectionState(
          page,
          testInfo,
          layout + '-inbox-latest-selection',
          'inbox',
        );
      } finally {
        releaseFirst();
      }
    },
  );
}
