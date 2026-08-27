/**
 * `station operate`'s v1 keybinding table (#168 Wave 1, Task 1A) — a pure,
 * documented mapping from a normalized `KeyInfo` (`types.ts`, decoupled from
 * Node's raw `readline` key object) to one of a small set of binding names.
 * Kept separate from `state.ts` so the keymap itself is trivially
 * testable/documentable in isolation, and so `docs/reference/cli.md`'s
 * keybinding table (Wave 2, Task 2B) can be transcribed straight from
 * `OPERATE_KEYBINDINGS` below without drifting from the actual code.
 *
 * TTY-free: no `readline`/`node:tty`/`node:http`/`fetch` imports here.
 */
import type { KeyInfo } from './types.js';

export type OperateKeyBinding =
  | 'cycle-focus-next'
  | 'cycle-focus-prev'
  | 'move-selection-up'
  | 'move-selection-down'
  | 'accept'
  | 'accept-for-session'
  | 'decline'
  | 'cancel'
  | 'refresh'
  | 'quit';

export interface OperateKeybindingDescriptor {
  keys: string;
  binding: OperateKeyBinding;
  description: string;
}

/**
 * The canonical, documented v1 keymap (plan's Task 1A file list). Order here
 * is the order the footer legend (`render.ts`) and `docs/reference/cli.md`'s
 * keybinding table render in.
 */
export const OPERATE_KEYBINDINGS: readonly OperateKeybindingDescriptor[] = [
  {
    keys: 'Tab',
    binding: 'cycle-focus-next',
    description: 'cycle session focus forward',
  },
  {
    keys: 'Shift+Tab',
    binding: 'cycle-focus-prev',
    description: 'cycle session focus backward',
  },
  {
    keys: 'Up',
    binding: 'move-selection-up',
    description: 'move approval selection up',
  },
  {
    keys: 'Down',
    binding: 'move-selection-down',
    description: 'move approval selection down',
  },
  { keys: 'a', binding: 'accept', description: 'accept selected approval' },
  {
    keys: 's',
    binding: 'accept-for-session',
    description: 'accept selected approval for the rest of the session',
  },
  { keys: 'd', binding: 'decline', description: 'decline selected approval' },
  { keys: 'x', binding: 'cancel', description: 'cancel selected approval' },
  {
    keys: 'r',
    binding: 'refresh',
    description:
      'manual refresh: re-seed the focused session history + flow-run/builder-run pulls',
  },
  { keys: 'q / Ctrl+C', binding: 'quit', description: 'quit operate' },
];

/**
 * Classifies a normalized keypress into one of the bindings above, or
 * `null` for an unrecognized key (callers must treat `null` as "no intent,
 * state unchanged" — see `state.ts`'s `keypress` reducer branch and
 * `operate-keys.test.ts`).
 */
export function classifyKey(key: KeyInfo): OperateKeyBinding | null {
  if (key.ctrl && key.name === 'c') {
    return 'quit';
  }
  if (key.name === 'tab') {
    return key.shift ? 'cycle-focus-prev' : 'cycle-focus-next';
  }
  if (key.name === 'up') {
    return 'move-selection-up';
  }
  if (key.name === 'down') {
    return 'move-selection-down';
  }

  switch (key.sequence) {
    case 'a':
      return 'accept';
    case 's':
      return 'accept-for-session';
    case 'd':
      return 'decline';
    case 'x':
      return 'cancel';
    case 'r':
      return 'refresh';
    case 'q':
      return 'quit';
    default:
      return null;
  }
}
