/**
 * The narrow session surface a {@link TerminalView} needs. The SDK terminal
 * session store implements it; tests and plugins can supply their own.
 */

export type TerminalViewSessionState =
  | 'connecting'
  | 'replaying'
  | 'ready'
  | 'disconnected'
  | 'exited'
  | 'failed';

export interface TerminalViewSessionListener {
  /**
   * PTY output in order. `replay` output predates this attachment: the view
   * renders it but answers none of its queries and rings none of its bells.
   * The returned promise settles once the view's emulator has parsed it; a
   * session should not take more output for the view until it does.
   */
  output(bytes: Uint8Array, kind: 'replay' | 'live'): unknown;
  /** The retained output was lost; the view clears before the next replay. */
  reset?(): void;
  state?(state: TerminalViewSessionState, detail?: string): void;
}

export interface TerminalViewSession {
  readonly state: TerminalViewSessionState;
  /** Observers can watch but never type, paste or resize. */
  readonly readOnly: boolean;
  subscribe(listener: TerminalViewSessionListener): () => void;
  /** Sends input; false when it could not be sent (closed, read-only). */
  write(bytes: Uint8Array): boolean;
  resize(cols: number, rows: number): void;
}
