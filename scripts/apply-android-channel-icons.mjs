#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAndroidThemedIcon } from './lib/android-themed-icon.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { CHANNEL_PALETTES } from './lib/station-icon.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ANDROID_ICON_CHANNELS = ['stable', 'dev', 'beta', 'nightly'];
// Android colour resources are #AARRGGBB.
const opaque = (hex) => `#FF${hex.slice(1).toUpperCase()}`;

// Each accent is its channel's icon water colour, so the Android 12+ theme
// accent matches the launcher icon. `splashBackground` fills the adaptive
// launcher icon's background layer (ic_launcher_background) with a light
// tint of the same hue; the opaque full-bleed foreground normally covers it.
export const ANDROID_CHANNEL_IDENTITY = {
  stable: {
    appName: 'Station',
    accent: opaque(CHANNEL_PALETTES.stable.water),
    splashBackground: '#FFFFFFFF',
  },
  dev: {
    appName: 'Station Dev',
    accent: opaque(CHANNEL_PALETTES.dev.water),
    splashBackground: '#FFFFF8E7',
  },
  beta: {
    appName: 'Station Beta',
    accent: opaque(CHANNEL_PALETTES.beta.water),
    splashBackground: '#FFF2FDF5',
  },
  nightly: {
    appName: 'Station Nightly',
    accent: opaque(CHANNEL_PALETTES.nightly.water),
    splashBackground: '#FFFDF2F6',
  },
};

function channelValues({ accent, splashBackground }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">${splashBackground}</color>
  <color name="station_channel_accent">${accent}</color>
  <color name="station_splash_background">#FFF5F4EF</color>
</resources>
`;
}

const ANDROID_12_SPLASH_THEME = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <!-- Android 12+ draws this before the WebView is ready. Keep it in the
       generated channel overlay so the package identity cannot fall back to
       Tauri's generic Material teal theme. -->
  <style name="Theme.station" parent="Theme.MaterialComponents.DayNight.NoActionBar">
    <item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>
    <item name="android:windowSplashScreenBackground">@color/station_splash_background</item>
    <item name="android:colorAccent">@color/station_channel_accent</item>
    <item name="colorAccent">@color/station_channel_accent</item>
  </style>
</resources>
`;

function androidStrings(source, appName) {
  for (const name of ['app_name', 'main_activity_title']) {
    const pattern = new RegExp(
      `(<string\\s+name="${name}">)([\\s\\S]*?)(</string>)`,
    );
    if (!pattern.test(source)) {
      throw new Error(
        `Generated Android strings.xml is missing ${name}; refusing to leave a generic channel label.`,
      );
    }
    source = source.replace(pattern, `$1${appName}$3`);
  }
  return source;
}

function channelStrings(appName) {
  return `<resources>\n  <string name="app_name">${appName}</string>\n  <string name="main_activity_title">${appName}</string>\n</resources>\n`;
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(destination, name);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

export function applyAndroidChannelIcons(
  channel,
  { root = ROOT, sourceSets = ['main', 'debug'] } = {},
) {
  if (!ANDROID_ICON_CHANNELS.includes(channel)) {
    throw new Error(
      `Unknown Android icon channel ${JSON.stringify(channel)}; expected ${ANDROID_ICON_CHANNELS.join(', ')}`,
    );
  }
  const identity = ANDROID_CHANNEL_IDENTITY[channel];
  const source = join(root, 'src-desktop', 'icons', channel, 'android');
  for (const sourceSet of sourceSets) {
    const destination = join(
      root,
      'src-desktop',
      'gen',
      'android',
      'app',
      'src',
      sourceSet,
      'res',
    );
    for (const density of readdirSync(source)) {
      if (density.startsWith('mipmap-')) {
        copyTree(join(source, density), join(destination, density));
      }
    }
    const drawable = join(destination, 'drawable');
    mkdirSync(drawable, { recursive: true });
    copyFileSync(
      join(
        root,
        'src-ui/public',
        channel === 'stable' ? 'favicon.png' : `favicon-${channel}.png`,
      ),
      join(drawable, 'station_startup_logo.png'),
    );
    writeFileSync(
      join(drawable, 'station_startup_background.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="@color/station_splash_background" />
  <item android:width="96dp" android:height="96dp" android:gravity="center">
    <bitmap android:src="@drawable/station_startup_logo" android:gravity="fill" />
  </item>
</layer-list>
`,
    );
    const values = join(destination, 'values');
    writeAndroidThemedIcon(destination);
    mkdirSync(values, { recursive: true });
    writeFileSync(
      join(values, 'ic_launcher_background.xml'),
      channelValues(identity),
    );
    const nightValues = join(destination, 'values-night');
    mkdirSync(nightValues, { recursive: true });
    writeFileSync(
      join(nightValues, 'station_splash_background.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="station_splash_background">#FF0A0E13</color></resources>\n',
    );
    const stringsPath = join(values, 'strings.xml');
    writeFileSync(
      stringsPath,
      existsSync(stringsPath)
        ? androidStrings(readFileSync(stringsPath, 'utf8'), identity.appName)
        : channelStrings(identity.appName),
    );
    // A generated values-night/Theme.station wins over an unqualified v31
    // resource when dark mode is active. Mirror the API-31 override into the
    // night-qualified source set instead of rewriting Tauri's generated theme.
    for (const qualifier of ['values-v31', 'values-night-v31']) {
      const qualifiedValues = join(destination, qualifier);
      mkdirSync(qualifiedValues, { recursive: true });
      writeFileSync(
        join(qualifiedValues, 'station_channel_splash.xml'),
        ANDROID_12_SPLASH_THEME,
      );
    }
  }
}

if (invokedDirectly(import.meta.url)) {
  applyAndroidChannelIcons(process.argv[2]);
}
