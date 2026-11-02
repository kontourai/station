import type { CellMetrics } from './glyph-atlas';
import type { Overlay } from './row-paint';
import type { ScreenModel, TerminalTheme } from './screen-model';

export interface TerminalRenderer {
  readonly kind: 'webgl2' | 'canvas2d';
  /** Device-pixel canvas size follows the grid; call after metrics or grid change. */
  resize(cols: number, rows: number, metrics: CellMetrics): void;
  setTheme(theme: TerminalTheme): void;
  render(model: ScreenModel, overlay: Overlay): void;
  /** Hidden terminals give up their GPU context; {@link resume} reacquires it. */
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export interface RendererCallbacks {
  /** The GPU context was lost or restored; the next render must be complete. */
  invalidated(): void;
  /** WebGL could not continue; the view swaps to the canvas2D renderer. */
  failed(): void;
}
