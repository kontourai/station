// Runs before first paint without loading the application module graph.
// Keep the envelope/prior-key precedence aligned with resolveBootTheme.
(() => {
  const root = document.documentElement;
  let theme = 'dark';
  let saved = null;
  try {
    const prior = localStorage.getItem('theme');
    if (prior === 'light' || prior === 'dark') theme = prior;
    try {
      saved = JSON.parse(
        localStorage.getItem('station-device-settings-v1'),
      )?.values;
      if (saved?.theme === 'light' || saved?.theme === 'dark')
        theme = saved.theme;
    } catch {
      // A malformed envelope still permits the legacy theme preference.
    }
  } catch {
    // Storage can be unavailable in a WebView; retain Station's default.
  }
  root.dataset.theme = theme;

  // Color theme (docs/decisions/user-color-themes.md): stamp the selection the
  // generated stylesheet keys on, and its page canvas as theme-color, before
  // the stylesheets load (Station adds neither). Resolved like lib/color-theme-selection.ts
  // resolveColorThemeSelection: an unknown family is Station (no attributes),
  // an unknown flavor or accent is the family default. The setting is new, so
  // it has no prior key. The index below is generated from the catalog.
  // BEGIN GENERATED COLOR THEMES (npm run gen:color-themes; do not edit)
  const COLOR_THEMES = JSON.parse(
    '{"catppuccin":{"stylesheet":"/color-themes/catppuccin.css?v=e4a47673","light":{"id":"latte","background":"#e6e9ef"},"dark":[{"id":"frappe","background":"#292c3c"},{"id":"macchiato","background":"#1e2030"},{"id":"mocha","background":"#181825"}],"defaultDarkFlavor":"mocha","accents":["rosewater","flamingo","pink","mauve","red","maroon","peach","yellow","green","teal","sky","sapphire","blue","lavender"],"defaultAccent":"mauve"},"rose-pine":{"stylesheet":"/color-themes/rose-pine.css?v=14c139cf","light":{"id":"dawn","background":"#faf4ed"},"dark":[{"id":"main","background":"#191724"},{"id":"moon","background":"#232136"}],"defaultDarkFlavor":"main","accents":["love","gold","rose","pine","foam","iris"],"defaultAccent":"iris"},"gruvbox":{"stylesheet":"/color-themes/gruvbox.css?v=c5736a71","light":{"id":"light","background":"#f2e5bc"},"dark":[{"id":"dark","background":"#1d2021"}],"defaultDarkFlavor":"dark","accents":["red","green","yellow","blue","purple","aqua","orange"],"defaultAccent":"orange"},"nord":{"stylesheet":"/color-themes/nord.css?v=af91296a","light":{"id":"snow-storm","background":"#e5e9f0"},"dark":[{"id":"polar-night","background":"#2e3440"}],"defaultDarkFlavor":"polar-night","accents":["frost","teal","blue","deep-blue","red","orange","yellow","green","purple"],"defaultAccent":"frost"},"tokyo-night":{"stylesheet":"/color-themes/tokyo-night.css?v=cceca5b5","light":{"id":"day","background":"#d0d5e3"},"dark":[{"id":"night","background":"#16161e"},{"id":"storm","background":"#1f2335"}],"defaultDarkFlavor":"night","accents":["blue","cyan","teal","green","yellow","orange","red","magenta","purple"],"defaultAccent":"blue"}}',
  );
  // END GENERATED COLOR THEMES
  try {
    // Object.hasOwn is newer than the oldest supported Android WebView
    // (minSdk 24 can run a WebView before Chrome 93).
    const own = (object, key) =>
      // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn needs Chrome 93.
      Object.prototype.hasOwnProperty.call(object, key);
    const family = own(COLOR_THEMES, saved?.colorTheme)
      ? COLOR_THEMES[saved.colorTheme]
      : null;
    if (family) {
      const dark =
        family.dark.find((entry) => entry.id === saved.colorThemeFlavor) ||
        family.dark.find((entry) => entry.id === family.defaultDarkFlavor);
      const flavor = dark.id;
      const accent = family.accents.includes(saved.colorThemeAccent)
        ? saved.colorThemeAccent
        : family.defaultAccent;
      root.dataset.colorTheme = saved.colorTheme;
      root.dataset.colorThemeFlavor = flavor;
      root.dataset.colorThemeAccent = accent;
      // The family's own sheet, so default users never download any theme.
      // A script-inserted sheet does not block rendering: the splash paints
      // from the startup subset meanwhile, and main.tsx waits for this one
      // (lib/color-theme-apply.ts whenColorThemeStylesheetSettled) before the
      // app's first render. Its state attribute lets that wait tell a sheet
      // that already loaded or failed from one still loading.
      const sheet = document.createElement('link');
      sheet.rel = 'stylesheet';
      sheet.id = 'station-color-theme';
      sheet.href = family.stylesheet;
      sheet.dataset.colorThemeFamily = saved.colorTheme;
      sheet.onload = () => {
        sheet.dataset.state = 'loaded';
      };
      sheet.onerror = () => {
        sheet.dataset.state = 'failed';
      };
      document.head.append(sheet);
      // Only a named theme tints browser chrome; Station adds no meta, so a
      // default page is unchanged.
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.setAttribute('data-color-theme-meta', '');
      meta.content =
        theme === 'light' ? family.light.background : dark.background;
      document.head.append(meta);
    }
  } catch {
    // Without a readable selection Station's own colours are the default.
  }

  // The splash mark is per channel, but the native host reports the channel
  // only after the app module graph loads. Each install has its own WebView
  // storage, so the identity this install last reported (written by
  // PlatformProfileContext) picks the mark before first paint. A first
  // launch has none yet and shows the stable mark until the report arrives.
  try {
    const mark = localStorage.getItem('station-startup-mark');
    if (mark === 'dev' || mark === 'beta' || mark === 'nightly')
      root.dataset.startupMark = mark;
  } catch {
    // Without storage the stable mark is the honest default.
  }
})();
