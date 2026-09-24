import { CheckGlyph, MicGlyph } from '../../components/icons/Glyph';
import { useMessageContextContext } from '../../contexts/MessageContextContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useVoiceProviderContext } from '../../contexts/VoiceProviderContext';
import type { BooleanFeatureSetting } from '../../hooks/useFeatureSettings';
import { useFeatureSettings } from '../../hooks/useFeatureSettings';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { AgentActivitySetting } from './AgentActivitySetting';
import { FeatureToggle, SettingsToggle } from './feature-toggle';
import { NotificationSoundSettings } from './NotificationSoundSettings';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

// The `key` literals here trip gitleaks' generic-api-key rule, and the
//gitleaks.toml allowlist for this file only masks identifiers matching
// ^[a-z][A-Za-z0-9]{2,40}Enabled$ — a new key NOT ending in `Enabled` will
// fail the secret scan until that regex is widened alongside it.
const FEATURE_META: Array<{
  catalogId: 'voice-pill' | 'tts-readback';
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
    catalogId: 'tts-readback',
    key: 'ttsReadbackEnabled',
    description:
      'Automatically reads the latest assistant response via the selected TTS provider after each reply.',
  },
];

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
    <SettingsSection icon={<MicGlyph />} title="Voice" id="section-voice">
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

      <span className="form-help settings__form-help-block">
        Voice service selection and context settings are saved in this browser
        only. Install plugins to add ElevenLabs or Nova Sonic services.
      </span>
    </SettingsSection>
  );
}

export function NotificationsSection({ apiBase }: { apiBase: string }) {
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
        {/* Native (FCM) delivery to the Android app. Independent of the browser
            push switch above, which a WebView cannot use. */}
        <AgentActivitySetting />
        <NotificationSoundSettings />
        <button
          type="button"
          className="button button--link settings__notifications-inbox-link"
          onClick={() => navigate('/notifications')}
        >
          View the notifications inbox
        </button>
      </div>
    </SettingsSection>
  );
}
