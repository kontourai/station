/**
 * Station's in-process host-command catalog for Console board intents.
 *
 * This is deliberately not a `ProductCapabilityDescriptor`: Station does
 * not ship an argv-dispatched `station-control` package bin, so advertising
 * one would promise a router-invocable executable that does not exist.
 * Console's `resolveIntentBinding` contract explicitly accepts host-declared
 * bindings, which lets Station bind these product-owned handlers in process
 * without making a CLI routing claim. A future executable belongs with the
 * package-publication work that can prove it exists.
 */

import type {
  ProductCommandConfirmation,
  ProductCommandSideEffect,
} from '@kontourai/console-core/product-capability-descriptor';

export const STATION_HOST_COMMAND_PRODUCT = 'station';

export interface StationHostCommand {
  readonly id:
    | 'taskStatus'
    | 'taskDispatch'
    | 'taskBlock'
    | 'taskUnblock'
    | 'sessionResume';
  readonly path: readonly string[];
  readonly summary: string;
  readonly sideEffect: ProductCommandSideEffect;
  readonly confirmation: ProductCommandConfirmation;
}

/**
 * The one authority catalog for Station board actions. It records only
 * in-process host-binding facts: command identity, effect, and consent.
 * There is intentionally no executable id, package bin, argv, or descriptor
 * schema here.
 */
export const STATION_HOST_COMMAND_CATALOG = [
  {
    id: 'taskStatus',
    path: ['task', 'status'],
    summary: 'Read the current status of a Station task.',
    sideEffect: 'read-local',
    confirmation: 'never',
  },
  {
    id: 'taskDispatch',
    path: ['task', 'dispatch'],
    summary: 'Dispatch a Station task.',
    sideEffect: 'write-local',
    confirmation: 'user-request',
  },
  {
    id: 'taskBlock',
    path: ['task', 'block'],
    summary: 'Move a Station task to the blocked status.',
    sideEffect: 'write-local',
    confirmation: 'user-request',
  },
  {
    id: 'taskUnblock',
    path: ['task', 'unblock'],
    summary: 'Move a blocked Station task back to ready.',
    sideEffect: 'write-local',
    confirmation: 'user-request',
  },
  {
    id: 'sessionResume',
    path: ['session', 'resume'],
    summary: 'Resume or continue a Station orchestration session.',
    // Resuming re-enters an orchestration provider adapter that can invoke an
    // external, billable model provider. `write-local` would understate it.
    sideEffect: 'write-external',
    confirmation: 'user-request',
  },
] as const satisfies readonly StationHostCommand[];
