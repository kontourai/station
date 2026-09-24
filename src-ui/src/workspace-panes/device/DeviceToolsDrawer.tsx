import {
  DEVICE_PUSH_PAYLOAD_MAX_BYTES,
  type DeviceAccessibilityTree,
  type DeviceLocationReadBack,
  type DevicePermission,
  type DevicePermissionDecision,
  type DeviceReadBack,
  type DeviceToolAction,
  type DeviceToolsUnreadableReason,
} from '@kontourai/station-contracts/device-tools';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/Button';
import { CloseGlyph } from '../../components/icons/Glyph';
import {
  axRectOnShownFrame,
  type DeviceFrameRotation,
} from './deviceAxGeometry';
import {
  type DeviceToolsTarget,
  describeDeviceToolsFailure,
  deviceToolsSupported,
  useDeviceAccessibilityTree,
  useDevicePermissions,
  useDeviceToolAction,
  useDeviceToolsSnapshot,
} from './deviceToolsApi';
import './DeviceToolsDrawer.css';

/**
 * The Device pane's Tools drawer and accessibility overlay (#1971, D10).
 *
 * Every value is the one the device REPORTED back (via the server), with
 * where it came from when that matters: iOS cannot report its simulated
 * location or app permissions, and the drawer says so instead of echoing
 * what was sent. Every change is one typed action; the device is read back
 * afterwards and that answer replaces what the drawer shows.
 *
 * Loaded lazily (it rides its own chunk, fetched the first time the drawer
 * or the overlay is opened). Sections follow t3code's DeviceToolsDrawer
 * (apps/web/src/components/device/DeviceToolsDrawer.tsx) and the overlay its
 * DeviceStreamView (MIT License, Copyright (c) 2026 T3 Tools Inc.).
 */

const UNREADABLE_COPY: Record<DeviceToolsUnreadableReason, string> = {
  unsupported: 'This device cannot report it.',
  'not-reported': 'The device did not report it.',
  'tool-unavailable': 'The device tools are not installed on the Station host.',
  'tool-failed': 'Reading it from the device failed.',
  'tool-timeout': 'The device did not answer in time.',
  'hub-unavailable': 'The device helper did not answer.',
};

const PERMISSION_LABEL: Record<DevicePermission, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  photos: 'Photos',
  'media-library': 'Media library',
  contacts: 'Contacts',
  calendar: 'Calendar',
  reminders: 'Reminders',
  location: 'Location',
  motion: 'Motion & fitness',
  notifications: 'Notifications',
};

const DECISION_LABEL: Record<DevicePermissionDecision, string> = {
  grant: 'Grant',
  revoke: 'Revoke',
  reset: 'Reset',
};

