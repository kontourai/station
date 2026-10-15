import { writeFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';

/** One rAF sample of the conversation transcript's geometry. */
export interface TranscriptFrame {
  t: number;
  /** A `role="log"` transcript scroller is mounted. */
  log: boolean;
  /** The empty/loading filler (`.chat-messages--empty`) is mounted instead. */
  filler: boolean;
  /**
   * What the dock's loading announcement region says this frame ('' when no
   * load is in progress). The skeletons no longer carry the wait over a
   * displayed transcript, so counting them would miss it.
   */
  loadingAnnouncement: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  /** Message rows mounted in the scroller. */
  rows: number;
  /** Mounted rows intersecting the scroller's viewport. */
  rowsInViewport: number;
  /** Top row intersecting the viewport and its offset from the viewport top. */
  first: { key: string; offset: number } | null;
  /** The "Scroll to bottom" control is rendered. */
  scrollToBottom: boolean;
  /** The scroller's bottom edge in viewport coordinates. */
  logBottom: number;
  /** Offset of the row named by `trackTimelineRow`, when it is mounted. */
  tracked: { key: string; offset: number } | null;
  /**
   * The composer (`.chat-input`) in viewport coordinates, and the bottom edge
   * of the region above it (the transcript scroller or the loading filler).
   * `null` while either is unmounted.
   */
  composer: { top: number; height: number; regionBottom: number } | null;
}

export interface TranscriptTimeline {
  frames: TranscriptFrame[];
  /** Timestamps of reader input (wheel, touch, pointer, key). */
  inputs: number[];
  shifts: Array<{
    t: number;
    value: number;
    hadRecentInput: boolean;
    sources: string[];
  }>;
  marks: Array<{ t: number; label: string }>;
  droppedFrames: number;
}

const MAX_FRAMES = 20_000;

/**
 * Installs a per-frame transcript sampler before any page script runs. Each
 * sample is taken after the frame has rendered. It reads geometry only; it
 * never writes scroll positions.
 */
export async function installTranscriptFrameSampler(page: Page) {
  await page.addInitScript((maxFrames: number) => {
    const timeline = {
      frames: [] as unknown[],
      inputs: [] as number[],
      shifts: [] as unknown[],
      marks: [] as unknown[],
      droppedFrames: 0,
      trackedKey: null as string | null,
    };
    const describe = (node: Node | null | undefined) => {
      if (!(node instanceof Element)) return 'unknown';
      const row = node.closest<HTMLElement>('[data-chat-message-key]');
      if (row) return `row:${row.dataset.chatMessageKey}`;
      const labelled = node.closest('[aria-label]');
      const label = labelled?.getAttribute('aria-label');
      const cls =
        typeof node.className === 'string'
          ? node.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
          : '';
      return `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${label ? `[${label}]` : ''}`;
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      window.addEventListener(
        type,
        () => timeline.inputs.push(performance.now()),
        { capture: true, passive: true },
      );
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<
          PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: Array<{ node?: Node | null }>;
          }
        >) {
          timeline.shifts.push({
            t: entry.startTime,
            value: entry.value,
            hadRecentInput: entry.hadRecentInput,
            sources: (entry.sources ?? []).map((source) =>
              describe(source.node),
            ),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Layout Instability is Chromium-only; frames still carry geometry.
    }
    const sample = () => {
      const log = document.querySelector<HTMLElement>(
        '.chat-messages[role="log"]',
      );
      const filler = document.querySelector('.chat-messages--empty');
      const frame: Record<string, unknown> = {
        t: performance.now(),
        log: Boolean(log),
        filler: Boolean(filler),
        loadingAnnouncement:
          document.querySelector(
            '[data-testid="chat-dock-loading-announcement"]',
          )?.textContent ?? '',
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        distanceFromBottom: 0,
        rows: 0,
        rowsInViewport: 0,
        first: null,
        scrollToBottom: Boolean(
          document.querySelector('button[aria-label="Scroll to bottom"]'),
        ),
        logBottom: 0,
        tracked: null,
        composer: null,
      };
      const composer = document.querySelector<HTMLElement>('.chat-input');
      const region = log ?? filler;
      if (composer && region) {
        const box = composer.getBoundingClientRect();
        frame.composer = {
          top: box.top,
          height: box.height,
          regionBottom: region.getBoundingClientRect().bottom,
        };
      }
      if (log) {
        const bounds = log.getBoundingClientRect();
        // One per transcript row: a bubble nests its own keyed element.
        const rows = [
          ...log.querySelectorAll<HTMLElement>(
            '.chat-message-anchor[data-chat-message-key]',
          ),
        ];
        let first: { key: string; offset: number } | null = null;
        let inViewport = 0;
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          if (row.dataset.chatMessageKey === timeline.trackedKey)
            frame.tracked = {
              key: timeline.trackedKey,
              offset: rect.top - bounds.top,
            };
          if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
            inViewport += 1;
            if (!first)
              first = {
                key: row.dataset.chatMessageKey ?? '',
                offset: rect.top - bounds.top,
              };
          }
        }
        Object.assign(frame, {
          scrollTop: log.scrollTop,
          scrollHeight: log.scrollHeight,
          clientHeight: log.clientHeight,
          distanceFromBottom:
            log.scrollHeight - log.scrollTop - log.clientHeight,
          rows: rows.length,
          rowsInViewport: inViewport,
          first,
          logBottom: bounds.bottom,
        });
      }
      if (timeline.frames.length >= maxFrames) {
        timeline.frames.shift();
        timeline.droppedFrames += 1;
      }
      timeline.frames.push(frame);
    };
    // Sample what the frame paints. requestAnimationFrame runs BEFORE the
    // frame's layout and the page's ResizeObserver corrections, and a task
    // after the frame can already hold the next commit. A ResizeObserver
    // created inside rAF is newer than every observer the page owns, so its
    // first notification runs after theirs in the same frame, just before
    // paint.
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:-2px;top:-2px;width:1px;height:1px;pointer-events:none';
    const frameLoop = () => {
      if (!probe.isConnected) document.documentElement.append(probe);
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        sample();
        requestAnimationFrame(frameLoop);
      });
      observer.observe(probe);
    };
    requestAnimationFrame(frameLoop);
    (window as unknown as Record<string, unknown>).__transcriptTimeline = {
      read: () => timeline,
      mark: (label: string) =>
        timeline.marks.push({ t: performance.now(), label }),
      track: (key: string) => {
        timeline.trackedKey = key;
      },
    };
  }, MAX_FRAMES);
}

