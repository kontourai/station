import { expect, type Page, type Route } from '@playwright/test';
import { buildLongSessionTurns } from './fixtures/long-session';
import { mockChatShell } from './helpers/chat-shell-fixture';
import { test } from './helpers/fixture-audit';
import { mockLongTranscriptConversation } from './helpers/long-transcript-conversation';
import {
  dismissSetupLauncher,
  installMockOrchestrationSse,
} from './helpers/orchestration';
import {
  attachTimeline,
  inputFreeFramesAfter,
  installTranscriptFrameSampler,
  markTimeline,
  type TranscriptFrame,
  trackedRowDrift,
  trackTimelineRow,
  waitForStableTranscript,
} from './helpers/transcript-frame-sampler';

/*
 * Owner report: "space appears below / above while the conversation loads".
 * These journeys open a long, Markdown-heavy conversation on a throttled
 * phone viewport and hold each asynchronous step (the conversation-open read,
 * the code-split renderers) behind an explicit gate, so every loading phase is
 * a deterministic frame range in the recorded timeline rather than a race.
 *
 * Every frame is sampled by `transcript-frame-sampler.ts`; each test attaches
 * that timeline (and the run records video) so a failure carries the frames
 * that broke the invariant.
 */

test.use({
  viewport: { width: 390, height: 844 },
  video: { mode: 'on', size: { width: 390, height: 844 } },
});

const THREAD_ID = 'thread-load-stability';
const CPU_THROTTLE_RATE = 4;
// Code-split chunks a transcript row needs after its first paint: the Markdown
// renderer, the worker-backed highlighter and the completed-turn footers.
const LATE_ROW_CHUNKS =
  /\/assets\/(MarkdownRenderer|highlight-client|TurnActionsMenu|ShareAnswerButton|AttachAnswerToTaskButton|CheckpointRestoreButton)-[^/]*\.js$/;

function markdownReply(index: number) {
  return [
    `Transcript fixture ${index}: answer.`,
    '',
    'Here is the change:',
    '',
    '```ts',
    `export const value${index} = ${index};`,
    `export function read${index}() {`,
    `  return value${index} * 2;`,
    '}',
    '```',
    '',
    `- first point about ${index}`,
    '- second point',
    '- third point',
  ].join('\n');
}

interface Gate {
  release(): void;
  readonly held: number;
  readonly released: boolean;
}

function gate(): Gate & { wait(): Promise<void> } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  let released = false;
  return {
    release() {
      released = true;
      open();
    },
    get held() {
      return held;
    },
    get released() {
      return released;
    },
    async wait() {
      held += 1;
      await opened;
    },
  };
}

