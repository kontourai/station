import { randomUUID } from 'node:crypto';
import type {
  MobileDeviceCapture,
  MobileDeviceHostFailure,
  MobileDeviceInventory,
  MobileDevicePlatform,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import {
  type DeviceHubAccessConnection,
  type DeviceHubConnectResult,
  type DeviceHubEndpoint,
  explicitDeviceHubEndpoint,
  parseMobileDeviceHubOrigin,
} from '../devices/device-hub-endpoint.js';

export { parseMobileDeviceHubOrigin };

const MAX_INVENTORY_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DEVICES = 256;
const IOS_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ANDROID_ID = /^[a-zA-Z0-9_.-]{1,256}$/;
const MAX_ACTION_RESPONSE_BYTES = 64 * 1024;
/** A cold simulator/emulator boot can take minutes (t3code allows three). */
const BOOT_TIMEOUT_MS = 180_000;
const SHUTDOWN_TIMEOUT_MS = 60_000;

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

/** A simulator UDID or emulator serial, in the spelling the hub lists. */
export function isValidMobileDeviceId(
  platform: unknown,
  deviceId: unknown,
): platform is MobileDevicePlatform {
  return (
    typeof deviceId === 'string' &&
    (platform === 'ios'
      ? IOS_ID.test(deviceId)
      : platform === 'android' && ANDROID_ID.test(deviceId))
  );
}

function isMobileDeviceTarget(
  value: MobileDeviceTarget,
  /** The host this caller serves; a target naming another host is refused. */
  hostId = 'local',
): boolean {
  return (
    value.hostId === hostId &&
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

function parseDevices(
  value: unknown,
  hostId: string,
): {
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
        !isMobileDeviceTarget(
          {
            hostId,
            platform,
            deviceId: item.id,
          },
          hostId,
        ) ||
        (item.booted &&
          platform === 'android' &&
          !/^emulator-[0-9]+$/.test(item.id))
      )
        throw new MobileDeviceHostError('invalid-response');
      const key = `${platform}:${item.id}`;
      if (seen.has(key)) throw new MobileDeviceHostError('invalid-response');
      seen.add(key);
      devices.push({
        hostId,
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

function validatedPngSize(bytes: Buffer): { width: number; height: number } {
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
  return { width, height };
}

/**
 * Grouped by platform (iOS, then Android), running devices first, then by
 * name — the order a picker shows them in, fixed here so every reader of the
 * list agrees on it.
 */
function sortDevices(devices: MobileDeviceSummary[]): MobileDeviceSummary[] {
  const platformRank = (platform: MobileDevicePlatform) =>
    platform === 'ios' ? 0 : 1;
  return [...devices].sort(
    (a, b) =>
      platformRank(a.platform) - platformRank(b.platform) ||
      Number(b.booted) - Number(a.booted) ||
      a.name.localeCompare(b.name) ||
      a.deviceId.localeCompare(b.deviceId),
  );
}

/** What one hub mutation (boot/attach/shutdown) answered. */
interface HubActionResult {
  ok: boolean;
  id?: string;
  serial?: string;
  error?: string;
}

function parseHubActionResult(value: unknown): HubActionResult {
  const body = object(value);
  if (!body || typeof body.ok !== 'boolean')
    throw new MobileDeviceHostError('invalid-response');
  const out: HubActionResult = { ok: body.ok };
  for (const key of ['id', 'serial', 'error'] as const) {
    const field = body[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || field.length > 4096)
      throw new MobileDeviceHostError('invalid-response');
    out[key] = field;
  }
  return out;
}

/**
 * The device hub's HTTP surface, as Station uses it.
 *
 * Inventory and capture read; `boot`, `attachStream` and `shutdown` are the
 * ONLY mutations, each a fixed hub route with a typed body built here from a
 * validated target (#1970) — never a caller-supplied path, and never the
 * hub's shell-exec routes. Where the hub is comes from a
 * `DeviceHubEndpoint` (explicit configuration today, a supervised hub
 * tomorrow); a bare `endpoint` string is the explicit case.
 */
export class LocalMobileDeviceHost {
  /** The device host this serves (`local`, or an SSH device host, #1973). */
  readonly hostId: string;
  readonly #hub: DeviceHubEndpoint;
  readonly #timeoutMs: number;
  /**
   * In-flight reads, per lane: screenshot polling (a live Android surface
   * without a decoder polls once a second) must never starve the inventory
   * that Start, Open and the picker depend on, so each lane has its own cap.
   */
  readonly #active = { inventory: 0, screenshot: 0 };

  constructor(
    options: {
      endpoint?: string;
      /** Takes precedence over `endpoint`. */
      hub?: DeviceHubEndpoint;
      fetch?: typeof fetch;
      /** Testable total request/body deadline; production uses 12 seconds. */
      timeoutMs?: number;
      /** Defaults to `local`. */
      hostId?: string;
    } = {},
  ) {
    this.hostId = options.hostId ?? 'local';
    this.#hub =
      options.hub ??
      explicitDeviceHubEndpoint(
        options.endpoint,
        options.fetch ? { fetch: options.fetch } : {},
      );
    this.#timeoutMs = options.timeoutMs ?? 12_000;
  }

  /**
   * The hub connection for streaming consumers (the live-surface producer),
   * or the typed reason there is none. Asked per use, never cached.
   */
  async connect(): Promise<DeviceHubConnectResult> {
    return this.#hub.connect();
  }

  async #connection(): Promise<DeviceHubAccessConnection> {
    const result = await this.#hub.connect();
    if (!result.ok) throw new MobileDeviceHostError(result.failure);
    return result.connection;
  }

  async #read(path: string, method: 'GET' | 'POST', maxBytes: number) {
    const connection = await this.#connection();
    const lane = method === 'POST' ? 'screenshot' : 'inventory';
    if (this.#active[lane] >= 2) throw new MobileDeviceHostError('busy');
    this.#active[lane] += 1;
    try {
      return await this.#exchange(connection, path, {
        method,
        maxBytes,
        accept: method === 'POST' ? 'image/png' : 'application/json',
        timeoutMs: this.#timeoutMs,
      });
    } finally {
      this.#active[lane] -= 1;
    }
  }

  async #exchange(
    connection: DeviceHubAccessConnection,
    path: string,
    request: {
      method: 'GET' | 'POST';
      maxBytes: number;
      accept: 'image/png' | 'application/json';
      timeoutMs: number;
      json?: unknown;
    },
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Through the connection's allowlist: a path it refuses rejects here
      // and reads as `hub-unavailable`, never as a request made around it.
      const response = await connection.request(request.method, path, {
        signal: controller.signal,
        headers: {
          accept: request.accept,
          ...(request.json === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(request.json === undefined
          ? {}
          : { body: JSON.stringify(request.json) }),
      });
      // A hub action answers its `{ ok:false, error }` with a 4xx/5xx, which
      // is still a typed answer worth reading (e.g. "no space left").
      const actionAnswer = request.json !== undefined && response.status >= 400;
      if ((!response.ok && !actionAnswer) || response.redirected)
        throw new MobileDeviceHostError('hub-unavailable');
      const size = response.headers.get('content-length');
      if (
        size !== null &&
        (!/^\d+$/.test(size) || Number(size) > request.maxBytes)
      )
        throw new MobileDeviceHostError('response-too-large');
      const expectedType = request.accept;
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
        if (length > request.maxBytes)
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
    }
  }

  /** One fixed hub mutation route with a typed JSON body. */
  async #action(
    path: string,
    json: Record<string, string>,
    timeoutMs: number,
  ): Promise<HubActionResult> {
    const connection = await this.#connection();
    const bytes = await this.#exchange(connection, path, {
      method: 'POST',
      maxBytes: MAX_ACTION_RESPONSE_BYTES,
      accept: 'application/json',
      timeoutMs,
      json,
    });
    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw new MobileDeviceHostError('invalid-response');
    }
    return parseHubActionResult(payload);
  }

  /**
   * Boot a stopped device through the hub, so the hub's list and its
   * streaming helper both see it come up. Returns the id the device is now
   * listed under: an Android AVD is listed by name while stopped and by its
   * `emulator-<n>` serial once running.
   */
  async boot(
    target: MobileDeviceTarget,
    name: string,
  ): Promise<{ deviceId: string }> {
    if (!isMobileDeviceTarget(target, this.hostId) || !text(name))
      throw new MobileDeviceHostError('invalid-target');
    const selected = { ...target };
    const result = await this.#action(
      '/api/devices/boot',
      { platform: selected.platform, id: selected.deviceId, name },
      BOOT_TIMEOUT_MS,
    );
    if (!result.ok) throw new MobileDeviceHostError('device-unavailable');
    const deviceId = result.serial ?? result.id ?? selected.deviceId;
    if (
      !isMobileDeviceTarget(
        {
          hostId: this.hostId,
          platform: selected.platform,
          deviceId,
        },
        this.hostId,
      )
    )
      throw new MobileDeviceHostError('invalid-response');
    if (selected.platform === 'ios') await this.attachStream(deviceId);
    return { deviceId };
  }

  /**
   * Attach the hub's iOS streaming helper to a booted simulator (booting
   * alone does not). Idempotent for a simulator already attached.
   */
  async attachStream(udid: string): Promise<void> {
    if (!IOS_ID.test(udid)) throw new MobileDeviceHostError('invalid-target');
    const result = await this.#action(
      '/vendor/serve-sim/grid/api/start',
      { udid },
      BOOT_TIMEOUT_MS,
    );
    if (!result.ok) throw new MobileDeviceHostError('device-unavailable');
  }

  /**
   * Shut a device down (Power off). iOS goes through the streaming helper's
   * own shutdown, which also drops its capture session; a simulator that is
   * already off answers `ok:false` there, which is accepted only when the
   * hub's list confirms it is off.
   */
  async shutdown(target: MobileDeviceTarget): Promise<void> {
    if (!isMobileDeviceTarget(target, this.hostId))
      throw new MobileDeviceHostError('invalid-target');
    const selected = { ...target };
    const result =
      selected.platform === 'ios'
        ? await this.#action(
            '/vendor/serve-sim/grid/api/shutdown',
            { udid: selected.deviceId },
            SHUTDOWN_TIMEOUT_MS,
          )
        : await this.#action(
            '/api/devices/shutdown',
            {
              platform: 'android',
              id: selected.deviceId,
              name: selected.deviceId,
            },
            SHUTDOWN_TIMEOUT_MS,
          );
    if (result.ok) return;
    const inventory = await this.inventory();
    const row = inventory.devices.find(
      (device) =>
        device.platform === selected.platform &&
        device.deviceId === selected.deviceId,
    );
    if (inventory.state !== 'unavailable' && row && !row.booted) return;
    throw new MobileDeviceHostError('device-unavailable');
  }

  /**
   * One PNG screenshot of a booted device, validated, without the inventory
   * round trip `capture` makes (the caller already holds an open session).
   */
  async screenshot(target: MobileDeviceTarget): Promise<{
    png: Buffer;
    width: number;
    height: number;
  }> {
    if (!isMobileDeviceTarget(target, this.hostId))
      throw new MobileDeviceHostError('invalid-target');
    const vendor: Record<MobileDevicePlatform, string> = {
      ios: 'serve-sim',
      android: 'serve-emu',
    };
    const bytes = await this.#read(
      `/vendor/${vendor[target.platform]}/api/screenshot?device=${encodeURIComponent(target.deviceId)}`,
      'POST',
      MAX_IMAGE_BYTES,
    );
    return { png: bytes, ...validatedPngSize(bytes) };
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
      const result = parseDevices(payload, this.hostId);
      return {
        hostId: this.hostId,
        state: result.partial ? 'partial' : 'ready',
        observedAt: new Date().toISOString(),
        devices: sortDevices(result.devices),
      };
    } catch (error) {
      return {
        hostId: this.hostId,
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
    if (!isMobileDeviceTarget(target, this.hostId))
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
    const { width, height } = validatedPngSize(bytes);
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
