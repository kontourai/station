import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineHost } from '../../terminal-view/engine/engine-host';
import type { EngineEvent } from '../../terminal-view/engine/protocol';

const wasmPath = fileURLToPath(
  new URL(
    '../../terminal-view/vendor/ghostty-vt/ghostty-vt.wasm',
    import.meta.url,
  ),
);
let module: WebAssembly.Module;
beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync(wasmPath));
});

const theme = {
  foreground: 0xdddddd,
  background: 0x111111,
  cursor: 0xffffff,
  ansi: [],
  scheme: 'dark' as const,
};
const bytes = (s: string) => new TextEncoder().encode(s);

async function host() {
  const events: EngineEvent[] = [];
  const h = new EngineHost((event) => events.push(event));
  await h.handle({
    type: 'init',
    module,
    size: { cols: 20, rows: 4, cellWidth: 8, cellHeight: 16 },
    theme,
  });
  const frames = () => events.filter((e) => e.type === 'frame');
  return { h, events, frames };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EngineHost frame pacing', () => {
  it('holds one frame in flight until the UI acknowledges it', async () => {
    vi.useFakeTimers();
    const { h, frames } = await host();
    await vi.runAllTimersAsync();
    expect(frames()).toHaveLength(1);
    for (let i = 0; i < 50; i += 1)
      await h.handle({
        type: 'write',
        bytes: bytes(`line ${i}\r\n`),
        mode: 'live',
      });
    await vi.runAllTimersAsync();
    // A flood parses everything but does not queue frames behind the UI.
    expect(frames()).toHaveLength(1);
    await h.handle({ type: 'frame-ack' });
    await vi.runAllTimersAsync();
    expect(frames()).toHaveLength(2);
  });

  it('produces no frames while hidden, and a complete one when shown', async () => {
    vi.useFakeTimers();
    const { h, frames } = await host();
    await vi.runAllTimersAsync();
    await h.handle({ type: 'frame-ack' });
    await h.handle({ type: 'visible', visible: false });
    await h.handle({
      type: 'write',
      bytes: bytes('hidden output'),
      mode: 'live',
    });
    await vi.runAllTimersAsync();
    expect(frames()).toHaveLength(1);
    await h.handle({ type: 'visible', visible: true });
    await vi.runAllTimersAsync();
    const shown = frames()[frames().length - 1];
    expect(frames()).toHaveLength(2);
    expect(shown?.type === 'frame' && shown.frame.full).toBe(true);
  });

  it('sends terminal replies only for live output', async () => {
    const { h, events } = await host();
    await h.handle({ type: 'write', bytes: bytes('\x1b[6n'), mode: 'replay' });
    expect(events.filter((e) => e.type === 'reply')).toHaveLength(0);
    await h.handle({ type: 'write', bytes: bytes('\x1b[6n'), mode: 'live' });
    expect(events.filter((e) => e.type === 'reply')).toHaveLength(1);
  });

  it('queues requests that arrive before the module is ready', async () => {
    const events: EngineEvent[] = [];
    const h = new EngineHost((event) => events.push(event));
    const init = h.handle({
      type: 'init',
      module,
      size: { cols: 20, rows: 4, cellWidth: 8, cellHeight: 16 },
      theme,
    });
    await h.handle({ type: 'write', bytes: bytes('early'), mode: 'live' });
    await h.handle({ type: 'query', id: 7, query: { kind: 'plain-text' } });
    await init;
    expect(events.find((e) => e.type === 'result')).toEqual({
      type: 'result',
      id: 7,
      value: 'early',
    });
  });
});
