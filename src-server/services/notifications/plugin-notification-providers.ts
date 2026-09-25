/**
 * Registers plugin notification providers one at a time. A refused provider
 * (reserved, internal or duplicate id — see
 * `NotificationService.addPluginProvider`) is skipped with a warning naming
 * the plugin, so one bad plugin cannot stop Station booting or replace a
 * built-in provider.
 */
import type { INotificationProvider } from '../../providers/provider-interfaces.js';
import {
  NotificationProviderIdError,
  type NotificationService,
} from './notification-service.js';

export function registerPluginNotificationProviders(
  notificationService: Pick<NotificationService, 'addPluginProvider'>,
  entries: ReadonlyArray<{ provider: INotificationProvider; source: string }>,
  logger: { warn(message: string, data?: Record<string, unknown>): void },
): number {
  let registered = 0;
  for (const { provider, source } of entries) {
    try {
      notificationService.addPluginProvider(provider);
      registered += 1;
    } catch (error) {
      if (!(error instanceof NotificationProviderIdError)) throw error;
      logger.warn('Plugin notification provider skipped', {
        plugin: source,
        providerId: error.providerId,
        reason: error.reason,
      });
    }
  }
  return registered;
}
