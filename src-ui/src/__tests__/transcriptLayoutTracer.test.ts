/**
 * @vitest-environment jsdom
 */
import debug from 'debug';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  markTranscriptPhase,
  noteTranscriptProgrammaticScroll,
  transcriptLayoutTraceRequested,
} from '../components/chat/transcriptLayoutTrace';
import {
  attachTranscriptLayoutTracer,
  describeTraceNode,
  TRANSCRIPT_TRACE_CAPACITY,
} from '../components/chat/transcriptLayoutTracer';
import { deviceSettingsStore } from '../lib/device-settings-store';

describe('transcript layout tracer', () => {
  // The `debug` package reads `localStorage.debug` when the page loads; the
  // documented workflow sets it and reloads. This emulates that reload.
  function reloadWithDebug(namespaces: string) {
    localStorage.setItem('debug', namespaces);
    debug.enable(namespaces);
  }

  afterEach(() => {
    debug.disable();
    localStorage.clear();
    window.__stationTranscriptTrace?.clear();
    vi.unstubAllGlobals();
  });

  test('is requested only by an explicit debug namespace', () => {
    expect(transcriptLayoutTraceRequested()).toBe(false);
    reloadWithDebug('app:chat');
    expect(transcriptLayoutTraceRequested()).toBe(false);
    reloadWithDebug('app:transcript-layout');
    expect(transcriptLayoutTraceRequested()).toBe(true);
  });

  test('replays marks raised before it attached and labels scrolls', () => {
    reloadWithDebug('app:transcript-layout');
    transcriptLayoutTraceRequested();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    markTranscriptPhase('dock-loading', { resolvingOpen: true });
    const scroller = document.createElement('div');
    document.body.append(scroller);
    const detach = attachTranscriptLayoutTracer(scroller, {
      sessionId: 's1',
      readState: () => ({ isUserScrolledUp: false }),
    });
    markTranscriptPhase('pin-layout');
    noteTranscriptProgrammaticScroll(scroller.scrollTop);
    scroller.dispatchEvent(new Event('scroll'));
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event('scroll'));
    detach();
    const records = window.__stationTranscriptTrace!.dump().records;
    const phases = records.filter((record) => record.kind === 'phase');
    expect(phases.map((record) => [record.label, record.replayed])).toEqual([
      ['dock-loading', true],
      ['pin-layout', undefined],
    ]);
    expect(
      records
        .filter((record) => record.kind === 'scroll')
        .map((record) => record.label),
    ).toEqual(['programmatic', 'reader']);
    // Detached: later marks record nothing.
    const total = window.__stationTranscriptTrace!.dump().total;
    markTranscriptPhase('after-detach');
    expect(window.__stationTranscriptTrace!.dump().total).toBe(total);
    scroller.remove();
  });

  test('keeps the newest records and counts every one it let go', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const scroller = document.createElement('div');
    const detach = attachTranscriptLayoutTracer(scroller, {
      sessionId: 's1',
      readState: () => ({ isUserScrolledUp: false }),
    });
    window.__stationTranscriptTrace!.clear();
    for (let index = 0; index < TRANSCRIPT_TRACE_CAPACITY + 25; index += 1)
      markTranscriptPhase(`mark-${index}`);
    const dump = window.__stationTranscriptTrace!.dump();
    expect(dump.total).toBe(TRANSCRIPT_TRACE_CAPACITY + 25);
    expect(dump.dropped).toBe(25);
    expect(dump.records).toHaveLength(TRANSCRIPT_TRACE_CAPACITY);
    expect(dump.records[0]?.label).toBe('mark-25');
    expect(TRANSCRIPT_TRACE_CAPACITY).toBe(2_000);
    detach();
  });

  test('the Developer tools setting alone does not start tracing', () => {
    deviceSettingsStore.set('developerToolsEnabled', true);
    try {
      expect(transcriptLayoutTraceRequested()).toBe(false);
    } finally {
      deviceSettingsStore.set('developerToolsEnabled', false);
    }
  });

  test('describes nodes without labels or message text', () => {
    document.body.innerHTML = `
      <div class="chat-message-anchor" data-chat-role="user"
        data-chat-message-key="s1:message:untimed:user:my secret plan.pdf">
        <button aria-label="Open my secret plan.pdf" class="file-chip">x</button>
      </div>
      <div class="skeleton-block" role="status" aria-label="Loading chat"></div>`;
    const chip = document.querySelector('button')!;
    const described = describeTraceNode(chip);
    expect(described).toMatch(/^row:user#[0-9a-z]+$/);
    expect(described).not.toContain('secret');
    const skeleton = describeTraceNode(
      document.querySelector('.skeleton-block'),
    );
    expect(skeleton).toBe('div.skeleton-block[role=status]');
    document.body.innerHTML = '';
  });

  test('removes its overlay when it detaches', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const scroller = document.createElement('div');
    const detach = attachTranscriptLayoutTracer(scroller, {
      sessionId: 's1',
      readState: () => ({ isUserScrolledUp: false }),
    });
    window.__stationTranscriptTrace!.overlay(true);
    markTranscriptPhase('pin-layout');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(
      document.querySelector('[data-transcript-trace-overlay]'),
    ).not.toBeNull();
    detach();
    expect(
      document.querySelector('[data-transcript-trace-overlay]'),
    ).toBeNull();
    window.__stationTranscriptTrace!.overlay(false);
  });
});
