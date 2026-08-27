#!/bin/zsh
set -euo pipefail

# --relaunch: if the app was running when the install started, reopen it after
# the swap (used by the in-app self-updater, station#1624).
relaunch=0
build_only=0
output_dir=''
notary_profile=''
invocation_cwd="$PWD"
station_root="$(node --input-type=module -e '
  import { homedir } from "node:os";
  import { join, resolve } from "node:path";
  const raw = (process.env.STATION_ROOT ?? "").trim();
  console.log(resolve(process.argv[1], raw || join(homedir(), ".station")));
' "$invocation_cwd")"
export STATION_ROOT="$station_root"
while (( $# > 0 )); do
  arg="$1"
  case "$arg" in
    --relaunch) relaunch=1 ;;
    --build-only) build_only=1 ;;
    --output-dir)
      shift
      if (( $# == 0 )) || [[ -z "$1" ]]; then
        print -u2 '--output-dir requires a non-empty directory path.'
        exit 1
      fi
      output_dir="$1"
      ;;
    --notary-profile)
      shift
      if (( $# == 0 )) || [[ -z "$1" ]]; then
        print -u2 '--notary-profile requires an existing named Keychain profile.'
        exit 1
      fi
      notary_profile="$1"
      ;;
    *)
      print -u2 "Unknown argument: $arg"
      exit 1
      ;;
  esac
  shift
done

if (( build_only )); then
  if (( relaunch )); then
    print -u2 '--relaunch cannot be used with --build-only.'
    exit 1
  fi
  if [[ -z "$output_dir" ]]; then
    print -u2 '--build-only requires --output-dir so artifacts never overwrite an implicit location.'
    exit 1
  fi
elif [[ -n "$output_dir" || -n "$notary_profile" ]]; then
  print -u2 '--output-dir and --notary-profile require --build-only.'
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ "$(uname -s)" != Darwin ]]; then
  print -u2 'Station Nightly for macOS must be built on macOS.'
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  print -u2 'Refusing to build Station Nightly from a dirty tracked checkout.'
  exit 1
fi

if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != 24 ]]; then
  print -u2 'Station Nightly requires Node 24.'
  exit 1
fi

case "$(uname -m)" in
  arm64) target='aarch64-apple-darwin' ;;
  x86_64) target='x86_64-apple-darwin' ;;
  *)
    print -u2 "Station Nightly does not support architecture $(uname -m)."
    exit 1
    ;;
esac

destination='/Applications/Station Nightly.app'
candidate="/Applications/.Station Nightly.candidate.$$"
backup="/Applications/.Station Nightly.backup.$$"
lock_root="$station_root/cache/nightly"
lock_dir="$lock_root/install.lock"
nightly_config=''
# The build runs in a machine-owned isolated checkout, never in the primary
# checkout: npm ci tears down node_modules underneath any Station service
# running from this tree, so an update in progress must not mutate the tree a
# live server resolves modules from (station#1849).
# v2 is an owned-cache protocol boundary. Leave legacy build-checkout intact:
# it has no ownership marker and must never be adopted or deleted implicitly.
build_root="$lock_root/build-checkout-v2"
built_app="$build_root/src-desktop/target/$target/release/bundle/macos/Station Nightly.app"
expected_nightly_port='38141'

if (( build_only )); then
  staging_root="$lock_root/build-only-staging"
  mkdir -p "$staging_root"
  staging_dir="$(mktemp -d "$staging_root/run.XXXXXX")"
  candidate="$staging_dir/candidate.app"
  backup=''
  staging_owned=1
  output_owned=0
  lock_owned=0
  early_cleanup() {
    if (( output_owned )); then output_owned=0; rm -rf "$output_dir"; fi
    if (( staging_owned )); then staging_owned=0; rm -rf "$staging_dir"; fi
    if (( lock_owned )); then lock_owned=0; rmdir "$lock_dir" 2>/dev/null || true; fi
  }
  trap early_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  output_dir="$(node --input-type=module -e '
    import { validateBuildOnlyOutput } from "./ops/nightly/macos-build-only-artifact.mjs";
    console.log(validateBuildOnlyOutput({ outputDir: process.argv[1], invocationCwd: process.argv[2], forbiddenRoots: ["/Applications", process.argv[3], process.argv[4], process.argv[5]] }));
  ' "$output_dir" "$invocation_cwd" "$repo_root" "$build_root" "$staging_root")"