export async function markTimeline(page: Page, label: string) {
  await page.evaluate((value) => {
    (
      window as unknown as {
        __transcriptTimeline: { mark(label: string): void };
      }
    ).__transcriptTimeline.mark(value);
  }, label);
}

/** Records the named row's viewport offset in every later frame. */
export async function trackTimelineRow(page: Page, key: string) {
  await page.evaluate((value) => {
    (
      window as unknown as {
        __transcriptTimeline: { track(key: string): void };
      }
    ).__transcriptTimeline.track(value);
  }, key);
}

export async function readTimeline(page: Page): Promise<TranscriptTimeline> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __transcriptTimeline: { read(): TranscriptTimeline };
      }
    ).__transcriptTimeline.read(),
  );
}

export async function attachTimeline(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<TranscriptTimeline> {
  const timeline = await readTimeline(page);
  const path = testInfo.outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(timeline, null, 1));
  await testInfo.attach(`${name}.json`, {
    contentType: 'application/json',
    path,
  });
  // The product tracer's records, when the page enabled it.
  const trace = await page.evaluate(
    () =>
      (
        window as unknown as {
          __stationTranscriptTrace?: { dump(): unknown };
        }
      ).__stationTranscriptTrace?.dump() ?? null,
  );
  if (trace) {
    const tracePath = testInfo.outputPath(`${name}-layout-trace.json`);
    writeFileSync(tracePath, JSON.stringify(trace, null, 1));
    await testInfo.attach(`${name}-layout-trace.json`, {
      contentType: 'application/json',
      path: tracePath,
    });
  }
  return timeline;
}

/** Waits until the transcript's scroll geometry has held for `frames` frames. */
export async function waitForStableTranscript(page: Page, frames = 20) {
  await page.waitForFunction(
    (required) => {
      const state = window as unknown as {
        __transcriptStable?: { key: string; count: number };
      };
      const log = document.querySelector<HTMLElement>(
        '.chat-messages[role="log"]',
      );
      if (!log) return false;
      const key = `${log.scrollTop}:${log.scrollHeight}:${log.clientHeight}`;
      const previous = state.__transcriptStable;
      state.__transcriptStable =
        previous?.key === key
          ? { key, count: previous.count + 1 }
          : { key, count: 0 };
      return state.__transcriptStable.count >= required;
    },
    frames,
    { polling: 'raf', timeout: 20_000 },
  );
}

/** Frames recorded after `t` with no reader input between them and `t`. */
export function inputFreeFramesAfter(timeline: TranscriptTimeline, t: number) {
  const lastInput = Math.max(t, ...timeline.inputs.filter((at) => at >= t));
  return timeline.frames.filter((frame) => frame.t > lastInput);
}

/**
 * Largest movement of the tracked row between consecutive frames that both
 * show it with no reader input between them, plus how many frames lost it.
 */
export function trackedRowDrift(
  frames: TranscriptFrame[],
  inputs: number[],
): { max: number; at: number | null; frames: number; unmounted: number } {
  let max = 0;
  let at: number | null = null;
  let compared = 0;
  let unmounted = 0;
  let previous: { t: number; offset: number } | null = null;
  for (const frame of frames) {
    if (!frame.tracked) {
      unmounted += 1;
      previous = null;
      continue;
    }
    if (
      previous &&
      !inputs.some((input) => input > previous!.t && input <= frame.t)
    ) {
      compared += 1;
      const delta = Math.abs(frame.tracked.offset - previous.offset);
      if (delta > max) {
        max = delta;
        at = frame.t;
      }
    }
    previous = { t: frame.t, offset: frame.tracked.offset };
  }
  return { max, at, frames: compared, unmounted };
}
