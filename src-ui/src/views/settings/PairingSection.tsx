import { Button } from '../../components/Button';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import { hasLocalStationForProfile } from '../../platform/client-origin-surface';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { SettingsToggle } from './feature-toggle';
import { LanDiscoveryControl } from './LanDiscoveryControl';
import { OwnAccessTokensPanel } from './OwnAccessTokensPanel';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

export function PairingSection() {
  const profile = usePlatformProfile();
  const { isMobile } = profile;
  const canInviteDevice = hasLocalStationForProfile(profile);
  const { openLastStationOnLaunch } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  return (
    // A glyph already on `ui-glyph-coverage-allowlist.json` rather than a new
    // one: that list is recorded debt (#1704 is shrinking it).
    <SettingsSection
      icon="▦"
      title="Pairing"
      id="section-pairing"
      // #3557: the section's one action, compact on its header line. It
      // carries the catalog row, so a deep link lands on (and focuses) it.
      action={
        <Button
          {...settingsRow('mobile-pairing')}
          // The catalog title ("Device pairing") is not this control's
          // description; its name is its label.
          title={undefined}
          size="sm"
          className="settings__header-action"
          onClick={() =>
            openConnectionsModal({
              mode: canInviteDevice ? 'pair-host' : 'pair-device',
            })
          }
        >
          {canInviteDevice ? '+ Pair device' : 'Connect phone'}
        </Button>
      }
    >
      {canInviteDevice && <LanDiscoveryControl />}
      {isMobile && (
        <div {...settingsRow('open-last-station')} tabIndex={-1}>
          <SettingsToggle
            className="settings__feature-toggle"
            checked={openLastStationOnLaunch}
            onChange={() =>
              setDeviceSetting(
                'openLastStationOnLaunch',
                !openLastStationOnLaunch,
              )
            }
            label={settingsRow('open-last-station').title}
            describedBy="open-last-station-description"
          >
            <div>
              <div className="settings__toggle-name">
                Open last Station on launch
              </div>
              <div
                className="settings__toggle-detail"
                id="open-last-station-description"
              >
                Reconnect to the Station you last selected when this phone
                opens. Turn off to open the default Station instead. Applies on
                the next launch.
              </div>
            </div>
          </SettingsToggle>
        </div>
      )}
      <p className="settings__section-note">
        {canInviteDevice
          ? 'Invite a phone or another device to the selected Station.'
          : 'Scan a pairing code to connect this phone to another Station.'}
      </p>
      {/* #3557: a person's own tokens, beside the device they act from. It
          renders nothing unless this device is tied to a person. */}
      <OwnAccessTokensPanel />
    </SettingsSection>
  );
}
