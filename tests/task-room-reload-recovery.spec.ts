import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isProjectTaskRoomAppendReceipt,
  type ProjectTaskRoomAppendReceipt,
} from '@kontourai/station-contracts/project-task-room';
import {
  type ProjectTaskRoomBrowserRecord,
  parseProjectTaskRoomBrowserHistory,
} from '@kontourai/station-contracts/project-task-room-browser';
import { expect, type Route } from '@playwright/test';
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
  startStation,
  stopStation,
} from './helpers/live-station-task';
import { pairBrowser } from './live/helpers/station-instance.mjs';

test.describe
  .serial('Task room reload recovery', () => {
    let live: LiveStation;
    let repositoryRoot = '';
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(240_000);
      live = await allocateLiveStation(
        'station-task-recovery-',
        'task-recovery',
      );
      repositoryRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'station-task-recovery-repos-')),
      );
      await startStation(live, true, {
        deterministicReadiness: false,
        logFile: testInfo.outputPath('station.log'),
      });
      const credential = readE2EOperatorCredential(live.home);
      await seedE2EFirstRunDecision(live.api, credential);
      await seedE2EUsageTelemetryDisclosure(live.api, credential);
    });
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      if (live) await stopStation(live);
      if (testInfo.status === testInfo.expectedStatus) {
        if (repositoryRoot)
          rmSync(repositoryRoot, { recursive: true, force: true });
        if (live?.home) rmSync(live.home, { recursive: true, force: true });
      }
    });

    test('restores a saved draft only after review across a real page reload', async ({
      page,
    }, testInfo) => {
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      const repository = join(repositoryRoot, 'draft');
      await createRepository(repository, 'reload-draft');
      await createProject(page, 'reload-draft', repository);
      await createTaskFromProject(
        page,
        live,
        'reload-draft',
        'Reload draft recovery',
        repository,
        'reload-draft',
      );
      await page
        .getByRole('tab', { name: 'Conversation', exact: true })
        .click();
      const input = page.getByRole('textbox', { name: 'Message the Task' });
      await expect(input).toBeEditable();
      await input.fill('Keep this draft through a reload; do not send it.');
      let writes = 0;
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /\/room\/messages$|\/delegations$/.test(request.url())
        )
          writes += 1;
      });
      page.once('dialog', (dialog) => dialog.accept());
      await page.reload();
      const saved = page.getByRole('region', { name: 'Saved Task draft' });
      await expect(saved).toBeVisible();
      await expect(
        saved.getByRole('button', { name: 'Restore saved draft' }),
      ).toBeEnabled();
      await expect(
        page
          .getByRole('region', { name: 'Present in this Task' })
          .getByRole('listitem'),
      ).toHaveCount(1);
      await expect(input).toBeDisabled();
      expect(writes).toBe(0);
      const visualRoot = mkdtempSync(
        join(process.cwd(), '.kontourai', 'task-recovery-visual-'),
      );
      console.log(`[task-recovery-visual] ${visualRoot}`);
      // Theme attributes are a rendering fixture; no appearance-setting persistence is claimed.
      for (const theme of ['dark', 'light']) {
        await page.evaluate(
          (theme) => document.documentElement.setAttribute('data-theme', theme),
          theme,
        );
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await saved.scrollIntoViewIfNeeded();
          await expect(saved).toBeInViewport();
          if (width === 390) {
            for (const button of await saved.getByRole('button').all()) {
              const box = await button.boundingBox();
              expect(box).not.toBeNull();
              expect(box!.height).toBeGreaterThanOrEqual(44);
              expect(box!.width).toBeGreaterThanOrEqual(44);
            }
          }
          await page.screenshot({
            path: testInfo.outputPath(`saved-draft-${theme}-${width}.png`),
            fullPage: true,
          });
          copyFileSync(
            testInfo.outputPath(`saved-draft-${theme}-${width}.png`),
            join(visualRoot, `saved-draft-${theme}-${width}.png`),
          );
        }
      }
      await saved.getByRole('button', { name: 'Restore saved draft' }).click();
      await expect(input).toHaveValue(
        'Keep this draft through a reload; do not send it.',
      );
      expect(writes).toBe(0);
      await page
        .getByRole('button', { name: 'Discard draft', exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancel' })
        .click();
      await expect(input).toHaveValue(
        'Keep this draft through a reload; do not send it.',
      );
      await page
        .getByRole('button', { name: 'Discard draft', exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Discard', exact: true })
        .click();
      await expect(input).toHaveValue('');
      await page.reload();
      await expect(input).toBeEditable();
      await expect(saved).toHaveCount(0);
      expect(writes).toBe(0);
    });

    test('a lost committed message acknowledgement retries the same proposal after reload', async ({
      page,
    }) => {
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      const repository = join(repositoryRoot, 'uncertain');
      await createRepository(repository, 'reload-uncertain');
      await createProject(page, 'reload-uncertain', repository);
      const taskId = await createTaskFromProject(
        page,
        live,
        'reload-uncertain',
        'Uncertain message recovery',
        repository,
        'reload-uncertain',
      );
      await page
        .getByRole('tab', { name: 'Conversation', exact: true })
        .click();
      const input = page.getByRole('textbox', { name: 'Message the Task' });
      await expect(input).toBeEditable();
      const messageText = `Lost-ack ${taskId}: one committed message.`;
      const authorization = e2eOperatorAuthorizationHeaders(
        readE2EOperatorCredential(live.home),
      );
      const readMessageIdentity = async () => {
        const records: ProjectTaskRoomBrowserRecord[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          const query = new URLSearchParams({ limit: '100' });
          if (cursor) query.set('cursor', cursor);
          const response = await page.request.get(
            `${live.api}/api/tasks/${encodeURIComponent(taskId)}/room/history?${query}`,
            { headers: authorization },
          );
          expect(response.ok()).toBe(true);
          const envelope: unknown = await response.json();
          if (
            !envelope ||
            typeof envelope !== 'object' ||
            !('success' in envelope) ||
            envelope.success !== true ||
            !('data' in envelope)
          )
            throw new Error('Expected an authenticated room history envelope');
          const history = parseProjectTaskRoomBrowserHistory(envelope.data);
          if (history?.kind !== 'available')
            throw new Error('Expected complete available room history');
          records.push(...history.records);
          if (!history.hasMore) break;
          if (!history.nextCursor || cursors.has(history.nextCursor))
            throw new Error('Room history pagination did not advance');
          cursors.add(history.nextCursor);
          cursor = history.nextCursor;
        }
        const matching = records.filter(
          (record) =>
            record.body.kind === 'human-message' &&
            record.body.text === messageText,
        );
        expect(matching).toHaveLength(1);
        const record = matching[0];
        if (!record)
          throw new Error('Committed message is absent from history');
        expect(record.actor.kind).toBe('human');
        expect(record.actor.id).toEqual(expect.any(String));
        return {
          sequence: record.sequence,
          actorId: record.actor.id,
          proposalDigest: record.digests.proposal,
          occurredAt: record.occurredAt,
        };
      };
      const bodies: unknown[] = [];
      const serializedBodies: (string | null)[] = [];
      const receipts: ProjectTaskRoomAppendReceipt[] = [];
      let beforeLoss:
        | Awaited<ReturnType<typeof readMessageIdentity>>
        | undefined;
      const origins = new Set([
        new URL(live.api).origin,
        new URL(live.ui).origin,
      ]);
      const messagePath = `/api/tasks/${encodeURIComponent(taskId)}/room/messages`;
      const pattern = (url: URL) =>
        origins.has(url.origin) && url.pathname === messagePath;
      const observeMessage = async (route: Route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        try {
          const body: unknown = route.request().postDataJSON();
          if (
            !body ||
            typeof body !== 'object' ||
            !('proposalId' in body) ||
            typeof body.proposalId !== 'string'
          )
            throw new Error('Expected the real message proposal');
          bodies.push(body);
          serializedBodies.push(route.request().postData());
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          const envelope: unknown = await response.json();
          const expectedKind = bodies.length === 1 ? 'committed' : 'duplicate';
          if (
            !envelope ||
            typeof envelope !== 'object' ||
            !('success' in envelope) ||
            envelope.success !== true ||
            !('data' in envelope) ||
            !envelope.data ||
            typeof envelope.data !== 'object' ||
            !('kind' in envelope.data) ||
            envelope.data.kind !== expectedKind ||
            !('receipt' in envelope.data) ||
            !isProjectTaskRoomAppendReceipt(envelope.data.receipt)
          )
            throw new Error('Expected the real committed or duplicate receipt');
          const receipt = envelope.data.receipt;
          expect(receipt.proposalId).toBe(body.proposalId);
          receipts.push(receipt);
          if (bodies.length === 1) {
            beforeLoss = await readMessageIdentity();
            expect(beforeLoss.sequence).toBe(receipt.coordinate.seq);
            await route.abort('failed');
          } else {
            expect(receipt).toEqual(receipts[0]);
            await route.fulfill({ response });
          }
        } catch (error) {
          await route.abort('failed');
          throw error;
        }
      };
      await page.route(pattern, observeMessage);
      try {
        await input.fill(messageText);
        await page.getByRole('button', { name: 'Send to task room' }).click();
        await expect(
          page.getByText(/Message acknowledgement is unavailable/),
        ).toBeVisible();
        expect(receipts).toHaveLength(1);
        expect(beforeLoss).toBeDefined();
        page.once('dialog', (dialog) => dialog.accept());
        await page.reload();
        await expect(
          page.getByRole('region', { name: 'Saved Task draft' }),
        ).toBeVisible();
        expect(bodies).toHaveLength(1);
        await page.getByRole('button', { name: 'Restore saved draft' }).click();
        await expect(input).toBeDisabled();
        await page
          .getByRole('button', { name: 'Retry same room message' })
          .click();
        await expect(input).toHaveValue('');
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toEqual(bodies[0]);
        expect(serializedBodies[1]).toBe(serializedBodies[0]);
        expect(receipts).toHaveLength(2);
        expect(await readMessageIdentity()).toEqual(beforeLoss);
        await expect(
          page
            .getByRole('region', { name: 'Task room conversation' })
            .getByText(messageText, { exact: true }),
        ).toHaveCount(1);
        await page.reload();
        await expect(
          page
            .getByRole('region', { name: 'Task room conversation' })
            .getByText(messageText, { exact: true }),
        ).toHaveCount(1);
        expect(await readMessageIdentity()).toEqual(beforeLoss);
        expect(bodies).toHaveLength(2);
        await expect(
          page.getByRole('region', { name: 'Saved Task draft' }),
        ).toHaveCount(0);
      } finally {
        if (!page.isClosed()) await page.unroute(pattern, observeMessage);
      }
    });
  });
