import {
  isBoundExtensionNotification,
  takeUnboundExtensionNotice,
} from '../../src-shared/extension-notification-bindings.js';
import { inboundExtensionNotifications } from '../telemetry/metrics.js';

type ExtensionObserveLogger = {
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

export function observeInboundExtensionNotification(input: {
  provider: string;
  namespace: string;
  type: string;
  logger?: ExtensionObserveLogger;
}): 'bound' | 'unbound' {
  const bound = isBoundExtensionNotification(input.namespace, input.type);
  inboundExtensionNotifications.add(1, {
    disposition: bound ? 'bound' : 'unbound',
    provider: input.provider,
  });
  if (
    !bound &&
    takeUnboundExtensionNotice(input.provider, input.namespace, input.type)
  ) {
    input.logger?.warn(
      'Unbound extension.notification; map it to a Station event or accept it as unique',
      {
        provider: input.provider,
        namespace: input.namespace,
        type: input.type,
      },
    );
  }
  return bound ? 'bound' : 'unbound';
}
