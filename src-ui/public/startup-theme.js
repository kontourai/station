// Runs before first paint without loading the application module graph.
// Keep the envelope/prior-key precedence aligned with resolveBootTheme.
(() => {
  let theme = 'dark';
  try {
    const prior = localStorage.getItem('theme');
    if (prior === 'light' || prior === 'dark') theme = prior;
    try {
      const saved = JSON.parse(
        localStorage.getItem('station-device-settings-v1'),
      )?.values?.theme;
      if (saved === 'light' || saved === 'dark') theme = saved;
    } catch {
      // A malformed envelope still permits the legacy theme preference.
    }
  } catch {
    // Storage can be unavailable in a WebView; retain Station's default.
  }
  document.documentElement.dataset.theme = theme;

  // The splash mark is per channel, but the native host reports the channel
  // only after the app module graph loads. Each install has its own WebView
  // storage, so the identity this install last reported (written by
  // PlatformProfileContext) picks the mark before first paint. A first
  // launch has none yet and shows the stable mark until the report arrives.
  try {
    const mark = localStorage.getItem('station-startup-mark');
    if (mark === 'dev' || mark === 'beta' || mark === 'nightly')
      document.documentElement.dataset.startupMark = mark;
  } catch {
    // Without storage the stable mark is the honest default.
  }
})();
