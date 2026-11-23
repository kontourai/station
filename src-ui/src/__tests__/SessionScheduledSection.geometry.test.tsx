/**
 * @vitest-environment jsdom
 *
 * #5493: in the dock's "This chat" card (a 280px column at the dock's right
 * edge) the Automations header did not wrap. Its title and two links were
 * wider than the card, so the section's grid column grew past the card and
 * "All automations" and each row's On toggle ran off the card's edge, where
 * the card clips them.
 *
 * jsdom lays nothing out, so the section's real markup is measured in
 * Chromium against the real cascade.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'device-a',
    requiresEnrolledCredential: false,
    isCurrent: () => true,
  }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../hooks/useAgentSchedule', () => ({
  useAgentSchedule: () => ({
    schedule: {
      wakeUps: [],
      jobProposals: [],
      jobs: [],
      automations: [{ name: 'release-notes-digest' }],
    },
    loaded: true,
    cancelWakeUp: { mutate: vi.fn(), isPending: false },
    holdResume: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock('../hooks/useScheduler', () => ({
  useSchedulerJobs: () => ({
    data: [
      {
        name: 'release-notes-digest',
        displayName: 'Release notes digest for the weekly review',
        provider: 'builtin',
        prompt: 'p',
        enabled: true,
        schedule: { kind: 'every', everyMs: 3_600_000 },
      },
    ],
    isSuccess: true,
    isError: false,
  }),
  useRunJob: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleJob: () => ({ mutate: vi.fn(), isPending: false }),
  useScheduledConversationTargetCapability: () => ({ data: true }),
}));

const { SessionScheduledSection } = await import(
  '../components/chat-dock/SessionScheduledSection'
);
const { SESSION_CONTEXT_CARD_WIDTH } = await import(
  '../components/chat-dock/sessionContextCardModel'
);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

const css = [
  '../index.css',
  '../components/Toggle.css',
  '../components/chat-dock/SessionContextCard.css',
  '../components/chat-dock/SessionScheduledSection.css',
]
  .map((path) => resolveCssImports(resolve(HERE, path)))
  .join('\n');

/** The section as the card renders it, in the card's own column. */
function cardMarkup(): string {
  const client = new QueryClient();
  const { container, unmount } = render(
    <QueryClientProvider client={client}>
      <aside
        className="session-context-card"
        data-testid="card"
        style={{
          width: SESSION_CONTEXT_CARD_WIDTH,
          height: 600,
        }}
      >
        <SessionScheduledSection conversationId="chat-1" wrap={(a) => a()} />
      </aside>
    </QueryClientProvider>,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

describe.skipIf(!chromiumAvailable)(
  'the This chat card’s Automations section at the card’s width',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      assertNoImportsSurvive(css);
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(cleanup);

    test('its header links and a row’s controls stay inside the 280px card', async () => {
      expect(SESSION_CONTEXT_CARD_WIDTH).toBe(280);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      try {
        await page.setContent(
          `<style>${css}</style><div style="display:flex;justify-content:flex-end">${cardMarkup()}</div>`,
        );
        const card = await page.getByTestId('card').boundingBox();
        expect(card).not.toBeNull();
        const right = card!.x + card!.width;
        const controls = [
          page.getByRole('button', { name: 'New automation' }),
          page.getByRole('button', { name: 'All automations' }),
          page.getByRole('button', { name: /^Run .* now$/ }),
          page.getByRole('button', { name: /^Edit / }),
          page.getByRole('switch'),
        ];
        for (const control of controls) {
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(card!.x - 0.5);
          expect(box!.x + box!.width).toBeLessThanOrEqual(right + 0.5);
        }
        // The two links keep together on one line (under the title when they
        // do not fit beside it), not one stranded on a line of its own.
        const newLink = await controls[0].boundingBox();
        const allLink = await controls[1].boundingBox();
        expect(Math.abs(newLink!.y - allLink!.y)).toBeLessThan(1);
        expect(newLink!.x).toBeLessThan(allLink!.x);
        // Nothing in the card is wider than the card.
        const overflow = await page
          .getByTestId('card')
          .evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      } finally {
        await page.close();
      }
    });
  },
);

/**
 * A geometry check that silently skips is indistinguishable from one that
 * passes, so the missing precondition fails loudly instead.
 */
test.skipIf(chromiumAvailable)(
  'Automations section geometry — Chromium not installed, cannot verify (#5493)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'Automations section could not be measured at the card’s width — this ' +
        'is a missing precondition, not a passing check.',
    );
  },
);
