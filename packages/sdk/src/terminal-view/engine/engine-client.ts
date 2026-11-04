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

/** The parts of a `Worker` the client uses; a real `Worker` satisfies it. */
export interface EnginePort {
  postMessage(message: EngineRequest, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

const ENGINE_EVENT_TYPES = new Set<string>([
  'ready',
  'frame',
  'input',
  'reply',
  'bell',
  'title',
  'result',
  'error',
]);

/** Worker messages cross a thread boundary; accept only known event kinds. */
function isEngineEvent(data: unknown): data is EngineEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    typeof data.type === 'string' &&
    ENGINE_EVENT_TYPES.has(data.type)
  );
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

/** SHA-256 of the vendored module, as recorded in its `REVISION` file. */
export const GHOSTTY_VT_SHA256 =
  '19318c11df6816ad76f9f612d693ce57cadef4d15321aa5f0f2c84c117762e73';

let modulePromise: Promise<WebAssembly.Module> | null = null;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * The vendored module, compiled once per page. Only the vendored file is
 * ever loaded, and only when its bytes match {@link GHOSTTY_VT_SHA256}.
 */
export function loadGhosttyVt(): Promise<WebAssembly.Module> {
  modulePromise ??= (async () => {
    const response = await fetch(
      new URL('../vendor/ghostty-vt/ghostty-vt.wasm', import.meta.url),
    );
    if (!response.ok)
      throw new Error(`Terminal engine unavailable (${response.status})`);
    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) !== GHOSTTY_VT_SHA256)
      throw new Error(
        'Terminal engine refused: ghostty-vt.wasm does not match its recorded SHA-256',
      );
    // compileStreaming needs application/wasm; some static servers differ.
    return WebAssembly.compile(bytes);
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
  });
}

export class EngineClient {
  private nextQuery = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();
  private disposed = false;

  constructor(
    private readonly port: EnginePort,
    private readonly handlers: EngineClientHandlers,
  ) {
    port.onmessage = (event) => {
      if (isEngineEvent(event.data)) this.receive(event.data);
    };
    port.onerror = () => handlers.error('The terminal engine stopped.');
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
