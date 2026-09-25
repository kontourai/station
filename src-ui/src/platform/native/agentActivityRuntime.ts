import {
  registerNativePush,
  unregisterNativePush,
} from '@kontourai/station-sdk';
import {
  type AgentActivityController,
  createAgentActivityController,
  localAgentActivityRegistrationStore,
} from './agentActivity';
import { nativePlatformPromise } from './index';
import { primeNativeNotifications } from './notify';

let controller: AgentActivityController | null = null;

/**
 * The app's one agent-activity controller, or `null` when this host does not
 * report `remote-push` as enabled (web, desktop, iOS, or an Android build with
 * no push configuration). Kept out of the entry chunk: callers import this
 * module lazily.
 */
export async function agentActivityController(): Promise<AgentActivityController | null> {
  const adapter = await nativePlatformPromise;
  if (adapter.capability('remote-push').state !== 'enabled') return null;
  controller ??= createAgentActivityController({
    adapter,
    register: registerNativePush,
    unregister: unregisterNativePush,
    store: localAgentActivityRegistrationStore(),
    requestNotificationPermission: primeNativeNotifications,
    now: Date.now,
  });
  return controller;
}
