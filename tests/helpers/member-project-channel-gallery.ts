import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import { expect, type Page, type Route } from '@playwright/test';
import { createAuthenticatedE2ERequest } from './authenticated-request';
import { resolveE2EApiBase } from './e2e-target';
import { rejectUnexpectedFixtureRequest } from './fixture-audit';
import {
  installProjectConversationsFixture,
  installProjectRoomFixture,
} from './room-gallery-fixtures';

export function memberProjectChannelScreens() {
  return (['light', 'dark'] as const).map((theme) => {
    const slug = `gallery-member-channels-${theme}`;
    const apiBase = resolveE2EApiBase();
    const projectPath = `/api/projects/${slug}`;
    const cleanups: (() => Promise<void>)[] = [];
    return {
      name: `member-project-channels-${theme}`,
      title: `Shared Project channels — ${theme}, 390px`,
      path: `/projects/${slug}`,
      viewport: { width: 390, height: 844 },
      captureTheme: theme,
      async beforeGoto(page: Page) {
        const request = createAuthenticatedE2ERequest(page.request);
        const created = await request.post(`${apiBase}/api/projects`, {
          data: { name: 'Onboarding revamp', slug },
        });
        expect(created.status()).toBe(201);
        cleanups.push(async () => {
          expect((await request.delete(`${apiBase}${projectPath}`)).ok()).toBe(
            true,
          );
        });
        const { data: project } = await created.json();
        const member: MemberProjectView = {
          version: 'station.member-project/v1',
          kind: 'member-project',
          id: project.id,
          slug,
          name: 'Onboarding revamp',
          actions: ['view'],
        };
        const publication: ProjectSharedTaskSummary = {
          version: 'station.shared-project-task/v1',
          project: {
            stationId: 'station:gallery',
            localProjectId: project.id,
            localProjectSlug: slug,
            portableProjectId: `portable-${slug}`,
          },
          task: {
            id: `task:${slug}-1`,
            title: 'Fix the login redirect on Safari',
            status: 'in_progress',
            createdAt: '2026-11-02T13:00:00Z',
          },
          shareId: '78f248f0-f452-4794-a35a-53a68e50ed1c',
          sharedAt: '2026-11-02T14:00:00Z',
        };
        const room = await installProjectRoomFixture(page, {
          slug,
          projectId: project.id,
          scene: 'navigation',
        });
        cleanups.push(room.cleanup);
        const conversations = await installProjectConversationsFixture(page, {
          slug,
          projectId: project.id,
        });
        cleanups.push(conversations.cleanup);
        const read = async (path: string, data: unknown) => {
          const url = `**${path}`;
          const handler = (route: Route) =>
            route.request().method() === 'GET'
              ? route.fulfill({ json: { success: true, data } })
              : rejectUnexpectedFixtureRequest(route);
          await page.route(url, handler);
          cleanups.push(() => page.unroute(url, handler));
        };
        await read(projectPath, member);
        await read(`${projectPath}/shared-work`, [publication]);
      },
      async afterGoto(page: Page) {
        const main = page.getByRole('main');
        await expect(
          main.getByRole('heading', { name: 'Onboarding revamp' }),
        ).toBeVisible();
        const channels = main.getByRole('list', { name: 'Channels' });
        await expect(
          channels.getByRole('button', { name: 'general, 3 unread' }),
        ).toBeVisible();
        await expect(
          channels.getByRole('button', { name: 'design', exact: true }),
        ).toBeVisible();
        await expect(
          main.getByRole('button', {
            name: 'Fix the login redirect on Safari, Task room, 2 unread',
          }),
        ).toBeVisible();
        await expect(
          main.getByRole('button', { name: /New channel/ }),
        ).toHaveCount(0);
        await expect(
          main.getByRole('button', { name: /Draft the release notes/ }),
        ).toHaveCount(0);

        // Resize the phone's work area to make this real list scroll without
        // adding rows to the captured layout.
        await page.setViewportSize({ width: 390, height: 440 });
        const later = main.getByRole('button', {
          name: 'Fix the login redirect on Safari, Task room, 2 unread',
        });
        await later.scrollIntoViewIfNeeded();
        const design = channels.getByRole('button', {
          name: 'design',
          exact: true,
        });
        await design.scrollIntoViewIfNeeded();
        const listScrollTop = () =>
          main.locator('.project-page').evaluate((pageRoot) => {
            for (
              let element: Element | null = pageRoot;
              element;
              element = element.parentElement
            ) {
              const { overflowY } = getComputedStyle(element);
              if (
                (overflowY === 'auto' || overflowY === 'scroll') &&
                element.scrollHeight > element.clientHeight
              )
                return element.scrollTop;
            }
            return document.scrollingElement?.scrollTop ?? 0;
          });
        const before = await listScrollTop();
        expect(before).toBeGreaterThan(0);
        await design.click();
        await expect(
          main.getByRole('heading', { name: 'design', exact: true }),
        ).toBeVisible();
        await page.goBack();
        await expect(design).toBeVisible();
        await expect
          .poll(async () => Math.abs((await listScrollTop()) - before))
          .toBeLessThanOrEqual(2);
        await page.setViewportSize({ width: 390, height: 844 });
        await main
          .getByRole('heading', { name: 'Onboarding revamp' })
          .scrollIntoViewIfNeeded();
      },
      async cleanup() {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      },
    };
  });
}
