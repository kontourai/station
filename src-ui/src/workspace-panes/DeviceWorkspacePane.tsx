import type {
  LiveSurfaceDeviceButton,
  LiveSurfaceOrientation,
} from '@kontourai/station-contracts/live-surface';
import type {
  DeviceHostSummary,
  MobileDevicePlatform,
  MobileDeviceSession,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import {
  useCloseMobileDeviceSessionMutation,
  useMobileDeviceHostsQuery,
  useMobileDeviceInventoryQuery,
  useMobileDeviceSessionsQuery,
  useOpenMobileDeviceSessionMutation,
  usePowerOffMobileDeviceMutation,
  useStartMobileDeviceMutation,
} from '@kontourai/station-sdk/mobile-devices-query';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { CloseGlyph, HomeGlyph } from '../components/icons/Glyph';
import { LazyBoundary } from '../components/LazyBoundary';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { deviceFloatSourceKey } from '../float-over-chat/floatSource';
import {
  requestFloat,
  useFloatHostAvailable,
} from '../float-over-chat/floatStore';
import { useAnnounceShownSource } from '../float-over-chat/shownSources';
import { useActiveProject } from '../hooks/useActiveProject';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceHeaderApi,
} from '../live-surface/LiveSurfaceCanvas';
import { DeviceSetupSlot } from './DeviceSetupSlot';
import {
  type DevicePaneSelection,
  onDevicePaneSelection,
} from './device/devicePaneSelection';
import {
  DEVICE_PLACEHOLDER_ASPECT,
  deviceCornerRadius,
  deviceOsLabel,
} from './device/deviceScreen';
import {
  BackGlyph,
  FloatGlyph,
  PowerGlyph,
  RecentsGlyph,
  RotateGlyph,
  StopGlyph,
  ToolsGlyph,
} from './deviceGlyphs';
import {
  DEVICE_HOST_FAILURE_COPY,
  type DeviceOutcomeCopy,
  describeDeviceActionFailure,
} from './deviceOutcome';
import {
  clearDevicePaneState,
  devicePaneStorage,
  readDevicePaneState,
  writeDevicePaneState,
} from './devicePaneStateStorage';
import './DeviceWorkspacePane.css';

// The Tools drawer and the accessibility overlay (#1971) load on first use:
// most device sessions never open them.
const loadDeviceToolsDrawer = () =>
  import('./device/DeviceToolsDrawer').then(({ DeviceToolsDrawer }) => ({
    default: DeviceToolsDrawer,
  }));
const loadDeviceAccessibilityOverlay = () =>
  import('./device/DeviceToolsDrawer').then(
    ({ DeviceAccessibilityOverlay }) => ({
      default: DeviceAccessibilityOverlay,
    }),
  );

/**
 * Below this container width the Tools drawer overlays the device stage;
 * at or above it the drawer docks as a 288px column beside it (t3code's
 * DevicePanel, `@[560px]`).
 */
export const DEVICE_TOOLS_DOCK_MIN_WIDTH = 560;

export function deviceToolsLayout(width: number): 'overlay' | 'docked' {
  return width >= DEVICE_TOOLS_DOCK_MIN_WIDTH ? 'docked' : 'overlay';
}

/** The element's measured width, kept current by a ResizeObserver. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * A live simulator or emulator, as a dock pane (#1969 → #1970, D8).
 *
 * The device's screen streams through Station's live surface — the same
 * primitive as the Browser pane: one control lease, human takeover, the
 * wedge and liveness states, one canvas. Taps, keys and the hardware
 * buttons in the toolbar are CONTROL input and go through that lease.
 *
 * Journeys:
 * - Pick a device (iOS Simulators and Android Emulators, running first). A
 *   running device offers Open; a stopped one offers Start, which boots it
 *   ("Starting X… This can take a minute") and then opens it.
 * - Opening is two steps, and the pane says which one it is on: "open
 *   device" (the server session) then "connect video" (the first frame).
 * - The toolbar sends Home, plus Back and Recents on Android or Rotate on
 *   iOS. Power off shuts the device down; Close only stops watching.
 * - Video and input are shown separately: a picture that keeps streaming
 *   while input reconnects says so, and the buttons pause.
 *
 * Adapted in shape from t3code's device panel (apps/web/src/components/
 * device/DevicePanel.tsx, DeviceStreamView.tsx, DeviceLoadingView.tsx;
 * MIT License, Copyright (c) 2026 T3 Tools Inc.).
 *
 * One Device pane per region set: which device it shows is pane STATE, not
 * pane identity. Instance-keyed panes (#2049's prefix mechanism) could hold
 * two devices side by side, but only with an entry point that opens a
 * second occurrence and per-occurrence state keys; that is recorded as a
 * follow-up rather than half-built here.
 */
