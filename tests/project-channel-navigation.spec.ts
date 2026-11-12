import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  type AuthenticatedE2ERequest,
  createAuthenticatedE2ERequest,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { test } from './helpers/fixture-audit';

/**
 * #4794 and #4795 against a real Station: channels, read markers and Task
 * lists are the server's own. The API calls below act as the same person as
 * the browser (the local operator), so they are this person's second client.
 */

interface SeededProject {
  slug: string;
  projectId: string;
  actorId: string;
  generalId: string;
  channels: Map<string, string>;
}

async function json(response: Awaited<ReturnType<AuthenticatedE2ERequest['get']>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function seedProject(
  request: AuthenticatedE2ERequest,
  slug: string,
  channelNames: readonly string[],
): Promise<SeededProject> {
  const api = resolveE2EApiBase();
  const project = await json(
    await request.post(`${api}/api/projects`, {
      data: { name: 'Channel journey', slug },
    }),
  );
  const room = await json(
    await request.post(`${api}/api/projects/${slug}/room/init`, {
      data: { expectedProjectId: project.id },
    }),
  );
  const guards = {
    expectedProjectId: project.id,
    expectedActorId: room.actor.id,
  };
  const channels = new Map<string, string>([['general', room.roomId]]);
  for (const name of channelNames) {
    const channel = await json(
      await request.post(`${api}/api/projects/${slug}/channels`, {
        data: { ...guards, name },
      }),
    );
    channels.set(name, channel.channelId);
  }
  return {
    slug,
    projectId: project.id,
    actorId: room.actor.id,
    generalId: room.roomId,
    channels,
  };
}

async function post(
  request: AuthenticatedE2ERequest,
  seeded: SeededProject,
  channel: string,
  text: string,
) {
  const roomId = seeded.channels.get(channel)!;
  const path =
    roomId === seeded.generalId ? 'room' : `channels/${roomId}`;
  await json(
    await request.post(
      `${resolveE2EApiBase()}/api/projects/${seeded.slug}/${path}/messages`,
      {
        data: {
          expectedRoomId: roomId,
          expectedProjectId: seeded.projectId,
          expectedActorId: seeded.actorId,
          intentId: randomUUID(),
          text,
        },
      },
    ),
  );
}

async function readState(
  request: AuthenticatedE2ERequest,
  seeded: SeededProject,
  channel: string,
) {
  const data = await json(
    await request.post(`${resolveE2EApiBase()}/api/read-markers/summary`, {
      data: {
        targets: [
          {
            kind: 'project-room',
            projectSlug: seeded.slug,
            roomId: seeded.channels.get(channel)!,
          },
        ],
      },
    }),
  );
  return data.items[0] as { unread: boolean; unreadCount?: number };
}

async function removeProject(request: AuthenticatedE2ERequest, slug: string) {
  const removed = await request.delete(
    `${resolveE2EApiBase()}/api/projects/${slug}`,
  );
  expect(removed.ok()).toBe(true);
}

/** No horizontal page scroll: the document and the page's own scroller. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() =>
    [document.scrollingElement, document.querySelector('.project-page')]
      .filter((node): node is Element => !!node)
      .map((node) => node.scrollWidth - node.clientWidth),
  );
  for (const extra of overflow) expect(extra).toBeLessThanOrEqual(0);
}

function projectSidebar(page: Page) {
  return page.getByRole('navigation', { name: 'Primary navigation' });
}

test.describe('Project channels in the sidebar (#4794)', () => {
  test('unread is the server’s answer, and opening a channel clears it here and for a second client', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const request = createAuthenticatedE2ERequest(page.request);
    const slug = `channels-sidebar-${Date.now().toString(36)}`;
    const seeded = await seedProject(request, slug, ['design', 'launch']);
    try {
      await post(request, seeded, 'design', 'Checkout screens are ready.');
      await post(request, seeded, 'design', 'The CTA is shorter now.');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/projects/${slug}`);
      const sidebar = projectSidebar(page);
      const design = sidebar.getByRole('button', { name: 'design, 2 unread' });
      await expect(design).toBeVisible();
      await expect(design).toHaveClass(/conversation-list__row--unread/);
      // #general sorts first; a read channel is plain.
      const general = sidebar.getByRole('button', { name: 'general' });
      await expect(general).not.toHaveClass(/conversation-list__row--unread/);
      expect(
        await general.evaluate(
          (node, other) =>
            !!(
              node.compareDocumentPosition(other as Node) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
          await design.elementHandle(),
        ),
      ).toBe(true);

      // Keyboard: Down from #general reaches #design; Enter opens it.
      await general.focus();
      await page.keyboard.press('ArrowDown');
      await expect(design).toBeFocused();
      await page.keyboard.press('Enter');
      await expect
        .poll(() => new URL(page.url()).searchParams.get('channel'))
        .toBe(seeded.channels.get('design'));
      const room = page.getByRole('region', {
        name: 'Project room',
        exact: true,
      });
      await expect(
        room.getByText('The CTA is shorter now.', { exact: true }),
      ).toBeVisible();

      // Opened here: the server's marker moves, so the bold clears here and
      // the second client (this API) reads it as seen.
      const read = sidebar.getByRole('button', { name: 'design', exact: true });
      await expect(read).toBeVisible();
      await expect(read).not.toHaveClass(/conversation-list__row--unread/);
      await expect(read).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => readState(request, seeded, 'design')).toEqual(
        expect.objectContaining({ unread: false }),
      );

      // A message from elsewhere makes #launch unread on the next read.
      await post(request, seeded, 'launch', 'Launch checklist is drafted.');
      await page.reload();
      await expect(
        projectSidebar(page).getByRole('button', { name: 'launch, 1 unread' }),
      ).toHaveClass(/conversation-list__row--unread/);
    } finally {
      await removeProject(request, slug);
    }
  });
});

test.describe('Project channels on a phone (#4795)', () => {
  test('channel list, full-screen channel, send, thread, and Back keeps the list where it was', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const request = createAuthenticatedE2ERequest(page.request);
    const slug = `channels-phone-${Date.now().toString(36)}`;
    // Enough channels that the list scrolls on a phone.
    const names = Array.from(
      { length: 14 },
      (_, index) => `team-${String(index).padStart(2, '0')}`,
    );
    const seeded = await seedProject(request, slug, names);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/projects/${slug}`);
      const list = page.getByRole('group', { name: 'Channels' });
      await expect(list.getByRole('button', { name: 'general' })).toBeVisible();
      await expectNoHorizontalScroll(page);

      // Scroll the Project page until the last channel is in reach.
      const target = list.getByRole('button', { name: 'team-12' });
      await target.scrollIntoViewIfNeeded();
      const scroller = page.locator('.project-page').first();
      const before = await scroller.evaluate((node) => node.scrollTop);
      expect(before).toBeGreaterThan(0);
      const historyBefore = await page.evaluate(() => history.length);

      await target.click();
      // A pushed page: a new history entry, the channel in the URL.
      await expect
        .poll(() => new URL(page.url()).searchParams.get('channel'))
        .toBe(seeded.channels.get('team-12'));
      expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);
      const room = page.getByRole('region', {
        name: 'Project room',
        exact: true,
      });
      await expect(
        room.getByRole('heading', { level: 1, name: '#team-12' }),
      ).toBeVisible();
      // Full screen: the Project's own header and sections are gone.
      await expect(page.getByRole('heading', { name: 'Channel journey' })).toHaveCount(0);
      await expect(list).toBeHidden();
      await expectNoHorizontalScroll(page);

      const composer = room.getByRole('textbox', { name: 'Message the project' });
      await composer.fill('Hello from the phone');
      await room.getByRole('button', { name: 'Send message' }).click();
      const sent = room.getByText('Hello from the phone', { exact: true });
      await expect(sent).toBeVisible();

      // The message's phone actions open its thread as its own page.
      await openMessageActions(room, sent);
      await room.getByRole('button', { name: /Reply/ }).first().click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('thread'))
        .not.toBeNull();
      await expect(
        room.getByRole('heading', { level: 1, name: 'Thread' }),
      ).toBeVisible();
      const reply = room.getByRole('textbox', { name: 'Reply in thread' });
      await reply.fill('A reply in the thread');
      await room.getByRole('button', { name: 'Send message' }).click();
      await expect(
        room.getByText('A reply in the thread', { exact: true }),
      ).toBeVisible();

      // Back: to the channel, where the root shows its reply count.
      await room.getByRole('button', { name: 'Back to #team-12' }).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('thread'))
        .toBeNull();
      await expect(room.getByRole('button', { name: '1 reply' })).toBeVisible();
      await expect(
        room.getByText('A reply in the thread', { exact: true }),
      ).toHaveCount(0);

      // Back again: the list, scrolled where it was.
      await room.getByRole('button', { name: 'Back to Channel journey' }).click();
      await expect(list.getByRole('button', { name: 'team-12' })).toBeVisible();
      await expect
        .poll(() => scroller.evaluate((node) => node.scrollTop))
        .toBeGreaterThanOrEqual(before - 2);
      expect(await scroller.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(
        before + 2,
      );

      // 360 wide: still no horizontal scroll, list or conversation.
      await page.setViewportSize({ width: 360, height: 780 });
      await expectNoHorizontalScroll(page);
      await list.getByRole('button', { name: 'general' }).click();
      await expect(
        room.getByRole('heading', { level: 1, name: '#general' }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    } finally {
      await removeProject(request, slug);
    }
  });
});

/** A phone shows a message's actions from its More button. */
async function openMessageActions(room: Locator, message: Locator) {
  const row = room.locator('.room-row').filter({ has: message });
  await row.getByRole('button', { name: /^More actions for / }).click();
}
