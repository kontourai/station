import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** A separate read-only projection; raw session rows include recovery state. */
export function OfflineSessionIndex() {
  const client = useQueryClient();
  useEffect(() => {
    const project = () => {
      const query = client
        .getQueryCache()
        .find({ queryKey: ['orchestration-sessions'], exact: true });
      if (
        query?.state.status !== 'success' ||
        query.state.error ||
        !Array.isArray(query.state.data)
      )
        return;
      const rows = query.state.data
        .flatMap((row: unknown) => {
          if (
            typeof row !== 'object' ||
            row === null ||
            !('threadId' in row) ||
            typeof row.threadId !== 'string'
          )
            return [];
          return [
            {
              threadId: row.threadId,
              ...('conversationId' in row &&
              typeof row.conversationId === 'string'
                ? { conversationId: row.conversationId }
                : {}),
            },
          ];
        })
        .slice(0, 1000);
      client.setQueryData(['offline-session-index'], {
        savedAt: query.state.dataUpdatedAt,
        rows,
      });
    };
    project();
    return client.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'success' &&
        event.query.queryKey[0] === 'orchestration-sessions'
      )
        project();
    });
  }, [client]);
  return null;
}
