import { AnthropicSealedPreparation } from './anthropic-sealed-preparation.js';
import {
  type BoundedApiProvider,
  BoundedApiProviderContractError,
} from './bounded-api-provider-contract.js';
import { GoogleSealedPreparation } from './google-sealed-preparation.js';

export type SealedProviderPreparation =
  | AnthropicSealedPreparation
  | GoogleSealedPreparation;

export function isSealedProviderPreparation(
  value: unknown,
): value is SealedProviderPreparation {
  return (
    AnthropicSealedPreparation.isOwner(value) ||
    GoogleSealedPreparation.isOwner(value)
  );
}

export async function createSealedProviderPreparation(
  provider: BoundedApiProvider,
): Promise<SealedProviderPreparation> {
  if (provider === 'anthropic') return AnthropicSealedPreparation.create();
  if (provider === 'google') return GoogleSealedPreparation.create();
  throw new BoundedApiProviderContractError('untrusted_contract');
}
