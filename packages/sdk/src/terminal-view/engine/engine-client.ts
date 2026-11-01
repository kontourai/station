/**
 * UI-thread handle on one engine worker. The WebAssembly module is fetched
 * and compiled once, on the first terminal, and the compiled module is
 * shared with every worker (a `WebAssembly.Module` is structured-cloneable).
 */

import type { Frame } from './frame';
import type {
  EngineEvent,
  EngineQuery,
  EngineQueryResult,
  EngineRequest,
} from './protocol';

export interface EnginePort {
  postMessage(message: EngineRequest, transfer: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<EngineEvent>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  terminate(): void;
}

export interface EngineClientHandlers {
  ready(): void;
  frame(frame: Frame): void;
  /** Bytes for the PTY: user input and live terminal replies. */
  output(bytes: Uint8Array, source: 'input' | 'reply'): void;
  bell(): void;
  title(title: string): void;
  error(message: string): void;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

/** The vendored module, compiled once per page. */
export function loadGhosttyVt(
  url: URL | string = new URL(
    '../vendor/ghostty-vt/ghostty-vt.wasm',
    import.meta.url,
  ),
): Promise<WebAssembly.Module> {
  modulePromise ??= (async () => {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Terminal engine unavailable (${response.status})`);
    // compileStreaming needs application/wasm; some static servers differ.
    return WebAssembly.compile(await response.arrayBuffer());
  })();
  modulePromise.catch(() => {
    modulePromise = null;
  });
  return modulePromise;
}

export function createEngineWorker(): EnginePort {
  return new Worker(new URL('./engine.worker.ts', import.meta.url), {
    type: 'module',
    name: 'station-terminal-engine',
  }) as unknown as EnginePort;
}

export class EngineClient {
  private nextQuery = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();
  private disposed = false;

  constructor(
    private readonly port: EnginePort,
    private readonly handlers: EngineClientHandlers,
  ) {
    port.addEventListener('message', (event) => this.receive(event.data));
    port.addEventListener('error', () =>
      handlers.error('The terminal engine stopped.'),
    );
  }

  private receive(event: EngineEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'ready':
        this.handlers.ready();
        break;
      case 'frame':
        this.handlers.frame(event.frame);
        break;
      case 'input':
        this.handlers.output(event.bytes, 'input');
        break;
      case 'reply':
        this.handlers.output(event.bytes, 'reply');
        break;
      case 'bell':
        this.handlers.bell();
        break;
      case 'title':
        this.handlers.title(event.title);
        break;
      case 'result': {
        const resolve = this.pending.get(event.id);
        this.pending.delete(event.id);
        resolve?.(event.value);
        break;
      }
      case 'error':
        this.handlers.error(event.message);
        break;
    }
  }

  send(request: EngineRequest, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    this.port.postMessage(request, transfer);
  }

  query<K extends EngineQuery['kind']>(
    query: Extract<EngineQuery, { kind: K }>,
  ): Promise<EngineQueryResult[K]> {
    if (this.disposed) return Promise.reject(new Error('Terminal closed'));
    const id = this.nextQuery++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (value: unknown) => void);
      this.port.postMessage({ type: 'query', id, query }, []);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.port.postMessage({ type: 'dispose' }, []);
    this.disposed = true;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.port.terminate();
  }
}