const LOCATION_PRESETS = [
  { label: 'San Francisco', latitude: 37.7749, longitude: -122.4194 },
  { label: 'London', latitude: 51.5074, longitude: -0.1278 },
  { label: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
] as const;

const APP_ID = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;

const DEFAULT_PUSH = JSON.stringify(
  { aps: { alert: { title: 'Station', body: 'Hello from Station' } } },
  null,
  2,
);

/**
 * A typed coordinate: a decimal point OR a single decimal comma (a comma
 * locale's "51,5074"). Anything else — empty, two separators, text — is
 * null, and the form says what it needs.
 */
function parseCoordinate(text: string): number | null {
  const trimmed = text.trim();
  const normalized =
    !trimmed.includes('.') && (trimmed.match(/,/g) ?? []).length === 1
      ? trimmed.replace(',', '.')
      : trimmed;
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function formatCoordinate(value: number): string {
  return value.toFixed(4);
}

function unreadableLine<T>(readBack: DeviceReadBack<T>): string | null {
  return readBack.state === 'unreadable'
    ? UNREADABLE_COPY[readBack.reason]
    : null;
}

function locationLine(location: DeviceLocationReadBack): string {
  if (location.state === 'read')
    return `Reported by the device: ${formatCoordinate(location.value.latitude)}, ${formatCoordinate(location.value.longitude)}`;
  if (location.state === 'last-set') {
    const at = new Date(location.setAt).toLocaleTimeString();
    return location.value
      ? `Last set from Station at ${at}: ${formatCoordinate(location.value.latitude)}, ${formatCoordinate(location.value.longitude)}. This device cannot report its location back.`
      : `Cleared from Station at ${at}. This device cannot report its location back.`;
  }
  return UNREADABLE_COPY[location.reason];
}

export interface DeviceToolsDrawerProps {
  requestScope: ApiRequestScope;
  projectSlug: string | null;
  target: DeviceToolsTarget;
  deviceName: string;
  /** The drawer's element id (the Tools toggle's `aria-controls`). */
  id: string;
  /** `overlay` below 560px of container width, `docked` (288px) above. */
  layout: 'overlay' | 'docked';
  axOverlay: boolean;
  onAxOverlayChange: (enabled: boolean) => void;
  /** The device is streaming and on screen (the overlay polls only then). */
  streamVisible: boolean;
  onClose: () => void;
}

/**
 * The drawer. Its tools run THIS Station's `xcrun`/`adb` (and read the
 * local hub), so a device on an SSH device host (#1973) gets a clear
 * notice instead — nothing is requested, and the server refuses such a
 * request anyway (`unsupported`).
 */
export function DeviceToolsDrawer(props: DeviceToolsDrawerProps) {
  return deviceToolsSupported(props.target) ? (
    <LocalDeviceToolsDrawer {...props} />
  ) : (
    <RemoteHostToolsNotice {...props} />
  );
}

function RemoteHostToolsNotice(props: DeviceToolsDrawerProps) {
  const headingId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    drawerRef.current?.focus();
  }, []);
  return (
    <aside
      aria-labelledby={headingId}
      className={`device-tools device-tools--${props.layout}`}
      data-layout={props.layout}
      data-testid="device-tools-drawer"
      id={props.id}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          props.onClose();
        }
      }}
      ref={drawerRef}
      tabIndex={-1}
    >
      <div className="device-tools__header">
        <h3 className="device-tools__title" id={headingId}>
          Tools
        </h3>
        <Button
          aria-label="Close tools"
          className="device-tools__close"
          onClick={props.onClose}
          size="sm"
          variant="ghost"
        >
          <CloseGlyph />
        </Button>
      </div>
      <div className="device-tools__body">
        <p className="device-tools__notice" role="status">
          Device tools (appearance, location, permissions, push and
          accessibility frames) are available only for simulators and emulators
          on this Station. {props.deviceName} runs on an SSH device host.
        </p>
      </div>
    </aside>
  );
}

