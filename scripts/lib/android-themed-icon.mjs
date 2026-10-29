import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusBarMarkPathData } from './station-icon.mjs';

/** Android 13+ launchers tint this alpha mask with the user's wallpaper palette. */
export function writeAndroidThemedIcon(resources) {
  const drawable = join(resources, 'drawable');
  const adaptive = join(resources, 'mipmap-anydpi-v33');
  mkdirSync(drawable, { recursive: true });
  mkdirSync(adaptive, { recursive: true });
  writeFileSync(
    join(drawable, 'station_launcher_monochrome.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="24" android:viewportHeight="24">
  <group android:pivotX="12" android:pivotY="12"
      android:scaleX="0.5" android:scaleY="0.5">
    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"
        android:pathData="${statusBarMarkPathData()}" />
  </group>
</vector>
`,
  );
  writeFileSync(
    join(adaptive, 'ic_launcher.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <foreground android:drawable="@mipmap/ic_launcher_foreground" />
  <background android:drawable="@color/ic_launcher_background" />
  <monochrome android:drawable="@drawable/station_launcher_monochrome" />
</adaptive-icon>
`,
  );
}
