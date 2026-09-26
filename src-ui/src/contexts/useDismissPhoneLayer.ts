import { useCallback } from 'react';
import { useRegionModelOptional } from './RegionModelContext';

/**
 * A chat-focus intent's half of the phone layer (review M4): focusing a
 * conversation — `focusSession`, `openChatForAgent`, opening one — shows
 * Chat, so a pane open OVER Chat on a phone must get out of the way rather
 * than keep covering the conversation the user just asked for. It leaves the
 * layer the way "‹ Chat" does (`closePhoneLayer`, unsaved-changes guards
 * included).
 *
 * A command, not a read: the chat hooks are pane-renderer territory and do
 * not read region state (`region-surface-boundary.test.ts`), the rule
 * `useShowSurface` follows. Outside a region model (the model-less mount,
 * isolated tests) it does nothing.
 */
export function useDismissPhoneLayer(): () => void {
  const close = useRegionModelOptional()?.closePhoneLayer;
  return useCallback(() => close?.(), [close]);
}
