import { useServerEventsTransport } from './ServerEventsMount';
import { useServerEventsListener } from './useServerEventsListener';

export * from './useServerEventsListener';

export function useServerEvents(
  handlers?: Record<string, (data: Record<string, unknown>) => void>,
) {
  useServerEventsListener(handlers);
  useServerEventsTransport();
}
