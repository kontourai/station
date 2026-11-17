import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
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
 * The live room on a real isolated Station (#4798, #4799, #4800): one
 * connection for a Project's channels, a dropped frame backfilled from
 * history, typing that clears, a person mention that reaches only that
 * person and opens the exact message, and an Agent request's state from its
 * record. The operator uses the room UI in a paired browser; an invited
 * contributor acts through their own account-bound session's API, because a
 * browser guest is shown Available Projects, not the room.
 */

let live: LiveStation;
let operatorCredential = '';
const SLUG = 'room-live';
let projectId = '';
let operator: { context: BrowserContext; page: Page; room: Locator };
let guestContext: BrowserContext;
let guest: Page;
/** Room ids by channel name; `general` is the default room. */
const channels = new Map<string, string>();

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
function operatorOptions() {
  return {
    origin: live.api,
    credential: operatorCredential,
    credentialOrigin: live.api,
    authentication: 'required' as const,
    timeoutMs: 15_000,
  };
}
/** The contributor, through their own session in their own browser. */
function asGuest(path: string, body?: unknown) {
  return guest.evaluate(
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
}
async function guestGuards() {
  const discovered = await asGuest(`/api/projects/${SLUG}/room`);
  expect(discovered.status, discovered.text).toBe(200);
  const view = JSON.parse(discovered.text).data as {
    roomId: string;
    actor: { id: string; displayName: string };
    scope: { localProjectId: string };
  };
  return {
    view,
    guards: {
      expectedRoomId: view.roomId,
      expectedProjectId: view.scope.localProjectId,
      expectedActorId: view.actor.id,
    },
  };
}
/** Posts as the operator through the API into one channel. */
async function operatorPost(channelId: string, text: string) {
  const view = await operatorJson(
    `/api/projects/${SLUG}/channels/${channelId}`,
  );
  const posted = await operatorJson(
    `/api/projects/${SLUG}/channels/${channelId}/messages`,
    {
      method: 'POST',
      body: {
        expectedRoomId: channelId,
        expectedProjectId: projectId,
        expectedActorId: view.body.data.actor.id,
        intentId: randomUUID(),
        text,
      },
    },
  );
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data as { seq: number; messageId: string };
}
function rowOf(room: Locator, text: string) {
  return room
    .locator('.room-row')
    .filter({ has: room.page().getByText(text, { exact: true }) });
}
async function openRoom(path = `/projects/${SLUG}?section=room`) {
  await operator.page.goto(`${live.ui}${path}`);
  await expect(
    operator.room.getByRole('textbox', { name: 'Message the project' }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe
  .serial('Project room live stream on a real Station (#4798, #4799, #4800)', () => {
    test.setTimeout(240_000);

    test.beforeAll(async ({ browser }, testInfo) => {
      testInfo.setTimeout(240_000);
      live = await allocateLiveStation('station-room-live-', 'room-live');
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
        { name: 'Room live', slug: SLUG },
        operatorOptions(),
      );
      projectId = project.id;
      const opened = await operatorJson(`/api/projects/${SLUG}/room/init`, {
        method: 'POST',
        body: { expectedProjectId: project.id },
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      channels.set('general', opened.body.data.roomId);
      operator = await pairOperator(browser);
      await inviteContributor(browser);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(120_000);
      await operator?.context.close();
      await guestContext?.close();
      if (!live) return;
      await stopStation(live);
      for (const output of ['dist-server', 'dist-ui'])
        rmSync(join(process.cwd(), `${output}-${live.instance}`), {
          recursive: true,
          force: true,
        });
      if (testInfo.status === testInfo.expectedStatus)
        rmSync(stationRootForLiveHome(live.home), {
          recursive: true,
          force: true,
        });
    });

    test('ten channels ride one connection, and a message in the tenth marks its row without a reload', async () => {
      const guard = {
        expectedProjectId: projectId,
        expectedActorId: (await operatorJson(`/api/projects/${SLUG}/room`)).body
          .data.actor.id,
      };
      for (let index = 1; index < 10; index += 1) {
        const created = await operatorJson(`/api/projects/${SLUG}/channels`, {
          method: 'POST',
          body: { ...guard, name: `room-${index}` },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        channels.set(`room-${index}`, created.body.data.channelId);
      }
      const liveRequests: string[][] = [];
      const perRoom: string[] = [];
      operator.page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith('/rooms/live'))
          liveRequests.push(url.searchParams.getAll('channel'));
        if (url.pathname.endsWith('/events') && url.pathname.includes('/room'))
          perRoom.push(url.pathname);
      });
      await openRoom();
      await expect(
        operator.page.getByRole('button', { name: /^room-9\b/ }).first(),
      ).toBeVisible({ timeout: 30_000 });
      // Every listed channel, on one stream; no per-room stream at all.
      await expect.poll(() => liveRequests.length).toBeGreaterThan(0);
      // A second connection would open within the hub's settle time; this
      // proves its absence, so it has to wait out that window.
      await operator.page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 1500)),
      );
      expect(liveRequests).toHaveLength(1);
      expect([...liveRequests[0]!].sort()).toEqual(
        [...channels.values()].sort(),
      );
      expect(perRoom).toEqual([]);
      // A message in the tenth room reaches the sidebar over that stream.
      await operatorPost(channels.get('room-9')!, 'Over the one connection.');
      await expect(
        operator.page
          .getByRole('button', { name: /^room-9, 1 unread/ })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      expect(liveRequests).toHaveLength(1);
    });

    test('a frame the client never received is backfilled from history, never skipped', async () => {
      // The browser's stream passes through a proxy that can drop one frame.
      let dropNextAppend = false;
      /** Every frame the proxy saw, for the failure message: event, room, seq. */
      const trail: string[] = [];
      const describe = (frame: string) => {
        const event = /^event: (\w+)/m.exec(frame)?.[1] ?? 'comment';
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        try {
          const value = data ? JSON.parse(data) : {};
          return `${event} ${String(value.key ?? '').slice(0, 8)} seq=${value.message?.seq ?? value.lastSeq ?? ''}`;
        } catch {
          return event;
        }
      };
      let dropped = 0;
      const proxy: Server = createServer(async (request, response) => {
        const upstream = await fetch(`${live.api}${request.url}`, {
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string' && entry[0] !== 'host',
            ),
          ),
        });
        response.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'text/plain',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': live.ui,
          'Access-Control-Allow-Credentials': 'true',
        });
        response.flushHeaders();
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        request.on('close', () => void reader.cancel().catch(() => {}));
        for (;;) {
          const chunk = await reader
            .read()
            .catch(() => ({ done: true }) as const);
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          for (
            let end = buffer.indexOf('\n\n');
            end >= 0;
            end = buffer.indexOf('\n\n')
          ) {
            const frame = buffer.slice(0, end + 2);
            buffer = buffer.slice(end + 2);
            if (dropNextAppend && frame.startsWith('event: append')) {
              dropNextAppend = false;
              dropped += 1;
              trail.push(`DROPPED ${describe(frame)}`);
              continue;
            }
            trail.push(describe(frame));
            response.write(frame);
          }
        }
        response.end();
      });
      await new Promise<void>((resolve) =>
        proxy.listen(0, '127.0.0.1', resolve),
      );
      const proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const backfills: string[] = [];
      try {
        await operator.page.route('**/rooms/live*', (route) => {
          const url = new URL(route.request().url());
          return route.continue({
            url: `${proxyBase}${url.pathname}${url.search}`,
          });
        });
        operator.page.on('request', (request) => {
          const url = new URL(request.url());
          if (
            url.pathname.endsWith('/room/messages') &&
            request.method() === 'GET'
          )
            backfills.push(url.search);
        });
        await openRoom();
        const general = channels.get('general')!;
        const room = general.slice(0, 8);
        /** Whether the proxy has passed a frame saying the room holds `seq`. */
        const passed = (seq: number) =>
          trail.some((entry) => {
            const match = /^(append|subscribed|resync) (\S+) seq=(\d+)$/.exec(
              entry,
            );
            return match?.[2] === room && Number(match[3]) >= seq;
          });
        /** A failed wait reports every frame the proxy saw by then. */
        const withTrail = (error: Error) => {
          throw new Error(`${error.message}\nframes ${JSON.stringify(trail)}`);
        };
        // The room is announced through the proxy before anything is posted.
        await expect
          .poll(() =>
            trail.some((entry) => entry.startsWith(`subscribed ${room}`)),
          )
          .toBe(true)
          .catch(withTrail);
        const first = await operatorPost(general, 'Before the gap.');
        await expect(rowOf(operator.room, 'Before the gap.')).toBeVisible();
        // The row can show from the room's own history read before its frame
        // reaches the proxy, and a (re)connection announces it in `subscribed`
        // instead of an `append`. Arm the drop only once the stream has said
        // the room holds it, so the one dropped is the next message's.
        await expect
          .poll(() => passed(first.seq))
          .toBe(true)
          .catch(withTrail);
        const reads = backfills.length;
        dropNextAppend = true;
        await operatorPost(general, 'This frame is dropped.');
        await expect.poll(() => dropped).toBe(1);
        await operatorPost(general, 'This frame arrives.');
        // Both show: the missing one was read from history, after `first`.
        await expect(rowOf(operator.room, 'This frame arrives.')).toBeVisible();
        await expect(
          rowOf(operator.room, 'This frame is dropped.'),
        ).toBeVisible({
          timeout: 5000,
        });
        expect(
          backfills.slice(reads),
          `history reads ${JSON.stringify(backfills)}; frames ${JSON.stringify(trail)}`,
        ).toContainEqual(expect.stringContaining(`after=${first.seq}`));
      } finally {
        await operator.page.unroute('**/rooms/live*');
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });

    test('typing shows, clears when the typist stops, and clears when their stream drops', async () => {
      await openRoom();
      const { view, guards } = await guestGuards();
      const clientId = randomUUID();
      const typing = (value: boolean) =>
        asGuest(`/api/projects/${SLUG}/room/typing`, {
          ...guards,
          clientId,
          typing: value,
        });
      const line = operator.room.getByText(
        `${view.actor.displayName} is typing…`,
      );
      expect((await typing(true)).status).toBe(200);
      await expect(line).toBeVisible({ timeout: 10_000 });
      expect((await typing(false)).status).toBe(200);
      await expect(line).toBeHidden({ timeout: 5000 });
      // Their own live stream registers the client; closing it clears typing.
      await guest.evaluate(
        ({ path }) => {
          const controller = new AbortController();
          (window as unknown as { stopLive: () => void }).stopLive = () =>
            controller.abort();
          void fetch(path, { signal: controller.signal }).catch(() => {});
        },
        {
          path: `/api/projects/${SLUG}/rooms/live?channel=${guards.expectedRoomId}&client=${clientId}`,
        },
      );
      await typing(true);
      await expect(line).toBeVisible({ timeout: 10_000 });
      await guest.evaluate(() =>
        (window as unknown as { stopLive: () => void }).stopLive(),
      );
      await expect(line).toBeHidden({ timeout: 5000 });
    });

    test('a person mention reaches only that person, and opening it shows the exact message', async () => {
      const { guards } = await guestGuards();
      const operatorView = (await operatorJson(`/api/projects/${SLUG}/room`))
        .body.data as { actor: { id: string; displayName: string } };
      const before = await operatorJson('/api/me/notifications');
      const guestBefore = JSON.parse(
        (await asGuest('/api/me/notifications')).text,
      ).data.length as number;
      const text = `@${operatorView.actor.displayName} the pricing copy is ready.`;
      const posted = await asGuest(`/api/projects/${SLUG}/room/messages`, {
        ...guards,
        intentId: randomUUID(),
        text,
        mentions: [
          {
            kind: 'person',
            actorId: operatorView.actor.id,
            display: operatorView.actor.displayName,
            offset: 0,
          },
        ],
      });
      expect(posted.status, posted.text).toBe(200);
      const messageId = JSON.parse(posted.text).data.messageId as string;
      // The named person has one; the author has none.
      await expect
        .poll(
          async () =>
            (
              (await operatorJson('/api/me/notifications')).body.data as {
                category: string;
              }[]
            ).filter((item) => item.category === 'room-mention').length,
        )
        .toBe(
          (before.body.data as { category: string }[]).filter(
            (item) => item.category === 'room-mention',
          ).length + 1,
        );
      expect(
        JSON.parse((await asGuest('/api/me/notifications')).text).data,
      ).toHaveLength(guestBefore);
      // Fill the channel so the message is not simply on screen already.
      for (let index = 0; index < 30; index += 1)
        await operatorPost(channels.get('general')!, `Later note ${index}`);
      // The one feed record for this message: its identity across reloads.
      const mentionRecord = (
        (await operatorJson('/api/me/notifications')).body.data as {
          id: string;
          category: string;
          metadata?: { messageId?: string };
        }[]
      ).find(
        (item) =>
          item.category === 'room-mention' &&
          item.metadata?.messageId === messageId,
      );
      expect(mentionRecord, 'the mention record').toBeTruthy();
      // Opening it from For you lands on the message, in view and marked.
      await operator.page.goto(`${live.ui}/notifications`);
      const forYou = operator.page.getByRole('region', { name: 'For you' });
      const row = forYou.getByRole('button', {
        name: /mentioned you in #general/,
      });
      await expect(row).toHaveCount(1);
      // Explicitly unread before it is opened.
      await expect(row).toHaveAccessibleName(/, unread/);
      // The ordinary user action: Enter on the focused row.
      await row.focus();
      await operator.page.keyboard.press('Enter');
      await expect(operator.page).toHaveURL(new RegExp(`message=${messageId}`));
      const target = operator.room.locator('.room-row--focused');
      await expect(target).toBeVisible({ timeout: 15_000 });
      await expect(target).toBeInViewport();
      await expect(target.locator('.room-mention--self')).toHaveText(
        `@${operatorView.actor.displayName}`,
      );
      // Back on Notifications the same row now reads as read. The For you
      // region must be present: a missing or loading section cannot pass.
      const readRow = async () => {
        const settled = operator.page.getByRole('region', { name: 'For you' });
        await expect(settled).toBeVisible({ timeout: 15_000 });
        const rows = settled.getByRole('button', {
          name: /mentioned you in #general/,
        });
        await expect(rows).toHaveCount(1);
        await expect(rows).not.toHaveAccessibleName(/, unread/);
        return rows;
      };
      await operator.page.goto(`${live.ui}/notifications`);
      const afterOpen = await readRow();
      const name = await afterOpen.evaluate(
        (node) => node.getAttribute('aria-label') ?? node.textContent,
      );
      await operator.page.reload();
      const afterReload = await readRow();
      expect(
        await afterReload.evaluate(
          (node) => node.getAttribute('aria-label') ?? node.textContent,
        ),
      ).toBe(name);
      // Same record identity, read on the server.
      const stored = (
        (await operatorJson('/api/me/notifications')).body.data as {
          id: string;
          metadata?: { envelope?: { readAt?: string } };
        }[]
      ).find((item) => item.id === mentionRecord!.id);
      expect(stored?.metadata?.envelope?.readAt).toBeTruthy();
      // A mention of someone outside the Project is refused at send time.
      const refused = await asGuest(`/api/projects/${SLUG}/room/messages`, {
        ...guards,
        intentId: randomUUID(),
        text: '@Nobody hello',
        mentions: [
          {
            kind: 'person',
            actorId: 'human:local:nobody',
            display: 'Nobody',
            offset: 0,
          },
        ],
      });
      expect(refused.status, refused.text).toBe(400);
    });

    test('an Agent request shows from its record, and its row clears when it ends', async () => {
      await openRoom();
      const view = (await operatorJson(`/api/projects/${SLUG}/room`)).body.data;
      // No Agent can run on this Station: the request is recorded, then ends
      // as "Couldn't finish" from the record's own failure.
      const asked = await operatorJson(`/api/projects/${SLUG}/room/agents`, {
        method: 'POST',
        body: {
          expectedRoomId: view.roomId,
          expectedProjectId: projectId,
          expectedActorId: view.actor.id,
          intentId: randomUUID(),
          agentId: 'not-installed',
          text: 'Check the pricing copy.',
        },
      });
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      const row = operator.room.locator('.room-agent-activity');
      await expect(row.getByText('Couldn’t finish')).toBeVisible({
        timeout: 15_000,
      });
      await expect(row.getByText(/The Agent was unavailable/)).toBeVisible();
      // Nothing is working: the channel's sidebar row has no working mark.
      await expect(
        operator.page.getByRole('button', { name: /^general, agent working/ }),
      ).toHaveCount(0);
      // The conversation moves on: the ending leaves the conversation.
      await operatorPost(channels.get('general')!, 'Moving on.');
      await expect(row).toHaveCount(0, { timeout: 10_000 });
    });
  });

