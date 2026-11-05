/**
 * The engine side of the worker protocol: one {@link TerminalEngine} and its
 * frame pacing. Output is parsed as it arrives; frames go out only while the
 * view is visible and only after the UI acknowledged the previous one, so a
 * flooding program costs parse time, never a backlog of frames.
 */

import { frameTransferables } from './frame';
import type { EngineEvent, EngineRequest } from './protocol';
import { TerminalEngine } from './terminal-engine';
import { GhosttyVtModule } from './wasm';

export type PostEvent = (event: EngineEvent, transfer?: Transferable[]) => void;

/** Output held while the module instantiates, at most. */
export const ENGINE_MAX_QUEUED_WRITE_BYTES = 4 * 1024 * 1024;
/** Requests held while the module instantiates, at most. */
export const ENGINE_MAX_QUEUED_REQUESTS = 4096;

export class EngineHost {
  private engine: TerminalEngine | null = null;
  private visible = true;
  private frameInFlight = false;
  private framePending = false;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: EngineRequest[] | null = [];
  private queuedWriteBytes = 0;

  constructor(private readonly post: PostEvent) {}

  async handle(request: EngineRequest): Promise<void> {
    if (request.type === 'init') {
      await this.init(request);
      return;
    }
    // Requests that arrive while the module instantiates run afterwards.
    if (this.queue) {
      this.enqueue(this.queue, request);
      return;
    }
    this.apply(request);
  }

  /**
   * Holds a request for after instantiation, within bounds. Output past the
   * bound is dropped with an explicit `overflow`, so the view rebuilds its
   * screen from replay instead of rendering an incomplete stream.
   */
  private enqueue(queue: EngineRequest[], request: EngineRequest): void {
    const bytes = request.type === 'write' ? request.bytes.byteLength : 0;
    if (
      queue.length < ENGINE_MAX_QUEUED_REQUESTS &&
      this.queuedWriteBytes + bytes <= ENGINE_MAX_QUEUED_WRITE_BYTES
    ) {
      queue.push(request);
      this.queuedWriteBytes += bytes;
      return;
    }
    if (request.type !== 'write') {
      // Input and layout requests made before the terminal exists; the
      // latest resize and theme still arrive with the view's next update.
      if (queue.length < ENGINE_MAX_QUEUED_REQUESTS) queue.push(request);
      return;
    }
    this.queue = queue.filter((pending) => pending.type !== 'write');
    this.queuedWriteBytes = 0;
    this.post({ type: 'overflow', id: request.id });
  }

  private async init(request: Extract<EngineRequest, { type: 'init' }>) {
    try {
      const vt = await GhosttyVtModule.instantiate(request.module);
      this.engine = new TerminalEngine(vt, request.size, {
        reply: (bytes) => this.post({ type: 'reply', bytes }, [bytes.buffer]),
        bell: () => this.post({ type: 'bell' }),
        title: (title) => this.post({ type: 'title', title }),
      });
      this.engine.setTheme(request.theme);
      this.post({ type: 'ready' });
      const queued = this.queue ?? [];
      this.queue = null;
      this.queuedWriteBytes = 0;
      for (const pending of queued) this.apply(pending);
      this.schedule();
    } catch (error) {
      this.post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private apply(request: EngineRequest): void {
    const engine = this.engine;
    if (!engine) return;
    try {
      this.applyTo(engine, request);
    } catch (error) {
      this.post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitInput(bytes: Uint8Array | null): void {
    if (bytes?.length) this.post({ type: 'input', bytes }, [bytes.buffer]);
  }

  private applyTo(engine: TerminalEngine, request: EngineRequest): void {
    switch (request.type) {
      case 'write':
        try {
          engine.write(request.bytes, request.mode);
        } finally {
          // Parsed (or refused): the view may take more output either way.
          this.post({ type: 'written', id: request.id });
        }
        break;
      case 'resize':
        engine.resize(request.size);
        break;
      case 'theme':
        engine.setTheme(request.theme);
        break;
      case 'visible':
        this.visible = request.visible;
        if (request.visible) {
          engine.invalidate();
          this.frameInFlight = false;
        }
        break;
      case 'frame-ack':
        this.frameInFlight = false;
        break;
      case 'key':
        this.emitInput(engine.encodeKey(request.input));
        // Typing returns the viewport to the live area, as terminals do.
        engine.scroll('bottom');
        break;
      case 'mouse':
        this.emitInput(engine.encodeMouse(request.input));
        return;
      case 'focus':
        this.emitInput(engine.encodeFocus(request.focused));
        return;
      case 'paste':
        this.emitInput(engine.encodePaste(request.text));
        engine.scroll('bottom');
        break;
      case 'scroll':
        engine.scroll(request.target);
        break;
      case 'select':
        engine.selectionGesture(
          request.gesture,
          request.cell,
          request.pixel,
          request.timeMs,
        );
        break;
      case 'select-all':
        engine.selectAll();
        break;
      case 'clear-selection':
        engine.clearSelection();
        break;
      case 'clear':
        engine.clear();
        break;
      case 'reset':
        engine.reset();
        break;
      case 'query':
        this.post({
          type: 'result',
          id: request.id,
          value: this.answer(engine, request.query),
        });
        break;
      case 'dispose':
        if (this.frameTimer) clearTimeout(this.frameTimer);
        engine.dispose();
        this.engine = null;
        return;
      case 'init':
        return;
    }
    this.schedule();
  }

  private answer(
    engine: TerminalEngine,
    query: Extract<EngineRequest, { type: 'query' }>['query'],
  ): unknown {
    switch (query.kind) {
      case 'selection-text':
        return engine.selectionText();
      case 'plain-text':
        return engine.plainText();
      case 'hyperlink':
        return engine.hyperlinkAt(query.x, query.y);
      case 'find':
        return engine.find(query.needle, query.direction);
      case 'mouse-tracking':
        return engine.mouseTracking();
    }
  }

  private schedule(): void {
    this.framePending = true;
    if (this.frameTimer) return;
    // Coalesce every request handled in this task into one frame.
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.flush();
    }, 0);
  }

  private flush(): void {
    const engine = this.engine;
    if (!engine || !this.visible || this.frameInFlight || !this.framePending)
      return;
    this.framePending = false;
    const frame = engine.frame();
    if (!frame) return;
    this.frameInFlight = true;
    this.post({ type: 'frame', frame }, frameTransferables(frame));
  }
}