async function openThrottledConversation(
  page: Page,
  { holdMarkdownRenderer = true }: { holdMarkdownRenderer?: boolean } = {},
) {
  const conversationOpen = gate();
  const lateChunks = gate();
  await installTranscriptFrameSampler(page);
  // The product's own opt-in layout tracer runs alongside the sampler, so its
  // dump explains a failing frame (who scrolled, what resized, which phase).
  await page.addInitScript(() =>
    localStorage.setItem('debug', 'app:transcript-layout'),
  );
  await mockChatShell(page);
  await installMockOrchestrationSse(page);
  const turns = buildLongSessionTurns({
    threadId: THREAD_ID,
    turnCount: 400,
    replyText: markdownReply,
  });
  const requestedWindows: string[] = [];
  await mockLongTranscriptConversation(page, {
    threadId: THREAD_ID,
    title: 'Load stability',
    turns: () => turns,
    onWindow: (url) => requestedWindows.push(url),
  });
  // Registered after the fixture, so these run first and fall back to it.
  await page.route(
    `**/api/conversations/${THREAD_ID}/open`,
    async (route: Route) => {
      await conversationOpen.wait();
      await route.fallback();
    },
  );
  await page.route(
    `**/api/orchestration/conversations/${THREAD_ID}/event-window**`,
    async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fallback();
    },
  );
  await page.route(LATE_ROW_CHUNKS, async (route: Route) => {
    if (
      !holdMarkdownRenderer &&
      route.request().url().includes('/MarkdownRenderer-')
    )
      return route.continue();
    await lateChunks.wait();
    await route.continue();
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', {
    rate: CPU_THROTTLE_RATE,
  });
  await page.goto(`/?dock=open&maximize=true&chat=${THREAD_ID}`);
  await dismissSetupLauncher(page);
  const transcript = page.getByRole('log', { name: 'Conversation transcript' });
  // The first page renders rows from their readable source before any late
  // chunk resolves.
  await expect(
    transcript.getByText('Transcript fixture 399: prompt.', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await markTimeline(page, 'rows-visible');
  expect(requestedWindows).toHaveLength(1);
  // The open read is still held, so the load is in progress and says so; the
  // later `expectConversationLoaded` waits are not satisfied up front.
  await expect(page.getByTestId('chat-dock-loading-announcement')).toHaveText(
    /\S/,
  );
  await expect(page.locator('.chat-input textarea')).toHaveAttribute(
    'placeholder',
    'Loading chat…',
  );
  return { conversationOpen, lateChunks, transcript, cdp };
}

/**
 * The conversation has finished loading: the dock's loading announcement has
 * gone quiet and the composer no longer names the wait.
 */
async function expectConversationLoaded(page: Page) {
  await expect(page.getByTestId('chat-dock-loading-announcement')).toHaveText(
    '',
  );
  await expect(page.locator('.chat-input textarea')).not.toHaveAttribute(
    'placeholder',
    'Loading chat…',
  );
}

function phaseFrames(
  frames: TranscriptFrame[],
  marks: Array<{ t: number; label: string }>,
  from: string,
) {
  const start = marks.find((mark) => mark.label === from)?.t;
  if (start === undefined) throw new Error(`no ${from} mark`);
  return frames.filter((frame) => frame.t >= start);
}

function blankViewportFrames(frames: TranscriptFrame[]) {
  return frames.filter(
    (frame) =>
      frame.log &&
      frame.rows > 0 &&
      frame.clientHeight > 0 &&
      frame.rowsInViewport === 0,
  );
}

test('a cold open on a throttled phone settles pinned to the newest message', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { conversationOpen, lateChunks, transcript } =
    await openThrottledConversation(page);
  await page.screenshot({
    path: testInfo.outputPath('01-rows-visible.png'),
  });

  // The open read lands while the rows still show their source text.
  conversationOpen.release();
  await expectConversationLoaded(page);
  await markTimeline(page, 'open-resolved');
  await page.screenshot({
    path: testInfo.outputPath('02-open-resolved.png'),
  });

  // Then the late renderers arrive and every row grows into its final shape.
  expect(lateChunks.held, 'rows waited on a late chunk').toBeGreaterThan(0);
  lateChunks.release();
  await expect(transcript.locator('pre').first()).toBeVisible();
  await markTimeline(page, 'chunks-resolved');
  await waitForStableTranscript(page, 30);
  await markTimeline(page, 'settled');
  await page.screenshot({ path: testInfo.outputPath('03-settled.png') });

  const timeline = await attachTimeline(page, testInfo, 'cold-open-timeline');
  // The product's opt-in tracer (enabled above) attached to the real
  // transcript and saw its rows resize.
  const trace = await page.evaluate(
    () =>
      (
        window as unknown as {
          __stationTranscriptTrace?: {
            dump(): { records: Array<{ kind: string; target?: string }> };
          };
        }
      ).__stationTranscriptTrace?.dump() ?? null,
  );
  expect(trace?.records.some((record) => record.kind === 'attach')).toBe(true);
  expect(
    trace?.records.some(
      (record) => record.kind === 'resize' && record.target?.startsWith('row:'),
    ),
  ).toBe(true);
  const settled = phaseFrames(timeline.frames, timeline.marks, 'settled');
  const loaded = phaseFrames(timeline.frames, timeline.marks, 'rows-visible');
  expect(timeline.inputs, 'the journey has no reader input').toEqual([]);
  // Nobody scrolled, so nothing may leave the transcript short of its end.
  expect(settled.length).toBeGreaterThan(0);
  expect(
    Math.max(...settled.map((frame) => frame.distanceFromBottom)),
    'a settled, unscrolled transcript sits at its newest message',
  ).toBeLessThanOrEqual(2);
  expect(
    settled.some((frame) => frame.scrollToBottom),
    'no reader moved, so no Scroll to bottom control',
  ).toBe(false);
  expect(blankViewportFrames(loaded)).toEqual([]);
  // The open read landing changes nothing about the transcript's frame: its
  // wait is announced, not drawn as a panel under the newest message.
  const heights = loaded.map((frame) => frame.clientHeight);
  expect(
    Math.max(...heights) - Math.min(...heights),
    'the transcript kept its height while the conversation finished loading',
  ).toBeLessThanOrEqual(2);
  // From the first frame the chat body shows a transcript-shaped region (the
  // loading filler, then the list), it never drops it: without one the
  // composer loses the flex fill that holds it at the bottom and jumps.
  const firstRegion = timeline.frames.findIndex(
    (frame) => frame.log || frame.filler,
  );
  expect(firstRegion, 'the loading filler was sampled').toBeGreaterThanOrEqual(
    0,
  );
  expect(
    timeline.frames
      .slice(firstRegion)
      .filter((frame) => !frame.log && !frame.filler)
      .map((frame) => ({
        t: frame.t,
        loadingAnnouncement: frame.loadingAnnouncement,
      })),
    'frames with no transcript region',
  ).toEqual([]);
});

