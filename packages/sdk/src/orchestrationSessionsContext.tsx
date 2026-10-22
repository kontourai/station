import { createContext } from 'react';
import type { ApiRequestScope } from './client/http.js';

/** Host binding shared by session lists and personal-board recent work. */
export const OrchestrationSessionsContext = createContext<{
  scope: (ApiRequestScope & { isCurrent?: () => boolean }) | undefined;
  streamLive: boolean;
} | null>(null);
