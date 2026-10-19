import type { ToolLibraryClient } from '@kontourai/station-sdk/tool-library';
import { createContext, type ReactNode, useContext } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
export const ToolLibraryClientContext = createContext<
  ToolLibraryClient | undefined
>(undefined);
export function useToolLibraryClient(): ToolLibraryClient {
  const client = useContext(ToolLibraryClientContext);
  if (!client) throw new Error('Tool library requires a Station connection.');
  return client;
}
export function StationToolLibraryProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { apiBase } = useApiBase();
  const scope = useHostRequestAuthorityScope();
  return (
    <ToolLibraryClientContext.Provider
      value={{ apiBase, options: scope ? { requestScope: scope } : undefined }}
    >
      {children}
    </ToolLibraryClientContext.Provider>
  );
}