async function pairOperator(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await pairBrowser(page, {
    root: process.cwd(),
    instance: live.instance,
    serverPort: live.serverPort,
    uiOrigin: live.ui,
  });
  return {
    context,
    page,
    room: page.getByRole('region', { name: 'Project room' }).first(),
  };
}

/** Shares the Project, and an invited contributor joins with operate scope. */
async function inviteContributor(browser: Browser) {
  const enabled = await changeProjectAccess(
    live.api,
    SLUG,
    { kind: 'enable', localProjectId: projectId },
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
  guestContext = await browser.newContext();
  guest = await guestContext.newPage();
  await guest.goto(
    `${live.ui}/account/join#invitation=${encodeURIComponent(invitation.token)}`,
  );
  await guest.getByRole('button', { name: 'Create an account' }).click();
  await guest.getByLabel('Username').fill('lin.contributor');
  await guest.getByLabel('Password').fill('Room-live-Aa1!234567');
  await guest.getByRole('button', { name: 'Create account' }).click();
  await guest.getByLabel('Password').fill('Room-live-Aa1!234567');
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
      )?.find((request) => request.requireAccountBinding)?.requestId ?? '';
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
  // Account binding starts read-only; typing and posting need operate.
  const devices = await operatorJson('/api/pairing/devices');
  const bound = (
    devices.body.devices as {
      id: string;
      revokedAt: number | null;
      principalBinding?: { kind?: string };
    }[]
  ).filter(
    (device) =>
      device.revokedAt === null && device.principalBinding?.kind === 'account',
  );
  expect(bound).toHaveLength(1);
  const granted = await operatorJson(
    `/api/pairing/devices/${bound[0]!.id}/scope`,
    {
      method: 'POST',
      body: { scope: ['orchestration:read', 'orchestration:operate'] },
    },
  );
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
}
