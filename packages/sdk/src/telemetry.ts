import { _getApiBaseSnapshot } from './api-core';
import { createPluginTelemetry } from './client/plugin-telemetry';

export { createPluginTelemetry } from './client/plugin-telemetry';

/** @deprecated Use useTelemetry() inside the mounted Pane. Ambient calls have no Pane capability. */
export const telemetry = {
  forPlugin(capability: string) {
    return createPluginTelemetry(_getApiBaseSnapshot(), capability);
  },
  count(_event: string, _attributes: Record<string, string | number> = {}) {},
  track(_event: string, _attributes: Record<string, string | number> = {}) {},
  async flush() {},
};

/** @deprecated Automatic sdk.* events are undeclared; instrumentation is a no-op. */
export function instrument<T extends (...args: any[]) => Promise<any>>(
  name: string,
  fn: T,
): T {
  const environment = 'env' in import.meta ? import.meta.env : undefined;
  if (
    (typeof process !== 'undefined' &&
      process.env.NODE_ENV === 'development') ||
    (environment &&
      typeof environment === 'object' &&
      'DEV' in environment &&
      environment.DEV === true)
  )
    console.warn(
      `[telemetry] instrument(${name}) is disabled; declare events and use useTelemetry().count().`,
    );
  return fn;
}
