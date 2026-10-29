import { Badge } from '@kontourai/ui/react';

const SCOPES = {
  account: {
    label: 'Account',
    description: 'Saved to your account on this Station.',
  },
  device: { label: 'This device', description: 'Saved only on this device.' },
  station: { label: 'Station', description: 'Saved on the connected Station.' },
} as const;

export function SettingsScopeBadge({
  scope,
  label,
  description,
}: {
  scope: keyof typeof SCOPES;
  label?: string;
  description?: string;
}) {
  return (
    <span title={description ?? SCOPES[scope].description}>
      <Badge
        value={label ?? SCOPES[scope].label}
        tone="neutral"
        className={`settings__scope-pill settings__scope-pill--${scope}`}
      />
    </span>
  );
}