function LocalDeviceToolsDrawer(props: DeviceToolsDrawerProps) {
  const { requestScope, projectSlug, target } = props;
  const snapshot = useDeviceToolsSnapshot(requestScope, target, projectSlug);
  const action = useDeviceToolAction(requestScope, target, projectSlug);
  // Same cache entry the overlay polls; this observer never fetches.
  const tree = useDeviceAccessibilityTree(
    requestScope,
    target,
    projectSlug,
    false,
  );
  const [lastAction, setLastAction] = useState<DeviceToolAction['type'] | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const headingId = useId();
  const drawerRef = useRef<HTMLElement>(null);

  // Opening the drawer moves focus into it, so a keyboard user is where the
  // new content is. ONLY on open: a docked↔overlay flip (a resize) must not
  // pull focus away from whatever the person is doing. Closing returns focus
  // to the Tools button (the pane owns that; see DeviceStage).
  useEffect(() => {
    drawerRef.current?.focus();
  }, []);

  async function run(next: DeviceToolAction, done?: string) {
    setLastAction(next.type);
    setNotice(null);
    try {
      await action.mutateAsync(next);
      if (done) setNotice(done);
    } catch {
      // Shown from `action.error` below.
    }
  }

  const data = snapshot.data;
  const capabilities = data?.capabilities;
  const busy = action.isPending;
  const pendingFor = (type: DeviceToolAction['type']) =>
    busy && lastAction === type;

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      props.onClose();
    }
  }

  return (
    <aside
      aria-labelledby={headingId}
      className={`device-tools device-tools--${props.layout}`}
      data-layout={props.layout}
      data-testid="device-tools-drawer"
      id={props.id}
      onKeyDown={onKeyDown}
      ref={drawerRef}
      tabIndex={-1}
    >
      <div className="device-tools__header">
        <h3 className="device-tools__title" id={headingId}>
          Tools
        </h3>
        <Button
          aria-label="Refresh device values"
          onClick={() => void snapshot.refetch()}
          pending={snapshot.isFetching}
          pendingLabel="Reading…"
          size="sm"
        >
          Refresh
        </Button>
        <Button
          aria-label="Close tools"
          className="device-tools__close"
          onClick={props.onClose}
          size="sm"
          variant="ghost"
        >
          <CloseGlyph />
        </Button>
      </div>
      <div className="device-tools__body">
        {action.isError ? (
          <p className="device-tools__error" role="alert">
            {describeDeviceToolsFailure(action.error)}
          </p>
        ) : null}
        {notice ? (
          <p className="device-tools__notice" role="status">
            {notice}
          </p>
        ) : null}
        {snapshot.isLoading ? (
          <p className="device-tools__line" role="status">
            Reading {props.deviceName}’s settings…
          </p>
        ) : null}
        {snapshot.isError ? (
          <p className="device-tools__error" role="alert">
            {describeDeviceToolsFailure(snapshot.error)}
          </p>
        ) : null}

        <Section title="App">
          <Row label="Foreground app">
            {data ? (
              data.foregroundApp.state === 'read' ? (
                <code className="device-tools__value">
                  {data.foregroundApp.value?.appId ?? 'None'}
                </code>
              ) : (
                <span className="device-tools__muted">
                  {unreadableLine(data.foregroundApp)}
                </span>
              )
            ) : (
              <span className="device-tools__muted">—</span>
            )}
          </Row>
        </Section>

        {capabilities?.appearance ? (
          <Section title="Appearance">
            <p className="device-tools__line">
              {data?.appearance.state === 'read'
                ? `The device reports ${data.appearance.value} mode.`
                : data
                  ? unreadableLine(data.appearance)
                  : null}
            </p>
            <fieldset
              aria-label="Appearance"
              className="device-tools__actions device-tools__fieldset"
            >
              {(['light', 'dark'] as const).map((mode) => (
                <Button
                  aria-pressed={
                    data?.appearance.state === 'read' &&
                    data.appearance.value === mode
                  }
                  disabled={busy && !pendingFor('set-appearance')}
                  key={mode}
                  onClick={() =>
                    void run({ type: 'set-appearance', appearance: mode })
                  }
                  pending={pendingFor('set-appearance')}
                  size="sm"
                >
                  {mode === 'light' ? 'Light' : 'Dark'}
                </Button>
              ))}
            </fieldset>
          </Section>
        ) : null}

        {capabilities?.accessibility ? (
          <AccessibilitySection
            enabled={props.axOverlay}
            onChange={props.onAxOverlayChange}
            streamVisible={props.streamVisible}
            tree={tree.data}
            treeError={tree.error}
          />
        ) : null}

        {capabilities?.push ? (
          <PushSection
            busy={busy}
            defaultAppId={
              data?.foregroundApp.state === 'read'
                ? (data.foregroundApp.value?.appId ?? '')
                : ''
            }
            onSend={(appId, payload) =>
              run(
                { type: 'send-push', appId, payload },
                `Sent to ${appId}. The simulator accepted it; whether the app shows it is up to the app.`,
              )
            }
            pending={pendingFor('send-push')}
          />
        ) : null}

        {capabilities?.location ? (
          <LocationSection
            busy={busy}
            canClear={capabilities.clearLocation}
            location={data?.location}
            onClear={() => run({ type: 'clear-location' })}
            onSet={(latitude, longitude) =>
              run({ type: 'set-location', latitude, longitude })
            }
            pending={pendingFor('set-location') || pendingFor('clear-location')}
          />
        ) : null}

        {capabilities && capabilities.permissions.length > 0 ? (
          <PermissionsSection
            busy={busy}
            decisions={capabilities.permissionDecisions}
            onDecide={(appId, permission, decision) =>
              run({ type: 'set-permission', appId, permission, decision })
            }
            pending={pendingFor('set-permission')}
            permissions={capabilities.permissions}
            projectSlug={projectSlug}
            requestScope={requestScope}
            target={target}
          />
        ) : null}
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="device-tools__section">
      <h4 className="device-tools__section-title" id={id}>
        {title}
      </h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="device-tools__row">
      <span className="device-tools__label">{label}</span>
      {children}
    </div>
  );
}

