import { createContext, type ReactNode } from 'react';

/**
 * A control a phone host puts at the start of the chat's own mobile header,
 * so the host needs no bar of its own above it. The coding view's tool
 * picker ("Chat ▾") rides here on its Chat page.
 */
export const MobileDockHeaderLeadingContext = createContext<ReactNode>(null);
