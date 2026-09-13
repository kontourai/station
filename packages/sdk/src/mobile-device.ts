import type {
  MobileDeviceCapture,
  MobileDeviceInventory,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import { type ClientRequestOptions, getJson, mutateJson } from './client/http';

export type {
  MobileDeviceCapture,
  MobileDeviceInventory,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';

export class MobileDeviceRequestError extends Error {
  constructor(readonly status: number) {
    super('Mobile device inspection is unavailable.');
    this.name = 'MobileDeviceRequestError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function target(value: unknown): value is MobileDeviceTarget {
  const row = object(value);
  return (
    !!row &&
    row.hostId === 'local' &&
    text(row.deviceId) &&
    (row.platform === 'ios' || row.platform === 'android')
  );
}
function summary(value: unknown): value is MobileDeviceSummary {
  const row = object(value);
  return (
    !!row &&
    target(row) &&
    text(row.name) &&
    text(row.runtime) &&
    typeof row.booted === 'boolean'
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32 &&
    Number.isFinite(Date.parse(value))
  );
}
async function data(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new MobileDeviceRequestError(response.status);
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = object(await response.json());
  } catch {
    /* generic public error */
  }
  const value = object(envelope?.data);
  if (envelope?.success !== true || !value)
    throw new MobileDeviceRequestError(response.status);
  return value;
}

/** Explicit API base keeps a device host bound to the selected Station. */
export async function fetchMobileDeviceInventory(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<MobileDeviceInventory> {
  const result = await data(
    await getJson(`${apiBase}/api/mobile-devices/hosts/local/devices`, {
      ...options,
      maxResponseBytes: 512 * 1024,
    }),
  );
  const failures = [
    'not-configured',
    'invalid-configuration',
    'hub-unavailable',
    'invalid-response',
    'response-too-large',
    'busy',
  ];
  if (
    result.hostId !== 'local' ||
    !['ready', 'partial', 'unavailable'].includes(String(result.state)) ||
    !timestamp(result.observedAt) ||
    !Array.isArray(result.devices) ||
    result.devices.length > 256 ||
    !result.devices.every(summary) ||
    (result.state === 'unavailable'
      ? !failures.includes(String(result.failure)) ||
        result.devices.length !== 0
      : result.failure !== undefined)
  )
    throw new MobileDeviceRequestError(200);
  return result as unknown as MobileDeviceInventory;
}

/** Capture is explicit and bounded. It does not create a stream or boot a device. */
export async function captureMobileDevice(
  apiBase: string,
  selected: MobileDeviceTarget,
  options?: ClientRequestOptions,
): Promise<MobileDeviceCapture> {
  if (
    !target(selected) ||
    (selected.platform === 'ios'
      ? !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          selected.deviceId,
        )
      : !/^emulator-[0-9]+$/.test(selected.deviceId))
  )
    throw new MobileDeviceRequestError(400);
  const expected = { ...selected };
  const path = `/api/mobile-devices/hosts/${encodeURIComponent(expected.hostId)}/devices/${expected.platform}/${encodeURIComponent(expected.deviceId)}/capture`;
  const result = await data(
    await mutateJson(
      `${apiBase}${path}`,
      'POST',
      {
        ...options,
        readOnly: true,
        maxResponseBytes: 12 * 1024 * 1024,
      },
      {},
    ),
  );
  const received = object(result.target);
  if (
    !text(result.captureId) ||
    !received ||
    received.hostId !== expected.hostId ||
    received.platform !== expected.platform ||
    received.deviceId !== expected.deviceId ||
    !timestamp(result.capturedAt) ||
    result.mimeType !== 'image/png' ||
    typeof result.width !== 'number' ||
    !Number.isInteger(result.width) ||
    result.width < 1 ||
    result.width > 8192 ||
    typeof result.height !== 'number' ||
    !Number.isInteger(result.height) ||
    result.height < 1 ||
    result.height > 8192 ||
    typeof result.pngBase64 !== 'string' ||
    result.pngBase64.length > 11_184_812 ||
    !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(result.pngBase64)
  )
    throw new MobileDeviceRequestError(200);
  return result as unknown as MobileDeviceCapture;
}
