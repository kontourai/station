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
  // the stylesheets load (Station adds neither). Resolved like lib/color-themes.ts
  // resolveColorThemeSelection: an unknown family is Station (no attributes),
  // an unknown flavor or accent is the family default. The setting is new, so
  // it has no prior key. The index below is generated from the catalog.
  // BEGIN GENERATED COLOR THEMES (npm run gen:color-themes; do not edit)
  const COLOR_THEMES = JSON.parse(
    '{"catppuccin":{"light":"#e6e9ef","dark":{"frappe":"#292c3c","macchiato":"#1e2030","mocha":"#181825"},"defaultDark":"mocha","accents":["rosewater","flamingo","pink","mauve","red","maroon","peach","yellow","green","teal","sky","sapphire","blue","lavender"],"defaultAccent":"mauve"},"rose-pine":{"light":"#faf4ed","dark":{"main":"#191724","moon":"#232136"},"defaultDark":"main","accents":["love","gold","rose","pine","foam","iris"],"defaultAccent":"iris"},"gruvbox":{"light":"#f2e5bc","dark":{"dark":"#1d2021"},"defaultDark":"dark","accents":["red","green","yellow","blue","purple","aqua","orange"],"defaultAccent":"orange"},"nord":{"light":"#e5e9f0","dark":{"polar-night":"#2e3440"},"defaultDark":"polar-night","accents":["frost","teal","blue","deep-blue","red","orange","yellow","green","purple"],"defaultAccent":"frost"},"tokyo-night":{"light":"#d0d5e3","dark":{"night":"#16161e","storm":"#1f2335"},"defaultDark":"night","accents":["blue","cyan","teal","green","yellow","orange","red","magenta","purple"],"defaultAccent":"blue"}}',
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
      const flavor = own(family.dark, saved.colorThemeFlavor)
        ? saved.colorThemeFlavor
        : family.defaultDark;
      const accent = family.accents.includes(saved.colorThemeAccent)
        ? saved.colorThemeAccent
        : family.defaultAccent;
      root.dataset.colorTheme = saved.colorTheme;
      root.dataset.colorThemeFlavor = flavor;
      root.dataset.colorThemeAccent = accent;
      // Only a named theme tints browser chrome; Station adds no meta, so a
      // default page is unchanged.
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.setAttribute('data-color-theme-meta', '');
      meta.content = theme === 'light' ? family.light : family.dark[flavor];
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
