import type { SelectableModel } from '../../utils/modelCapabilities';
import { BrandIcon } from './BrandIcon';

export function ModelIcon({
  model,
  size = 24,
}: {
  model: SelectableModel;
  size?: number;
}) {
  const family = model.canonicalModelIdentity?.canonicalId.split(':')[0];
  const provider = family ?? model.providerType;
  const brand =
    provider === 'anthropic' || provider === 'claude'
      ? 'claude'
      : provider === 'openai' || provider === 'codex'
        ? 'codex'
        : undefined;
  return (
    <BrandIcon
      name={model.name}
      icon={brand ? `brand:${brand}` : undefined}
      size={size}
    />
  );
}
