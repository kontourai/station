import { createContext } from 'react';

/**
 * The surface whose content an unsaved-changes guard protects: the dock
 * pane's surface id, provided by the region host around each pane it renders
 * (`RegionPaneHost`). `useUnsavedGuard` registers with it, so leaving ONE
 * pane — a phone layer's Back or "‹ Chat" — asks that pane's guards only,
 * not every dirty form in the app. Null outside a region pane: such a guard
 * is asked by route navigation only.
 */
export const UnsavedGuardOwnerContext = createContext<string | null>(null);
