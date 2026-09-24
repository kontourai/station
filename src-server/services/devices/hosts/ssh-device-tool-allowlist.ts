/**
 * The argument vectors an SSH device host may run for Station (#2442): the
 * Tools drawer's fixed shapes (`DEVICE_TOOL_ARGV_SHAPES`) and an Android
 * rotation's (`ANDROID_ROTATE_ARGV_SHAPES`), and nothing else.
 *
 * The boundary is HERE: {@link isAllowedSshDeviceToolArgv} refuses a vector
 * before Station opens an ssh session at all. The device-host program
 * checks every vector again against {@link SSH_DEVICE_TOOL_ALLOWLIST_JSON},
 * the same shapes serialized into its source — defence in depth against a
 * Station bug (a builder or runner that skipped the check), NOT a trust
 * boundary: the program itself arrives from Station on stdin with every
 * call, so it can never constrain a compromised Station. Per-call
 * parameters travel separately (JSON on stdin) and cannot widen the list.
 */
import { ANDROID_ROTATE_ARGV_SHAPES } from '../device-host-tools.js';
import {
  type ArgPart,
  DEVICE_TOOL_ARGV_SHAPES,
  type DeviceTool,
  matchesArgvShapes,
} from '../device-tools.js';

export const SSH_DEVICE_TOOL_ARGV_SHAPES: Readonly<
  Record<DeviceTool, readonly (readonly ArgPart[])[]>
> = {
  xcrun: DEVICE_TOOL_ARGV_SHAPES.xcrun,
  adb: [...DEVICE_TOOL_ARGV_SHAPES.adb, ...ANDROID_ROTATE_ARGV_SHAPES],
};

function isSshDeviceTool(value: unknown): value is DeviceTool {
  return value === 'xcrun' || value === 'adb';
}

/** Whether Station may ask an SSH device host to run `tool args`. */
export function isAllowedSshDeviceToolArgv(
  tool: unknown,
  args: readonly string[],
): boolean {
  return (
    isSshDeviceTool(tool) &&
    matchesArgvShapes(SSH_DEVICE_TOOL_ARGV_SHAPES[tool], args)
  );
}

/** A shape part as the host program reads it: a literal, or `{re}`. */
export type SerializedArgPart = string | { re: string };

/** The shapes as plain JSON (a RegExp by its source; flags are refused). */
export function serializeArgvShapes(
  shapes: Readonly<Record<string, readonly (readonly ArgPart[])[]>>,
): Record<string, SerializedArgPart[][]> {
  const out: Record<string, SerializedArgPart[][]> = {};
  for (const [tool, list] of Object.entries(shapes))
    out[tool] = list.map((shape) =>
      shape.map((part) => {
        if (typeof part === 'string') return part;
        if (part.flags !== '')
          throw new Error('argv shape patterns take no flags');
        return { re: part.source };
      }),
    );
  return out;
}

/** Embedded in the device-host program's source (see the module docblock). */
export const SSH_DEVICE_TOOL_ALLOWLIST_JSON = JSON.stringify(
  serializeArgvShapes(SSH_DEVICE_TOOL_ARGV_SHAPES),
);