fi
# The stamp retains the provenance checkout because it remains the authenticated
# self-update entrypoint. A newly built app does not replace that checkout's
# installer: future installer semantics require this checkout to be updated
# explicitly (or a separately versioned bundle-owned updater), never inferred
# from the newly installed app code.
source_checkout="$repo_root"
if (( build_only )); then
  # Archives are portable delivery artifacts, not installed self-update roots;
  # omit the primary checkout path so a user's home is never embedded.
  source_checkout=''
fi

# Fail closed if the build root would overlap the primary checkout — building
# there is exactly the defect the isolated layout exists to prevent (#1849).
if [[ "$build_root/" == "$repo_root/"* || "$repo_root/" == "$build_root/"* ]]; then
  print -u2 'Isolated build checkout must live outside the primary checkout.'
  exit 1
fi

# The lock covers the WHOLE run, build included: npm ci is not concurrency-safe,
# two builds in one checkout corrupt each other, and the reused isolated build
# checkout below is shared state between runs. Acquiring it only at swap time
# left the multi-minute build window unguarded — which matters now that the
# in-app self-updater can trigger this script over HTTP (station#1624).
mkdir -p "$lock_root"
if ! mkdir "$lock_dir"; then
  print -u2 'Another Station Nightly installation is already running.'
  exit 1
fi
if (( build_only )); then lock_owned=1; fi
lock_cleanup() {
  if [[ -n "${nightly_config:-}" ]]; then rm -f "$nightly_config"; nightly_config=''; fi
  rmdir "$lock_dir" 2>/dev/null || true
}
if (( ! build_only )); then
  trap lock_cleanup EXIT HUP INT TERM
fi

# The isolated checkout is reused across runs so the Rust target dir stays warm
# (a fresh clone costs a full rebuild every night). It is refreshed fail-closed
# to the exact remote main SHA inside the machine-owned cache. On any failure
# past this point the previous installed app and the recorded source checkout
# are untouched — nothing before the swap writes outside $lock_root.
prepare_build_checkout() {
  source_sha="$(node "$repo_root/ops/nightly/owned-source-checkout.mjs" "$repo_root" "$build_root" "$lock_root")" || {
    print -u2 'Refreshing the owned Nightly source checkout failed; the recorded source checkout was left unchanged.'
    exit 1
  }
}
prepare_build_checkout

if (( build_only )); then
  archive_path="$staging_dir/Station-Nightly-$source_sha-macos.zip"
  checksum_path="$staging_dir/Station-Nightly-$source_sha-macos.zip.sha256"
  receipt_path="$staging_dir/station-nightly-build-receipt.json"
fi

build_sha="$(git -C "$build_root" rev-parse HEAD)"
if [[ "$build_sha" != "$source_sha" ]]; then
  print -u2 "Isolated build checkout is at $build_sha; expected $source_sha."
  exit 1
fi
if [[ -n "$(git -C "$build_root" status --porcelain --untracked-files=no)" ]]; then
  print -u2 'Isolated build checkout has dirty tracked files after refresh.'
  exit 1
fi

cd "$build_root"
npm run dependencies:ci
node scripts/product-version.mjs --check
# Keep the tracked channel overlay versionless. This per-source-SHA overlay is
# ephemeral, so the app, tray, and embedded web build agree without mutating
# the isolated checkout or confusing the next Stable promotion.
nightly_date="$(git -C "$build_root" show -s --format=%cI "$source_sha")"
nightly_config="$lock_root/tauri.nightly.version.$$.json"
if (( build_only )); then
  nightly_build_cleanup() {
    rm -f "$nightly_config"
    nightly_config=''
    early_cleanup
  }
  trap nightly_build_cleanup EXIT
fi
node scripts/lib/nightly-build-identity.mjs \
  --package-json package.json \
  --tauri-config src-desktop/tauri.conf.json \
  --date "$nightly_date" \
  --build 0 \
  --output "$nightly_config"
nightly_version="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).version);' "$nightly_config")"
nightly_bundle_version="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).bundle.macOS.bundleVersion);' "$nightly_config")"
STATION_BUILD_VERSION="$nightly_version" npx tauri build \
  --target "$target" \
  --bundles app \
  --config src-desktop/tauri.nightly.conf.json \
  --config "$nightly_config"

if [[ ! -d "$built_app" ]]; then
  print -u2 "Nightly build did not produce $built_app."
  exit 1
