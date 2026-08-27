import { createContext } from 'react';
import type { ConversationsContextType } from './conversation-types';

export const ConversationsContext = createContext<
  ConversationsContextType | undefined
>(undefined);
