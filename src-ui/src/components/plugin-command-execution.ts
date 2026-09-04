import {
  CLIENT_ORIGIN_SURFACES,
  type ClientOriginActor,
} from '@kontourai/station-contracts/client-origin';
import {
  PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
  type PluginCommandExecutionReceipt,
  type PluginCommandExecutionRequest,
  type PluginCommandResolvedTarget,
} from '@kontourai/station-contracts/plugin';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';

export class PluginCommandExecutionError extends Error {
  constructor(readonly reason: string) {
    super(`Plugin command was not admitted: ${reason}`);
    this.name = 'PluginCommandExecutionError';
  }
}

function validActor(value: ClientOriginActor | undefined): boolean {
  return (
    value?.kind === 'operator' ||
    value?.kind === 'internal' ||
    value?.kind === 'unknown' ||
    (value?.kind === 'device' &&
      typeof value.deviceId === 'string' &&
      value.deviceId.length > 0 &&
      value.deviceId.length <= 256)
  );
}

function sameTarget(
  left: unknown,
  right: PluginCommandResolvedTarget,
): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const target = left as Record<string, unknown>;
  if (Object.keys(target).length !== 2 || !Object.hasOwn(target, 'kind'))
    return false;
  if (right.kind === 'surface') {
    return (
      target.kind === 'surface' &&
      Object.hasOwn(target, 'surfaceId') &&
      typeof target.surfaceId === 'string' &&
      target.surfaceId === right.surfaceId
    );
  }
  return (
    target.kind === 'composer' &&
    Object.hasOwn(target, 'sessionId') &&
    typeof target.sessionId === 'string' &&
    target.sessionId === right.sessionId
  );
}

/** Host admission and durable audit must succeed before the local UI effect. */
export async function authorizePluginPaletteCommand(
  apiBase: string,
  input: Omit<PluginCommandExecutionRequest, 'schemaVersion' | 'requestId'>,
  options: { signal?: AbortSignal } = {},
): Promise<PluginCommandExecutionReceipt> {
  const request: PluginCommandExecutionRequest = {
    schemaVersion: PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
    requestId: randomCorrelationId(),
    ...input,
  };
  const response = await authenticatedFetch(
    `${apiBase}/api/ui/plugin-command-receipts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    success?: unknown;
    reason?: unknown;
    receipt?: PluginCommandExecutionReceipt;
  } | null;
  if (!response.ok || body?.success !== true || !body.receipt) {
    throw new PluginCommandExecutionError(
      typeof body?.reason === 'string' ? body.reason : 'audit-unavailable',
    );
  }
  const receipt = body.receipt;
  if (
    receipt.schemaVersion !== PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION ||
    receipt.requestId !== request.requestId ||
    receipt.pluginId !== request.pluginId ||
    receipt.pluginVersion !== request.pluginVersion ||
    receipt.commandGeneration !== request.commandGeneration ||
    receipt.commandId !== request.commandId ||
    typeof receipt.receiptId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.receiptId) ||
    typeof receipt.recordedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.recordedAt)) ||
    !validActor(receipt.actor) ||
    !CLIENT_ORIGIN_SURFACES.includes(receipt.reportedSurface) ||
    receipt.decision !== 'authorized' ||
    receipt.outcome !== 'admitted' ||
    !sameTarget(receipt.target, request.target)
  ) {
    throw new PluginCommandExecutionError('malformed-receipt');
  }
  return receipt;
}
