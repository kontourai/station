/** @vitest-environment jsdom */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { chromium } from '@playwright/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { execFileSyncBounded } from '../../../scripts/lib/bounded-capture.mjs';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { ConversationInboxMessages } from '../components/chat/ConversationInboxMessages';

const authority = vi.hoisted(() => ({
  apiBase: 'http://inbox.fixture',
  authorityKey: 'visual-owner',
  requiresEnrolledCredential: false,
  isCurrent: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority,
}));
vi.mock('../hooks/useQueuedMessages', () => ({
  useQueuedMessages: () => ({
    editingIndex: null,
    editValue: '',
    setEditValue: vi.fn(),
    startEdit: vi.fn(),
    cancelEdit: vi.fn(),
    saveEdit: vi.fn(),
    remove: vi.fn(),
    moveUp: vi.fn(),
    moveDown: vi.fn(),
  }),
}));

const root = fileURLToPath(new NodeURL('../../../', import.meta.url));
const subject = execFileSyncBounded('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const artifacts = resolve(root, '.kontourai/inbox-visual', subject);
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let client: QueryClient;

beforeAll(async () => {
  if (!chromiumIsInstalled(root))
    throw new Error('Pinned Chromium is required for inbox layout evidence.');
  browser = await chromium.launch();
  mkdirSync(artifacts, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
});
afterEach(() => {
  cleanup();
  client?.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test.each(
  [390, 1440].flatMap((width) =>
    ['dark', 'light'].map((theme) => ({ width, theme })),
  ),
)(
  'inbox review actions fit and remain hittable at $width px in $theme',
  async ({ width, theme }) => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setClientCredentialResolver(() => ({
      origin: 'http://inbox.fixture',
      requestAuthority: authority,
    }));
    const common = {
      conversationId: 'conversation',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                entries: [
                  {
                    ...common,
                    kind: 'steer',
                    state: 'unconfirmed',
                    clientTurnId: 'unknown',
                    message:
                      'Review the migration before changing the database.',
                    ownedByCaller: true,
                  },
                  {
                    ...common,
                    kind: 'display',
                    state: 'sent',
                    clientTurnId: 'note',
                    message:
                      'Display note: the queued input remains visible on another client.',
                  },
                ],
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(
      <QueryClientProvider client={client}>
        <ConversationInboxMessages
          conversationId="conversation"
          sessionId="session"
          messages={['Saved input whose originating Station must be reviewed.']}
          metadata={[{ id: 'legacy', mode: 'queue', originUnverified: true }]}
          onResend={() => true}
          onReviewOrigin={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('Display only');
    fireEvent.click(
      await screen.findByRole('button', { name: /pending messages/ }),
    );
    const markup = document.body.innerHTML;
    const css =
      resolveCssImports(resolve(root, 'src-ui/src/index.css')) +
      resolveCssImports(
        resolve(root, 'src-ui/src/components/chat/QueuedMessages.css'),
      ) +
      resolveCssImports(
        resolve(
          root,
          'src-ui/src/components/chat/ConversationInboxMessages.css',
        ),
      );
    assertNoImportsSurvive(css);
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    try {
      await page.route('http://inbox.fixture/fonts/**', async (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop()!;
        if (
          ![
            'dm-sans-latin.woff2',
            'dm-sans-latin-ext.woff2',
            'jetbrains-mono-latin.woff2',
            'jetbrains-mono-latin-ext.woff2',
          ].includes(name)
        )
          return route.abort();
        await route.fulfill({
          contentType: 'font/woff2',
          body: readFileSync(resolve(root, 'src-ui/public/fonts', name)),
        });
      });
      await page.setContent(
        `<!doctype html><html data-theme="${theme}"><head><base href="http://inbox.fixture/"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main style="padding:16px;max-width:800px">${markup}</main></body></html>`,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(async () => {
        await Promise.allSettled(
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.timeline === document.timeline &&
                animation.effect?.getTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished),
        );
      });
      await page.screenshot({
        path: resolve(artifacts, `inbox-${width}-${theme}.png`),
        fullPage: true,
      });
      const kindBox = await page
        .getByText('Display only', { exact: true })
        .boundingBox();
      expect(kindBox).not.toBeNull();
      expect(kindBox!.x + kindBox!.width).toBeLessThanOrEqual(width);
      const actions = page.getByRole('button', { name: 'Review and resend' });
      await expect.poll(() => actions.count()).toBe(2);
      for (const action of await actions.all()) {
        await action.scrollIntoViewIfNeeded();
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        if (width === 390) expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(
          await action.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            );
          }),
        ).toBe(true);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: resolve(artifacts, `inbox-${width}-${theme}.png`),
        fullPage: true,
      });
    } finally {
      await page.close();
    }
  },
);
