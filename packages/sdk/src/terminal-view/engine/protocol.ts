import type { Frame } from './frame';
import type {
  EngineSize,
  EngineTheme,
  KeyInput,
  MouseInput,
  SearchState,
} from './terminal-engine';

export type ScrollTarget =
  | { delta: number }
  | { row: number }
  | 'top'
  | 'bottom';

/** Messages from the UI thread to the engine worker. */
export type EngineRequest =
  | {
      type: 'init';
      module: WebAssembly.Module;
      size: EngineSize;
      theme: EngineTheme;
    }
  | { type: 'write'; bytes: Uint8Array; mode: 'live' | 'replay' }
  | { type: 'resize'; size: EngineSize }
  | { type: 'theme'; theme: EngineTheme }
  /** Hidden terminals parse output but produce no frames. */
  | { type: 'visible'; visible: boolean }
  /** The UI drew the last frame and can take another. */
  | { type: 'frame-ack' }
  | { type: 'key'; input: KeyInput }
  | { type: 'mouse'; input: MouseInput }
  | { type: 'focus'; focused: boolean }
  | { type: 'paste'; text: string }
  | { type: 'scroll'; target: ScrollTarget }
  | {
      type: 'select';
      gesture: 'press' | 'drag' | 'release';
      cell: { x: number; y: number };
      pixel: { x: number; y: number };
      timeMs: number;
    }
  | { type: 'select-all' }
  | { type: 'clear-selection' }
  | { type: 'clear' }
  | { type: 'query'; id: number; query: EngineQuery }
  | { type: 'dispose' };

export type EngineQuery =
  | { kind: 'selection-text' }
  | { kind: 'plain-text' }
  | { kind: 'hyperlink'; x: number; y: number }
  | { kind: 'find'; needle: string; direction: 'next' | 'prev' | 'same' }
  | { kind: 'mouse-tracking' };

export interface EngineQueryResult {
  'selection-text': string;
  'plain-text': string;
  hyperlink: string | null;
  find: SearchState;
  'mouse-tracking': boolean;
}

/** Messages from the engine worker to the UI thread. */
export type EngineEvent =
  | { type: 'ready' }
  | { type: 'frame'; frame: Frame }
  /** Bytes the user produced (keys, mouse, paste, focus) for the PTY. */
  | { type: 'input'; bytes: Uint8Array }
  /** Terminal replies (DA, DSR, mode reports) for the PTY. Live output only. */
  | { type: 'reply'; bytes: Uint8Array }
  | { type: 'bell' }
  | { type: 'title'; title: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; message: string };
