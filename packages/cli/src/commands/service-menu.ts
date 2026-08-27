/**
 * Interactive `station service` menu (station#1984).
 *
 * `station service` with no action, in a TTY, presents the service actions as a
 * menu and dispatches the choice through the ordinary `runServiceCommand` — so
 * the setup receipt / rollback contract and every flag behaviour are exactly
 * what an explicit `station service <action>` would get. In a non-TTY process
 * it falls back to the current usage error, and it does so by calling
 * `runServiceCommand` with no action, so the exact usage string can never drift
 * from the one an explicit bad invocation prints.
 */

import { promptSelect, type SelectOption } from './prompt.js';
import type { ServiceLifecycleArgs } from './service.js';

/** The actions `runServiceCommand` actually accepts, offered in menu order. */
const SERVICE_ACTIONS: SelectOption<string>[] = [
  { value: 'status', label: 'Status — is the service installed and running?' },
  { value: 'install', label: 'Install and start the background service' },
  { value: 'start', label: 'Start the installed service' },
  { value: 'stop', label: 'Stop the service' },
  { value: 'uninstall', label: 'Uninstall the service' },
];

export interface ServiceMenuDeps {
  isInteractive: boolean;
  runService: (
    args: string[],
    lifecycle: ServiceLifecycleArgs,
  ) => Promise<unknown>;
  select?: (
    message: string,
    options: SelectOption<string>[],
  ) => Promise<string | null>;
}

/**
 * Runs the interactive menu (TTY) or the deterministic usage error (non-TTY).
 * Returns whatever `runServiceCommand` returns so the setup receipt survives.
 */
export async function runServiceMenu(
  lifecycle: ServiceLifecycleArgs,
  deps: ServiceMenuDeps,
): Promise<unknown> {
  if (!deps.isInteractive) {
    // No action + no TTY: delegate to the real command so the usage error is
    // byte-identical to `station service <bad>` rather than a copy that can rot.
    return deps.runService([], lifecycle);
  }
  const select = deps.select ?? promptSelect;
  const action = await select('Station service — choose an action:', [
    ...SERVICE_ACTIONS,
  ]);
  if (!action) return undefined; // cancelled
  return deps.runService([action], lifecycle);
}
