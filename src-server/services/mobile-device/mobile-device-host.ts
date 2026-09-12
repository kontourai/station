import { randomUUID } from 'node:crypto';
import type {
  MobileDeviceCapture,
  MobileDeviceHostFailure,
  MobileDeviceInventory,
  MobileDevicePlatform,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';

const MAX_INVENTORY_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DEVICES = 256;
const IOS_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ANDROID_ID = /^[a-zA-Z0-9_.-]{1,256}$/;

export class MobileDeviceHostError extends Error {
  constructor(
    readonly code:
      | MobileDeviceHostFailure
      | 'invalid-target'
      | 'device-unavailable',
  ) {
    super('Mobile device inspection is unavailable.');
    this.name = 'MobileDeviceHostError';
  }
}

/** Restrict raw syntax too: URL normalization must not admit numeric IP aliases. */
export function parseMobileDeviceHubOrigin(value: string): string | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/?$/.exec(value);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (port <= 1024 || port > 65535 || port === 3000 || port === 3141)
    return undefined;
  return `http://127.0.0.1:${port}`;
}

export function isMobileDeviceTarget(value: MobileDeviceTarget): boolean {
  return (
    value.hostId === 'local' &&
    typeof value.deviceId === 'string' &&
    (value.platform === 'ios'
      ? IOS_ID.test(value.deviceId)
      : value.platform === 'android' && ANDROID_ID.test(value.deviceId))
  );
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

function parseDevices(value: unknown): {
  devices: MobileDeviceSummary[];
  partial: boolean;
} {
  const body = object(value);
  if (
    !body ||
    !Array.isArray(body.simulators) ||
    !Array.isArray(body.emulators)
  )
    throw new MobileDeviceHostError('invalid-response');
  if (
    body.simulators.length + body.emulators.length > MAX_DEVICES ||
    (body.errors !== undefined && !Array.isArray(body.errors))
  )
    throw new MobileDeviceHostError('invalid-response');
  const devices: MobileDeviceSummary[] = [];
  const seen = new Set<string>();
  for (const [platform, rows] of [
    ['ios', body.simulators],
    ['android', body.emulators],
  ] as const) {
    for (const row of rows) {
      const item = object(row);
      if (!item || typeof item.physical !== 'boolean')
        throw new MobileDeviceHostError('invalid-response');
      // This slice never turns a plugged-in physical phone into a test target.
      if (item.physical) continue;
      if (
        item.platform !== platform ||
        !text(item.id) ||
        !text(item.name) ||
        !text(item.version) ||
        typeof item.booted !== 'boolean' ||
        !isMobileDeviceTarget({
          hostId: 'local',
          platform,
          deviceId: item.id,
        }) ||
        (item.booted &&
          platform === 'android' &&
          !/^emulator-[0-9]+$/.test(item.id))
      )
        throw new MobileDeviceHostError('invalid-response');
      const key = `${platform}:${item.id}`;
      if (seen.has(key)) throw new MobileDeviceHostError('invalid-response');
      seen.add(key);
      devices.push({
        hostId: 'local',
        platform,
        deviceId: item.id,
        name: item.name,
        runtime: item.version,
        booted: item.booted,
      });
    }
  }
  return {
    devices,
    partial: Array.isArray(body.errors) && body.errors.length > 0,
  };
}

/**
 * Explicitly configured, externally owned helper. No process launch, boot,
 * dashboard proxy, caller-supplied endpoint, or mutation authority lives here.
 */
export class LocalMobileDeviceHost {
  readonly #origin: string | undefined;
  readonly #configurationFailure: MobileDeviceHostFailure | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #active = 0;

  constructor(
    options: {
      endpoint?: string;
      fetch?: typeof fetch;
      /** Testable total request/body deadline; production uses 12 seconds. */
      timeoutMs?: number;
    } = {},
  ) {
    this.#origin = options.endpoint
      ? parseMobileDeviceHubOrigin(options.endpoint)
      : undefined;
    this.#configurationFailure = this.#origin
      ? undefined
      : options.endpoint
        ? 'invalid-configuration'
        : 'not-configured';
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 12_000;
  }

  async #read(path: string, method: 'GET' | 'POST', maxBytes: number) {
    if (!this.#origin)
      throw new MobileDeviceHostError(
        this.#configurationFailure ?? 'not-configured',
      );
    if (this.#active >= 2) throw new MobileDeviceHostError('busy');
    this.#active += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method,
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          accept: method === 'POST' ? 'image/png' : 'application/json',
        },
      });
      if (!response.ok || response.redirected)
        throw new MobileDeviceHostError('hub-unavailable');
      const size = response.headers.get('content-length');
      if (size !== null && (!/^\d+$/.test(size) || Number(size) > maxBytes))
        throw new MobileDeviceHostError('response-too-large');
      const expectedType = method === 'POST' ? 'image/png' : 'application/json';
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim() !==
        expectedType
      )
        throw new MobileDeviceHostError('invalid-response');
      if (!response.body) throw new MobileDeviceHostError('invalid-response');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maxBytes)
          throw new MobileDeviceHostError('response-too-large');
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, length);
    } catch (error) {
      if (error instanceof MobileDeviceHostError) throw error;
      throw new MobileDeviceHostError('hub-unavailable');
    } finally {
      controller.abort();
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      this.#active -= 1;
    }
  }

  async inventory(): Promise<MobileDeviceInventory> {
    try {
      const bytes = await this.#read(
        '/api/devices',
        'GET',
        MAX_INVENTORY_BYTES,
      );
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      } catch {
        throw new MobileDeviceHostError('invalid-response');
      }
      const result = parseDevices(payload);
      return {
        hostId: 'local',
        state: result.partial ? 'partial' : 'ready',
        observedAt: new Date().toISOString(),
        devices: result.devices,
      };
    } catch (error) {
      return {
        hostId: 'local',
        state: 'unavailable',
        observedAt: new Date().toISOString(),
        devices: [],
        failure:
          error instanceof MobileDeviceHostError
            ? (error.code as MobileDeviceHostFailure)
            : 'hub-unavailable',
      };
    }
  }

  async capture(target: MobileDeviceTarget): Promise<MobileDeviceCapture> {
    if (!isMobileDeviceTarget(target))
      throw new MobileDeviceHostError('invalid-target');
    // Copy before awaiting: an in-process caller cannot retarget this request.
    const selected = { ...target };
    const inventory = await this.inventory();
    if (inventory.state === 'unavailable')
      throw new MobileDeviceHostError(inventory.failure ?? 'hub-unavailable');
    if (
      !inventory.devices.some(
        (device) =>
          device.platform === selected.platform &&
          device.deviceId === selected.deviceId &&
          device.booted,
      )
    )
      throw new MobileDeviceHostError('device-unavailable');
    const vendor: Record<MobileDevicePlatform, string> = {
      ios: 'serve-sim',
      android: 'serve-emu',
    };
    const bytes = await this.#read(
      `/vendor/${vendor[selected.platform]}/api/screenshot?device=${encodeURIComponent(selected.deviceId)}`,
      'POST',
      MAX_IMAGE_BYTES,
    );
    if (
      bytes.length < 45 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND'
    )
      throw new MobileDeviceHostError('invalid-response');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192)
      throw new MobileDeviceHostError('invalid-response');
    return {
      captureId: randomUUID(),
      target: selected,
      capturedAt: new Date().toISOString(),
      mimeType: 'image/png',
      width,
      height,
      pngBase64: bytes.toString('base64'),
    };
  }
}