/*
 * The composer re-measures the room it reserves whenever a row beside it
 * appears or leaves: the long-load controls, the loading announcement, the
 * filler. That measurement used to lay the composer out one line shorter for
 * a moment; the transcript took the line, the browser clamped its pinned
 * scroll position to the taller box, and the next painted frame showed a
 * one-line gap under the newest message.
 */
test('the composer measuring itself never opens a gap under the newest message', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { conversationOpen, lateChunks, transcript } =
    await openThrottledConversation(page, { holdMarkdownRenderer: false });
  lateChunks.release();
  conversationOpen.release();
  await expectConversationLoaded(page);
  await waitForStableTranscript(page, 30);
  await markTimeline(page, 'loaded');
  await page.screenshot({ path: testInfo.outputPath('composer-loaded.png') });
  // A draft that grows past one line, then is cleared again.
  const draft = page.locator('.chat-input textarea');
  await draft.click();
  await page.keyboard.type('first line', { delay: 30 });
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line', { delay: 30 });
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('third', { delay: 30 });
  await waitForStableTranscript(page, 10);
  await markTimeline(page, 'typed');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await waitForStableTranscript(page, 10);
  await markTimeline(page, 'cleared');
  const timeline = await attachTimeline(page, testInfo, 'composer-timeline');
  const rowsVisible = timeline.marks.find(
    (mark) => mark.label === 'rows-visible',
  )!.t;
  const framed = timeline.frames.filter(
    (frame) => frame.t >= rowsVisible && frame.log && frame.composer,
  );
  expect(framed.length).toBeGreaterThan(0);
  expect(
    framed
      .filter((frame) => frame.distanceFromBottom > 1)
      .map((frame) => ({ t: frame.t, gap: frame.distanceFromBottom })),
    'frames that painted space under the newest message',
  ).toEqual([]);
  expect(
    framed
      .filter(
        (frame) =>
          Math.abs(frame.composer!.top - frame.composer!.regionBottom) > 0.5,
      )
      .map((frame) => frame.t),
    'frames where the composer came loose from the transcript',
  ).toEqual([]);
  await expect(transcript).toBeVisible();
});

test("the long-load row keeps the transcript's inset on a phone", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { conversationOpen, lateChunks, transcript } =
    await openThrottledConversation(page, { holdMarkdownRenderer: false });
  lateChunks.release();
  const sentence = page
    .locator('.chat-dock__body > .session-history-controls')
    .getByText('This conversation is taking longer to load.', {
      exact: false,
    });
  await expect(sentence).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath('long-wait-390.png') });
  const gutter = await transcript.evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).paddingLeft) || 0,
  );
  const row = await page
    .locator('.chat-dock__body > .session-history-controls')
    .boundingBox();
  const text = await sentence.boundingBox();
  const viewport = page.viewportSize()!;
  expect(gutter).toBeGreaterThan(0);
  expect(row).not.toBeNull();
  expect(text).not.toBeNull();
  // The words sit inside the same gutter as the transcript's rows.
  expect(text!.x - row!.x).toBeGreaterThanOrEqual(gutter - 0.5);
  expect(text!.x).toBeGreaterThanOrEqual(gutter - 0.5);
  expect(text!.x + text!.width).toBeLessThanOrEqual(
    viewport.width - gutter + 0.5,
  );
  conversationOpen.release();
  await expectConversationLoaded(page);
});

