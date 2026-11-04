import {
  REQUIRED_SLOT_DEFAULTS,
  resolveRequiredSlot,
} from '@kontourai/station-contracts/required-slots';
import type { WorkspaceHomeRoleStatus } from '@kontourai/station-contracts/workspace-home-role';
import { deriveWorkspaceHomeRoleStatus } from './workspace-home-role-service.js';

/** Adapt the existing grant file without copying or weakening its standing rules. */
export function resolveInstallationRequiredSlots(
  status: WorkspaceHomeRoleStatus,
) {
  return {
    home: resolveRequiredSlot(
      'home',
      {
        id: REQUIRED_SLOT_DEFAULTS.home,
        available: true,
        value: 'builtin',
      },
      status.state === 'granted'
        ? {
            id: status.grant.descriptor.id,
            available: true,
            value: 'home-role',
          }
        : undefined,
    ),
    // Inbox and conversation views share this built-in pane today (#3011).
    chat: resolveRequiredSlot('chat', {
      id: REQUIRED_SLOT_DEFAULTS.chat,
      available: true,
      value: 'builtin',
    }),
  };
}

/** No cross-request state: presence, enablement, revision and bytes are read afresh. */
export function readInstallationRequiredSlots(
  deps: Parameters<typeof deriveWorkspaceHomeRoleStatus>[0],
) {
  const status = deriveWorkspaceHomeRoleStatus(deps);
  return { status, slots: resolveInstallationRequiredSlots(status) };
}
