import { useLayoutEffect } from 'react';
import { nativePlatformPromise } from './index';
import type { NativePlatformAdapter } from './types';

type ResolveNativePlatform = () => Promise<NativePlatformAdapter>;

/**
 * Builds the eager, render-only liveness commit. The closure owns exactly one
 * host attempt for the lifetime of this JavaScript module, so React StrictMode
 * and remounts cannot race duplicate native transitions.
 */
export function createNativeRendererMountCommit(
  resolveNativePlatform: ResolveNativePlatform,
) {
  let commit: Promise<void> | undefined;
  return function NativeRendererMountCommit() {
    useLayoutEffect(() => {
      commit ??= resolveNativePlatform()
        .then(async (adapter) => {
          if (adapter.platform !== 'tauri') return;
          const report = await adapter.getCapabilityReport();
          if (
            report.status !== 'ok' ||
            !['linux', 'macos', 'windows'].includes(report.value.platform)
          )
            return;
          await adapter.commitRendererMount();
        })
        .catch(() => {
          // Fail closed. Native startup readiness owns the bounded timeout and
          // Retry/Exit surface; the renderer must not reveal itself or invent
          // a second recovery UI when the host acknowledgement is unavailable.
        });
      void commit;
    }, []);
    return null;
  };
}

export const NativeRendererMountCommit = createNativeRendererMountCommit(
  () => nativePlatformPromise,
);
