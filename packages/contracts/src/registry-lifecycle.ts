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