test('a reader scrolled up keeps their row while late content renders', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { conversationOpen, lateChunks, transcript } =
    await openThrottledConversation(page);
  conversationOpen.release();
  await expectConversationLoaded(page);
  await waitForStableTranscript(page);

  await transcript.hover();
  await page.mouse.wheel(0, -900);
  await expect(
    page.getByRole('button', { name: 'Scroll to bottom' }),
  ).toBeVisible();
  await waitForStableTranscript(page);
  // The row the transcript keeps: the first one still showing at the top of
  // the viewport (`captureChatScrollAnchor`). A row below it moves whenever
  // this one grows, and that movement is the content, not a jump.
  const anchor = await transcript.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [
      ...element.querySelectorAll<HTMLElement>(
        '.chat-message-anchor[data-chat-message-key]',
      ),
    ].find(
      (candidate) => candidate.getBoundingClientRect().bottom > bounds.top,
    );
    return row
      ? {
          key: row.dataset.chatMessageKey ?? '',
          offset: row.getBoundingClientRect().top - bounds.top,
        }
      : null;
  });
  expect(anchor, 'a row to keep').not.toBeNull();
  await trackTimelineRow(page, anchor!.key);
  await markTimeline(page, 'reader-anchored');
  await page.screenshot({
    path: testInfo.outputPath('01-reader-anchored.png'),
  });

  expect(lateChunks.held, 'rows waited on a late chunk').toBeGreaterThan(0);
  lateChunks.release();
  await expect(transcript.locator('pre').first()).toBeAttached();
  await waitForStableTranscript(page, 30);
  await markTimeline(page, 'settled');
  await page.screenshot({ path: testInfo.outputPath('02-settled.png') });

  const timeline = await attachTimeline(page, testInfo, 'reader-timeline');
  const after = inputFreeFramesAfter(
    timeline,
    timeline.marks.find((mark) => mark.label === 'reader-anchored')!.t,
  );
  const drift = trackedRowDrift(after, timeline.inputs);
  await testInfo.attach('reader-drift.json', {
    contentType: 'application/json',
    body: JSON.stringify({ anchor, drift }),
  });
  expect(
    drift.frames,
    'the kept row was compared across frames',
  ).toBeGreaterThan(10);
  expect(drift.unmounted, 'the kept row stayed mounted').toBe(0);
  expect(
    drift.max,
    'the kept row moved between input-free frames',
  ).toBeLessThanOrEqual(2);
  const final = after.at(-1)!;
  expect(Math.abs(final.tracked!.offset - anchor!.offset)).toBeLessThanOrEqual(
    2,
  );
  expect(blankViewportFrames(after)).toEqual([]);
});

