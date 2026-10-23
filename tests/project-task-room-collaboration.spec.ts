import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectTaskRoomBrowserLiveSnapshot } from '@kontourai/station-contracts/project-task-room-browser';
import type { ProjectTaskRoomLiveCommand } from '@kontourai/station-sdk/client';
import { expect, type Page, type Route } from '@playwright/test';
import {
  seedE2EFirstRunDecision,
  seedE2EUsageTelemetryDisclosure,
} from '../scripts/run-e2e-suite.mjs';
import {
  e2eOperatorAuthorizationHeaders,
  readE2EOperatorCredential,
} from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  createProject,
  createRepository,
  createTaskFromProject,
  type LiveStation,
  pairBrowserDevice,
  publishTaskRoomAgentEdit,
  startStation,
  stopStation,
} from './helpers/live-station-task';
import { pairBrowser } from './live/helpers/station-instance.mjs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface HeldBatch {
  readonly route: Route;
  readonly body: string;
  release(): void;
}

async function installBatchHold(page: Page, pattern: string) {
  const held = deferred<HeldBatch>();
  await page.route(pattern, async (route, request) => {
    const release = deferred<void>();
    held.resolve({
      route,
      body: request.postData() ?? '',
      release: () => release.resolve(),
    });
    await release.promise;
  });
  return held;
}

async function documentReceipt(
  response: Awaited<ReturnType<Page['waitForResponse']>>,
) {
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== 'object' ||
    !('data' in value) ||
    !value.data ||
    typeof value.data !== 'object' ||
    !('kind' in value.data) ||
    (value.data.kind !== 'snapshot' && value.data.kind !== 'delta') ||
    !('revision' in value.data) ||
    typeof value.data.revision !== 'string' ||
    !('text' in value.data) ||
    typeof value.data.text !== 'string'
  )
    throw new Error('Room document response was malformed');
  return {
    revision: value.data.revision,
    text: value.data.text,
  };
}

async function liveFixtureCommand(
  page: Page,
  taskId: string,
  command: ProjectTaskRoomLiveCommand,
  expected = 'updated',
) {
  // Explicit server fixture seam for the retained cursor/watch protocol. The
  // product journey below uses implicit presence and the visible Brief/Chat tabs.
  const response = await page.evaluate(
    async ({ taskId, command }) => {
      const result = await fetch(
        `/api/tasks/${encodeURIComponent(taskId)}/room/live`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
        },
      );
      return { status: result.status, body: await result.json() };
    },
    { taskId, command },
  );
  expect(response.status).toBe(200);
  const envelope = response.body as { data: Record<string, unknown> };
  const snapshot = parseProjectTaskRoomBrowserLiveSnapshot({
    type: 'live',
    ...envelope.data,
  });
  if (!snapshot)
    throw new Error('Live fixture command returned an invalid projection');
  expect(snapshot.result?.outcome).toBe(expected);
  return snapshot;
}

function participants(page: Page) {
  return page
    .getByRole('region', { name: 'Here now' })
    .getByRole('list', { name: 'Live room participants' })
    .getByRole('listitem');
}
async function rawHistory(page: Page) {
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  const disclosure = page
    .locator('details')
    .filter({ has: page.getByText('Raw room history', { exact: true }) });
  await disclosure.locator('summary').click();
  return disclosure.locator('pre');
}
async function expectAgentPresence(
  page: Page,
  taskId: string,
  sessionId: string,
  runId: string,
) {
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  const live = await liveFixtureCommand(
    page,
    taskId,
    { command: 'heartbeat' },
    'refreshed',
  );
  const agent = live.participants.find(
    (participant) =>
      participant.actor.kind === 'agent' &&
      participant.work.sessionId === sessionId,
  );
  expect(agent?.work.runId).toBe(runId);
  if (!agent) throw new Error('Published Agent is missing');
  await expect(
    page.locator(`.task-room-rail [data-actor-id="${agent.actor.actorId}"]`),
  ).toContainText(agent.actor.label);
}

