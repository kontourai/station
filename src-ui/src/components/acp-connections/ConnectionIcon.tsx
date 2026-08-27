import { BrandIcon } from '../icons/BrandIcon';

export function ConnectionIcon({
  icon,
  name,
  id,
  size = 24,
}: {
  icon?: string;
  name?: string;
  id?: string;
  size?: number;
}) {
  return (
    <BrandIcon name={name ?? id ?? 'Engine'} id={id} icon={icon} size={size} />
  );
}
