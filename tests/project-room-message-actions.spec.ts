import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createProject } from '@kontourai/station-sdk/client';
import { changeProjectAccess } from '@kontourai/station-sdk/project-access-client';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';
import { localLabEnvironment } from '../scripts/lib/local-collaboration-process.mjs';
import {
  seedE2EFirstRunDecision,
  seedE2EUsageTelemetryDisclosure,
} from '../scripts/run-e2e-suite.mjs';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  type LiveStation,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './helpers/live-station-task';
import { pairBrowser } from './live/helpers/station-instance.mjs';

/**
 * Reactions (#4796), edits and deletes (#4797) and channel files (#4812) on a
 * real isolated Station. Two paired browser contexts are two clients of the
 * operator; an invited contributor is a second person, acting through their
 * own account-bound browser session. Nothing here is mocked: every count,
 * edit, tombstone and file is the server's.
 *
 * The contributor acts through the API from their browser because a browser
 * guest's surface ("Available Projects") does not show the room; their room
 * UI is not exercised here.
 */

let live: LiveStation;
let operatorCredential = '';
const SLUG = 'room-actions';

async function operatorJson(
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${live.api}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${operatorCredential}`,
      'Content-Type': 'application/json',
      Origin: live.ui,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** SDK client options that act as the operator of the isolated Station. */
function operatorOptions() {
  const options = {
    origin: live.api,
    credential: operatorCredential,
    credentialOrigin: live.api,
    authentication: 'required' as const,
    timeoutMs: 15_000,
  };
  return options;
}

/** A paired operator browser on the Project's room. */
async function openClient(
  browser: Browser,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page; room: Locator }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await pairBrowser(page, {
    root: process.cwd(),
    instance: live.instance,
    serverPort: live.serverPort,
    uiOrigin: live.ui,
  });
  await page.goto(`${live.ui}/projects/${SLUG}?section=room`);
  const room = page.getByRole('region', { name: 'Project room' }).first();
  await expect(
    room.getByRole('textbox', { name: 'Message the project' }),
  ).toBeVisible({ timeout: 30_000 });
  return { context, page, room };
}

async function send(room: Locator, text: string) {
  const composer = room.getByRole('textbox', { name: 'Message the project' });
  await composer.fill(text);
  await room.getByRole('button', { name: 'Send message' }).click();
  await expect(rowOf(room, text)).toBeVisible();
}

function rowOf(room: Locator, text: string) {
  return room
    .locator('.room-row')
    .filter({ has: room.page().getByText(text, { exact: true }) });
}

/** Desktop rows show their actions on hover or focus. */
async function rowAction(room: Locator, text: string, name: string | RegExp) {
  const row = rowOf(room, text);
  await row.hover();
  return row.getByRole('button', { name });
}

async function expectNoHorizontalScroll(page: Page) {
  const extra = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(extra).toBeLessThanOrEqual(0);
}

test.describe
  .serial('Project room message actions on a real Station (#4796, #4797, #4812)', () => {
    test.setTimeout(240_000);

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      live = await allocateLiveStation('station-room-actions-', 'room-actions');
      await startStation(live, true, {
        logFile: testInfo.outputPath(`${live.instance}.log`),
        environment: {
          ...localLabEnvironment(),
          STATION_LOCAL_ACCOUNTS: '1',
          STATION_PROJECT_SHARING: '1',
          STATION_AUTHENTICATION_ORIGIN: live.ui,
          ALLOWED_ORIGINS: live.ui,
          STATION_LOG_LEVEL: 'error',
          OTEL_SDK_DISABLED: 'true',
          AWS_EC2_METADATA_DISABLED: 'true',
        },
      });
      operatorCredential = readE2EOperatorCredential(live.home);
      await seedE2EFirstRunDecision(live.api, operatorCredential);
      await seedE2EUsageTelemetryDisclosure(live.api, operatorCredential);
      const project = await createProject(
        live.api,
        { name: 'Room actions', slug: SLUG },
        operatorOptions(),
      );
      const opened = await operatorJson(`/api/projects/${SLUG}/room/init`, {
        method: 'POST',
        body: { expectedProjectId: project.id },
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(120_000);
      if (!live) return;
      await stopStation(live);
      if (testInfo.status === testInfo.expectedStatus)
        rmSync(stationRootForLiveHome(live.home), {
          recursive: true,
          force: true,
        });
    });

    test('two clients: a reaction and its removal, an edit and a delete reach the other client and survive a reload', async ({
      browser,
    }) => {
      const a = await openClient(browser);
      const b = await openClient(browser);
      try {
        await send(a.room, 'Pricing copy is ready.');
        await expect(rowOf(b.room, 'Pricing copy is ready.')).toBeVisible();

        // React through the picker on A; B sees the count.
        await (
          await rowAction(a.room, 'Pricing copy is ready.', /^React to /)
        ).click();
        const picker = a.page.getByRole('dialog', { name: 'Add reaction' });
        await picker.getByRole('searchbox').fill('thumbs');
        await picker.getByRole('button', { name: '👍', exact: true }).click();
        const pillA = rowOf(a.room, 'Pricing copy is ready.').getByRole(
          'button',
          { name: /^👍 1:/ },
        );
        await expect(pillA).toHaveAttribute('aria-pressed', 'true');
        await expect(
          rowOf(b.room, 'Pricing copy is ready.').getByRole('button', {
            name: /^👍 1:/,
          }),
        ).toBeVisible();
        // A tap takes it back; B sees it go.
        await pillA.click();
        await expect(
          rowOf(b.room, 'Pricing copy is ready.').getByRole('group', {
            name: 'Reactions',
          }),
        ).toHaveCount(0);

        // Edit on A, through the composer; B sees it, and it survives reload.
        await send(a.room, 'Shipping on Friday.');
        await (
          await rowAction(a.room, 'Shipping on Friday.', 'Edit message')
        ).click();
        await expect(a.room.getByText('Editing message')).toBeVisible();
        const composer = a.room.getByRole('textbox', {
          name: 'Message the project',
        });
        await expect(composer).toHaveValue('Shipping on Friday.');
        await composer.fill('Shipping on Monday.');
        await a.room.getByRole('button', { name: 'Save edit' }).click();
        const edited = rowOf(a.room, 'Shipping on Monday.');
        await expect(edited.getByText('edited', { exact: true })).toBeVisible();
        await expect(
          rowOf(b.room, 'Shipping on Monday.').getByText('edited', {
            exact: true,
          }),
        ).toBeVisible();
        await a.page.reload();
        await expect(
          rowOf(a.room, 'Shipping on Monday.').getByText('edited', {
            exact: true,
          }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(a.room.getByText('Shipping on Friday.')).toHaveCount(0);

        // Delete on A, after the confirmation; B sees the tombstone, and it
        // survives a reload on both.
        await send(a.room, 'Wrong channel, sorry.');
        await (
          await rowAction(a.room, 'Wrong channel, sorry.', 'Delete message')
        ).click();
        const confirm = a.page.getByRole('alertdialog', {
          name: 'Delete this message?',
        });
        await confirm.getByRole('button', { name: 'Delete' }).click();
        await expect(a.room.getByText('Wrong channel, sorry.')).toHaveCount(0);
        await expect(b.room.getByText('Wrong channel, sorry.')).toHaveCount(0);
        await expect(b.room.getByText('Message deleted')).toBeVisible();
        for (const client of [a, b]) {
          await client.page.reload();
          await expect(client.room.getByText('Message deleted')).toBeVisible({
            timeout: 30_000,
          });
          await expect(
            client.room.getByText('Wrong channel, sorry.'),
          ).toHaveCount(0);
        }
      } finally {
        await a.context.close();
        await b.context.close();
      }
    });

    test('files: an upload reaches the other client and downloads there byte for byte; an oversize file is refused in the composer', async ({
      browser,
    }) => {
      const a = await openClient(browser);
      const b = await openClient(browser);
      try {
        const notes = 'Launch notes: CTA shortened, price unchanged.\n';
        await a.room.locator('input[type="file"]').setInputFiles({
          name: 'launch-notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from(notes),
        });
        await expect(a.room.getByText('launch-notes.txt')).toBeVisible();
        await send(a.room, 'Notes attached.');
        const onB = rowOf(b.room, 'Notes attached.');
        const link = onB.getByRole('link', { name: /launch-notes\.txt/ });
        await expect(link).toBeVisible();
        const download = b.page.waitForEvent('download');
        await link.click();
        const saved = await (await download).path();
        expect(readFileSync(saved, 'utf8')).toBe(notes);

        // Over the 5 MB per-file limit: refused before any upload, in words.
        let uploads = 0;
        a.page.on('request', (request) => {
          if (
            request.method() === 'POST' &&
            new URL(request.url()).pathname.endsWith('/attachments')
          )
            uploads += 1;
        });
        await a.room.locator('input[type="file"]').setInputFiles({
          name: 'too-big.txt',
          mimeType: 'text/plain',
          buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
        });
        await expect(
          a.room.getByText('too-big.txt must be smaller than 5 MB.'),
        ).toBeVisible();
        expect(uploads).toBe(0);
      } finally {
        await a.context.close();
        await b.context.close();
      }
    });

    test('a narrow desktop (900px): row actions and the picker stay on screen and react', async ({
      browser,
    }) => {
      const a = await openClient(browser, { width: 900, height: 800 });
      try {
        await send(a.room, 'Narrow check.');
        const react = await rowAction(a.room, 'Narrow check.', /^React to /);
        await expect(react).toBeInViewport();
        await react.click();
        const picker = a.page.getByRole('dialog', { name: 'Add reaction' });
        await expect(picker).toBeInViewport({ ratio: 1 });
        await picker.getByRole('button', { name: '🎉', exact: true }).click();
        await expect(
          rowOf(a.room, 'Narrow check.').getByRole('button', {
            name: /^🎉 1:/,
          }),
        ).toBeVisible();
        await expectNoHorizontalScroll(a.page);
      } finally {
        await a.context.close();
      }
    });

    test('a second person cannot edit or delete the operator’s message, and neither can the operator theirs', async ({
      browser,
    }) => {
      const project = await operatorJson(`/api/projects/${SLUG}`);
      const enabled = await changeProjectAccess(
        live.api,
        SLUG,
        { kind: 'enable', localProjectId: project.body.data.id },
        operatorOptions(),
      );
      if (enabled.kind !== 'enabled') throw new Error('Sharing not enabled');
      const invitation = await changeProjectAccess(
        live.api,
        SLUG,
        {
          kind: 'invite',
          scope: enabled.view.scope,
          email: null,
          role: 'contributor',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        operatorOptions(),
      );
      if (invitation.kind !== 'invited') throw new Error('Not invited');

      const a = await openClient(browser);
      const guestContext = await browser.newContext();
      const guest = await guestContext.newPage();
      try {
        await send(a.room, 'Only I may change this.');
        // The contributor registers, accepts, and pairs this browser.
        await guest.goto(
          `${live.ui}/account/join#invitation=${encodeURIComponent(invitation.token)}`,
        );
        await guest.getByRole('button', { name: 'Create an account' }).click();
        await guest.getByLabel('Username').fill('room.contributor');
        await guest.getByLabel('Password').fill('Room-actions-Aa1!234567');
        await guest.getByRole('button', { name: 'Create account' }).click();
        await guest.getByLabel('Password').fill('Room-actions-Aa1!234567');
        await guest.getByRole('button', { name: 'Sign in' }).click();
        await guest.getByRole('button', { name: 'Accept invitation' }).click();
        await guest
          .getByRole('button', { name: 'Request access for this browser' })
          .click();
        await guest.getByRole('button', { name: 'Request access' }).click();
        let requestId = '';
        const deadline = Date.now() + 15_000;
        while (!requestId && Date.now() < deadline) {
          const pending = await operatorJson('/api/pairing/requests');
          requestId =
            (
              pending.body.requests as
                | { requestId: string; requireAccountBinding?: true }[]
                | undefined
            )?.find((request) => request.requireAccountBinding)?.requestId ??
            '';
          if (!requestId) await new Promise((done) => setTimeout(done, 100));
        }
        expect(requestId).not.toBe('');
        const confirmed = await operatorJson(
          `/api/pairing/requests/${encodeURIComponent(requestId)}/confirm`,
          { method: 'POST', body: { bindAccountIdentity: true } },
        );
        expect(confirmed.status).toBe(200);
        await expect(
          guest.getByRole('heading', { name: 'Available Projects' }),
        ).toBeVisible({ timeout: 15_000 });

        // The contributor, through their own session: discover, post, and
        // try to change the operator's message.
        const asGuest = (path: string, body?: unknown) =>
          guest.evaluate(
            async ({ path, body }) => {
              const response = await fetch(path, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              });
              return { status: response.status, text: await response.text() };
            },
            { path, body },
          );
        const discovered = await asGuest(`/api/projects/${SLUG}/room`);
        expect(discovered.status, discovered.text).toBe(200);
        const view = JSON.parse(discovered.text).data as {
          roomId: string;
          actor: { id: string };
          scope: { localProjectId: string };
        };
        const guards = {
          expectedRoomId: view.roomId,
          expectedProjectId: view.scope.localProjectId,
          expectedActorId: view.actor.id,
        };
        const history = await asGuest(
          `/api/projects/${SLUG}/room/messages?after=0&limit=100`,
        );
        const operatorMessage = (
          JSON.parse(history.text).data.messages as {
            messageId: string;
            text: string;
          }[]
        ).find((message) => message.text === 'Only I may change this.')!;
        expect(operatorMessage).toBeTruthy();
        const posted = await asGuest(`/api/projects/${SLUG}/room/messages`, {
          ...guards,
          intentId: randomUUID(),
          text: 'Contributor here.',
        });
        expect(posted.status, posted.text).toBe(200);
        const guestMessage = JSON.parse(posted.text).data as {
          messageId: string;
        };
        for (const leaf of ['edit', 'delete'] as const) {
          const refused = await asGuest(
            `/api/projects/${SLUG}/room/messages/${operatorMessage.messageId}/${leaf}`,
            {
              ...guards,
              intentId: randomUUID(),
              ...(leaf === 'edit' ? { text: 'Changed by someone else' } : {}),
            },
          );
          expect(refused.status, `${leaf}: ${refused.text}`).toBe(409);
          expect(refused.text).toContain('project_room_forbidden');
        }
        // A contributor may react: room leaves are open to their device.
        const reacted = await asGuest(
          `/api/projects/${SLUG}/room/messages/${operatorMessage.messageId}/reactions`,
          { ...guards, emoji: '👀', reacted: true },
        );
        expect(reacted.status, reacted.text).toBe(200);

        // The operator's client: the contributor's reaction arrives, and the
        // contributor's message offers no Edit or Delete.
        await expect(
          rowOf(a.room, 'Only I may change this.').getByRole('button', {
            name: /^👀 1:/,
          }),
        ).toBeVisible();
        const theirs = rowOf(a.room, 'Contributor here.');
        await expect(theirs).toBeVisible();
        await theirs.hover();
        await expect(
          theirs.getByRole('button', { name: /^React to / }),
        ).toBeVisible();
        await expect(
          theirs.getByRole('button', { name: 'Edit message' }),
        ).toHaveCount(0);
        await expect(
          theirs.getByRole('button', { name: 'Delete message' }),
        ).toHaveCount(0);
        // Nor does the server let the operator change it.
        const operatorView = await operatorJson(`/api/projects/${SLUG}/room`);
        for (const leaf of ['edit', 'delete'] as const) {
          const refused = await operatorJson(
            `/api/projects/${SLUG}/room/messages/${guestMessage.messageId}/${leaf}`,
            {
              method: 'POST',
              body: {
                expectedRoomId: operatorView.body.data.roomId,
                expectedProjectId: operatorView.body.data.scope.localProjectId,
                expectedActorId: operatorView.body.data.actor.id,
                intentId: randomUUID(),
                ...(leaf === 'edit' ? { text: 'Not mine to change' } : {}),
              },
            },
          );
          expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        }
        await expect(a.room.getByText('Contributor here.')).toBeVisible();
      } finally {
        await guestContext.close();
        await a.context.close();
      }
    });
  });
