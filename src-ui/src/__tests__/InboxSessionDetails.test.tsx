/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import InboxSessionDetails from '../components/chat-dock/InboxSessionDetails';

const query = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionQuery: query,
}));
vi.mock('../components/session-detail/SessionDetail', () => ({
  SessionDetail: () => <p>External session transcript</p>,
}));
describe('inbox chat details', () => {
  test('opens visible details without navigating; Activity is a separate explicit action', () => {
    query.mockReturnValue({
      data: { session: { threadId: 'external-1' } },
      refetch: vi.fn(),
    });
    const onOpenActivity = vi.fn();
    const onClose = vi.fn();
    render(
      <InboxSessionDetails
        threadId="external-1"
        apiBase=""
        onClose={onClose}
        onOpenActivity={onOpenActivity}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Chat details' })).toBeTruthy();
    expect(screen.getByText('External session transcript')).toBeTruthy();
    expect(onOpenActivity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Activity' }));
    expect(onOpenActivity).toHaveBeenCalledWith('external-1');
    fireEvent.click(screen.getByRole('button', { name: 'Close chat details' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  test('the detail dialog is above the workspace and entirely within the viewport', async () => {
    query.mockReturnValue({
      data: { session: { threadId: 'external-1' } },
      refetch: vi.fn(),
    });
    render(
      <InboxSessionDetails
        threadId="external-1"
        apiBase=""
        onClose={() => {}}
        onOpenActivity={() => {}}
      />,
    );
    const markup = document.querySelector(
      '.inbox-session-details-overlay',
    )!.outerHTML;
    const css = [
      '../index.css',
      '../components/chat-dock/InboxSessionDetails.css',
    ]
      .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
      .join('\n');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      await page.setContent(
        `<style>${css}</style><main style="height:1600px">Workspace</main>${markup}`,
      );
      const dialog = page.getByRole('dialog', { name: 'Chat details' });
      const box = await dialog.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(800);
      const close = page.getByRole('button', { name: 'Close chat details' });
      expect(
        await close.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
