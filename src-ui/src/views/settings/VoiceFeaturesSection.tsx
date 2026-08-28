import {
  QRDisplay,
  useConnections,
  useHostUrl,
} from '@kontourai/station-connect';
import type { ReactNode } from 'react';
import '../../components/Toggle.css';
import { CheckGlyph, MicGlyph } from '../../components/icons/Glyph';
import { useMessageContextContext } from '../../contexts/MessageContextContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useVoiceProviderContext } from '../../contexts/VoiceProviderContext';
import type { BooleanFeatureSetting } from '../../hooks/useFeatureSettings';
import { useFeatureSettings } from '../../hooks/useFeatureSettings';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { NotificationSoundSettings } from './NotificationSoundSettings';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

function SettingsToggle({
  checked,
  className,
  describedBy,
  label,
  onChange,
  children,
}: {
  checked: boolean;
  className: string;
  describedBy?: string;
  label: string;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-label={label}
      onClick={onChange}
    >
      <span
        className={`station-toggle station-toggle--sm${checked ? ' station-toggle--on' : ''}`}
        aria-hidden="true"
      >
        <span className="station-toggle__thumb" />
      </span>
      {children}
    </button>
  );
}

function MobilePairingSection() {
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
      return Number(url.port) || 3141;
    } catch {
      return 3141;
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

// The `key` literals here trip gitleaks' generic-api-key rule, and the
//gitleaks.toml allowlist for this file only masks identifiers matching
// ^[a-z][A-Za-z0-9]{2,40}Enabled$ — a new key NOT ending in `Enabled` will
// fail the secret scan until that regex is widened alongside it.
const FEATURE_META: Array<{
  catalogId: 'voice-pill' | 'mobile-pairing' | 'tts-readback';
  key: BooleanFeatureSetting;
  description: string;
  privacyNote?: string;
}> = [
  {
    catalogId: 'voice-pill',
    key: 'voiceS2SEnabled',
    description:
      'Show the floating voice pill for full-duplex speech-to-speech sessions with app control.',
  },
  {
    catalogId: 'mobile-pairing',
    key: 'mobilePairingEnabled',
    description:
      'Show QR code and LAN discovery for connecting mobile devices to this server.',
    privacyNote: 'Detects your local IP address via WebRTC when enabled.',
  },
  {
    catalogId: 'tts-readback',
    key: 'ttsReadbackEnabled',
    description:
      'Automatically reads the latest assistant response via the selected TTS provider after each reply.',
  },
];

function FeatureToggle({
  featureKey,
  label,
  description,
  privacyNote,
  checked,
  onToggle,
}: {
  featureKey: BooleanFeatureSetting;
  label: string;
  description: string;
  privacyNote?: string;
  checked: boolean;
  onToggle: (key: BooleanFeatureSetting) => void;
}) {
  const descId = `feature-desc-${featureKey}`;
  return (
    <SettingsToggle
      className="settings__feature-toggle"
      checked={checked}
      onChange={() => onToggle(featureKey)}
      describedBy={descId}
      label={label}
    >
      <div>
        <div className="settings__toggle-name">{label}</div>
        <div className="settings__toggle-detail" id={descId}>
          {description}
        </div>
        {privacyNote && (
          <div className="settings__toggle-privacy">{privacyNote}</div>
        )}
      </div>
    </SettingsToggle>
  );
}

function NotificationSubscribeButton({ apiBase }: { apiBase: string }) {
  const { settings } = useFeatureSettings();
  const notifications = usePushNotifications({
    enabled: settings.pushNotificationsEnabled,
    apiBase,
  });

  if (!notifications.supported) return null;

  return (
    <div className="settings__notif-subscribe">
      {notifications.subscribed ? (
        <div className="settings__notif-subscribed">
          <span className="settings__notif-status">
            <CheckGlyph /> Subscribed to push notifications
          </span>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={notifications.unsubscribe}
          >
            Unsubscribe
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={notifications.subscribe}
          disabled={notifications.permission === 'denied'}
        >
          {notifications.permission === 'denied'
            ? 'Notifications blocked by browser'
            : 'Enable push notifications'}
        </button>
      )}
      {notifications.error && (
        <div className="settings__notif-error">{notifications.error}</div>
      )}
    </div>
  );
}

export function VoiceFeaturesSection() {
  const { settings, toggle } = useFeatureSettings();
  const {
    availableSTT,
    availableTTS,
    activeSTT,
    activeTTS,
    setSTTProvider,
    setTTSProvider,
  } = useVoiceProviderContext();
  const { providers: contextProviders, toggleProvider } =
    useMessageContextContext();

  return (
    <SettingsSection
      icon={<MicGlyph />}
      title="Voice & Features"
      id="section-voice"
    >
      <div
        className="voice-provider-section"
        {...settingsRow('speech-to-text')}
        tabIndex={-1}
      >
        <label className="voice-provider-section__label" htmlFor="stt-provider">
          {settingsRow('speech-to-text').title}
        </label>
        <select
          id="stt-provider"
          className="voice-provider-section__select"
          data-testid="stt-provider-select"
          value={activeSTT?.id ?? ''}
          onChange={(event) => setSTTProvider(event.target.value)}
        >
          {availableSTT.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
              {provider.isSupported ? '' : ' (not available)'}
            </option>
          ))}
          {availableSTT.length === 0 && (
            <option value="">No speech-to-text services registered</option>
          )}
        </select>
        <div className="voice-provider-section__hint">
          Using WisprFlow? Focus the chat input and press your hotkey — it
          injects text naturally.
        </div>
      </div>

      <div
        className="voice-provider-section"
        {...settingsRow('text-to-speech')}
        tabIndex={-1}
      >
        <label className="voice-provider-section__label" htmlFor="tts-provider">
          {settingsRow('text-to-speech').title}
        </label>
        <select
          id="tts-provider"
          className="voice-provider-section__select"
          data-testid="tts-provider-select"
          value={activeTTS?.id ?? ''}
          onChange={(event) => setTTSProvider(event.target.value)}
        >
          {availableTTS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
              {provider.isSupported ? '' : ' (not available)'}
            </option>
          ))}
          {availableTTS.length === 0 && (
            <option value="">No text-to-speech services registered</option>
          )}
        </select>
      </div>

      <div
        className="context-provider-section"
        {...settingsRow('message-context')}
        tabIndex={-1}
      >
        {contextProviders.length > 0 && (
          <>
            <div className="context-provider-section__label">
              {settingsRow('message-context').title}
            </div>
            {contextProviders.map((provider) => (
              <SettingsToggle
                key={provider.id}
                className="settings__feature-toggle"
                checked={provider.enabled}
                onChange={() => toggleProvider(provider.id)}
                label={provider.name}
              >
                <div>
                  <div className="settings__toggle-name">{provider.name}</div>
                  {provider.description && (
                    <div className="settings__toggle-detail">
                      {provider.description}
                    </div>
                  )}
                </div>
              </SettingsToggle>
            ))}
          </>
        )}
      </div>

      <div>
        {FEATURE_META.map((feature) => (
          <div
            key={feature.key}
            {...settingsRow(feature.catalogId)}
            tabIndex={-1}
          >
            <FeatureToggle
              featureKey={feature.key}
              label={settingsRow(feature.catalogId).title}
              description={feature.description}
              privacyNote={feature.privacyNote}
              checked={settings[feature.key]}
              onToggle={toggle}
            />
          </div>
        ))}
      </div>

      {settings.mobilePairingEnabled && <MobilePairingSection />}

      <span className="form-help settings__form-help-block">
        Voice service selection and context settings are saved in this browser
        only. Install plugins to add ElevenLabs or Nova Sonic services.
      </span>
    </SettingsSection>
  );
}

