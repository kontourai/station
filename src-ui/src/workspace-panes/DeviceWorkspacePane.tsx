import type {
  MobileDeviceCapture,
  MobileDeviceSummary,
} from '@kontourai/station-contracts/mobile-device';
import { isCaptureableMobileDeviceTarget } from '@kontourai/station-sdk/mobile-device';
import {
  useCaptureMobileDeviceMutation,
  useMobileDeviceInventoryQuery,
} from '@kontourai/station-sdk/mobile-devices-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  DEVICE_HOST_FAILURE_COPY,
  type DeviceCaptureOutcome,
  describeCaptureFailure,
} from './deviceCaptureOutcome';
import {
  clearDevicePaneState,
  devicePaneStorage,
  readDevicePaneState,
  writeDevicePaneState,
} from './devicePaneStateStorage';
import './DeviceWorkspacePane.css';

/**
 * A captured simulator or emulator screen, as a dock pane (#1969).
 *
 * This is a SNAPSHOT surface and says so everywhere a frame appears: the
 * caption, the image's own alt text and a persistent view-only line all name
 * what the reader is looking at. There is no stream, and there is no input —
 * the frame carries no click or key handler at all, so there is nothing to
 * re-enable by accident, and the line states that as a property of this build
 * rather than as a condition that might lift on its own.
 *
 * Nothing here claims a device is live. An inventory row and a decoded PNG
 * establish "this device existed a moment ago" and "this is what its screen
 * looked like at this time", and those are the only two claims made.
 */
export function DeviceWorkspacePane() {
  const requestScope = useHostRequestAuthorityScope();
  const previousAuthority = useRef(requestScope);

  // The authority discipline `ConnectedSessionInventory` established and the
  // mobile-device guide requires: when the selected Station or its authority
  // changes, the previous one's remembered selection goes with it.
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
        Device inspection is unavailable until this Station is authorized.
      </section>
    );
  // Keyed on the authority so React UNMOUNTS the surface when it changes,
  // which is what drops the decoded frame from memory — stronger than
  // clearing a state variable and remembering to keep doing so.
  return (
    <DeviceWorkspacePaneSurface
      // `JSON.stringify` of the pair rather than a NUL-joined template:
      // biome rewrites a unicode escape to the raw control byte, which is
      // invisible in a diff. This is unambiguous and plain ASCII.
      key={JSON.stringify([requestScope.apiBase, requestScope.authorityKey])}
      requestScope={requestScope}
    />
  );
}

/** How long a frame stays presented as current before it is called old. */
export const DEVICE_SNAPSHOT_STALE_AFTER_MS = 30_000;

const PLATFORM_LABEL = { ios: 'iOS', android: 'Android' } as const;

function capturedAtLabel(capturedAt: string): string {
  const parsed = new Date(capturedAt);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleTimeString()
    : capturedAt;
}

/**
 * Why this row cannot be captured, or null when it can.
 *
 * Addressability is checked BEFORE "not running", because the two orders give
 * opposite advice for the one row that fails both — and that row is the only
 * reachable divergent population there is. `LocalMobileDeviceHost` enforces
 * the `emulator-<n>` spelling only for a BOOTED Android device, so an
 * unbooted emulator may legitimately be listed under an AVD name; telling its
 * reader to start it sends them to an inventory the host then refuses
 * WHOLESALE, because that same row booted breaks its listing rule and takes
 * every other device down with it. Probed against the host directly: an
 * unbooted `Pixel_9_API_36` row answers `ready` and is listed; the identical
 * row with `booted: true` answers `unavailable` / `invalid-response`.
 *
 * The iOS sentence has NO reachable population — the host regex-checks an iOS
 * id unconditionally, so a simulator without a UDID never reaches an
 * inventory at all (probed both booted and unbooted: `invalid-response`
 * either way). It is drift insurance against a future helper, and is written
 * here as that rather than as a live case.
 */
function unsupportedReason(device: MobileDeviceSummary): string | null {
  if (!isCaptureableMobileDeviceTarget(device))
    return device.platform === 'android'
      ? 'Station captures an Android emulator by its emulator-<number> serial, and this device does not report one.'
      : 'Station captures an iOS simulator by its UDID, and this device does not report one.';
  if (!device.booted) return 'Not running — start it, then refresh.';
  return null;
}

