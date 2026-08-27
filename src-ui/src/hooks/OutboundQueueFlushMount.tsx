import { useOutboundQueueFlush } from './useOutboundQueueFlush';

export function OutboundQueueFlushMount({ apiBase }: { apiBase: string }) {
  useOutboundQueueFlush(apiBase);
  return null;
}
