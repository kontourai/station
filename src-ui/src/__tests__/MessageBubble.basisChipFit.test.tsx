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
import { fireEvent, render, screen } from '@testing-library/react';
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
      [
        { target, isIntersecting: true },
      ] as unknown as IntersectionObserverEntry[],
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
async function answerMarkup(mobile: boolean) {
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
  const row = container.innerHTML;
  if (mobile) {
    expect(container.querySelector('.answer-basis-chip')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Answer details and actions' }),
    );
  }
  const chip = await screen.findByRole(
    'button',
    {
      name: `${LABEL} for the answer “The build passed on the second attempt.”`,
    },
    { timeout: 5_000 },
  );
  expect(chip.textContent).toBe(LABEL);
  expect(chip.getAttribute('title')).toMatch(
    /^Basis · Temporarily unavailable\. /,
  );
  if (!mobile) {
    await screen.findByRole('button', { name: 'More answer actions' });
  }
  const sheet = mobile
    ? screen.getByRole('dialog').closest('.responsive-surface-overlay')!
        .outerHTML
    : '';
  const markup = { row: mobile ? row : container.innerHTML, sheet };
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
  // The phone sheet is portalled outside the answer bubble.
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
    leadWhole:
      lead.scrollWidth <= lead.clientWidth + 0.5 && lead.clientWidth > 0,
    time: time && {
      height: time.getBoundingClientRect().height,
      fontSize: Number.parseFloat(getComputedStyle(time).fontSize),
      whole: time.scrollWidth <= time.clientWidth + 0.5,
      left: time.getBoundingClientRect().left,
      right: time.getBoundingClientRect().right,
    },
    rowOverflow: row ? row.scrollWidth > row.clientWidth : null,
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
}

describe.skipIf(!chromiumAvailable)(
  'a long Basis standing fits its row',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    it.each([
      [820, 135],
      [1000, 220],
    ])(
      'at %ipx the complete answer footer fits its %ipx allocation and reveals focusable actions',
      async (width, footerWidth) => {
        const markup = await answerMarkup(false);
        const page = await browser.newPage({
          viewport: { width, height: 850 },
        });
        page.setDefaultTimeout(3_000);
        try {
          await page.setContent(
            `<!doctype html><style>${stylesheet()}</style><main style="margin-left:120px;width:420px">${markup.row}</main>`,
          );
          const footer = page.locator('.turn-footer');
          await footer.evaluate((element, size) => {
            element.style.width = `${size}px`;
          }, footerWidth);
          const names = [
            `${LABEL} for the answer “The build passed on the second attempt.”`,
            'Copy answer',
            'More answer actions',
            'Good response',
            'Bad response',
          ];
          const buttons = names.map((name) =>
            footer.getByRole('button', { name, exact: true }),
          );
          await buttons[0]!.focus();
          for (const button of buttons) {
            expect(
              await button.evaluate((element) =>
                element.matches(':focus-visible'),
              ),
            ).toBe(true);
            await page.keyboard.press('Tab');
          }
          const fit = await page.evaluate(measure);
          expect(fit.leadWhole).toBe(true);
          const bounds = await footer.boundingBox();
          expect(bounds?.width).toBe(footerWidth);
          for (const button of buttons) {
            const box = await button.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 0.5);
            expect(box!.x + box!.width).toBeLessThanOrEqual(
              bounds!.x + bounds!.width + 0.5,
            );
          }
          await buttons[0]!.hover({ timeout: 2_000 });
          for (const button of buttons) {
            expect(
              await button.evaluate((element) => {
                const box = element.getBoundingClientRect();
                return element.contains(
                  document.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2,
                  ),
                );
              }),
            ).toBe(true);
          }
        } finally {
          await page.close();
        }
      },
    );

    it.each([280, 320, 360])(
      'in a %ipx desktop dock it stays inside the bubble, whole "Basis · " and clickable',
      async (dock) => {
        const markup = await answerMarkup(false);
        const page = await browser.newPage({
          viewport: { width: 1280, height: 800 },
        });
        try {
          await page.setContent(
            `<!doctype html><style>${stylesheet()}</style><main style="width:${dock}px;overflow:hidden">${markup.row}</main>`,
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
      'in a %ipx phone row the trailing timestamp keeps one line and the chip fits in answer details',
      async (width) => {
        const markup = await answerMarkup(true);
        const page = await browser.newPage({
          viewport: { width, height: 800 },
          hasTouch: true,
          isMobile: true,
        });
        try {
          await page.setContent(
            `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${stylesheet()}</style><main style="padding:8px">${markup.row}</main>`,
          );
          const trigger = page.getByRole('button', {
            name: 'Answer details and actions',
          });
          const rowFit = await trigger.evaluate((el) => {
            if (!(el instanceof HTMLButtonElement))
              throw new Error('Expected an answer details button');
            const time = el
              .closest('.message-meta')!
              .querySelector<HTMLElement>('.message-meta__time')!;
            const t = time.getBoundingClientRect(),
              r = el.getBoundingClientRect();
            return {
              height: t.height,
              fontSize: parseFloat(getComputedStyle(time).fontSize),
              whole: time.scrollWidth <= time.clientWidth + 1,
              timeLeft: t.left,
              timeRight: t.right,
              buttonRight: r.right,
              buttonWidth: el.offsetWidth,
              buttonHeight: el.offsetHeight,
            };
          });
          expect(rowFit.height).toBeLessThan(1.8 * rowFit.fontSize);
          expect(rowFit.whole).toBe(true);
          expect(rowFit.timeRight).toBeLessThanOrEqual(width);
          expect(rowFit.buttonRight).toBeLessThanOrEqual(rowFit.timeLeft + 1);
          expect(rowFit.buttonWidth).toBeGreaterThanOrEqual(44);
          expect(rowFit.buttonHeight).toBeGreaterThanOrEqual(44);
          await page
            .locator('body')
            .evaluate(
              (el, html) => el.insertAdjacentHTML('beforeend', html),
              markup.sheet,
            );
          const fit = await page.evaluate(measure);
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
  },
);

it.skipIf(chromiumAvailable)(
  'a long Basis standing fits its row — Chromium not installed',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the narrow-row fit of the Basis chip cannot be verified. Run npm run install:playwright and retry.',
    );
  },
);
