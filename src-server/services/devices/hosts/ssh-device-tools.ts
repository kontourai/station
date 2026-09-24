/**
 * The Device Tools drawer and Android rotation on an SSH device host
 * (#2442), Station side.
 *
 * The drawer's service (`DeviceToolsService`) is the SAME class for every
 * host: it builds each argument vector, refuses any vector outside
 * `DEVICE_TOOL_ARGV_SHAPES`, and applies the per-invocation deadline and
 * output bound, the parsers and the accessibility caps. For an SSH device
 * host it is built with:
 *
 * - a runner that runs each vector ON THAT HOST through the device-host
 *   program's `tool` mode ({@link createSshDeviceToolRunner}) — checked once
 *   more against the allowlist here, before any ssh starts, and again by
 *   the program on the host; every value travels as JSON on stdin, and the
 *   ssh command line is the constant loader;
 * - that host's OWN hub endpoint (its forward, with its per-launch secret)
 *   for the accessibility tree and the iOS foreground app — never the local
 *   hub ({@link createSshDeviceToolsService}).
 *
 * Whether a host may run anything (the operator enabled it: `hubEnabled`),
 * and how many runs it takes at once, is the registry's
 * (`DeviceHostRegistry.runTool`).
 */

import {
  androidRotateCommands,
  type DeviceHostActions,
  DeviceToolError,
} from '../device-host-tools.js';
import type { DeviceHubEndpoint } from '../device-hub-endpoint.js';
import {
  type DeviceTool,
  type DeviceToolRunner,
  DeviceToolsError,
  DeviceToolsService,
} from '../device-tools.js';
import { REMOTE_TOOL_LIMITS } from './ssh-device-remote-script.js';
import { runSshDeviceScript, type SpawnSsh } from './ssh-device-session.js';
import type { SshDeviceTarget } from './ssh-device-target.js';
import { isAllowedSshDeviceToolArgv } from './ssh-device-tool-allowlist.js';

export interface SshToolRequest {
  tool: DeviceTool;
  args: readonly string[];
  /** A push payload: JSON on stdin to the host, then the tool's stdin. */
  stdin?: string;
  /**
   * Further vectors of the SAME tool, run in order on the host in the same
   * run — one ssh handshake, one slot, one deadline (an Android rotation).
   * The run stops at the first failure. Never with `stdin`.
   */
  followedBy?: readonly (readonly string[])[];
  /**
   * Go on past a vector the tool refuses (non-zero exit) and report which
   * (`failed`): an Android permission group. A timeout still stops the run.
   */
  keepGoing?: boolean;
  /** The hard deadline for the whole run, as the local runner has it. */
  timeoutMs: number;
  /** The most output the tool may print. */
  maxBuffer: number;
}

export type SshToolFailure =
  | 'tool-unavailable'
  | 'tool-failed'
  | 'tool-timeout'
  /** The vector is outside the allowlist (here or on the host): nothing ran. */
  | 'tool-refused'
  /** ssh did not reach the host, or the run was cancelled (host changed). */
  | 'host-unavailable'
  /** The operator has not enabled this host: no ssh was started. */
  | 'not-enabled'
  /** The caller gave up (its signal aborted): nothing more runs. */
  | 'cancelled';

export type SshToolOutcome =
  | {
      ok: true;
      stdout: string;
      /** With `keepGoing`: the indexes of vectors the tool refused. */
      failed?: number[];
    }
  | {
      ok: false;
      failure: SshToolFailure;
      /**
       * Vectors of the run the host reported as completed before it
       * stopped. Absent when it never reported (nothing is known).
       */
      applied?: number;
    };

/**
 * The caller's hold on one run (#2442 review M1/M2). `deadlineAt` (epoch
 * ms) bounds the WHOLE run, the wait for a host slot included: a wait that
 * outlives it runs nothing, and the vector gets only what is left.
 * `signal` cancels at any point (a waiting run leaves the queue; a running
 * one has its ssh killed, which stops it on the host too). `beforeRun` is
 * asked once the slot is granted and before any ssh: it throws to refuse.
 */
