import { verifyCloudMoveTarget } from '@kontourai/station-sdk/client';
import {
  configureApiCredential,
  type ParsedCoreArgs,
  resolveApiBase,
} from './core-api.js';

export async function runCloudTargetVerification(
  parsed: ParsedCoreArgs,
): Promise<void> {
  const selectors = ['station', 'api-base'].filter(
    (key) => parsed.flags[key] !== undefined,
  );
  if (
    selectors.length !== 1 ||
    selectors.some(
      (key) =>
        typeof parsed.flags[key] !== 'string' ||
        !(parsed.flags[key] as string).trim(),
    )
  )
    throw new Error(
      'Select one enrolled target explicitly with --station or --api-base',
    );
  const apiBase = resolveApiBase(parsed);
  configureApiCredential(parsed, apiBase);
  const observation = await verifyCloudMoveTarget(apiBase);
  console.log(
    parsed.flags.json
      ? JSON.stringify(observation, null, 2)
      : `Verified Station ${observation.environmentId} at ${observation.targetOrigin} (boot ${observation.bootId}). No execution authority transferred; agent continuation is not available.`,
  );
}
