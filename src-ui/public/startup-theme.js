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
})();