export function DeviceWorkspacePane() {
  const requestScope = useHostRequestAuthorityScope();
  const previousAuthority = useRef(requestScope);

  // When the selected Station or its authority changes, the previous one's
  // remembered device goes with it.
  useEffect(() => {
    const previous = previousAuthority.current;
    if (
      previous &&
      (!requestScope ||
        previous.apiBase !== requestScope.apiBase ||
        previous.authorityKey !== requestScope.authorityKey)
    )
      clearDevicePaneState(devicePaneStorage(), previous);
    previousAuthority.current = requestScope;
  }, [requestScope]);

  if (!requestScope)
    return (
      <section className="device-pane" role="alert">
        Devices are unavailable until this Station is authorized.
      </section>
    );
  // Keyed on the authority so React UNMOUNTS the surface (and its stream)
  // when it changes.
  return (
    <DeviceWorkspacePaneSurface
      key={JSON.stringify([requestScope.apiBase, requestScope.authorityKey])}
      requestScope={requestScope}
    />
  );
}

const PLATFORM_LABEL = { ios: 'iOS', android: 'Android' } as const;

const osLabel = deviceOsLabel;

/**
 * The device host a session runs on (D13): `local` is this Station; an SSH
 * device host (#1973) by the label the operator gave it.
 */
function hostLabel(
  hostId: string,
  hosts: readonly DeviceHostSummary[] | undefined,
): string {
  if (hostId === 'local') return 'Local';
  return hosts?.find((host) => host.hostId === hostId)?.label ?? hostId;
}

export { DEVICE_PLACEHOLDER_ASPECT, deviceCornerRadius };

/**
 * How long a pane asked to show a device (the float's "Open in right panel")
 * waits for its session to appear in a list read, re-reading every second.
 */
export const DEVICE_SELECTION_WAIT_MS = 10_000;
const DEVICE_SELECTION_RETRY_MS = 1_000;

/** How long a Start may take before the pane says it did not finish. */
const DEVICE_START_LIMIT_MS = 5 * 60_000;

/** The iOS Rotate button turns a quarter clockwise from where it is now. */
const NEXT_ORIENTATION: Record<LiveSurfaceOrientation, LiveSurfaceOrientation> =
  {
    portrait: 'landscape-left',
    'landscape-left': 'portrait-upside-down',
    'portrait-upside-down': 'landscape-right',
    'landscape-right': 'portrait',
  };

/** Platform hints for an empty group: what to install or create. */
const EMPTY_GROUP: Record<
  MobileDevicePlatform,
  { label: string; hint: string }
> = {
  ios: {
    label: 'No iOS simulators found.',
    hint: 'Install Xcode and an iOS Simulator runtime (Xcode › Settings › Components), then refresh.',
  },
  android: {
    label: 'No Android emulators found.',
    hint: "Create an emulator (an AVD) in Android Studio's Device Manager, then refresh.",
  },
};

const GROUP_TITLE: Record<MobileDevicePlatform, string> = {
  ios: 'iOS Simulators',
  android: 'Android Emulators',
};

function targetOf(device: {
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
}): MobileDeviceTarget {
  return {
    hostId: device.hostId,
    platform: device.platform,
    deviceId: device.deviceId,
  };
}

type Pending = {
  device: MobileDeviceSummary;
  phase: 'starting' | 'opening';
};