function AccessibilitySection({
  enabled,
  onChange,
  streamVisible,
  tree,
  treeError,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  streamVisible: boolean;
  tree: DeviceAccessibilityTree | undefined;
  treeError: unknown;
}) {
  let line: string;
  if (!enabled) line = 'Off.';
  else if (!streamVisible)
    line = 'Paused while the device is not showing. It resumes when it is.';
  else if (treeError) line = describeDeviceToolsFailure(treeError);
  else if (!tree) line = 'Reading the accessibility tree…';
  // `truncated` has two causes (the element cap and the response byte
  // cap), so the count shown is the one drawn, never a fixed number.
  else
    line = `${tree.elements.length} element${tree.elements.length === 1 ? '' : 's'} outlined, re-read every 2 seconds.${tree.truncated ? ` The tree was larger; only these ${tree.elements.length} are shown.` : ''}`;
  return (
    <Section title="Accessibility">
      <div className="device-tools__actions">
        <Button
          aria-pressed={enabled}
          onClick={() => onChange(!enabled)}
          size="sm"
        >
          {enabled ? 'Hide accessibility frames' : 'Show accessibility frames'}
        </Button>
      </div>
      <p className="device-tools__line" role="status">
        {line}
      </p>
    </Section>
  );
}

function PushSection({
  defaultAppId,
  busy,
  pending,
  onSend,
}: {
  defaultAppId: string;
  busy: boolean;
  pending: boolean;
  onSend: (appId: string, payload: Record<string, unknown>) => void;
}) {
  const appIdId = useId();
  const payloadId = useId();
  const [appId, setAppId] = useState<string | null>(null);
  const [payload, setPayload] = useState(DEFAULT_PUSH);
  const effectiveAppId = appId ?? defaultAppId;
  let parsed: Record<string, unknown> | null = null;
  let problem: string | null = null;
  try {
    const value: unknown = JSON.parse(payload);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { aps?: unknown }).aps &&
      typeof (value as { aps?: unknown }).aps === 'object'
    )
      parsed = value as Record<string, unknown>;
    else problem = 'The payload must be a JSON object with an "aps" object.';
  } catch {
    problem = 'The payload is not valid JSON.';
  }
  const bytes = parsed
    ? new TextEncoder().encode(JSON.stringify(parsed)).length
    : 0;
  if (!problem && bytes > DEVICE_PUSH_PAYLOAD_MAX_BYTES)
    problem = `The payload is ${bytes} bytes; a push allows ${DEVICE_PUSH_PAYLOAD_MAX_BYTES}.`;
  const appIdValid = APP_ID.test(effectiveAppId);
  return (
    <Section title="Push notification">
      <label className="device-tools__field" htmlFor={appIdId}>
        <span className="device-tools__label">App (bundle id)</span>
        <input
          autoCapitalize="off"
          autoComplete="off"
          id={appIdId}
          onChange={(event) => setAppId(event.target.value)}
          spellCheck={false}
          value={effectiveAppId}
        />
      </label>
      <label className="device-tools__field" htmlFor={payloadId}>
        <span className="device-tools__label">Payload (JSON)</span>
        <textarea
          id={payloadId}
          onChange={(event) => setPayload(event.target.value)}
          rows={5}
          spellCheck={false}
          value={payload}
        />
      </label>
      {problem ? (
        <p className="device-tools__muted">{problem}</p>
      ) : (
        <p className="device-tools__muted">
          {bytes} of {DEVICE_PUSH_PAYLOAD_MAX_BYTES} bytes
        </p>
      )}
      <div className="device-tools__actions">
        <Button
          disabled={!parsed || !!problem || !appIdValid || (busy && !pending)}
          onClick={() => parsed && onSend(effectiveAppId, parsed)}
          pending={pending}
          pendingLabel="Sending…"
          size="sm"
          variant="primary"
        >
          Send push
        </Button>
      </div>
    </Section>
  );
}

