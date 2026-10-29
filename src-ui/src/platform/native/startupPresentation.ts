import {
  allowInitialStartupAnimation,
  initialStartupIsActive,
} from '../../lib/startup-presentation';
import { nativePlatformPromise } from './index';

/** Native admission is independent of document visibility behind a cover. */
export function observeInitialStartupVisibility() {
  void nativePlatformPromise
    .then(async (adapter) => {
      if (!initialStartupIsActive()) return;
      if (adapter.platform === 'tauri') {
        const report = await adapter.getCapabilityReport();
        if (report.status !== 'ok') return;
        if (['linux', 'macos', 'windows'].includes(report.value.platform)) {
          const check = async () => {
            if (!initialStartupIsActive()) return;
            const admitted = await adapter.isStartupWindowAdmitted();
            if (!initialStartupIsActive() || admitted.status !== 'ok') return;
            if (admitted.value) allowInitialStartupAnimation();
            else window.setTimeout(() => void check().catch(() => {}), 100);
          };
          await check();
          return;
        }
      }
      if (initialStartupIsActive()) allowInitialStartupAnimation();
    })
    .catch(() => {
      // Without an admission observation the intro stays static and never
      // holds a ready app. Native readiness still owns its recovery surface.
    });
}
