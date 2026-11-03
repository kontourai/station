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
export { toTerminalViewSession } from './store-session';
export { TerminalView, type TerminalViewProps } from './TerminalView';
