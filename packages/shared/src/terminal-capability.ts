/**
 * Terminal-capability vocabulary for a Station whose `node-pty` native module
 * is absent or unbuildable (#1244).
 *
 * node-pty is the only Station dependency that needs a C++ toolchain on
 * Linux, and it backs exactly one surface: interactive terminal panes and
 * attached-session follow. Agent execution spawns through `child_process`
 * and never touches it. When the module fails to load, Station keeps running
 * with the terminal surface degraded — and that degradation must be LOUD:
 * `station doctor`, `/api/system/status` capabilities, and the terminal
 * transport all report the same specific, actionable reason instead of a
 * pane that mysteriously does nothing.
 *
 * This module owns the shared wording so the CLI doctor
 * (`packages/cli/src/commands/lifecycle-doctor.ts`) and the server adapter
 * (`src-server/adapters/node-pty-adapter.ts`) cannot drift apart. It must
 * not import `node-pty` itself: probing is the caller's job, because each
 * caller resolves the module from a different root.
 */

export type TerminalCapability =
  | { state: 'available' }
  | { state: 'unavailable'; reason: string };

/**
 * What is lost and how to get it back. Kept free of any dynamic content so
 * transports with an outward-sanitization doctrine can send it verbatim.
 */
export const TERMINAL_PTY_UNAVAILABLE_REMEDIATION =
  'Interactive terminal panes are unavailable; agent execution is unaffected. ' +
  'Install a C++ toolchain (g++, make, python3), run `npm run dependencies:install` ' +
  'in the Station checkout, then restart Station.';

/**
 * The one degraded-terminal reason every surface reports. `cause` carries the
 * loader's first error line for operator-facing surfaces (doctor, system
 * status); omit it on outward transports.
 */
export function terminalPtyUnavailableReason(cause?: string): string {
  const base = `node-pty failed to load. ${TERMINAL_PTY_UNAVAILABLE_REMEDIATION}`;
  return cause ? `${base} (cause: ${cause})` : base;
}

/**
 * First line of a load failure, bounded so a native loader's multi-path
 * candidate dump cannot flood a status payload or doctor line.
 */
export function describeTerminalPtyLoadFailure(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'unknown load failure';
  const firstLine = message.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}
