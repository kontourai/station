import { useConnections } from '@kontourai/station-connect';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import {
  type AgentActivityController,
  type AgentActivityEnableOutcome,
  describeAgentActivityError,
} from '../../platform/native/agentActivity';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { SettingsToggle } from './feature-toggle';

type LoadController = () => Promise<AgentActivityController | null>;

const loadAgentActivityController: LoadController = () =>
  import('../../platform/native/agentActivityRuntime').then((module) =>
    module.agentActivityController(),
  );

const STATUS_QUERY_KEY = ['native', 'agent-activity-status'] as const;

/**
 * "Agent activity on this phone": the Android app's Live Update card, or the
 * iOS app's Live Activity, for the active Station. Renders nothing unless
 * this is the Android or iOS app and its host reports `remote-push` as
 * enabled: an Android build carrying a push configuration, or an iOS build
 * with the Live Activity half. On iOS, while this Station is off, it also
 * stays hidden until the plugin says the build is signed for push on an OS
 * with Live Activities, since nothing else there could ever turn it on. A
 * Station that is already on stays visible so it can be turned off.
 */
export function AgentActivitySetting({
  loadController = loadAgentActivityController,
}: {
  loadController?: LoadController;
}) {
  const { target } = usePlatformProfile();
  const phoneApp = target === 'android' || target === 'ios';
  const [controller, setController] = useState<AgentActivityController | null>(
    null,
  );
  useEffect(() => {
    // Only the phone plugins exist; nothing else is worth loading.
    if (!phoneApp) return;
    let live = true;
    loadController().then(
      (loaded) => {
        if (live) setController(loaded);
      },
      () => {
        if (live) setController(null);
      },
    );
    return () => {
      live = false;
    };
  }, [phoneApp, loadController]);
  if (!phoneApp || !controller) return null;
  return (
    <AgentActivityControl controller={controller} iosApp={target === 'ios'} />
  );
}

function AgentActivityControl({
  controller,
  iosApp,
}: {
  controller: AgentActivityController;
  iosApp: boolean;
}) {
  const { apiBase, activeConnection } = useConnections();
  const environmentId = activeConnection?.environmentId ?? null;
  const queryClient = useQueryClient();
  // The registration is device-local state the controller owns; re-read it
  // for the active Station and after every change.
  const [registration, setRegistration] = useState<ReturnType<
    AgentActivityController['registration']
  > | null>(null);
  const readRegistration = useCallback(() => {
    setRegistration(
      environmentId ? controller.registration(environmentId) : null,
    );
  }, [controller, environmentId]);
  useEffect(readRegistration, [readRegistration]);

  const status = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => controller.status(),
    // The person may come back from Android settings having changed either
    // switch; read the phone again rather than trusting an old answer.
    refetchOnWindowFocus: 'always',
    staleTime: 0,
    retry: false,
  });

  const settle = () => {
    readRegistration();
    void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
  };

  const [outcome, setOutcome] = useState<
    AgentActivityEnableOutcome['status'] | null
  >(null);
  const change = useMutation({
    mutationFn: async (turnOn: boolean) => {
      if (!environmentId) throw new Error('Connect to a Station first.');
      const target = { environmentId, apiBase };
      if (!turnOn) {
        await controller.disable(target);
        return null;
      }
      return (await controller.enable(target)).status;
    },
    onMutate: () => setOutcome(null),
    onSuccess: (result) => setOutcome(result),
    onSettled: settle,
  });

  const openSettings = useMutation({
    mutationFn: () => controller.openLiveUpdateSettings(),
  });

  const on = registration !== null;
  const phone = status.data;
  const iosUnavailable =
    phone?.platform === 'ios' &&
    (!phone.pushConfigured || !phone.liveActivitiesSupported);
  // iOS: without a push-signed build on iOS 18 there is nothing to offer,
  // so show nothing rather than a switch that can never turn on — unless
  // this Station is already on, which must stay visible so it can be turned
  // off. A status that failed still renders, so its error is seen.
  if (iosApp && !on && (status.isPending || iosUnavailable)) return null;
  const android = phone?.platform !== 'ios' ? phone : undefined;
  const ios = phone?.platform === 'ios' ? phone : undefined;
  // On iOS a build without push is `iosUnavailable` above; the outcome is
  // still reachable if `push_token` disagrees with `status`.
  const unconfigured =
    outcome === 'unconfigured' || (!ios && phone?.pushConfigured === false);
  const notificationsOff =
    outcome === 'notifications-disabled' ||
    (on && android?.notificationsEnabled === false);
  const promotionOff =
    on && android?.liveUpdatesSupported === true && !android.promotionAllowed;
  const liveActivitiesOff =
    outcome === 'live-activities-disabled' ||
    (on && ios?.liveActivitiesEnabled === false);

  return (
    <div className="settings__notif-subscribe" data-testid="agent-activity">
      <SettingsToggle
        className="settings__toggle-row"
        checked={on}
        disabled={change.isPending || !environmentId || (!on && unconfigured)}
        onChange={() => change.mutate(!on)}
        describedBy="agent-activity-desc"
        label="Agent activity on this phone"
      >
        <div>
          <div className="settings__toggle-label">
            Agent activity on this phone
          </div>
          <div className="settings__toggle-desc" id="agent-activity-desc">
            Shows running agents, and anything waiting on you, in a card on this
            phone even when Station is closed.
          </div>
        </div>
      </SettingsToggle>
      {!environmentId && (
        <div className="settings__toggle-desc">
          Connect to a Station to turn this on.
        </div>
      )}
      {unconfigured && (
        <div className="settings__toggle-desc">
          This build has no push configuration.
        </div>
      )}
      {notificationsOff && (
        <div className="settings__notif-error">
          Notifications for Station are off. Turn them on in Android settings.
        </div>
      )}
      {promotionOff && (
        <div className="settings__notif-subscribed">
          <span className="settings__toggle-desc">
            Live Updates are off, so the card stays in the notification shade.
          </span>
          <Button
            size="sm"
            pending={openSettings.isPending}
            onClick={() => openSettings.mutate()}
          >
            Allow Live Updates
          </Button>
        </div>
      )}
      {on && iosUnavailable && (
        <div className="settings__toggle-desc">
          This build can no longer show Live Activities. Turn this off to stop
          the Station sending them.
        </div>
      )}
      {liveActivitiesOff && (
        <div className="settings__notif-subscribed">
          <span className="settings__toggle-desc">
            Live Activities are off for Station. Turn them on in Settings.
          </span>
          <Button
            size="sm"
            pending={openSettings.isPending}
            onClick={() => openSettings.mutate()}
          >
            Open Settings
          </Button>
        </div>
      )}
      {change.error && (
        <div className="settings__notif-error" role="alert">
          {describeAgentActivityError(change.error)}
        </div>
      )}
      {status.error && (
        <div className="settings__notif-error" role="alert">
          {describeAgentActivityError(status.error)}
        </div>
      )}
    </div>
  );
}