export interface SshToolControl {
  signal?: AbortSignal;
  deadlineAt?: number;
  beforeRun?: () => void | Promise<void>;
}

/** A timeout past the host's ceiling is clamped to it, never refused. */
export function clampSshToolRequest(request: SshToolRequest): SshToolRequest {
  return Number.isFinite(request.timeoutMs) &&
    request.timeoutMs > REMOTE_TOOL_LIMITS.maxTimeoutMs
    ? { ...request, timeoutMs: REMOTE_TOOL_LIMITS.maxTimeoutMs }
    : request;
}

/** The default output bound, as `runBoundedToolCapture` has it. */
const DEFAULT_MAX_BUFFER = 256 * 1024;

/** The request is one Station may send: allowlisted, and within limits. */
export function isValidSshToolRequest(request: SshToolRequest): boolean {
  // `followedBy: null` is refused, exactly as the host program refuses it
  // (round 3, N1): only an absent list means "no further vectors".
  const followedBy = request.followedBy === undefined ? [] : request.followedBy;
  return (
    isAllowedSshDeviceToolArgv(request.tool, request.args) &&
    Array.isArray(followedBy) &&
    followedBy.length <= REMOTE_TOOL_LIMITS.maxFollowedBy &&
    followedBy.every((args) =>
      isAllowedSshDeviceToolArgv(request.tool, args),
    ) &&
    (followedBy.length === 0 || request.stdin === undefined) &&
    (request.keepGoing === undefined ||
      typeof request.keepGoing === 'boolean') &&
    Number.isSafeInteger(request.timeoutMs) &&
    request.timeoutMs >= 1 &&
    request.timeoutMs <= REMOTE_TOOL_LIMITS.maxTimeoutMs &&
    Number.isSafeInteger(request.maxBuffer) &&
    request.maxBuffer >= 1 &&
    request.maxBuffer <= REMOTE_TOOL_LIMITS.maxBuffer &&
    (request.stdin === undefined ||
      (typeof request.stdin === 'string' &&
        Buffer.byteLength(request.stdin, 'utf8') <=
          REMOTE_TOOL_LIMITS.maxStdinBytes))
  );
}

