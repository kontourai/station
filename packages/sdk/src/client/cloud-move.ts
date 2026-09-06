import type { CloudMoveTargetObservation } from '@kontourai/station-contracts/cloud-move';
import { type ClientRequestOptions, getJson } from './http';

export type { CloudMoveTargetObservation } from '@kontourai/station-contracts/cloud-move';

function field(value: unknown, key: string): string {
  const result =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  if (
    typeof result !== 'string' ||
    !result.trim() ||
    result.length > 256 ||
    Array.from(result).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('Target returned an invalid Station identity');
  return result;
}

/** Reuse this observation in CLI/UI preparation; activation needs fresh authority. */
export async function verifyCloudMoveTarget(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<CloudMoveTargetObservation> {
  const url = new URL(apiBase);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Select a Station origin without a path, query or embedded credential',
    );
  const origin = url.origin;
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const requestOptions = {
    ...options,
    authentication: 'required' as const,
    requireCredential: true,
    maxResponseBytes: 4096,
    redirect: 'error' as const,
    signal,
    timeoutMs: 15000,
  };
  const read = async (path: string) => {
    const response = await getJson(`${origin}${path}`, requestOptions);
    if (!response.ok || response.redirected)
      throw new Error('Target identity verification failed');
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error('Target returned an invalid Station identity');
    }
  };
  const first = await read('/api/system/identity');
  const instanceId = field(first, 'instanceId');
  const bootId = field(first, 'bootId');
  const sha = field(first, 'sha');
  if (!/^[a-f0-9]{40}$/i.test(sha))
    throw new Error('Target returned an invalid Station build identity');
  const discovery = await read('/.well-known/station/v1');
  const environmentId = field(discovery, 'environmentId');
  const last = await read('/api/system/identity');
  if (
    field(last, 'instanceId') !== instanceId ||
    field(last, 'bootId') !== bootId ||
    field(last, 'sha') !== sha
  )
    throw new Error(
      'Target restarted or changed during verification; verify again',
    );
  signal.throwIfAborted();
  return {
    schemaVersion: 'station.cloud-target-observation/v1',
    targetOrigin: origin,
    environmentId,
    instanceId,
    bootId,
    sha,
    observedAt: new Date().toISOString(),
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  };
}
