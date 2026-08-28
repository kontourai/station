/**
 * activeTerminalWriter — a tiny module singleton that lets the file explorer
 * (or anything else) write text into the *currently active* terminal.
 *
 * The terminal tabs each own their own WebSocket, so there is no React tree
 * path from the file tree to "the active terminal". Instead, the active
 * TerminalPanel registers a writer here (keyed by its id) when it is the
 * visible tab, and clears it when it stops being active or unmounts. write
 * forwards to whoever is currently registered.
 */

type Writer = (text: string) => boolean;

let activeId: string | null = null;
let activeWriter: Writer | null = null;

export const activeTerminalWriter = {
  /** Mark `id` as the active terminal and register its writer. */
  setActive(id: string, writer: Writer): void {
    activeId = id;
    activeWriter = writer;
  },

  /** Clear the active writer, but only if `id` still owns it (avoids races). */
  clearActive(id: string): void {
    if (activeId === id) {
      activeId = null;
      activeWriter = null;
    }
  },

  /** True when some terminal is currently registered to receive input. */
  hasActive(): boolean {
    return activeWriter !== null;
  },

  /**
   * Write `text` into the active terminal as if typed. Returns false when there
   * is no active terminal or it is not ready (e.g. socket still connecting).
   */
  write(text: string): boolean {
    return activeWriter ? activeWriter(text) : false;
  },
};
