/**
 * @vitest-environment jsdom
 *
 * A notable Basis chip's longest Surface label ("Temporarily unavailable")
 * in the narrowest rows it lives in, laid out in Chromium with the real
 * stylesheets: the REAL MessageBubble and chip, fed Surface's REAL view model
 * through the SDK read. Only `fetch`, the authority hook, the phone predicate
 * and IntersectionObserver (everything reported on screen) are replaced.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { chromium } from '@playwright/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { answerBasisProjection } from '../../../packages/basis-pane/src/__tests__/fixtures/answer-basis-standing';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import type { ChatMessage } from '../types';

const mocks = vi.hoisted(() => ({
  isMobile: false,
  authority: {
    apiBase: 'http://station.test',
    authorityKey: 'authority-a',
    isCurrent: () => true,
  },
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../hooks/useIsMobile', async (original) => ({
  ...(await original<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => mocks.isMobile,
}));
vi.mock('../contexts/ApiBaseContext', async (original) => ({
  ...(await original<typeof import('../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => mocks.authority,
}));
vi.mock('../contexts/ProjectsContext', async (original) => ({
  ...(await original<typeof import('../contexts/ProjectsContext')>()),
  useScopedProjectQuery: () => ({ data: undefined }),
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

const SESSION = 'agent:1792425046978';
const LABEL = 'Basis · Temporarily unavailable';
const HERE = dirname(fileURLToPath(import.meta.url));
const chromiumAvailable = chromiumIsInstalled(resolve(HERE, '../../../'));

class OnScreenObserver {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, isIntersecting: true }] as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', OnScreenObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: answerBasisProjection('unresolved', SESSION, 'm-1'),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  setClientCredentialResolver(() => ({
    origin: mocks.authority.apiBase,
    requestAuthority: mocks.authority,
  }));
});
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

/** One settled answer whose chip carries the longest unresolved label. */
async function answerMarkup(mobile: boolean): Promise<string> {
  mocks.isMobile = mobile;
  const { container, unmount } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble
        msg={
          {
            role: 'assistant',
            content: 'The build passed on the second attempt.',
            sessionId: SESSION,
            turnId: 'turn-1',
            answerEligible: true,
            timestamp: Date.parse('2026-10-19T16:10:00Z'),
            provenance: {
              envelopeVersion: 1,
              sessionId: SESSION,
              turnId: 'turn-1',
              outcome: 'completed',
              observedAt: '2026-10-19T16:10:00.000Z',
              engine: {
                state: 'observed',
                value: { provider: 'codex' },
                observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
              },
              requestedModel: {
                state: 'unavailable',
                reason: 'not-reported-by-engine',
              },
              reportedModel: {
                state: 'unavailable',
                reason: 'not-reported-by-engine',
              },
              tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
              usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
              routingReceipt: {
                state: 'unavailable',
                reason: 'not-captured-by-station',
              },
              sources: {
                state: 'unavailable',
                reason: 'not-captured-by-station',
              },
              trustReport: {
                state: 'unavailable',
                reason: 'not-captured-by-station',
              },
            },
          } as unknown as ChatMessage
        }
        idx={0}
        activeSession={{ id: SESSION, agentSlug: 'agent', messageCount: 1 }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
      />
    </QueryClientProvider>,
  );
  const chip = await screen.findByRole(
    'button',
    { name: `${LABEL} for the answer “The build passed on the second attempt.”` },
    { timeout: 5_000 },
  );
  expect(chip.textContent).toBe(LABEL);
  expect(chip.getAttribute('title')).toMatch(/^Basis · Temporarily unavailable\. /);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function stylesheet(): string {
  const css = `${resolveCssImports(resolve(HERE, '../index.css'))}\n${resolveCssImports(resolve(HERE, '../components/chat/chat.css'))}`;
  assertNoImportsSurvive(css);
  return css;
}

/** Where the chip landed, and whether its "Basis · " lead is whole. */
function measure() {
  const chip = document.querySelector<HTMLElement>('.answer-basis-chip')!;
  const lead = chip.querySelector<HTMLElement>(
    '.station-basis-affordance__lead',
  )!;
  // On a phone the chip sits in the meta row below the bubble, not in it.
  const bubble = chip.closest<HTMLElement>('.message')?.getBoundingClientRect();
  const box = chip.getBoundingClientRect();
  const hit = document.elementFromPoint(
    box.x + box.width / 2,
    box.y + box.height / 2,
  );
  const time = document.querySelector<HTMLElement>('.message-meta__time');
  const row = document.querySelector<HTMLElement>('.message-meta');
  return {
    chip: { left: box.left, right: box.right, width: box.width },
    bubble: bubble ? { left: bubble.left, right: bubble.right } : null,
    hittable: Boolean(hit && chip.contains(hit)),
    leadWhole: lead.scrollWidth <= lead.clientWidth + 0.5 && lead.clientWidth > 0,
    time: time && {
      height: time.getBoundingClientRect().height,
      fontSize: Number.parseFloat(getComputedStyle(time).fontSize),
      whole: time.scrollWidth <= time.clientWidth + 0.5,
      right: time.getBoundingClientRect().right,
    },
    rowOverflow: row ? row.scrollWidth > row.clientWidth : null,
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
}

describe.skipIf(!chromiumAvailable)('a long Basis standing fits its row', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each([280, 320, 360])(
    'in a %ipx desktop dock it stays inside the bubble, whole "Basis · " and clickable',
    async (dock) => {
      const markup = await answerMarkup(false);
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      try {
        await page.setContent(
          `<!doctype html><style>${stylesheet()}</style><main style="width:${dock}px;overflow:hidden">${markup}</main>`,
        );
        expect(
          await page.evaluate(() => matchMedia('(hover: hover)').matches),
        ).toBe(true);
        const fit = await page.evaluate(measure);
        expect(fit.chip.left).toBeGreaterThanOrEqual(0);
        expect(fit.bubble).not.toBeNull();
        expect(fit.chip.left).toBeGreaterThanOrEqual(fit.bubble!.left);
        expect(fit.chip.right).toBeLessThanOrEqual(fit.bubble!.right);
        expect(fit.leadWhole).toBe(true);
        expect(fit.hittable).toBe(true);
      } finally {
        await page.close();
      }
    },
  );

  it.each([320, 375])(
    'in a %ipx phone row the timestamp keeps one line and the chip stays on screen',
    async (width) => {
      const markup = await answerMarkup(true);
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: true,
        isMobile: true,
      });
      try {
        await page.setContent(
          `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${stylesheet()}</style><main style="padding:8px">${markup}</main>`,
        );
        const fit = await page.evaluate(measure);
        expect(fit.time).not.toBeNull();
        // One line: a second would at least double a ~1.2em line box.
        expect(fit.time!.height).toBeLessThan(1.8 * fit.time!.fontSize);
        expect(fit.time!.whole).toBe(true);
        expect(fit.time!.right).toBeLessThanOrEqual(fit.chip.left);
        expect(fit.chip.left).toBeGreaterThanOrEqual(0);
        expect(fit.chip.right).toBeLessThanOrEqual(width);
        expect(fit.rowOverflow).toBe(false);
        expect(fit.pageOverflow).toBe(false);
        expect(fit.leadWhole).toBe(true);
        expect(fit.hittable).toBe(true);
      } finally {
        await page.close();
      }
    },
  );
});

it.skipIf(chromiumAvailable)(
  'a long Basis standing fits its row — Chromium not installed',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the narrow-row fit of the Basis chip cannot be verified. Run npm run install:playwright and retry.',
    );
  },
);
