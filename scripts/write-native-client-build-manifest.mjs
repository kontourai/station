import { writeNativeClientBuildManifest } from './lib/desktop-build-manifest.mjs';

const manifestPath = writeNativeClientBuildManifest(process.cwd(), {
  // A parent build explicitly sets this only while it invokes Tauri. That
  // lets Tauri's nested `beforeBuildCommand` reuse the parent stamp without
  // turning an unrelated later `npm run build:native-client` into stale data.
  // Fresh by default. Reuse is an explicit, short-lived parent-build lease so
  // a later direct build at the same revision cannot inherit yesterday's date.
  refresh: process.env.STATION_CLIENT_BUILD_REUSE !== '1',
});
if (manifestPath) {
  console.log(`Staged native client build provenance at ${manifestPath}`);
} else {
  console.warn(
    'No build provenance available (no git checkout and no valid .station-release.json). Native source/browser builds will report no immutable artifact timestamp.',
  );
}