/**
 * `guard` is `SettingsView.tsx`'s own `useUnsavedGuard` guard (
 * finding, 1) — the "View the notifications inbox" cross-link
 * below must route through it like every other navigation trigger on a page
 * with dirty state.
 */
export function NotificationsSection({
  apiBase,
  guard,
}: {
  apiBase: string;
  guard: (callback: () => void) => void;
}) {
  const { navigate } = useNavigation();
  const { settings: featureSettings, toggle: toggleFeature } =
    useFeatureSettings();

  return (
    <SettingsSection icon="◉" title="Notifications" id="section-notifications">
      <div {...settingsRow('push-notifications')} tabIndex={-1}>
        <SettingsToggle
          className="settings__toggle-row"
          checked={featureSettings.pushNotificationsEnabled}
          onChange={() => toggleFeature('pushNotificationsEnabled')}
          describedBy="notif-desc"
          label={settingsRow('push-notifications').title}
        >
          <div>
            <div className="settings__toggle-label">
              {settingsRow('push-notifications').title}
            </div>
            <div className="settings__toggle-desc" id="notif-desc">
              Browser push notifications for tool approvals and high-priority
              alerts
            </div>
          </div>
        </SettingsToggle>
        {featureSettings.pushNotificationsEnabled && (
          <NotificationSubscribeButton apiBase={apiBase} />
        )}
        <NotificationSoundSettings />
        <button
          type="button"
          className="button button--link settings__notifications-inbox-link"
          onClick={() => guard(() => navigate('/notifications'))}
        >
          View the notifications inbox
        </button>
      </div>
    </SettingsSection>
  );
}
