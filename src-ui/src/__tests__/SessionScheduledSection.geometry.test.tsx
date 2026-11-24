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
      automations: [
        { name: 'release-notes-digest' },
        { name: 'nightly-dependency-audit' },
        { name: 'weekly-review-summary' },
      ],
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
      // Long names: one with no break opportunity at all, one with spaces.
      {
        name: 'nightly-dependency-audit',
        displayName:
          'NightlyDependencyAuditAcrossEveryWorkspacePackageAndTheLockfileToo',
        provider: 'builtin',
        prompt: 'p',
        enabled: true,
        schedule: { kind: 'every', everyMs: 86_400_000 },
      },
      {
        name: 'weekly-review-summary',
        displayName:
          'Weekly review summary of every merged change and the open questions left on them',
        provider: 'builtin',
        prompt: 'p',
        enabled: false,
        schedule: { kind: 'every', everyMs: 604_800_000 },
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

    // The text's width depends on the font the host falls back to, so the
    // pair of links is also measured at a spacing that always fits one line
    // and at one that never does. Both outcomes are then checked on every
    // host, whatever its font.
    test.each([
      ['in the host’s own font', '', undefined],
      ['when the pair fits one line', 'letter-spacing:-1px', true],
      ['when the pair is too wide for one line', 'letter-spacing:4px', false],
    ] as const)(
      'its header links and a row’s controls stay inside the 280px card, %s',
      async (_case, linkSpacing, pairMustFit) => {
        expect(SESSION_CONTEXT_CARD_WIDTH).toBe(280);
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
        });
        try {
          await page.setContent(
            `<style>${css}</style><style>.session-scheduled__links button{${linkSpacing}}</style><div style="display:flex;justify-content:flex-end">${cardMarkup()}</div>`,
          );
          const card = await page.getByTestId('card').boundingBox();
          expect(card).not.toBeNull();
          const right = card!.x + card!.width;
          const controls = [
            page.getByRole('button', { name: 'New automation' }),
            page.getByRole('button', { name: 'All automations' }),
            ...(await page.getByRole('button', { name: /^Run .* now$/ }).all()),
            ...(await page.getByRole('button', { name: /^Edit / }).all()),
            ...(await page.getByRole('switch').all()),
            ...(await page.locator('.session-scheduled__name').all()),
          ];
          // Three rows, each with Run, Edit, a switch and a name.
          expect(controls).toHaveLength(2 + 3 * 4);
          for (const control of controls) {
            const box = await control.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.x).toBeGreaterThanOrEqual(card!.x - 0.5);
            expect(box!.x + box!.width).toBeLessThanOrEqual(right + 0.5);
          }
          // The two links keep together on one line (under the title when they
          // do not fit beside it) whenever the pair fits the header's width. When
          // the text is too wide for that, they stack in order. Every control,
          // these two included, was held inside the card above.
          const newLink = await controls[0].boundingBox();
          const allLink = await controls[1].boundingBox();
          const group = page.locator('.session-scheduled__links');
          const groupBox = await group.boundingBox();
          expect(groupBox).not.toBeNull();
          const gap = await group.evaluate(
            (node) => Number.parseFloat(getComputedStyle(node).columnGap) || 0,
          );
          const pairFits =
            newLink!.width + allLink!.width + gap <= groupBox!.width + 0.5;
          if (pairMustFit !== undefined) expect(pairFits).toBe(pairMustFit);
          if (pairFits) {
            expect(Math.abs(newLink!.y - allLink!.y)).toBeLessThan(1);
            expect(newLink!.x).toBeLessThan(allLink!.x);
          } else {
            expect(allLink!.y).toBeGreaterThanOrEqual(
              newLink!.y + newLink!.height - 0.5,
            );
          }
          // Each link is one line of text, not "New / automation" stacked.
          for (const link of controls.slice(0, 2)) {
            const lines = await link.evaluate((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              return new Set(
                [...range.getClientRects()].map((rect) => Math.round(rect.top)),
              ).size;
            });
            expect(lines).toBe(1);
          }
          // Nothing in the card is wider than the card.
          const overflow = await page
            .getByTestId('card')
            .evaluate((node) => node.scrollWidth - node.clientWidth);
          expect(overflow).toBeLessThanOrEqual(0);
        } finally {
          await page.close();
        }
      },
    );
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
