/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { MessageBubble } from '../components/chat/MessageBubble';
import { ChatDockProjectSwitcherSheet } from '../components/chat-dock/ChatDockProjectSwitcherSheet';
import { ProjectSidebarHeader } from '../components/project-sidebar/ProjectSidebarHeader';
import { SplitPaneLayout } from '../components/SplitPaneLayout';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ developerToolsEnabled: false }),
}));

const css = [
  '../index.css',
  '../components/SplitPaneLayout.css',
  '../components/chat/chat.css',
  '../components/project-sidebar/ProjectSidebar.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

describe('September 8 visual feedback regressions', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(cleanup);

  test.each([390, 1200])(
    'hover and keyboard actions do not move message boxes at %ipx',
    async (width) => {
      const { container } = render(
        <div>
          <MessageBubble
            msg={{
              role: 'assistant',
              content: 'A completed answer with an action row.',
              turnId: 'turn-1',
            }}
            idx={0}
            activeSession={{
              id: 'session-1',
              agentSlug: 'agent',
              messageCount: 2,
            }}
            agents={[]}
            chatFontSize={14}
            showReasoning={false}
            showToolDetails={false}
            onCopy={() => {}}
          />
          <p data-testid="following">The next message must stay still.</p>
        </div>,
      );
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await page.setContent(`<style>${css}</style>${container.innerHTML}`);
        // Let the product's entrance animation complete before measuring hover.
        await page.locator('.message-row').evaluate(async (node) => {
          await Promise.all(
            node.getAnimations({ subtree: true }).map((a) => a.finished),
          );
        });
        await page.mouse.move(width - 1, 799);
        const before = await page.getByTestId('following').boundingBox();
        const bubble = await page.locator('.message').boundingBox();
        expect(bubble).not.toBeNull();
        await page.locator('.message').hover();
        expect(await page.getByTestId('following').boundingBox()).toEqual(
          before,
        );
        expect(await page.locator('.message').boundingBox()).toEqual(bubble);
        await page.mouse.move(width - 1, 799);
        await page.keyboard.press('Tab');
        await expect
          .poll(() =>
            page
              .getByRole('button', { name: 'Copy message' })
              .evaluate((node) => node === document.activeElement),
          )
          .toBe(true);
        expect(await page.getByTestId('following').boundingBox()).toEqual(
          before,
        );
        expect(
          await page
            .locator('.turn-footer__actions')
            .evaluate((node) => getComputedStyle(node).opacity),
        ).toBe('1');
      } finally {
        await page.close();
      }
    },
  );

  test('collapsed Nightly sidebar hides the whole brand block', async () => {
    const { container } = render(
      <nav className="sidebar sidebar--collapsed">
        <ProjectSidebarHeader
          appName="Station"
          homeLabel="Station Nightly"
          channelBadge="Nightly"
          buildLabel="Built 2 hours ago"
          collapsed
          isMobile={false}
          onCloseMobile={() => {}}
          onGoHome={() => {}}
          onToggleCollapse={() => {}}
        />
      </nav>,
    );
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>${css}</style>${container.innerHTML}`);
      expect(await page.locator('.sidebar__brand-name').isVisible()).toBe(
        false,
      );
      expect(
        await page
          .getByRole('button', { name: 'Station Nightly home' })
          .isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  test.each([40, 650])(
    'project switcher stays within the viewport from anchor y=%i',
    async (top) => {
      const anchor = document.createElement('button');
      document.body.appendChild(anchor);
      anchor.getBoundingClientRect = () => ({
        top,
        bottom: top + 40,
        left: 100,
        right: 140,
        width: 40,
        height: 40,
        x: 100,
        y: top,
        toJSON: () => ({}),
      });
      const anchorRef = createRef<HTMLElement>();
      anchorRef.current = anchor;
      render(
        <ChatDockProjectSwitcherSheet
          anchorRef={anchorRef}
          boundProjectSlug=""
          projects={[]}
          onOpenProject={() => {}}
          onSwitchProject={() => {}}
          onClose={() => {}}
        />,
      );
      const markup = document.querySelector(
        '.responsive-surface-overlay',
      )!.outerHTML;
      const page = await browser.newPage({
        viewport: { width: 1200, height: 768 },
      });
      try {
        await page.setContent(`<style>${css}</style>${markup}`);
        const panel = await page
          .getByRole('dialog', { name: 'Switch project' })
          .boundingBox();
        expect(panel).not.toBeNull();
        expect(panel!.y).toBeGreaterThanOrEqual(0);
        expect(panel!.y + panel!.height).toBeLessThanOrEqual(768);
        const close = page.getByRole('button', {
          name: 'Close project switcher',
        });
        expect(
          await close.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return node.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            );
          }),
        ).toBe(true);
      } finally {
        await page.close();
        anchor.remove();
      }
    },
  );

  test.each([400, 900])(
    'Activity detail gets usable width inside a %ipx region',
    async (width) => {
      const { container } = render(
        <div style={{ width, display: 'flex', height: 500 }}>
          <SplitPaneLayout
            label="Activity"
            title="Activity"
            items={[{ id: 'a', name: 'External session' }]}
            selectedId="a"
            onSelect={() => {}}
            onDeselect={() => {}}
            onSearch={() => {}}
          >
            <p>Session transcript</p>
          </SplitPaneLayout>
        </div>,
      );
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      try {
        await page.setContent(`<style>${css}</style>${container.innerHTML}`);
        const detail = await page.locator('.split-pane__right').boundingBox();
        expect(detail?.width).toBeGreaterThanOrEqual(
          width < 640 ? width - 2 : 320,
        );
        expect(
          await page
            .getByRole('button', { name: '← Back to list' })
            .isVisible(),
        ).toBe(width < 640);
        expect(await page.locator('.split-pane__left').isVisible()).toBe(
          width >= 640,
        );
      } finally {
        await page.close();
      }
    },
  );
});
