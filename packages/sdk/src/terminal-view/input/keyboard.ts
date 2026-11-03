/**
 * Browser keyboard events to engine key input, and the keys the view keeps
 * for itself (copy, paste, find, leaving the terminal).
 */

import { Mods } from '../engine/abi';
import type { KeyActionName, KeyInput } from '../engine/terminal-engine';

export function modsOf(event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState?: (key: string) => boolean;
}): number {
  let mods = 0;
  if (event.shiftKey) mods |= Mods.SHIFT;
  if (event.ctrlKey) mods |= Mods.CTRL;
  if (event.altKey) mods |= Mods.ALT;
  if (event.metaKey) mods |= Mods.SUPER;
  if (event.getModifierState?.('CapsLock')) mods |= Mods.CAPS_LOCK;
  if (event.getModifierState?.('NumLock')) mods |= Mods.NUM_LOCK;
  return mods;
}

/** The key's code point on an unshifted US layout, or 0. */
function unshiftedCodepoint(code: string, key: string): number {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) + 32;
  if (/^Digit\d$/.test(code)) return code.charCodeAt(5);
  const fixed: Record<string, string> = {
    Space: ' ',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
  };
  const char = fixed[code];
  if (char) return char.codePointAt(0)!;
  return [...key].length === 1 ? key.toLowerCase().codePointAt(0)! : 0;
}

export function keyInput(
  event: KeyboardEvent,
  action: KeyActionName,
): KeyInput {
  const printable = [...event.key].length === 1;
  return {
    code: event.code,
    action,
    mods: modsOf(event),
    text: printable ? event.key : '',
    unshifted: unshiftedCodepoint(event.code, event.key),
    composing: event.isComposing,
  };
}

export type ViewKeyAction =
  | 'copy'
  | 'paste'
  | 'find'
  | 'select-all'
  | 'context-menu'
  | 'focus-next'
  | 'focus-previous'
  | null;

const isMac = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Tracks the documented focus escape: Escape, then Tab within one second,
 * moves focus out of the terminal (Shift+Tab backwards). Escape itself still
 * reaches the program, so full-screen programs keep working.
 */
export class FocusEscape {
  private escapedAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly now: () => number = () => performance.now()) {}

  observe(event: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }): 'focus-next' | 'focus-previous' | null {
    if (
      event.key === 'Escape' &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      this.escapedAt = this.now();
      return null;
    }
    if (event.key === 'Tab' && this.now() - this.escapedAt <= 1000) {
      this.escapedAt = Number.NEGATIVE_INFINITY;
      return event.shiftKey ? 'focus-previous' : 'focus-next';
    }
    if (event.key !== 'Shift') this.escapedAt = Number.NEGATIVE_INFINITY;
    return null;
  }
}

/** A chord in Station's shortcut vocabulary: `cmd` is Control off a Mac. */
export interface TerminalViewChord {
  key: string;
  modifiers: ('cmd' | 'ctrl' | 'shift' | 'alt')[];
}

/** One key the view keeps for itself, as a host lists it. */
export interface TerminalViewShortcut {
  id: string;
  description: string;
  /** Pressed in order; most are one chord. */
  chords: TerminalViewChord[];
}

/**
 * The keys a focused terminal keeps for itself, in this platform's chords,
 * so a host can list them beside its own shortcuts. Off a Mac the view's
 * chords add Shift, leaving plain Control chords to the program.
 */
export function terminalViewShortcuts(
  mac: boolean = isMac(),
): readonly TerminalViewShortcut[] {
  const view = (key: string): TerminalViewChord => ({
    key,
    modifiers: mac ? ['cmd'] : ['cmd', 'shift'],
  });
  return [
    { id: 'terminal.copy', description: 'Copy selection', chords: [view('c')] },
    { id: 'terminal.paste', description: 'Paste', chords: [view('v')] },
    { id: 'terminal.find', description: 'Find', chords: [view('f')] },
    {
      id: 'terminal.selectAll',
      description: 'Select all',
      chords: [view('a')],
    },
    {
      id: 'terminal.menu',
      description: 'Open the terminal menu',
      chords: [{ key: 'F10', modifiers: ['shift'] }],
    },
    {
      id: 'terminal.leave',
      description: 'Leave the terminal (Shift+Tab: backwards)',
      chords: [
        { key: 'Escape', modifiers: [] },
        { key: 'Tab', modifiers: [] },
      ],
    },
  ];
}

/**
 * Chords the view leaves to the page, so the host's shortcuts work from a
 * focused terminal: Command chords on a Mac, which terminals do not send to
 * programs, and Control+Shift letter chords elsewhere. Checked after the
 * view's own keys.
 */
export function isHostChord(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
  >,
  mac: boolean = isMac(),
): boolean {
  if ([...event.key].length !== 1) return false;
  if (mac) return event.metaKey;
  return (
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    /^[a-z]$/i.test(event.key)
  );
}

/** Keys the view handles instead of sending to the program. */
export function viewKeyAction(
  event: KeyboardEvent,
  hasSelection: boolean,
): ViewKeyAction {
  const mac = isMac();
  const primary = mac ? event.metaKey : event.ctrlKey && event.shiftKey;
  const key = event.key.toLowerCase();
  if (primary && key === 'c') return 'copy';
  // Plain Ctrl+C copies only when there is a selection; otherwise it interrupts.
  if (!mac && event.ctrlKey && !event.shiftKey && key === 'c' && hasSelection)
    return 'copy';
  if (primary && key === 'v') return 'paste';
  if (primary && key === 'f') return 'find';
  if (primary && key === 'a') return 'select-all';
  if (event.shiftKey && event.key === 'F10') return 'context-menu';
  if (event.key === 'ContextMenu') return 'context-menu';
  return null;
}
