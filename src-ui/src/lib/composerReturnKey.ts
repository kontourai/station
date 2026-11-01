import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import { isComposingKeyEvent } from './isComposingKeyEvent';

/**
 * One submit-key policy for every chat composer (#4387).
 *
 * Return sends when the device setting says so; `auto` sends on a fine
 * pointer and inserts a newline on a touch keyboard, where the Send button is
 * the way to send. Ctrl/Cmd+Return always sends. Shift+Return and Alt+Return
 * always insert a newline, and a Return that confirms an IME composition is
 * never a submit.
 */
export function composerReturnSends(
  behavior: DeviceSettings['chatReturnBehavior'],
  coarsePointer: boolean,
): boolean {
  return behavior === 'send' || (behavior === 'auto' && !coarsePointer);
}

export function isComposerSubmitKey(
  event: {
    key: string;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean };
  },
  returnSends: boolean,
): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return false;
  if (isComposingKeyEvent(event)) return false;
  return event.ctrlKey || event.metaKey || returnSends;
}
