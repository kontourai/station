export type RegistryLifecycleState =
  | 'draft'
  | 'installable'
  | 'installed'
  | 'disabled'
  | 'update_available'
  | 'removed';

export interface RegistryLifecycleRecord {
  itemId: string;
  state: RegistryLifecycleState;
  installedVersion?: string;
  availableVersion?: string;
  source?: string;
}

export function canInstallRegistryItem(
  record: Pick<RegistryLifecycleRecord, 'state'>,
): boolean {
  return record.state === 'installable' || record.state === 'update_available';
}

export function canRemoveRegistryItem(
  record: Pick<RegistryLifecycleRecord, 'state'>,
): boolean {
  return (
    record.state === 'installed' ||
    record.state === 'disabled' ||
    record.state === 'update_available'
  );
}
