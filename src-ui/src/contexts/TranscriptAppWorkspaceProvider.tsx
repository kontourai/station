import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';
import { useApiBase } from './ApiBaseContext';
import { TranscriptAppWorkspaceContext } from './TranscriptAppWorkspaceContext';

/** Bind discovery once, inside the application's connection and query owners. */
export function TranscriptAppWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { apiBase } = useApiBase();
  const queryClient = useQueryClient();
  const workspace = useMemo(
    () => ({ apiBase, queryClient }),
    [apiBase, queryClient],
  );
  return (
    <TranscriptAppWorkspaceContext.Provider value={workspace}>
      {children}
    </TranscriptAppWorkspaceContext.Provider>
  );
}
