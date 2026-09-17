/**
 * Pairing — reaching this Station from a phone.
 *
 * Its own Settings section since #2182. It used to be the third row of a
 * section called "Voice & Features", where "Features" was not a category a
 * reader could predict: it was the word the one non-voice row was filed
 * under. Pairing has nothing to do with speech, and now says so by having a
 * name of its own.
 *
 * The switch and the panel are deliberately one section rather than two
 * rows: turning the switch on has exactly one effect, which is to show the
 * panel below it. Nothing is enabled on the server.
 */
import {
  QRDisplay,
  useConnections,
  useHostUrl,
} from '@kontourai/station-connect';
import { useFeatureSettings } from '../../hooks/useFeatureSettings';
import { FeatureToggle } from './feature-toggle';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

/** The default Station port, used when a connection URL names none. */
const DEFAULT_STATION_PORT = 3141;

function PairingPanel() {
  const { activeConnection } = useConnections();
  const serverPort = (() => {
    try {
      // archive#198: resolve against the current page as the base so a relative
      // or empty `activeConnection.url` never throws — parity with the
      // hardened `TerminalPanel.tsx`/`deriveVoiceWsUrl` pattern elsewhere.
      const url = new URL(
        activeConnection?.url || window.location.origin,
        window.location.href,
      );
      return Number(url.port) || DEFAULT_STATION_PORT;
    } catch {
      return DEFAULT_STATION_PORT;
    }
  })();
  const { hostUrl, isDetecting } = useHostUrl({
    port: serverPort,
    fallback: activeConnection?.url || `http://localhost:${serverPort}`,
  });
  const isLocalhost =
    hostUrl.includes('localhost') || hostUrl.includes('127.0.0.1');

  return (
    <div className="form-group">
      <span className="form-group__label">Mobile Pairing</span>
      <div className="settings__pairing-content">
        {isDetecting ? (
          <div className="settings__pairing-detecting">Detecting local IP…</div>
        ) : (
          <QRDisplay url={hostUrl} size={160} label={hostUrl} />
        )}
        {isLocalhost && !isDetecting && (
          <div className="settings__pairing-warning">
            Showing localhost — your device may not be able to reach this
            address. Make sure both devices are on the same network and use your
            computer&apos;s LAN IP.
          </div>
        )}
        <span className="form-help">
          Scan this QR code with the mobile app to connect to this server
          automatically.
        </span>
      </div>
    </div>
  );
}

export function PairingSection() {
  const { settings, toggle } = useFeatureSettings();
  return (
    // A glyph already on `ui-glyph-coverage-allowlist.json` rather than a new
    // one: that list is recorded debt (#1704 is shrinking it).
    <SettingsSection icon="▦" title="Pairing" id="section-pairing">
      <div {...settingsRow('mobile-pairing')} tabIndex={-1}>
        <FeatureToggle
          featureKey="mobilePairingEnabled"
          label={settingsRow('mobile-pairing').title}
          // The toggle's only effect is mounting the panel below it — it
          // enables no pairing capability on the server, which is what the
          // description used to imply. The WebRTC consequence keeps its own
          // `privacyNote` element (`.settings__toggle-privacy`) rather than
          // being folded into the description as an ordinary sentence.
          description="Show the pairing QR code and LAN discovery panel below."
          privacyNote="Detects this device’s local IP address via WebRTC while the panel is shown."
          checked={settings.mobilePairingEnabled}
          onToggle={toggle}
        />
      </div>
      {settings.mobilePairingEnabled && <PairingPanel />}
    </SettingsSection>
  );
}
