import type { QueryClient } from '@tanstack/react-query';
import { createContext } from 'react';

/** Only the connected application tree supplies app-discovery inputs. */
export const TranscriptAppWorkspaceContext = createContext<
  | {
      apiBase: string;
      queryClient: QueryClient;
    }
  | undefined
>(undefined);
