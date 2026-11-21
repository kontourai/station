import { createContext, type ReactNode } from 'react';

export const ScheduledCheckBackContext = createContext<{
  nextTime: string;
  notes: ReactNode;
} | null>(null);
