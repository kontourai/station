import {
  ENSEMBLE_INSPECTION_LIMITS,
  type EnsembleInspection,
  type EnsembleInspectionInput,
} from '@kontourai/station-contracts/ensemble';
import {
  type ClientRequestOptions,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';

function validAuthenticationOffer(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('state' in value)
  )
    return false;
  const keys = Object.keys(value);
  if (value.state === 'available') return keys.length === 1;
  return (
    value.state === 'unavailable' &&
    keys.length === 2 &&
    'detail' in value &&
    typeof value.detail === 'string' &&
    value.detail.trim().length > 0 &&
    value.detail.length <= 256
  );
}

function validGroupInspection(
  value: unknown,
  requested: string | undefined,
): boolean {
  if (value === undefined) return requested === undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('state' in value)
  )
    return false;
  if (value.state !== 'bound')
    return requested === undefined && validAuthenticationOffer(value);
  return (
    Object.keys(value).length === 3 &&
    'groupId' in value &&
    typeof value.groupId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.groupId) &&
    requested === value.groupId &&
    'revision' in value &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

export async function inspectEnsemble(
  apiBase: string,
  input: EnsembleInspectionInput,
  options?: ClientRequestOptions,
): Promise<EnsembleInspection> {
  input = structuredClone(input);
  if (
    new TextEncoder().encode(JSON.stringify(input)).length >
    (input.presetJson === undefined
      ? ENSEMBLE_INSPECTION_LIMITS.requestBytes
      : ENSEMBLE_INSPECTION_LIMITS.uploadedRequestBytes)
  )
    throw new Error('Ensemble inspection request exceeds its byte limit.');
  const response = await mutateJson(
    `${apiBase}/api/orchestration/ensembles/inspect`,
    'POST',
    {
      ...options,
      readOnly: true,
      maxResponseBytes: ENSEMBLE_INSPECTION_LIMITS.responseBytes,
    },
    input,
  );
  const result = await readEnvelopeOrThrow<EnsembleInspection>(response);
  if (
    result?.version !== 'station.ensemble.inspection/v1' ||
    !validAuthenticationOffer(result.authenticationCheck) ||
    !validGroupInspection(result.groupInspection, input.groupId) ||
    !result.source ||
    !/^sha256:[0-9a-f]{64}$/.test(result.source.sha256) ||
    (input.expectedPresetHash !== undefined &&
      input.expectedPresetHash !== result.source.sha256) ||
    !Array.isArray(result.facts) ||
    result.facts.length > ENSEMBLE_INSPECTION_LIMITS.facts ||
    !Array.isArray(result.resolutions) ||
    result.resolutions.length > 16
  )
    throw new Error('Invalid Ensemble inspection response.');
  return result;
}