function DeviceWorkspacePaneSurface({
  requestScope,
}: {
  requestScope: { apiBase: string; authorityKey: string };
}) {
  const inventory = useMobileDeviceInventoryQuery(requestScope);
  const capture = useCaptureMobileDeviceMutation(requestScope);
  const groupId = useId();

  const devices = useMemo(
    () => inventory.data?.devices ?? [],
    [inventory.data],
  );

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const stored = readDevicePaneState(devicePaneStorage(), requestScope);
    return stored ? `${stored.platform}:${stored.deviceId}` : null;
  });
  const selected =
    devices.find(
      (device) => `${device.platform}:${device.deviceId}` === selectedId,
    ) ?? null;

  const frame: MobileDeviceCapture | undefined = capture.data;
  const [now, setNow] = useState(() => Date.now());
  const capturedAt = frame ? Date.parse(frame.capturedAt) : Number.NaN;
  const isStale =
    Number.isFinite(capturedAt) &&
    now - capturedAt >= DEVICE_SNAPSHOT_STALE_AFTER_MS;

  // One ticker, only while there is a frame that has not yet been called old.
  useEffect(() => {
    if (!frame || isStale) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [frame, isStale]);

  function selectDevice(device: MobileDeviceSummary) {
    setSelectedId(`${device.platform}:${device.deviceId}`);
    writeDevicePaneState(devicePaneStorage(), requestScope, device);
    capture.reset();
  }

  if (inventory.isLoading)
    return (
      <div className="device-pane">
        <SkeletonBlock count={3} label="Reading the device list" />
      </div>
    );

  if (inventory.isError)
    return (
      <div className="device-pane">
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
  const failure = inventory.data?.failure;

  if (state === 'unavailable' && failure) {
    const copy = DEVICE_HOST_FAILURE_COPY[failure];
    // `not-configured` is a SETUP state, not a failure: nothing broke, the
    // helper was never pointed at. It gets the prominent first-run card and
    // no retry, because retrying an absent configuration answers the same
    // thing every time.
    return (
      <div className="device-pane">
        {failure === 'not-configured' ? (
          <Empty
            variant="prominent"
            label={copy.title}
            description={copy.description}
          />
        ) : (
          <ErrorState
            variant="compact"
            title={copy.title}
            description={copy.description}
            action={
              <Button size="sm" onClick={() => void inventory.refetch()}>
                Refresh
              </Button>
            }
          />
        )}
      </div>
    );
  }

  /*
    A partial discovery is a fact about the READ, not about the list's
    length: `LocalMobileDeviceHost` answers `partial` whenever the helper
    reported any source error, and it can do that with an empty `devices`
    (probed directly with `{simulators:[],emulators:[],errors:[{…}]}`). So
    the note belongs to a list of zero exactly as much as to a list of one,
    and both states render this same element.
  */
  const incompleteNote =
    state === 'partial' ? (
      <p className="device-pane__note">
        Some device sources did not answer, so this list may be incomplete.
      </p>
    ) : null;

  if (devices.length === 0)
    return (
      <div className="device-pane">
        <Empty
          variant="compact"
          label="Nothing here yet"
          description={
            // "reported nothing running" is a claim about a discovery that
            // FINISHED. Under `partial` it did not, so the sentence says only
            // what the sources that answered reported, and the note below
            // carries the rest.
            state === 'partial'
              ? 'The device sources that did answer listed nothing running.'
              : "This Station's device helper reported nothing running. Start a simulator or emulator, then refresh."
          }
          action={
            <Button size="sm" onClick={() => void inventory.refetch()}>
              Refresh
            </Button>
          }
        />
        {incompleteNote}
      </div>
    );

  const outcome: DeviceCaptureOutcome | null = capture.isError
    ? describeCaptureFailure(capture.error)
    : null;
  const selectedReason = selected ? unsupportedReason(selected) : null;
  const canCapture = Boolean(selected) && selectedReason === null;

  return (
    <div className="device-pane">
      <div className="device-pane__toolbar">
        <fieldset className="device-pane__picker">
          <legend className="device-pane__picker-legend">Device</legend>
          {devices.map((device) => {
            const id = `${device.platform}:${device.deviceId}`;
            const reason = unsupportedReason(device);
            return (
              <label
                className="device-pane__choice"
                key={id}
                htmlFor={`${groupId}-${id}`}
              >
                <input
                  checked={selectedId === id}
                  disabled={reason !== null}
                  id={`${groupId}-${id}`}
                  name={groupId}
                  onChange={() => selectDevice(device)}
                  type="radio"
                  value={id}
                />
                <span className="device-pane__choice-name">{device.name}</span>
                <span className="device-pane__choice-meta">
                  {PLATFORM_LABEL[device.platform]} · {device.runtime}
                </span>
                {reason ? (
                  <span className="device-pane__choice-reason">{reason}</span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
        <div className="device-pane__actions">
          <Button
            disabled={!canCapture}
            onClick={() => selected && capture.mutate(selected)}
            pending={capture.isPending}
            size="sm"
            variant="primary"
          >
            Capture
          </Button>
          <Button size="sm" onClick={() => void inventory.refetch()}>
            Refresh
          </Button>
        </div>
        {/*
          Present in every state that shows the frame area, including a stale
          one. It is a property of this build, not a condition: saying
          "control is unavailable" would name a transient state that does not
          exist here.
        */}
        <p className="device-pane__view-only">
          View only — taps and typing are not sent to this device.
        </p>
        {incompleteNote}
      </div>
      <div className="device-pane__stage">
        <DeviceStage
          capture={frame}
          isCapturing={capture.isPending}
          isStale={isStale}
          onRefreshInventory={() => void inventory.refetch()}
          onRetry={() => selected && capture.mutate(selected)}
          outcome={outcome}
          selected={selected}
          selectedReason={selectedReason}
        />
      </div>
    </div>
  );
}

function DeviceStage({
  capture,
  isCapturing,
  isStale,
  onRefreshInventory,
  onRetry,
  outcome,
  selected,
  selectedReason,
}: {
  capture: MobileDeviceCapture | undefined;
  isCapturing: boolean;
  isStale: boolean;
  onRefreshInventory: () => void;
  onRetry: () => void;
  outcome: DeviceCaptureOutcome | null;
  selected: MobileDeviceSummary | null;
  selectedReason: string | null;
}) {
  if (isCapturing) return <SkeletonBlock count={2} label="Taking a snapshot" />;

  if (outcome)
    return (
      <ErrorState
        variant="compact"
        title={outcome.title}
        description={outcome.description}
        action={
          outcome.action === 'retry' ? (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : outcome.action === 'refresh' ? (
            <Button size="sm" onClick={onRefreshInventory}>
              Refresh devices
            </Button>
          ) : undefined
        }
      />
    );

  if (!selected)
    return (
      <Empty
        variant="compact"
        label="Nothing here yet"
        description="Choose a device above, then take a snapshot of its screen."
      />
    );

  if (selectedReason)
    return (
      <Empty
        variant="compact"
        label="Nothing here yet"
        description={selectedReason}
      />
    );

  if (!capture)
    return (
      <Empty
        variant="compact"
        label="Nothing here yet"
        description={`Take a snapshot to see ${selected.name}'s screen. It shows the device screen, not which build is running on it.`}
      />
    );

  const time = capturedAtLabel(capture.capturedAt);
  const caption = `Snapshot of ${selected.name} · ${PLATFORM_LABEL[selected.platform]} · captured ${time}`;
  return (
    <figure className="device-pane__figure">
      {/*
        The ratio comes from the CAPTURE's own width and height, so a device
        held in landscape simply reports the other way round and the frame
        relayouts — there is no orientation field to trust and none is
        invented. `object-fit: contain` inside it means the bitmap is never
        cropped even if the two ever disagree, because cropping a device
        screen silently hides the thing this pane exists to show.
        Keyed by capture id so a new frame never inherits the last one's box.
      */}
      <div
        className="device-pane__frame"
        key={capture.captureId}
        style={
          {
            '--device-frame-ratio': `${capture.width} / ${capture.height}`,
          } as React.CSSProperties
        }
      >
        <img
          alt={`Snapshot of ${selected.name}, captured ${time}`}
          className="device-pane__image"
          src={`data:${capture.mimeType};base64,${capture.pngBase64}`}
        />
      </div>
      <figcaption className="device-pane__caption" role="status">
        {caption}
        {isStale ? (
          <span className="device-pane__stale">
            {' '}
            — more than 30 seconds old; capture again for the current screen.
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
