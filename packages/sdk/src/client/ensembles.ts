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

export async function inspectEnsemble(
  apiBase: string,
  input: EnsembleInspectionInput,
  options?: ClientRequestOptions,
): Promise<EnsembleInspection> {
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
