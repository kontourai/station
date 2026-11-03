import { createContext, useContext } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

/** The transcript's target can be a bridge under the current host's authority. */
export const ChatRequestContext = createContext<{
  apiBase: string;
  requestScope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
} | null>(null);

export function useChatRequestTarget() {
  return useContext(ChatRequestContext);
}