test('loading earlier history into the virtualized transcript never blanks the viewport', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { conversationOpen, lateChunks, transcript } =
    await openThrottledConversation(page);
  conversationOpen.release();
  lateChunks.release();
  await expect(transcript.locator('pre').first()).toBeAttached();
  await waitForStableTranscript(page, 30);
  const earlier = page.getByRole('button', { name: 'Earlier messages' });
  await expect(
    transcript.getByTestId('virtualized-transcript-spacer'),
  ).toHaveCount(0);
  // The first window is ten turns (20 messages); one page adds twenty turns,
  // crossing the 40-message virtualization threshold. The reader is up in
  // the history, clear of the auto-load band at the top, when they ask for
  // the page before it.
  const scrollTop = await transcript.evaluate((element) => element.scrollTop);
  await transcript.hover();
  await page.mouse.wheel(0, -(scrollTop - 500));
  await expect(
    page.getByRole('button', { name: 'Scroll to bottom' }),
  ).toBeVisible();
  await waitForStableTranscript(page);
  const anchor = await transcript.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [
      ...element.querySelectorAll<HTMLElement>(
        '.chat-message-anchor[data-chat-message-key]',
      ),
    ].find(
      (candidate) => candidate.getBoundingClientRect().bottom > bounds.top,
    );
    return row
      ? {
          key: row.dataset.chatMessageKey ?? '',
          offset: row.getBoundingClientRect().top - bounds.top,
          scrollTop: element.scrollTop,
        }
      : null;
  });
  expect(anchor, 'a row to keep').not.toBeNull();
  expect(anchor!.scrollTop, 'clear of the 96px auto-load band').toBeGreaterThan(
    200,
  );
  await trackTimelineRow(page, anchor!.key);
  await earlier.evaluate((button) =>
    (button as HTMLElement).focus({ preventScroll: true }),
  );
  await markTimeline(page, 'earlier-pressed');
  await page.keyboard.press('Enter');
  await expect(
    transcript.getByTestId('virtualized-transcript-spacer'),
  ).toHaveAttribute('data-transcript-row-count', '60');
  await waitForStableTranscript(page, 30);
  await markTimeline(page, 'virtualized');
  await page.screenshot({ path: testInfo.outputPath('01-virtualized.png') });
  const timeline = await attachTimeline(page, testInfo, 'earlier-timeline');
  const frames = phaseFrames(
    timeline.frames,
    timeline.marks,
    'earlier-pressed',
  );
  expect(
    frames.some((frame) => frame.rows > 0),
    'the handoff was sampled',
  ).toBe(true);
  expect(blankViewportFrames(frames)).toEqual([]);
  // Twenty turns land above the reader and the list becomes virtualized
  // under them; the row they were reading stays where it was.
  const pressedAt = timeline.marks.find(
    (mark) => mark.label === 'earlier-pressed',
  )!.t;
  const drift = trackedRowDrift(
    inputFreeFramesAfter(timeline, pressedAt),
    timeline.inputs,
  );
  await testInfo.attach('earlier-drift.json', {
    contentType: 'application/json',
    body: JSON.stringify({ anchor, drift }),
  });
  expect(
    drift.frames,
    'the kept row was compared across frames',
  ).toBeGreaterThan(10);
  expect(
    drift.max,
    'the kept row moved between input-free frames',
  ).toBeLessThanOrEqual(2);
  const final = frames.at(-1)!;
  expect(final.tracked, 'the kept row is still mounted').not.toBeNull();
  expect(Math.abs(final.tracked!.offset - anchor!.offset)).toBeLessThanOrEqual(
    2,
  );
});

test('Scroll to bottom glides to the newest message and hands back to follow', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { conversationOpen, lateChunks, transcript } =
    await openThrottledConversation(page);
  conversationOpen.release();
  lateChunks.release();
  await expect(transcript.locator('pre').first()).toBeAttached();
  await waitForStableTranscript(page, 30);
  await transcript.hover();
  await page.mouse.wheel(0, -1_400);
  const jump = page.getByRole('button', { name: 'Scroll to bottom' });
  await expect(jump).toBeVisible();
  await waitForStableTranscript(page);
  await markTimeline(page, 'jump');
  await jump.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);
  await waitForStableTranscript(page);
  await markTimeline(page, 'landed');
  const timeline = await attachTimeline(page, testInfo, 'jump-timeline');
  const jumpAt = timeline.marks.find((mark) => mark.label === 'jump')!.t;
  // Frames after the key press: the press itself is the only input.
  const travel = inputFreeFramesAfter(timeline, jumpAt);
  const tops = travel.map((frame) => frame.scrollTop);
  await testInfo.attach('jump-travel.json', {
    contentType: 'application/json',
    body: JSON.stringify(tops),
  });
  // Frame counts depend on the host; the invariants do not: it only ever
  // moves toward the end, and lands there.
  const final = travel.at(-1)!;
  const intermediate = new Set(tops.filter((top) => top < tops.at(-1)! - 1));
  expect(
    intermediate.size,
    'it passes through positions on the way, not one jump',
  ).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < tops.length; index += 1)
    expect(tops[index]).toBeGreaterThanOrEqual(tops[index - 1] - 1);
  expect(final.distanceFromBottom).toBeLessThanOrEqual(2);
});

test('Markdown that arrived before the transcript paints parsed, not as source that grows', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { conversationOpen, transcript } = await openThrottledConversation(
    page,
    { holdMarkdownRenderer: false },
  );
  conversationOpen.release();
  await expectConversationLoaded(page);
  await waitForStableTranscript(page, 30);
  await markTimeline(page, 'settled');
  const timeline = await attachTimeline(page, testInfo, 'first-paint-timeline');
  const rowsVisible = timeline.marks.find(
    (mark) => mark.label === 'rows-visible',
  )!.t;
  // The code fences render as code blocks from the rows' first paint.
  await expect(transcript.locator('pre').first()).toBeAttached();
  expect(
    await transcript.evaluate((element) =>
      element.textContent?.includes('```'),
    ),
    'no row shows its Markdown source',
  ).toBe(false);
  const rowShifts = timeline.shifts.filter(
    (shift) =>
      shift.t >= rowsVisible - 1_000 &&
      shift.value > 0.05 &&
      shift.sources.some((source) => source.startsWith('row:')),
  );
  expect(rowShifts, 'rows that moved because they re-rendered').toEqual([]);
});

