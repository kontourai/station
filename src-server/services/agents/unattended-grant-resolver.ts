/**
 * Resolves recorded exact-tool grants for unattended invocations (archive#2037).
 *
 * This is deliberately only the lookup/receipt seam. Agent hooks decide when it
 * may run, after higher-priority guards have already had their say.
 */

import type {
  InvocationContext,
  ToolCallContext,
} from '../../runtime/types.js';
import {
  unattendedGrantStoreUnavailable,
  unattendedGrantUses,
} from '../../telemetry/metrics.js';
import {
  principalKey,
  UnattendedGrantStore,
  UnattendedGrantStoreUnavailableError,
} from './unattended-grant-store.js';

type ResolverLogger = {
  debug: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
};

/** Build the last-resort standing-grant resolver used by managed-agent hooks. */
export function makeUnattendedGrantResolver(
  store: UnattendedGrantStore,
  deps: { logger: ResolverLogger },
): (tool: ToolCallContext, invocation: InvocationContext) => Promise<boolean> {
  return async (tool, invocation) => {
    const principal = invocation.unattendedPrincipal;
    if (!principal) return false;

    const principalKind = principal.kind;
    let granted: boolean;
    try {
      granted = store.isGranted(principalKey(principal), tool.toolName);
    } catch (error) {
      if (error instanceof UnattendedGrantStoreUnavailableError) {
        deps.logger.error('unattended grant store unavailable; denying', {
          toolName: tool.toolName,
          principalKind,
        });
        unattendedGrantStoreUnavailable.add(1, { principalKind });
        return false;
      }
      throw error;
    }

    if (granted !== true) return false;

    // This is an authorization event, distinct from the grant/revoke receipt.
    // Tool name and principal identity must never become metric attributes.
    unattendedGrantUses.add(1, { principalKind });
    deps.logger.debug('unattended grant authorized tool execution', {
      toolName: tool.toolName,
      principalKind,
    });
    return true;
  };
}