function LocationSection({
  location,
  canClear,
  busy,
  pending,
  onSet,
  onClear,
}: {
  location: DeviceLocationReadBack | undefined;
  canClear: boolean;
  busy: boolean;
  pending: boolean;
  onSet: (latitude: number, longitude: number) => void;
  onClear: () => void;
}) {
  const latId = useId();
  const lonId = useId();
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const lat = parseCoordinate(latitude);
  const lon = parseCoordinate(longitude);
  const valid =
    lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const typed = latitude.trim() !== '' || longitude.trim() !== '';
  return (
    <Section title="Location">
      <p className="device-tools__line" role="status">
        {location ? locationLine(location) : '—'}
      </p>
      <fieldset
        aria-label="Location presets"
        className="device-tools__actions device-tools__fieldset"
      >
        {LOCATION_PRESETS.map((preset) => (
          <Button
            disabled={busy}
            key={preset.label}
            onClick={() => onSet(preset.latitude, preset.longitude)}
            size="sm"
          >
            {preset.label}
          </Button>
        ))}
      </fieldset>
      <div className="device-tools__coordinates">
        <label className="device-tools__field" htmlFor={latId}>
          <span className="device-tools__label">Latitude</span>
          <input
            id={latId}
            inputMode="decimal"
            onChange={(event) => setLatitude(event.target.value)}
            value={latitude}
          />
        </label>
        <label className="device-tools__field" htmlFor={lonId}>
          <span className="device-tools__label">Longitude</span>
          <input
            id={lonId}
            inputMode="decimal"
            onChange={(event) => setLongitude(event.target.value)}
            value={longitude}
          />
        </label>
      </div>
      {typed && !valid ? (
        <p className="device-tools__muted" role="status">
          Enter a latitude from -90 to 90 and a longitude from -180 to 180, for
          example 51.5074 and -0.1278 (a decimal comma works too).
        </p>
      ) : null}
      <div className="device-tools__actions">
        <Button
          disabled={!valid || (busy && !pending)}
          onClick={() => valid && onSet(lat, lon)}
          pending={pending}
          pendingLabel="Setting…"
          size="sm"
          variant="primary"
        >
          Set location
        </Button>
        {canClear ? (
          <Button disabled={busy} onClick={onClear} size="sm">
            Clear
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function PermissionsSection({
  requestScope,
  projectSlug,
  target,
  permissions,
  decisions,
  busy,
  pending,
  onDecide,
}: {
  requestScope: ApiRequestScope;
  projectSlug: string | null;
  target: DeviceToolsTarget;
  permissions: readonly DevicePermission[];
  decisions: readonly DevicePermissionDecision[];
  busy: boolean;
  pending: boolean;
  onDecide: (
    appId: string,
    permission: DevicePermission,
    decision: DevicePermissionDecision,
  ) => void;
}) {
  const appIdId = useId();
  const permissionId = useId();
  const [appId, setAppId] = useState('');
  const [permission, setPermission] = useState<DevicePermission>(
    permissions[0]!,
  );
  const [readFor, setReadFor] = useState<string | null>(null);
  const [decided, setDecided] = useState<DevicePermissionDecision | null>(null);
  const readBack = useDevicePermissions(
    requestScope,
    target,
    projectSlug,
    readFor,
  );
  const appIdValid = APP_ID.test(appId);
  const current = readBack.data?.permissions;
  return (
    <Section title="Permissions">
      <label className="device-tools__field" htmlFor={appIdId}>
        <span className="device-tools__label">App (bundle id or package)</span>
        <input
          autoCapitalize="off"
          autoComplete="off"
          id={appIdId}
          onChange={(event) => setAppId(event.target.value)}
          spellCheck={false}
          value={appId}
        />
      </label>
      <label className="device-tools__field" htmlFor={permissionId}>
        <span className="device-tools__label">Permission</span>
        <select
          id={permissionId}
          onChange={(event) =>
            setPermission(event.target.value as DevicePermission)
          }
          value={permission}
        >
          {permissions.map((entry) => (
            <option key={entry} value={entry}>
              {PERMISSION_LABEL[entry]}
            </option>
          ))}
        </select>
      </label>
      <fieldset
        aria-label="Permission decision"
        className="device-tools__actions device-tools__fieldset"
      >
        {decisions.map((decision) => (
          <Button
            // Every decision is disabled while ANY action runs (no double
            // send); the one in flight shows it.
            disabled={!appIdValid || busy}
            key={decision}
            onClick={() => {
              setDecided(decision);
              setReadFor(appId);
              onDecide(appId, permission, decision);
            }}
            pending={pending && decided === decision}
            size="sm"
          >
            {DECISION_LABEL[decision]}
          </Button>
        ))}
        <Button
          disabled={!appIdValid}
          onClick={() => {
            // A new app id is read by the query it enables; the same one is
            // read again. Never a refetch for an id the query is not for.
            if (readFor === appId) void readBack.refetch();
            else setReadFor(appId);
          }}
          size="sm"
        >
          Read permissions
        </Button>
      </fieldset>
      {readFor && current ? (
        current.state === 'read' ? (
          <ul
            aria-label={`Permissions of ${readFor}`}
            className="device-tools__list"
          >
            {permissions.map((entry) => (
              <li key={entry}>
                {PERMISSION_LABEL[entry]}:{' '}
                {current.value[entry] === 'granted'
                  ? 'Granted'
                  : current.value[entry] === 'denied'
                    ? 'Denied'
                    : 'Not requested'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="device-tools__muted">
            {current.reason === 'unsupported'
              ? 'This device cannot report permission state. A change is accepted by the simulator but cannot be read back.'
              : UNREADABLE_COPY[current.reason]}
          </p>
        )
      ) : null}
    </Section>
  );
}

/**
 * The accessibility frames over the device's screen. Polls the tree every
 * 2 s only while it is mounted AND `visible` (the stream is live); the
 * drawer need not be open. Drawn inside `LiveSurfaceCanvas`'s overlay
 * layer, which covers the drawn frame exactly and never takes pointers.
 */
export function DeviceAccessibilityOverlay(props: {
  requestScope: ApiRequestScope;
  projectSlug: string | null;
  target: DeviceToolsTarget;
  shown: { width: number; height: number };
  rotation: DeviceFrameRotation;
  visible: boolean;
}) {
  // An SSH device host's device has no tree here (#1973): never polled.
  const tree = useDeviceAccessibilityTree(
    props.requestScope,
    props.target,
    props.projectSlug,
    props.visible && deviceToolsSupported(props.target),
  );
  const data = tree.data;
  if (!data || !props.visible) return null;
  return (
    <div className="device-ax-overlay" data-testid="device-ax-overlay">
      {data.elements.map((element, index) => {
        const rect = axRectOnShownFrame(
          element,
          data.space,
          props.shown,
          props.rotation,
        );
        return (
          <div
            className="device-ax-overlay__frame"
            data-ax-id={element.id}
            // Ids repeat in some trees; the index keeps keys unique.
            key={`${element.id}:${index}`}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          >
            {element.label ? (
              <span className="device-ax-overlay__label">{element.label}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