fi

built_port="$(/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:STATION_DESKTOP_PORT' "$built_app/Contents/Info.plist" 2>/dev/null || true)"
if [[ "$built_port" != "$expected_nightly_port" ]]; then
  print -u2 "Nightly built app STATION_DESKTOP_PORT is ${built_port:-missing}; expected $expected_nightly_port."
  exit 1
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$built_app/Contents/Info.plist" 2>/dev/null || true)" != "$nightly_version" ]]; then
  print -u2 "Nightly built app version does not match its generated identity $nightly_version."
  exit 1
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$built_app/Contents/Info.plist" 2>/dev/null || true)" != "$nightly_bundle_version" ]]; then
  print -u2 "Nightly built app build number does not match its generated identity $nightly_bundle_version."
  exit 1
fi

if (( ! build_only )) && [[ -e "$candidate" || -e "$backup" ]]; then
  print -u2 'A stale Station Nightly installation candidate or backup needs inspection.'
  exit 1
fi

cleanup() {
  if [[ -e "$backup" && ! -e "$destination" ]]; then
    mv "$backup" "$destination"
  fi
  rm -rf "$candidate"
  if [[ -n "${nightly_config:-}" ]]; then rm -f "$nightly_config"; nightly_config=''; fi
  if (( build_only )) && (( staging_owned )); then staging_owned=0; rm -rf "$staging_dir"; fi
  if (( build_only )) && (( output_owned )); then output_owned=0; rm -rf "$output_dir"; fi
  if (( ! build_only || lock_owned )); then lock_owned=0; rmdir "$lock_dir" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ditto "$built_app" "$candidate"
node --input-type=module -e '
  import { writeNightlySourceStamp } from "./ops/nightly/macos-source-stamp.mjs";
  const [file, sha, createdAt, originUrl, sourceCheckout] = process.argv.slice(1);
  writeNightlySourceStamp(file, { sha, createdAt, originUrl, sourceCheckout });
' \
  "$candidate/Contents/Resources/station-nightly-source.json" \
  "$source_sha" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(git -C "$repo_root" remote get-url origin)" \
  "$source_checkout"
signing_identity="$(node "$build_root/ops/nightly/macos-signing-identity.mjs")" || {
  print -u2 'Station Nightly requires an explicit stable macOS signing identity; ad-hoc signing is refused because this app owns persistent Keychain credentials.'
  exit 1
}
node "$build_root/ops/nightly/macos-embedded-signing.mjs" "$candidate" "$signing_identity"
# The selective helper seals only reviewed embedded Mach-O code. The final
# bundle seal adds hardened runtime and timestamp without treating every
# resource as executable or replacing an entitlement contract.
codesign --force --sign "$signing_identity" --options runtime --timestamp "$candidate"
codesign --verify --deep --strict --verbose=2 "$candidate"
runtime_details="$(codesign -d --verbose=4 "$candidate" 2>&1)"
if [[ "$runtime_details" != *'flags=0x10000(runtime)'* ]]; then
  print -u2 'Station Nightly signing did not enable the hardened runtime; refusing the atomic swap.'
  exit 1
fi
designated_requirement="$(codesign -d -r- "$candidate" 2>&1 | node "$build_root/ops/nightly/macos-signing-identity.mjs" --candidate-designated-requirement)" || {
  print -u2 'Station Nightly was not signed with a stable certificate-backed designated requirement; refusing the atomic swap.'
  exit 1
}
if [[ -e "$destination" ]]; then
  existing_designated_requirement="$(codesign -d -r- "$destination" 2>&1 | node "$build_root/ops/nightly/macos-signing-identity.mjs" --raw-designated-requirement)" || {
    print -u2 'Existing Station Nightly has no readable designated requirement; refusing to replace a credential-owning app.'
    exit 1
  }
  if [[ "$existing_designated_requirement" == *cdhash* ]]; then
    print 'Migrating the existing ad-hoc Station Nightly signature to the stable certificate-backed requirement.'
  elif [[ "$existing_designated_requirement" != "$designated_requirement" ]]; then
    print -u2 'Existing Station Nightly has a different stable designated requirement. Keep its signing identity or perform an explicit credential migration; replacement is refused.'
    exit 1
  fi
fi

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate/Contents/Info.plist")"
if [[ "$bundle_id" != io.kontourai.station.nightly ]]; then
  print -u2 "Nightly bundle identifier is $bundle_id."
  exit 1
fi

if (( build_only )); then
  artifact_app="$staging_dir/Station Nightly.app"
  ditto "$candidate" "$artifact_app"
  codesign --verify --deep --strict --verbose=2 "$artifact_app"
  ditto -c -k --sequesterRsrc --keepParent "$artifact_app" "$archive_path"
  node --input-type=module -e '
    import { assertSafeArchiveFile } from "./ops/nightly/macos-build-only-artifact.mjs";
    assertSafeArchiveFile(process.argv[1]);
  ' "$archive_path"

  notarization_status='not-requested'
  if [[ -n "$notary_profile" ]]; then
    notary_result="$staging_dir/notary-result.json"
    if xcrun notarytool submit "$archive_path" --keychain-profile "$notary_profile" --wait --output-format json > "$notary_result" &&
      node -e 'const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (value.status !== "Accepted") process.exit(1);' "$notary_result" &&
      xcrun stapler staple "$artifact_app" &&
      xcrun stapler validate "$artifact_app"; then
      notarization_status='notarized'
      rm -f "$archive_path"
      ditto -c -k --sequesterRsrc --keepParent "$artifact_app" "$archive_path"
    else
      notarization_status='failed'
    fi
  fi
  node --input-type=module -e '
    import { assertSafeArchiveFile } from "./ops/nightly/macos-build-only-artifact.mjs";
    assertSafeArchiveFile(process.argv[1]);
  ' "$archive_path"
  archive_sha="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  print "$archive_sha  $(basename "$archive_path")" > "$checksum_path"
  node -e '
    const { writeFileSync } = require("node:fs");
    const [file, sha, archive, checksum, archiveSha, identity, notarization] = process.argv.slice(1);
    writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      channel: "nightly",
      source: { ref: "origin/main", sha },
      signing: { identity, status: "verified" },
      notarization: { status: notarization },
      archive: { path: archive, sha256: archiveSha, sha256Path: checksum },
    }, null, 2)}\n`, { mode: 0o644 });
  ' "$receipt_path" "$source_sha" "$output_dir/$(basename "$archive_path")" "$output_dir/$(basename "$checksum_path")" "$archive_sha" "$signing_identity" "$notarization_status"
  if [[ "$notarization_status" == failed ]]; then
    print -u2 'Nightly archive signing succeeded, but notarization failed. The receipt records notarization as failed.'
    exit 1
  fi
  if ! mkdir "$output_dir"; then
    print -u2 "Build-only output directory already exists: $output_dir. Refusing to overwrite an artifact receipt."
    exit 1
  fi
  output_owned=1
  if ! ditto "$artifact_app" "$output_dir/Station Nightly.app" ||
    ! ditto "$archive_path" "$output_dir/$(basename "$archive_path")" ||
    ! ditto "$checksum_path" "$output_dir/$(basename "$checksum_path")" ||
    ! ditto "$receipt_path" "$output_dir/$(basename "$receipt_path")"; then
    exit 1
  fi
  staging_owned=0
  rm -rf "$staging_dir"
  output_owned=0
  lock_owned=0
  rmdir "$lock_dir"
  trap - EXIT HUP INT TERM
  print "Built signed Station Nightly archive $source_sha at $output_dir/$(basename "$archive_path")"
  exit 0
fi

if [[ -e "$destination" ]]; then
  mv "$destination" "$backup"
fi

if ! mv "$candidate" "$destination"; then
  if [[ -e "$backup" && ! -e "$destination" ]]; then
    mv "$backup" "$destination"
  fi
  exit 1
fi

rm -rf "$backup"
rmdir "$lock_dir"
trap - EXIT HUP INT TERM

xattr -dr com.apple.quarantine "$destination" 2>/dev/null || true
# A plain `open` on a running app only focuses the OLD process; the swapped
# binary starts only after that process exits. --relaunch (the in-app
# self-updater) quits it first so the reopen actually runs the new build.
if (( relaunch )) && pgrep -qf "$destination/Contents/MacOS/"; then
  osascript -e 'tell application id "io.kontourai.station.nightly" to quit' \
    2>/dev/null || true
  for _ in {1..20}; do
    pgrep -qf "$destination/Contents/MacOS/" || break
    sleep 0.5
  done
fi
open "$destination"

print "Installed Station Nightly $source_sha at $destination"
