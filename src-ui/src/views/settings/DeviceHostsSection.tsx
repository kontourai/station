import { lazy, Suspense } from 'react';
import { Skeleton } from '../../components/state';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

/**
 * Settings › Device hosts (#1973): the section shell. Its anchor and heading
 * render with Settings; the panel (lists, forms, the connection test) is
 * lazy-loaded so it rides its own chunk.
 */
const DeviceHostsPanel = lazy(() =>
  import('./DeviceHostsPanel').then((module) => ({
    default: module.DeviceHostsPanel,
  })),
);

export function DeviceHostsSection() {
  return (
    <SettingsSection icon="◉" title="Device hosts" id="section-device-hosts">
      <div {...settingsRow('device-hosts')} tabIndex={-1}>
        <Suspense fallback={<Skeleton variant="line" />}>
          <DeviceHostsPanel />
        </Suspense>
      </div>
    </SettingsSection>
  );
}
