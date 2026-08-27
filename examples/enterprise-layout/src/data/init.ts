/**
 * Provider Registration — Register and configure providers for this workspace.
 *
 * Deferred initialization: providers are registered when the SDK is ready.
 * Each provider is registered with a unique id, scoped to this layout's workspace.
 */

import { configureProvider, registerProvider } from '@kontourai/station-sdk';
import { calendarProvider } from './providers/calendar';
import { crmProvider } from './providers/crm';
import { directoryProvider } from './providers/directory';
import { emailProvider } from './providers/email';

const WORKSPACE = 'enterprise';

let initialized = false;

export function ensureProviders(): boolean {
  if (initialized) return true;
  try {
    registerProvider(
      'enterprise/calendar',
      { layout: WORKSPACE, type: 'calendar' },
      () => calendarProvider,
    );
    registerProvider(
      'enterprise/email',
      { layout: WORKSPACE, type: 'email' },
      () => emailProvider,
    );
    registerProvider(
      'enterprise/crm',
      { layout: WORKSPACE, type: 'crm' },
      () => crmProvider,
    );
    registerProvider(
      'enterprise/user',
      { layout: WORKSPACE, type: 'user' },
      () => crmProvider,
    );
    registerProvider(
      'enterprise/internal',
      { layout: WORKSPACE, type: 'internal' },
      () => directoryProvider,
    );

    configureProvider(WORKSPACE, 'calendar', 'enterprise/calendar');
    configureProvider(WORKSPACE, 'email', 'enterprise/email');
    configureProvider(WORKSPACE, 'crm', 'enterprise/crm');
    configureProvider(WORKSPACE, 'user', 'enterprise/user');
    configureProvider(WORKSPACE, 'internal', 'enterprise/internal');
    initialized = true;
    return true;
  } catch {
    return false;
  }
}