const TOOL_FAILURES: readonly SshToolFailure[] = [
  'tool-unavailable',
  'tool-failed',
  'tool-timeout',
  'tool-refused',
  'cancelled',
];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Run one vector on the host. Refused here, without ssh, when it is not
 * allowlisted. Station's own deadline is `timeoutMs` — the same hard
 * deadline the local runner has (ssh's own setup counts against it) — and
 * stdout is bounded by what `maxBuffer` of output encodes to.
 */
export async function runSshDeviceTool(input: {
  target: SshDeviceTarget;
  request: SshToolRequest;
  spawn?: SpawnSsh;
  signal?: AbortSignal;
}): Promise<SshToolOutcome> {
  const request = clampSshToolRequest(input.request);
  if (!isValidSshToolRequest(request))
    return { ok: false, failure: 'tool-refused' };
  if (input.signal?.aborted) return { ok: false, failure: 'cancelled' };
  const run = await runSshDeviceScript({
    target: input.target,
    params: {
      mode: 'tool',
      tool: request.tool,
      args: [...request.args],
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.followedBy?.length
        ? { followedBy: request.followedBy.map((args) => [...args]) }
        : {}),
      ...(request.keepGoing ? { keepGoing: true } : {}),
      timeoutMs: request.timeoutMs,
      maxBuffer: request.maxBuffer,
      cancelOnClose: true,
    },
    // stdin stays open while the run lasts: killing this ssh (the deadline
    // below, or the caller's signal) then stops the run on the host.
    holdStdin: true,
    timeoutMs: request.timeoutMs,
    // base64 of maxBuffer bytes, plus the event's own few bytes.
    maxStdoutBytes: Math.ceil(request.maxBuffer / 3) * 4 + 1024,
    ...(input.spawn ? { spawn: input.spawn } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (input.signal?.aborted) return { ok: false, failure: 'cancelled' };
  if (run.overflow) return { ok: false, failure: 'tool-failed' };
  const event = run.events.find((candidate) => candidate.event === 'tool');
  if (event?.ok === true) {
    if (typeof event.stdout !== 'string' || !BASE64.test(event.stdout))
      return { ok: false, failure: 'tool-failed' };
    const stdout = Buffer.from(event.stdout, 'base64');
    if (stdout.byteLength > request.maxBuffer)
      return { ok: false, failure: 'tool-failed' };
    const count = 1 + (request.followedBy?.length ?? 0);
    const failed = Array.isArray(event.failed)
      ? event.failed.filter(
          (at): at is number =>
            Number.isSafeInteger(at) &&
            (at as number) >= 0 &&
            (at as number) < count,
        )
      : undefined;
    return {
      ok: true,
      stdout: stdout.toString('utf8'),
      ...(request.keepGoing && failed ? { failed } : {}),
    };
  }
  if (event?.ok === false)
    return {
      ok: false,
      failure:
        TOOL_FAILURES.find((failure) => failure === event.failure) ??
        'tool-failed',
      ...(Number.isSafeInteger(event.applied) && (event.applied as number) >= 0
        ? { applied: event.applied as number }
        : {}),
    };
  if (run.failure === 'timeout') return { ok: false, failure: 'tool-timeout' };
  // The program refused the request's shape: Station and host disagree.
  if (run.failure === 'protocol') return { ok: false, failure: 'tool-failed' };
  return { ok: false, failure: 'host-unavailable' };
}

/** What the runner and the rotation need from the registry. */
export interface SshDeviceToolHost {
  /** Throws `DeviceHostBusyError` when the host has no free slot. */
  runTool(
    hostId: string,
    request: SshToolRequest,
    control?: SshToolControl,
  ): Promise<SshToolOutcome>;
  /**
   * Changes whenever the host stops being the machine it was (retargeted,
   * removed, disabled): state kept about its devices is then dropped.
   */
  generation(hostId: string): number;
}

function throwFailure(failure: SshToolFailure): never {
  switch (failure) {
    case 'tool-unavailable':
      throw new DeviceToolError(failure, 'the tool is not on the device host');
    case 'tool-failed':
      throw new DeviceToolError(failure, 'the tool failed on the device host');
    case 'tool-timeout':
    case 'cancelled':
      throw new DeviceToolError('tool-timeout', 'the tool timed out');
    case 'tool-refused':
      throw new DeviceToolsError('invalid-request');
    case 'not-enabled':
      throw new DeviceToolsError('device-host-not-enabled');
    default:
      throw new DeviceToolsError('device-host-unavailable');
  }
}

/** The Tools drawer's runner for one SSH device host. */
export function createSshDeviceToolRunner(
  host: SshDeviceToolHost,
  hostId: string,
): DeviceToolRunner {
  return {
    async run(tool, args, options) {
      const outcome = await host.runTool(
        hostId,
        {
          tool,
          args,
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
          timeoutMs: options.timeoutMs,
          maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        },
        options.beforeRun ? { beforeRun: options.beforeRun } : undefined,
      );
      if (!outcome.ok) throwFailure(outcome.failure);
      return outcome.stdout;
    },
    /**
     * A permission group as ONE run of the host's `tool` mode (round 3,
     * D2): one slot, one re-admission after it, one deadline, the vectors
     * sequenced on the host, going on past a permission `pm` refuses (as
     * the local loop does). A run that stops early after applying some of
     * the group succeeds, as the local loop does; the read-back says what
     * holds.
     */
    async runSequence(tool, commands, options) {
      const [first, ...followedBy] = commands;
      if (!first) throw new DeviceToolsError('invalid-request');
      const outcome = await host.runTool(
        hostId,
        {
          tool,
          args: first,
          followedBy,
          keepGoing: true,
          timeoutMs: options.timeoutMs,
          maxBuffer: 64 * 1024,
        },
        options.beforeRun ? { beforeRun: options.beforeRun } : undefined,
      );
      if (outcome.ok) return;
      // Some of the group applied before the run stopped (a timeout): the
      // same answer the local loop gives when any command changed — the
      // action succeeds and the permission read-back reports what now holds
      // (final review R1). Only a run that applied nothing fails, and only a
      // timeout or a tool failure that stopped strictly partway counts: any
      // other failure, or an `applied` the group could not reach, fails.
      if (
        (outcome.failure === 'tool-timeout' ||
          outcome.failure === 'tool-failed') &&
        outcome.applied !== undefined &&
        outcome.applied > 0 &&
        outcome.applied < commands.length
      )
        return;
      throwFailure(outcome.failure);
    },
  };
}

/**
 * Android rotation on an SSH device host (#2442 review M1): the three `adb`
 * vectors the local host runs (`androidRotateCommands`) as ONE run of the
 * host's `tool` mode — one ssh handshake, one slot, one deadline, and the
 * vectors sequenced on the host. Three separate runs would pay three
 * handshakes inside the producer's dispatch deadline (3 s by default),
 * which over a tailnet routinely does not fit, and would each wait for a
 * slot of their own.
 *
 * The caller's deadline covers the wait for the slot as well as the run;
 * its signal cancels either (the ssh is killed, and the host program stops
 * on its stdin closing); its `beforeRun` (the lease) is asked once the slot
 * is granted and before any ssh.
 *
 * Order: the two vectors that only ALLOW rotation (accelerometer rotation
 * on, user rotation free) run first; the one that rotates (the emulated
 * accelerometer) runs last. A run that stops early therefore never leaves a
 * half-rotated screen: at worst auto-rotation is left enabled, which is
 * what every completed rotation leaves anyway. It is still reported as
 * partial, with how many steps were applied.
 */
export function createSshDeviceHostActions(
  host: SshDeviceToolHost,
  hostId: string,
): DeviceHostActions {
  return {
    async rotateAndroid(serial, orientation, timeoutMs, control) {
      const [first, ...followedBy] = androidRotateCommands(serial, orientation);
      const outcome = await host.runTool(
        hostId,
        {
          tool: 'adb',
          args: first!,
          followedBy,
          timeoutMs,
          maxBuffer: 64 * 1024,
        },
        {
          deadlineAt: Date.now() + timeoutMs,
          ...(control?.signal ? { signal: control.signal } : {}),
          ...(control?.beforeRun ? { beforeRun: control.beforeRun } : {}),
        },
      );
      if (outcome.ok) return;
      if (outcome.applied !== undefined && outcome.applied > 0)
        throw new DeviceToolError(
          outcome.failure === 'tool-timeout' ? 'tool-timeout' : 'tool-failed',
          `rotation partly applied: ${outcome.applied} of ${followedBy.length + 1} steps; the rotating step ${outcome.applied < followedBy.length ? 'did not run' : 'did not complete'}`,
        );
      throwFailure(outcome.failure);
    },
  };
}

/**
 * The drawer's service for one SSH device host: that host's runner and
 * that host's OWN hub endpoint. The runtime builds it here, and so do the
 * tests, so what they prove is what runs.
 */
export function createSshDeviceToolsService(input: {
  hostId: string;
  host: SshDeviceToolHost;
  /** The host's forwarded hub (`DeviceHostRegistry.endpoint(hostId)`). */
  endpoint: Pick<DeviceHubEndpoint, 'connect'>;
}): DeviceToolsService {
  return new DeviceToolsService({
    hostId: input.hostId,
    runner: createSshDeviceToolRunner(input.host, input.hostId),
    hub: input.endpoint,
  });
}