function DeviceWorkspacePaneSurface({
  requestScope,
}: {
  requestScope: { apiBase: string; authorityKey: string };
}) {
  // D12: device shares are per Project. Every device request names the
  // Project this pane is in, so a Project admin reaches the devices the
  // operator shared with it; the operator needs none and loses nothing.
  const projectSlug = useActiveProject().projectSlug;
  // #1973: which device host the pane shows. Every request names it; the
  // picker appears only when the operator has added SSH device hosts.
  const [hostId, setHostId] = useState<string>(
    () =>
      readDevicePaneState(devicePaneStorage(), requestScope)?.hostId ?? 'local',
  );
  const hosts = useMobileDeviceHostsQuery(requestScope, projectSlug);
  const [booting, setBooting] = useState<{
    device: MobileDeviceSummary;
    since: number;
    /** A read has shown the row `starting` (so its end means done). */
    seenStarting?: boolean;
  } | null>(null);
  // `starting` is a transient the server reports while a Start's boot call
  // is still out — for iOS, even on a read that already lists the device
  // `booted` (LIVE-1). The boot poll ends on that read (the device is
  // running, so it opens), so the list is also polled while ANY row of the
  // last read is `starting`; otherwise that read is what the list shows
  // ("Opening…", disabled) until someone refreshes by hand.
  const [listStarting, setListStarting] = useState(false);
  const inventory = useMobileDeviceInventoryQuery(
    requestScope,
    booting || listStarting ? { refetchInterval: 2_000 } : undefined,
    projectSlug,
    hostId,
  );
  const anyStarting =
    inventory.data?.devices.some((device) => device.starting === true) ?? false;
  useEffect(() => setListStarting(anyStarting), [anyStarting]);
  const sessions = useMobileDeviceSessionsQuery(
    requestScope,
    projectSlug,
    undefined,
    hostId,
  );
  const start = useStartMobileDeviceMutation(requestScope, projectSlug, hostId);
  const open = useOpenMobileDeviceSessionMutation(
    requestScope,
    projectSlug,
    hostId,
  );
  const close = useCloseMobileDeviceSessionMutation(
    requestScope,
    projectSlug,
    hostId,
  );
  const powerOff = usePowerOffMobileDeviceMutation(
    requestScope,
    projectSlug,
    hostId,
  );

  const [active, setActive] = useState<{
    session: MobileDeviceSession;
    since: number;
  } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<DeviceOutcomeCopy | null>(null);
  const [ended, setEnded] = useState<string | null>(null);

  // Rejoin the remembered device's session when this pane mounts and one is
  // open (D6: a session outlives the pane that opened it).
  const rejoined = useRef(false);
  useEffect(() => {
    if (rejoined.current || active || !sessions.data) return;
    rejoined.current = true;
    const stored = readDevicePaneState(devicePaneStorage(), requestScope);
    if (!stored) return;
    const session = sessions.data.find(
      (candidate) =>
        candidate.hostId === stored.hostId &&
        candidate.platform === stored.platform &&
        candidate.deviceId === stored.deviceId,
    );
    if (session) setActive({ session, since: Date.now() });
  }, [active, sessions.data, requestScope]);

  // #90 D9: the float-over-chat's "Open in right panel" asks this (already
  // mounted) pane to show a device. Its session may not be in the list this
  // pane last read, so the list is read again until it is — within a bound,
  // after which the pane says so rather than waiting silently.
  const [selection, setSelection] = useState<{
    target: DevicePaneSelection;
    since: number;
    /** The Project the pane was in when asked (a change ends the wait). */
    projectSlug: string | null;
  } | null>(null);
  const projectRef = useRef(projectSlug);
  projectRef.current = projectSlug;
  useEffect(
    () =>
      onDevicePaneSelection((target) => {
        setFailure(null);
        setEnded(null);
        setBooting(null);
        setHostId(target.hostId);
        setActive(null);
        setSelection({
          target,
          since: Date.now(),
          projectSlug: projectRef.current,
        });
      }),
    [],
  );
  // The session appearing in ANY read ends the wait.
  useEffect(() => {
    if (!selection) return;
    const { target } = selection;
    const session = sessions.data?.find(
      (candidate) =>
        candidate.hostId === target.hostId &&
        candidate.platform === target.platform &&
        candidate.deviceId === target.deviceId,
    );
    if (!session) return;
    setSelection(null);
    setActive({ session, since: Date.now() });
  }, [selection, sessions.data]);
  // The re-read and the give-up run on their own clock, independent of what
  // each read returns: a read that FAILS changes no data, and must neither
  // stop the re-reads nor keep the bound from ever firing.
  const refetchSessions = sessions.refetch;
  useEffect(() => {
    if (!selection) return;
    const timer = setInterval(() => {
      if (Date.now() - selection.since >= DEVICE_SELECTION_WAIT_MS) {
        setSelection(null);
        setFailure({
          title: 'That device is not open here',
          description:
            'Its session was not found on this device host. It may have ended; open the device again from the list.',
        });
        return;
      }
      void refetchSessions();
    }, DEVICE_SELECTION_RETRY_MS);
    return () => clearInterval(timer);
  }, [selection, refetchSessions]);
  // The person moved to another host or Project while waiting: the wait
  // was for THAT host and Project, so it ends quietly rather than reporting
  // "not open here" about a place they left.
  useEffect(() => {
    if (!selection) return;
    if (
      hostId !== selection.target.hostId ||
      projectSlug !== selection.projectSlug
    )
      setSelection(null);
  }, [hostId, projectSlug, selection]);

  // A session that disappears from a list read AFTER it was opened has
  // ended elsewhere (closed, powered off, the device stopped).
  useEffect(() => {
    if (!active || !sessions.data) return;
    if (sessions.dataUpdatedAt <= active.since) return;
    if (
      !sessions.data.some(
        (candidate) => candidate.sessionId === active.session.sessionId,
      )
    ) {
      setEnded(active.session.name);
      setActive(null);
    }
  }, [active, sessions.data, sessions.dataUpdatedAt]);

  /** Open (or join) the session on a RUNNING device. */
  async function openRunning(device: MobileDeviceSummary) {
    try {
      setPending({ device, phase: 'opening' });
      const session = await open.mutateAsync(targetOf(device));
      writeDevicePaneState(devicePaneStorage(), requestScope, session);
      setActive({ session, since: Date.now() });
    } catch (error) {
      setFailure(describeDeviceActionFailure(error, device.name));
    } finally {
      setPending(null);
    }
  }

  async function openDevice(device: MobileDeviceSummary) {
    setFailure(null);
    setEnded(null);
    if (device.booted) {
      await openRunning(device);
      return;
    }
    // Start answers at once; a cold boot finishes in the background and the
    // list is polled until the device is running (see the effect below).
    setPending({ device, phase: 'starting' });
    try {
      const started = await start.mutateAsync(targetOf(device));
      if (started.state === 'running')
        await openRunning({
          ...device,
          deviceId: started.deviceId,
          booted: true,
        });
      else setBooting({ device, since: Date.now() });
    } catch (error) {
      setFailure(describeDeviceActionFailure(error, device.name));
      setPending(null);
    }
  }

  // A device booting in the background: when the list shows it running,
  // open it. iOS keeps its UDID (and simulator NAMES repeat across
  // runtimes), so iOS matches by id; an Android emulator reappears under
  // its serial, so it matches by AVD name, which is unique. A failure is
  // reported as soon as a read shows it: the server's `startError`, or a
  // Start that was seen booting and is now neither booting nor running.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-evaluated on each list read; openRunning is a one-shot call.
  useEffect(() => {
    if (!booting || !inventory.data) return;
    const { device } = booting;
    const running = inventory.data.devices.find(
      (row) =>
        row.platform === device.platform &&
        row.booted &&
        (device.platform === 'ios'
          ? row.deviceId === device.deviceId
          : row.name === device.name),
    );
    if (running) {
      setBooting(null);
      void openRunning(running);
      return;
    }
    const row = inventory.data.devices.find(
      (candidate) =>
        candidate.platform === device.platform &&
        candidate.deviceId === device.deviceId,
    );
    if (row?.starting && !booting.seenStarting) {
      setBooting({ ...booting, seenStarting: true });
      return;
    }
    const failedNow =
      row?.startError !== undefined ||
      (booting.seenStarting && row !== undefined && !row.starting);
    if (failedNow) {
      setBooting(null);
      setPending(null);
      setFailure({
        title: `${device.name} did not start`,
        description:
          row?.startError === 'hub-unavailable'
            ? 'The device helper did not answer while starting it. Check that it is running, then try again.'
            : 'Starting it failed. Check the device (for example, free disk space), then try again.',
      });
      return;
    }
    if (Date.now() - booting.since > DEVICE_START_LIMIT_MS) {
      setBooting(null);
      setPending(null);
      setFailure({
        title: `${booting.device.name} did not finish starting`,
        description:
          'It was still not running after several minutes. Check the device, then refresh devices and try again.',
      });
    }
  }, [booting, inventory.data]);

  /** "End for everyone" (the operator's): the session ends for every viewer. */
  async function endForEveryone(session: MobileDeviceSession) {
    setFailure(null);
    try {
      await close.mutateAsync(session.sessionId);
      setActive(null);
    } catch (error) {
      setFailure(describeDeviceActionFailure(error, session.name));
    }
  }

  async function powerOffDevice(session: MobileDeviceSession) {
    setFailure(null);
    try {
      await powerOff.mutateAsync(targetOf(session));
      setActive(null);
    } catch (error) {
      setFailure(describeDeviceActionFailure(error, session.name));
    }
  }

  async function reconnect(session: MobileDeviceSession) {
    setFailure(null);
    try {
      const next = await open.mutateAsync(targetOf(session));
      setActive({ session: next, since: Date.now() });
    } catch (error) {
      setFailure(describeDeviceActionFailure(error, session.name));
    }
  }

  // Whether this caller may start, power off, or end a session for everyone
  // (the operator, D12). A server that does not say is treated as yes; the
  // routes refuse a caller who may not either way.
  const canManage = inventory.data?.canManageDevices !== false;

  const failureCard = failure ? (
    <ErrorState
      variant="compact"
      title={failure.title}
      description={failure.description}
    />
  ) : null;

  if (active)
    return (
      <div className="device-pane device-pane--live">
        {failureCard}
        <DeviceStage
          hostLabel={hostLabel(active.session.hostId, hosts.data)}
          projectSlug={projectSlug}
          requestScope={requestScope}
          canManage={canManage}
          ending={close.isPending}
          // Close only detaches THIS viewer: the session stays listed for
          // others and ends by itself once nobody watches it.
          onClose={() => setActive(null)}
          onEndForEveryone={() => void endForEveryone(active.session)}
          onPowerOff={() => void powerOffDevice(active.session)}
          onReconnect={() => void reconnect(active.session)}
          poweringOff={powerOff.isPending}
          reconnecting={open.isPending}
          session={active.session}
        />
      </div>
    );

  // The host picker (#1973): only when there is more than one host.
  const hostPicker =
    (hosts.data?.length ?? 0) > 1 ? (
      <DeviceHostPicker
        hostId={hostId}
        hosts={hosts.data ?? []}
        onPick={(next) => {
          if (next === hostId) return;
          setFailure(null);
          setEnded(null);
          setBooting(null);
          setHostId(next);
        }}
      />
    ) : null;

  if (inventory.isLoading)
    return (
      <div className="device-pane">
        {hostPicker}
        <SkeletonBlock count={3} label="Reading the device list" />
      </div>
    );

  if (inventory.isError)
    return (
      <div className="device-pane">
        {hostPicker}
        <ErrorState
          variant="compact"
          title="The device list could not be read"
          description={describeReadFailure(inventory.error)}
          action={
            <Button size="sm" onClick={() => void inventory.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );

  const state = inventory.data?.state;
  const hostFailure = inventory.data?.failure;
  if (state === 'unavailable' && hostFailure) {
    if (hostFailure === 'not-configured' && hostId !== 'local')
      return (
        <div className="device-pane">
          {hostPicker}
          <Empty
            variant="compact"
            label="Devices are not set up on this host"
            description="The Station operator enables the device hub on an SSH host in Settings › Device hosts."
          />
        </div>
      );
    if (hostFailure === 'not-configured')
      return (
        <div className="device-pane">
          {hostPicker}
          <DeviceSetupSlot failure={hostFailure} requestScope={requestScope} />
        </div>
      );
    const copy = DEVICE_HOST_FAILURE_COPY[hostFailure];
    return (
      <div className="device-pane">
        {hostPicker}
        <ErrorState
          variant="compact"
          title={copy.title}
          description={copy.description}
          action={
            <Button size="sm" onClick={() => void inventory.refetch()}>
              Refresh devices
            </Button>
          }
        />
      </div>
    );
  }

  const devices = inventory.data?.devices ?? [];
  const openDeviceIds = new Set(
    (sessions.data ?? []).map(
      (session) => `${session.platform}:${session.deviceId}`,
    ),
  );

  return (
    <div className="device-pane">
      {ended ? (
        <p className="device-pane__note" role="status">
          The session on {ended} ended.
        </p>
      ) : null}
      {failureCard}
      {hostPicker}
      {pending ? <DeviceLoading pending={pending} /> : null}
      <div className="device-pane__picker-header">
        <h2 className="device-pane__picker-title">Devices</h2>
        <div className="device-pane__picker-actions">
          <Button
            size="sm"
            onClick={() => {
              void inventory.refetch();
              void sessions.refetch();
            }}
            pending={inventory.isFetching}
            pendingLabel="Refreshing…"
          >
            Refresh devices
          </Button>
        </div>
      </div>
      {state === 'partial' ? (
        <p className="device-pane__note">
          Some device sources did not answer, so this list may be incomplete.
        </p>
      ) : null}
      {(['ios', 'android'] as const).map((platform) => (
        <DeviceGroup
          devices={devices.filter((device) => device.platform === platform)}
          key={platform}
          onOpen={(device) => void openDevice(device)}
          openDeviceIds={openDeviceIds}
          pending={pending}
          platform={platform}
        />
      ))}
    </div>
  );
}

/**
 * Which device host the pane lists (#1973). A group of toggle buttons: a
 * handful of hosts at most, each a 44px target, the current one pressed.
 */
function DeviceHostPicker({
  hosts,
  hostId,
  onPick,
}: {
  hosts: readonly DeviceHostSummary[];
  hostId: string;
  onPick: (hostId: string) => void;
}) {
  return (
    <fieldset className="device-pane__hosts">
      <legend className="device-pane__hosts-legend">Device host</legend>
      <div className="device-pane__hosts-options">
        {hosts.map((host) => (
          <Button
            aria-pressed={host.hostId === hostId}
            className="device-pane__host"
            key={host.hostId}
            onClick={() => onPick(host.hostId)}
            size="sm"
            variant={host.hostId === hostId ? 'primary' : 'secondary'}
          >
            {host.kind === 'local' ? 'This Station' : host.label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

function DeviceGroup({
  platform,
  devices,
  openDeviceIds,
  pending,
  onOpen,
}: {
  platform: MobileDevicePlatform;
  devices: MobileDeviceSummary[];
  openDeviceIds: ReadonlySet<string>;
  /** The device being started or opened; its row shows the spinner. */
  pending: Pending | null;
  onOpen: (device: MobileDeviceSummary) => void;
}) {
  const headingId = `device-group-${platform}`;
  // The host already orders the list; keep running devices first even if a
  // reader of an older host did not.
  const ordered = [...devices].sort(
    (a, b) => Number(b.booted) - Number(a.booted),
  );
  return (
    <section aria-labelledby={headingId} className="device-pane__group">
      <h3 className="device-pane__group-title" id={headingId}>
        {GROUP_TITLE[platform]}
      </h3>
      {ordered.length === 0 ? (
        <Empty
          variant="compact"
          label={EMPTY_GROUP[platform].label}
          description={EMPTY_GROUP[platform].hint}
        />
      ) : (
        <ul className="device-pane__rows">
          {ordered.map((device) => {
            const id = `${device.platform}:${device.deviceId}`;
            const inSession = openDeviceIds.has(id);
            const busy =
              pending?.device.platform === device.platform &&
              pending.device.deviceId === device.deviceId;
            return (
              <li className="device-pane__row" key={id}>
                <span className="device-pane__row-name">{device.name}</span>
                <span className="device-pane__row-meta">
                  {PLATFORM_LABEL[device.platform]} · {device.runtime} ·{' '}
                  {device.booted ? 'Running' : 'Stopped'}
                  {inSession ? ' · Open in a session' : ''}
                </span>
                {/* D12: every listed device is one this caller may start
                    (the operator, or an admin it is shared with). */}
                <div className="device-pane__row-actions">
                  <Button
                    aria-label={`${device.booted ? 'Open' : 'Start'} ${device.name}`}
                    // One device at a time: a second boot while one is
                    // under way would race it for the host.
                    disabled={pending !== null && !busy}
                    onClick={() => onOpen(device)}
                    pending={busy || device.starting === true}
                    pendingLabel={device.booted ? 'Opening…' : 'Starting…'}
                    size="sm"
                    variant={device.booted ? 'primary' : 'secondary'}
                  >
                    {device.booted ? 'Open' : 'Start'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DeviceLoading({ pending }: { pending: Pending }) {
  const { device, phase } = pending;
  const line =
    phase === 'starting'
      ? `Starting ${device.name}… This can take a minute.`
      : 'Step 1 of 2: open device';
  return (
    <div className="device-pane__loading">
      <p className="device-pane__loading-line" role="status">
        {line}
      </p>
      <SkeletonBlock
        className="device-pane__loading-stage"
        count={1}
        label={line}
      />
    </div>
  );
}

function DeviceStage({
  requestScope,
  hostLabel,
  projectSlug,
  session,
  canManage,
  ending,
  poweringOff,
  reconnecting,
  onClose,
  onEndForEveryone,
  onPowerOff,
  onReconnect,
}: {
  requestScope: { apiBase: string; authorityKey: string };
  /** The device host's display name (#1973). */
  hostLabel: string;
  projectSlug: string | null;
  session: MobileDeviceSession;
  canManage: boolean;
  ending: boolean;
  poweringOff: boolean;
  reconnecting: boolean;
  onClose: () => void;
  onEndForEveryone: () => void;
  onPowerOff: () => void;
  onReconnect: () => void;
}) {
  const platform = session.platform;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const layout = deviceToolsLayout(useElementWidth(workspaceRef));
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const toolsDrawerId = useId();
  // Closing the drawer (its Close, Escape, or the Tools toggle) returns
  // focus to the Tools button, so a keyboard user is not dropped on <body>.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !toolsOpen) toolsButtonRef.current?.focus();
    wasOpen.current = toolsOpen;
  }, [toolsOpen]);
  const [axOverlay, setAxOverlay] = useState(false);
  const [streamLive, setStreamLive] = useState(false);
  const target = {
    hostId: session.hostId,
    platform,
    deviceId: session.deviceId,
  };
  // #90 D9: while this device is on screen here, the float-over-chat hides
  // it (and so never streams it a second time).
  const stageRef = useRef<HTMLDivElement>(null);
  useAnnounceShownSource(deviceFloatSourceKey(target), stageRef);
  // "Float over chat": a chat's floater takes it, and this pane lets go of
  // it (only this viewer's view — the session stays open), so the float,
  // hidden while a pane shows the device, appears.
  const floatAvailable = useFloatHostAvailable();
  // Let go only once a chat has TAKEN it: until then this pane keeps
  // showing the device. The float reads it under this pane's Project (the
  // one the person is viewing it from), and says so in the chat if it
  // cannot show it there.
  const floatOverChat = () => {
    requestFloat(
      {
        kind: 'device',
        hostId: session.hostId,
        platform,
        deviceId: session.deviceId,
        surfaceId: session.surfaceId,
        projectSlug,
        name: session.name,
      },
      onClose,
    );
  };
  const canvas = (
    <LiveSurfaceCanvas
      apiBase={requestScope.apiBase}
      fit={{
        aspect: DEVICE_PLACEHOLDER_ASPECT[platform],
        cornerRadius: (box) => deviceCornerRadius(platform, box),
      }}
      key={session.surfaceId}
      {...(projectSlug ? { projectSlug } : {})}
      label={`${session.name} (${osLabel(session)})`}
      params={{ maxFps: 15, quality: 70, maxWidth: 1600, maxHeight: 1600 }}
      renderHeader={(api) => (
        <DeviceToolbar
          api={api}
          hostLabel={hostLabel}
          canManage={canManage}
          ending={ending}
          floatAvailable={floatAvailable}
          onFloat={floatOverChat}
          onStreamLive={setStreamLive}
          onToggleTools={() => setToolsOpen((open) => !open)}
          toolsButtonRef={toolsButtonRef}
          toolsDrawerId={toolsDrawerId}
          toolsOpen={toolsOpen}
          onClose={onClose}
          onEndForEveryone={onEndForEveryone}
          onPowerOff={onPowerOff}
          onReconnect={onReconnect}
          poweringOff={poweringOff}
          reconnecting={reconnecting}
          session={session}
        />
      )}
      {...(axOverlay
        ? {
            renderOverlay: (geometry) => (
              <LazyBoundary
                componentProps={{
                  projectSlug,
                  requestScope,
                  rotation: geometry.rotation,
                  shown: geometry.shown,
                  target,
                  visible: geometry.visible,
                }}
                load={loadDeviceAccessibilityOverlay}
                pending={null}
              />
            ),
          }
        : {})}
      surfaceId={session.surfaceId}
    />
  );
  return (
    <div
      className="device-pane__workspace"
      data-tools-layout={layout}
      ref={workspaceRef}
    >
      <div className="device-pane__stage" ref={stageRef}>
        {canvas}
      </div>
      {toolsOpen ? (
        <LazyBoundary
          componentProps={{
            axOverlay,
            deviceName: session.name,
            id: toolsDrawerId,
            layout,
            onAxOverlayChange: setAxOverlay,
            onClose: () => setToolsOpen(false),
            projectSlug,
            requestScope,
            streamVisible: streamLive,
            target,
          }}
          load={loadDeviceToolsDrawer}
          pending={<SkeletonBlock count={1} label="Loading device tools" />}
        />
      ) : null}
    </div>
  );
}

/**
 * Arrow keys move focus among a toolbar's buttons; Tab enters and leaves it
 * once (roving tabindex, the WAI-ARIA toolbar pattern).
 */
function onToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button:not([disabled])',
    ),
  ];
  if (buttons.length === 0) return;
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) %
          buttons.length;
  event.preventDefault();
  for (const button of buttons) button.tabIndex = -1;
  buttons[next]!.tabIndex = 0;
  buttons[next]!.focus();
}

function DeviceToolbar({
  api,
  hostLabel,
  session,
  canManage,
  ending,
  poweringOff,
  reconnecting,
  toolsOpen,
  toolsButtonRef,
  toolsDrawerId,
  onToggleTools,
  floatAvailable,
  onFloat,
  onStreamLive,
  onClose,
  onEndForEveryone,
  onPowerOff,
  onReconnect,
}: {
  api: LiveSurfaceHeaderApi;
  hostLabel: string;
  session: MobileDeviceSession;
  canManage: boolean;
  ending: boolean;
  poweringOff: boolean;
  reconnecting: boolean;
  toolsOpen: boolean;
  toolsButtonRef: RefObject<HTMLButtonElement | null>;
  toolsDrawerId: string;
  onToggleTools: () => void;
  /** A chat's floater is mounted (a chat with a Project is open). */
  floatAvailable: boolean;
  onFloat: () => void;
  /** Whether the stream is live (the accessibility overlay polls only then). */
  onStreamLive: (live: boolean) => void;
  onClose: () => void;
  onEndForEveryone: () => void;
  onPowerOff: () => void;
  onReconnect: () => void;
}) {
  const { surface, inputReady, sendInput } = api;
  const live = surface.status === 'live';
  useEffect(() => onStreamLive(live), [live, onStreamLive]);
  const press = (button: LiveSurfaceDeviceButton) =>
    sendInput([{ kind: 'device-button', button }]);
  const orientation = surface.producerStatus.orientation ?? 'portrait';
  // Roving tabindex: exactly the first button is in the tab order.
  // The one tab stop is the first ENABLED button: Home is disabled while
  // input is down, and must not take Close out of keyboard reach.
  let tabStopTaken = false;
  const iconButton = (
    label: string,
    glyph: ReactNode,
    onClick: () => void,
    options: {
      disabled?: boolean;
      /** Replaces the label as the tooltip (and accessible description). */
      title?: string;
      pending?: boolean;
      expanded?: boolean;
      controls?: string;
      ref?: RefObject<HTMLButtonElement | null>;
    } = {},
  ) => {
    const tabIndex = tabStopTaken || options.disabled ? -1 : 0;
    if (!options.disabled) tabStopTaken = true;
    return (
      <Button
        aria-controls={options.controls}
        aria-expanded={options.expanded}
        aria-label={label}
        className="device-pane__icon-button"
        disabled={options.disabled}
        onClick={onClick}
        pending={options.pending}
        ref={options.ref}
        size="sm"
        tabIndex={tabIndex}
        title={options.title ?? label}
        variant="ghost"
      >
        {glyph}
      </Button>
    );
  };
  const ended = surface.status === 'unavailable' || surface.status === 'denied';
  return (
    <>
      <div className="device-pane__toolbar">
        <p className="device-pane__identity">
          <span className="device-pane__identity-name">{session.name}</span>
          <span className="device-pane__identity-meta">
            {hostLabel} · {osLabel(session)}
          </span>
        </p>
        <div
          aria-label={`${session.name} controls`}
          className="device-pane__actions"
          onKeyDown={onToolbarKeyDown}
          role="toolbar"
        >
          {iconButton('Home', <HomeGlyph />, () => press('home'), {
            disabled: !inputReady,
          })}
          {session.platform === 'android' ? (
            <>
              {iconButton('Back', <BackGlyph />, () => press('back'), {
                disabled: !inputReady,
              })}
              {iconButton('Recents', <RecentsGlyph />, () => press('recents'), {
                disabled: !inputReady,
              })}
            </>
          ) : (
            iconButton(
              'Rotate',
              <RotateGlyph />,
              () =>
                sendInput([
                  {
                    kind: 'rotate',
                    orientation: NEXT_ORIENTATION[orientation],
                  },
                ]),
              { disabled: !inputReady },
            )
          )}
          {iconButton('Tools', <ToolsGlyph />, onToggleTools, {
            controls: toolsDrawerId,
            expanded: toolsOpen,
            ref: toolsButtonRef,
          })}
          {iconButton('Float over chat', <FloatGlyph />, onFloat, {
            disabled: !floatAvailable,
            // Disabled says why: only an open chat (in a Project) can float it.
            ...(floatAvailable
              ? {}
              : { title: 'Open a chat in a Project to float this device' }),
          })}
          {canManage
            ? iconButton('Power off', <PowerGlyph />, onPowerOff, {
                pending: poweringOff,
                disabled: ending,
              })
            : null}
          {canManage
            ? iconButton('End for everyone', <StopGlyph />, onEndForEveryone, {
                pending: ending,
                disabled: poweringOff,
              })
            : null}
          {iconButton('Close', <CloseGlyph />, onClose)}
        </div>
      </div>
      {ended ? (
        <ErrorState
          variant="compact"
          title={
            surface.status === 'denied'
              ? 'You cannot watch this device'
              : 'This device session has ended'
          }
          description={
            surface.status === 'denied'
              ? 'Only the Station operator, or an admin of a Project this device is shared with, can watch and control it.'
              : 'It was ended, the device stopped, or the device helper went away. Reconnect to open it again.'
          }
          action={
            surface.status === 'unavailable' ? (
              <Button
                onClick={onReconnect}
                pending={reconnecting}
                pendingLabel="Reconnecting…"
                size="sm"
              >
                Reconnect
              </Button>
            ) : undefined
          }
        />
      ) : surface.lastFrameAt === null ? (
        <p className="device-pane__loading-line" role="status">
          Step 2 of 2: connect video
        </p>
      ) : null}
    </>
  );
}
