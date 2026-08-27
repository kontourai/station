const TRUSTED_NATIVE_STATION_CONTROL = Symbol(
  'station.trusted-native-station-control',
);

/**
 * Marks a tool created from Station's verified built-in station-control
 * definition. The enumerable symbol survives the runtime's intentional
 * object-spread wrappers without admitting a user-authored name as proof.
 */
export function markTrustedNativeStationControlTool<T extends object>(
  tool: T,
): T {
  Object.defineProperty(tool, TRUSTED_NATIVE_STATION_CONTROL, {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
  return tool;
}

export function isTrustedNativeStationControlTool(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Record<PropertyKey, unknown>)[
        TRUSTED_NATIVE_STATION_CONTROL
      ] === true,
  );
}
