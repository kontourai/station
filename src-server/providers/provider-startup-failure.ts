import {
  ENGINE_STARTUP_FAILURE_GUIDANCE,
  type EngineStartupFailureCode,
} from '@kontourai/station-contracts/provider-failure';
import { errorMessage } from '../utils/error-message.js';
import { providerFailureForCode } from './provider-failure.js';

export function classifyEngineStartupFailure(
  provider: 'codex' | 'claude',
  error: unknown,
): EngineStartupFailureCode | undefined {
  const message = errorMessage(error);
  if (
    provider === 'codex' &&
    message.includes('bwrap: No permissions to create namespace')
  )
    return 'sandbox_unavailable';
  if (
    provider === 'claude' &&
    /API Error:\s*400\s+unknown provider for model\s+\S+/.test(message)
  )
    return 'provider_model_unavailable';
  return undefined;
}

export class EngineStartupFailure extends Error {
  constructor(readonly code: EngineStartupFailureCode) {
    super(ENGINE_STARTUP_FAILURE_GUIDANCE[code]);
    this.name = 'EngineStartupFailure';
  }
}

export function engineStartupFailureEvent(code: EngineStartupFailureCode) {
  return {
    ...providerFailureForCode(code),
    code,
    message: ENGINE_STARTUP_FAILURE_GUIDANCE[code],
    retriable: false,
  };
}