test.describe
  .serial('Project/Task room collaboration visual acceptance (#2890)', () => {
    test.setTimeout(180_000);
    let live: LiveStation;
    let fixtureRoot = '';
    let controlRoot = '';
    let taskRoomControlSocket = '';

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(240_000);
      fixtureRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'station-room-acceptance-')),
      );
      controlRoot = mkdtempSync(join(realpathSync('/tmp'), 'station-room-'));
      taskRoomControlSocket = join(controlRoot, 'control.sock');
      live = await allocateLiveStation(
        'station-room-acceptance-home-',
        'room-acceptance',
      );
      await startStation(live, true, {
        taskRoomControlSocket,
        logFile: testInfo.outputPath(`${live.instance}.log`),
      });
      const credential = readE2EOperatorCredential(live.home);
      await seedE2EFirstRunDecision(live.api, credential);
      await seedE2EUsageTelemetryDisclosure(live.api, credential);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      let stopError: unknown;
      if (live) {
        try {
          await stopStation(live);
        } catch (error) {
          stopError = error;
        }
      }
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
      if (controlRoot) rmSync(controlRoot, { recursive: true, force: true });
      if (
        live?.home &&
        !stopError &&
        testInfo.status === testInfo.expectedStatus
      )
        rmSync(live.home, { recursive: true, force: true });
      if (stopError)
        throw new Error(
          `Failed to stop isolated Station instance ${live.instance}; preserved diagnostic home ${live.home}`,
          { cause: stopError },
        );
    });

    test('shows an actual implicit-presence refusal and recovers when the Task is reopened', async ({
      page,
    }, testInfo) => {
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      const repository = join(fixtureRoot, 'refusal-worktree');
      await createRepository(repository, 'room-refusal');
      await createProject(page, 'room-refusal', repository);
      const pattern = '**/api/tasks/*/room/live';
      let refused = 0;
      // Deliberate command-transport fault: before any membership exists, ask
      // the real server to announce. Forward its canonical forbidden receipt
      // unchanged; do not fabricate success, a snapshot, or membership.
      await page.route(pattern, async (route) => {
        if (
          route.request().method() !== 'POST' ||
          route.request().postDataJSON().command !== 'join' ||
          refused
        ) {
          await route.continue();
          return;
        }
        refused += 1;
        const response = await route.fetch({
          postData: { command: 'announce' },
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({
          success: true,
          data: { kind: 'available', result: { outcome: 'forbidden' } },
        });
        await route.fulfill({ response });
      });
      try {
        await createTaskFromProject(
          page,
          live,
          'room-refusal',
          'Live room refusal',
          repository,
          'room-refusal',
        );
        await page
          .getByRole('tab', { name: 'Conversation', exact: true })
          .click();

        const alert = page
          .getByRole('region', { name: 'Task room conversation' })
          .getByRole('alert')
          .filter({ hasText: 'Presence could not join this Task.' });
        await expect(alert).toBeVisible();
        await expect(
          page.getByRole('button', {
            name: /Join room|Announce work|Leave room/,
          }),
        ).toHaveCount(0);
        expect(refused).toBe(1);
        const visualRoot = mkdtempSync(
          join(process.cwd(), '.kontourai', 'live-refusal-browser-'),
        );
        console.log(`[live-refusal-browser] ${visualRoot}`);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await alert.scrollIntoViewIfNeeded();
          await expect(alert).toBeInViewport();
          await page.screenshot({
            path: testInfo.outputPath(`live-refusal-${width}.png`),
            fullPage: true,
          });
          copyFileSync(
            testInfo.outputPath(`live-refusal-${width}.png`),
            join(visualRoot, `live-refusal-${width}.png`),
          );
        }
        await page.unroute(pattern);
        await page.reload();
        await expect(
          page.getByRole('region', { name: 'Here now' }).getByRole('listitem'),
        ).toHaveCount(1);
        await expect(alert).toHaveCount(0);
        expect(refused).toBe(1);
      } finally {
        await page.unroute(pattern);
      }
    });

    test('implicitly joins, autosaves, converges, revokes, and restores with retained live-command fixtures', async ({
      browser,
      page: owner,
    }, testInfo) => {
      testInfo.setTimeout(180_000);
      await pairBrowser(owner, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      await expect(
        owner.getByRole('region', { name: 'Station access required' }),
      ).toHaveCount(0);

      const repository = join(fixtureRoot, 'shared-worktree');
      await createRepository(repository, 'room-acceptance');
      await createProject(owner, 'room-acceptance', repository);
      const taskId = await createTaskFromProject(
        owner,
        live,
        'room-acceptance',
        'Shared room acceptance',
        repository,
        'room-acceptance',
      );

      const operatorCredential = readE2EOperatorCredential(live.home);
      const paired = await pairBrowserDevice(
        live,
        operatorCredential,
        'Collaboration peer',
      );
      const ownerStorage = await owner.context().storageState();
      const peerStorage = {
        ...ownerStorage,
        cookies: ownerStorage.cookies.filter(
          (cookie) =>
            cookie.name !== 'station-device' &&
            cookie.name !== '__Host-station-device',
        ),
        origins: ownerStorage.origins.map((origin) => ({
          ...origin,
          localStorage: origin.localStorage
            .filter(
              (entry) =>
                entry.name !== 'station-connect-connections-credentials',
            )
            .map((entry) =>
              entry.name === 'station-connect-connections'
                ? {
                    ...entry,
                    value: JSON.stringify(
                      (
                        JSON.parse(entry.value) as Array<
                          Record<string, unknown>
                        >
                      ).map((profile) => ({
                        ...profile,
                        credentialState: 'device-session',
                      })),
                    ),
                  }
                : entry,
            ),
        })),
      };
      const peerContext = await browser.newContext({
        storageState: peerStorage,
      });
      await peerContext.addCookies([
        {
          name: 'station-device',
          value: paired.credential,
          url: live.ui,
          httpOnly: true,
          sameSite: 'Strict',
        },
      ]);
      const peer = await peerContext.newPage();
      try {
        const taskUrl = `${live.ui}/tasks/${encodeURIComponent(taskId)}`;
        await Promise.all([owner.goto(taskUrl), peer.goto(taskUrl)]);
        for (const [name, context] of [
          ['owner', owner],
          ['peer', peer],
        ] as const) {
          const roomProbe = await context.evaluate(async (id) => {
            const response = await fetch(
              `/api/tasks/${encodeURIComponent(id)}/room`,
            );
            return { status: response.status, body: await response.text() };
          }, taskId);
          expect(roomProbe, `${name} room endpoint`).toMatchObject({
            status: 200,
          });
          await expect(
            context.getByRole('tab', { name: 'Overview', exact: true }),
          ).toHaveAttribute('aria-selected', 'true');
          await context
            .getByRole('tab', { name: 'Conversation', exact: true })
            .click();
          await expect(
            context.getByRole('textbox', { name: 'Message the Task' }),
          ).toBeVisible();
          await expect(participants(context)).toHaveCount(2, {
            timeout: 15_000,
          });
        }

        await owner.reload();
        await expect(participants(owner)).toHaveCount(2, { timeout: 15_000 });
        await expect(
          owner.getByRole('button', {
            name: /Join room|Announce work|Leave room/,
          }),
        ).toHaveCount(0);
        const peerActorId = await peer
          .locator('[data-viewer-actor-id]')
          .first()
          .getAttribute('data-viewer-actor-id');
        if (!peerActorId)
          throw new Error('Peer viewer identity is unavailable');
        const paneId = `task-room-editor:${taskId}`;
        await liveFixtureCommand(owner, taskId, {
          command: 'watch',
          paneId,
          targetActorId: peerActorId,
        });
        await liveFixtureCommand(owner, taskId, {
          command: 'follow',
          paneId,
          targetActorId: peerActorId,
        });
        await Promise.all([
          owner.getByRole('tab', { name: 'Plan', exact: true }).click(),
          peer.getByRole('tab', { name: 'Plan', exact: true }).click(),
        ]);
        await Promise.all([
          owner
            .getByRole('button', { name: 'Edit brief', exact: true })
            .click(),
          peer.getByRole('button', { name: 'Edit brief', exact: true }).click(),
        ]);
        const ownerDocument = owner.getByRole('textbox', {
          name: 'Task brief',
        });
        await ownerDocument.fill('Owner and peer share this durable text.');
        const stoppedAfterEdit = await liveFixtureCommand(
          owner,
          taskId,
          { command: 'heartbeat' },
          'refreshed',
        );
        expect(
          stoppedAfterEdit.panes.find((pane) => pane.paneId === paneId)?.state,
        ).toBe('paused');

        await expect(
          peer.getByRole('textbox', { name: 'Task brief' }),
        ).toHaveValue('Owner and peer share this durable text.');
        await liveFixtureCommand(owner, taskId, {
          command: 'follow',
          paneId,
          targetActorId: peerActorId,
        });
        const peerCursorResponse = peer.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname.endsWith('/room/live') &&
            (response.request().postDataJSON() as ProjectTaskRoomLiveCommand)
              .command === 'cursor',
        );
        const peerDocument = peer.getByRole('textbox', {
          name: 'Task brief',
        });
        await peerDocument.click();
        await peerDocument.press('ControlOrMeta+A');
        const peerCursor = await peerCursorResponse;
        const peerCursorBody = (await peerCursor.json()) as {
          data?: { result?: { outcome?: string } };
        };
        expect(peerCursorBody.data?.result?.outcome).toBe('updated');
        await expect(
          owner.getByRole('complementary', { name: 'Remote selections' }),
        ).toContainText('selection 0–39');
        await owner.getByRole('textbox', { name: 'Task brief' }).click();
        const stoppedAfterInput = await liveFixtureCommand(
          owner,
          taskId,
          { command: 'heartbeat' },
          'refreshed',
        );
        expect(
          stoppedAfterInput.panes.find((pane) => pane.paneId === paneId)?.state,
        ).toBe('paused');

        await Promise.all([
          owner.getByRole('tab', { name: 'Conversation', exact: true }).click(),
          peer.getByRole('tab', { name: 'Conversation', exact: true }).click(),
        ]);
        await peer
          .getByRole('textbox', { name: 'Message the Task' })
          .fill('Peer is working in the same Task room.');
        await peer.getByRole('button', { name: 'Send to task room' }).click();
        await expect(
          owner.getByRole('list', { name: 'Task room history' }),
        ).toContainText('Peer is working in the same Task room.');
        await expect(await rawHistory(owner)).toContainText(
          'revision-evidence-v1:',
        );
        await Promise.all([
          owner.getByRole('tab', { name: 'Plan', exact: true }).click(),
          peer.getByRole('tab', { name: 'Plan', exact: true }).click(),
        ]);

        const sharedBase = 'Owner and peer share this durable text.';
        const ownerConcurrent =
          'Owner and peer share this durable text. Concurrent owner insert.';
        const peerConcurrent = 'Owner and peer share this text.';
        const converged =
          'Owner and peer share this text. Concurrent owner insert.';
        const batchPattern = `**/api/tasks/${encodeURIComponent(taskId)}/room/batches`;
        const [ownerBatchHold, peerBatchHold] = await Promise.all([
          installBatchHold(owner, batchPattern),
          installBatchHold(peer, batchPattern),
        ]);
        await ownerDocument.fill(ownerConcurrent);
        await peerDocument.fill(peerConcurrent);
        const [heldOwnerBatch, heldPeerBatch] = await Promise.all([
          ownerBatchHold.promise,
          peerBatchHold.promise,
        ]);
        expect(heldOwnerBatch.body).not.toBe(heldPeerBatch.body);

        // Both opaque plans were minted from `sharedBase`. Send the insert
        // first but withhold its response; then send and deliver the delete so
        // request, SSE, and response observations arrive in different orders.
        const ownerServerResponse = await heldOwnerBatch.route.fetch();
        expect(ownerServerResponse.status()).toBe(200);
        const ownerServerEnvelope = (await ownerServerResponse.json()) as {
          data?: { kind?: string; text?: string };
        };
        expect(ownerServerEnvelope).toMatchObject({
          data: { kind: 'committed', text: ownerConcurrent },
        });
        const peerServerResponse = await heldPeerBatch.route.fetch();
        expect(peerServerResponse.status()).toBe(200);
        const peerServerEnvelope = (await peerServerResponse.json()) as {
          data?: { kind?: string; text?: string; reason?: string };
        };
        expect(
          peerServerEnvelope,
          'concurrent delete settlement',
        ).toMatchObject({
          data: { kind: 'committed', text: converged },
        });
        await heldPeerBatch.route.fulfill({ response: peerServerResponse });
        heldPeerBatch.release();
        await expect(peerDocument).toHaveValue(converged);
        await heldOwnerBatch.route.abort('connectionfailed');
        heldOwnerBatch.release();
        await expect(
          owner.getByRole('button', { name: 'Retry identical batch' }),
        ).toBeVisible();

        await owner.unroute(batchPattern);
        const duplicateRequest = owner.waitForRequest(
          (request) =>
            request.method() === 'POST' &&
            new URL(request.url()).pathname.endsWith('/room/batches'),
        );
        const duplicateResponse = owner.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname.endsWith('/room/batches'),
        );
        await owner
          .getByRole('button', { name: 'Retry identical batch' })
          .click();
        expect((await duplicateRequest).postData()).toBe(heldOwnerBatch.body);
        const duplicateEnvelope = (await duplicateResponse).json() as Promise<{
          data?: { kind?: string };
        }>;
        await expect(duplicateEnvelope).resolves.toMatchObject({
          data: { kind: 'duplicate' },
        });
        await expect(
          owner.getByText('This exact edit was already saved.'),
        ).toBeVisible();

        // Drop both real browser networks so the existing SSE clients must
        // reconnect. Their reconnect snapshots drive document queries; no
        // Resync button or page reload participates in convergence.
        await Promise.all([
          owner.context().setOffline(true),
          peerContext.setOffline(true),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const ownerReconnectedDocument = owner.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname.endsWith('/room/document') &&
            response.status() === 200,
        );
        const peerReconnectedDocument = peer.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname.endsWith('/room/document') &&
            response.status() === 200,
        );
        await Promise.all([
          owner.context().setOffline(false),
          peerContext.setOffline(false),
        ]);
        const [ownerDurable, peerDurable] = await Promise.all([
          ownerReconnectedDocument.then(documentReceipt),
          peerReconnectedDocument.then(documentReceipt),
        ]);
        expect(ownerDurable).toEqual(peerDurable);
        expect(ownerDurable).toMatchObject({
          revision: expect.stringMatching(/^swsr-v1:[0-9a-f]{64}$/),
          text: converged,
        });
        await expect(ownerDocument).toHaveValue(converged);
        await expect(peerDocument).toHaveValue(converged);
        expect(sharedBase).not.toBe(converged);

        const agentText =
          'The Station agent settled this authoritative shared edit.';
        const agentEdit = await publishTaskRoomAgentEdit(
          taskRoomControlSocket,
          {
            taskId,
            agentId: 'station',
            desiredText: agentText,
          },
        );
        expect(agentEdit).toMatchObject({
          kind: 'published',
          taskId,
          agentId: 'station',
          text: agentText,
        });
        for (const context of [owner, peer]) {
          await expect(
            context.getByRole('textbox', { name: 'Task brief' }),
          ).toHaveValue(agentText);
          await expectAgentPresence(
            context,
            taskId,
            agentEdit.sessionId,
            agentEdit.runId,
          );
        }
        await expect(await rawHistory(owner)).toContainText(
          agentEdit.sessionId,
        );
        await owner
          .getByRole('tab', { name: 'Conversation', exact: true })
          .click();
        await peer.getByRole('tab', { name: 'Plan', exact: true }).click();

        const revoked = await fetch(
          `${live.api}/api/pairing/devices/${encodeURIComponent(paired.device.id)}`,
          {
            method: 'DELETE',
            headers: e2eOperatorAuthorizationHeaders(operatorCredential),
          },
        );
        expect(revoked.status).toBe(200);
        await owner
          .getByRole('textbox', { name: 'Message the Task' })
          .fill('Revocation check.');
        await owner.getByRole('button', { name: 'Send to task room' }).click();
        await expect(
          peer.getByText(
            'Task room authorization ended. The last readable document remains read-only.',
          ),
        ).toBeVisible();
        await expect(
          peer.getByRole('textbox', { name: 'Task brief' }),
        ).toHaveValue(agentText);
        await expect(
          peer.getByRole('textbox', { name: 'Task brief' }),
        ).toHaveAttribute('readonly', '');
        await peer
          .getByRole('tab', { name: 'Conversation', exact: true })
          .click();
        await expect(
          peer.getByRole('textbox', { name: 'Message the Task' }),
        ).toBeDisabled();

        await owner.screenshot({
          path: testInfo.outputPath('project-task-room-owner.png'),
          fullPage: true,
        });
        await peer.screenshot({
          path: testInfo.outputPath('project-task-room-revoked-peer.png'),
          fullPage: true,
        });

        await stopStation(live);
        await startStation(live, false);
        await owner.goto(taskUrl);
        const restartedRoomProbe = await owner.evaluate(async (id) => {
          const response = await fetch(
            `/api/tasks/${encodeURIComponent(id)}/room`,
          );
          return { status: response.status, body: await response.text() };
        }, taskId);
        if (restartedRoomProbe.status !== 200)
          throw new Error(
            `restarted room endpoint ${restartedRoomProbe.status}: ${restartedRoomProbe.body}`,
          );
        await expectAgentPresence(
          owner,
          taskId,
          agentEdit.sessionId,
          agentEdit.runId,
        );
        await owner.getByRole('tab', { name: 'Plan', exact: true }).click();
        await owner
          .getByRole('button', { name: 'Edit brief', exact: true })
          .click();
        await expect(
          owner.getByRole('textbox', { name: 'Task brief' }),
        ).toHaveValue(agentText);
        await expect(
          owner.getByRole('complementary', { name: 'Remote selections' }),
        ).toContainText('Remote selections appear here.');
        await expect(
          owner.getByRole('button', { name: 'Stop watching' }),
        ).toHaveCount(0);
        await owner
          .getByRole('tab', { name: 'Conversation', exact: true })
          .click();
        await expect(
          owner.getByRole('list', { name: 'Task room history' }),
        ).toContainText('Peer is working in the same Task room.');
      } finally {
        await peerContext.close();
      }
    });
  });
