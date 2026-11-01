/**
 * `@kontourai/station-sdk/terminal-view`: Station's terminal surface over
 * Ghostty's libghostty-vt. The Coding layout and plugins import this entry;
 * the engine, renderer and input modules behind it are internal.
 */

export type { TerminalLinkTarget } from './links';
export type {
  TerminalViewSession,
  TerminalViewSessionListener,
  TerminalViewSessionState,
} from './session';
// UNWIRED(#3994): Coding's TerminalPanel renders this once the operate session store lands.
export { TerminalView, type TerminalViewProps } from './TerminalView';