test.describe('a finger on the phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const [pace, speed] of [
    ['slow', 200],
    ['fast', 800],
  ] as const) {
    test(`a ${pace} drag up from the newest message leaves it, and stays left`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const { conversationOpen, lateChunks, transcript, cdp } =
        await openThrottledConversation(page);
      conversationOpen.release();
      lateChunks.release();
      await expect(transcript.locator('pre').first()).toBeAttached();
      await waitForStableTranscript(page, 30);
      const before = await transcript.evaluate((element) => ({
        scrollTop: element.scrollTop,
        short: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      expect(before.short, 'starts at the newest message').toBeLessThanOrEqual(
        2,
      );
      const box = (await transcript.boundingBox())!;
      await markTimeline(page, 'drag');
      // A real touch drag with its fling: pointer cancelled once panning
      // starts, momentum after the finger lifts.
      await cdp.send('Input.synthesizeScrollGesture', {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        yDistance: 200,
        speed,
        gestureSourceType: 'touch',
        preventFling: false,
      });
      await waitForStableTranscript(page, 30);
      await markTimeline(page, 'settled');
      await attachTimeline(page, testInfo, `touch-${pace}-timeline`);
      const after = await transcript.evaluate((element) => ({
        scrollTop: element.scrollTop,
        short: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      await testInfo.attach(`touch-${pace}.json`, {
        contentType: 'application/json',
        body: JSON.stringify({ before, after }),
      });
      expect(
        before.scrollTop - after.scrollTop,
        'the drag moved the transcript',
      ).toBeGreaterThan(100);
      expect(after.short).toBeGreaterThan(100);
      await expect(
        page.getByRole('button', { name: 'Scroll to bottom' }),
      ).toBeVisible();
    });
  }
});

// Owner report: "scrolling manually to the bottom gets there and then scrolls
// back up", while Scroll to bottom worked. Reaching the end removed Scroll to
// bottom from the composer, the composer re-measured itself by shrinking its
// draft, and the browser clamped the transcript up by that much while the
// wheel was still counted as the reader's: the transcript stayed unpinned,
// 18px (desktop, virtualized) or 69px (phone) short. Fixed by #3661's
// measurement; these pin the reader's own path to the end.
test.describe('wheeling back to the newest message', () => {
  for (const [label, viewport, turnCount] of [
    ['desktop, virtualized', { width: 1280, height: 900 }, 400],
    ['phone, short chat', { width: 390, height: 844 }, 8],
  ] as const) {
    test(`stays at the newest message (${label})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockChatShell(page);
      await installMockOrchestrationSse(page);
      const threadId = 'thread-wheel-to-end';
      const turns = buildLongSessionTurns({
        threadId,
        turnCount,
        replyText: (index) =>
          `Reply ${index}.\n\n- one\n- two\n- three\n\n${'word '.repeat(40)}`,
      });
      await mockLongTranscriptConversation(page, {
        threadId,
        title: 'Wheel to end',
        turns: () => turns,
      });
      await page.goto(`/?dock=open&maximize=true&chat=${threadId}`);
      await dismissSetupLauncher(page);
      const transcript = page.getByRole('log', {
        name: 'Conversation transcript',
      });
      await expect(
        transcript.getByText(`Reply ${turnCount - 1}.`, { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await waitForStableTranscript(page, 30);
      const shortBy = () =>
        transcript.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        );
      await transcript.hover();
      await page.mouse.wheel(0, -1_200);
      const jump = page.getByRole('button', { name: 'Scroll to bottom' });
      await expect(jump).toBeVisible();
      // Back down in wheel notches, past the end, the way a person does.
      for (let notch = 0; notch < 30; notch += 1) {
        await page.mouse.wheel(0, 120);
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(resolve)),
        );
      }
      await waitForStableTranscript(page, 30);
      await expect.poll(shortBy).toBeLessThanOrEqual(1);
      await expect(jump).toHaveCount(0);
    });
  }
});
