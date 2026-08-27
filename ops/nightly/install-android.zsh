#!/bin/zsh
set -euo pipefail

# Station Nightly for Android: build the arm64 debug APK from the exact latest
# origin/main and install it on one connected adb device (#1569). Mirrors the
# fail-closed posture of install-macos.zsh: dirty trees, drifted checkouts,
# wrong Node, and ambiguous devices all refuse rather than guess.

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  print -u2 'Refusing to build the Android nightly from a dirty tracked checkout.'
  exit 1
fi

git fetch origin main
source_sha="$(git rev-parse HEAD)"
main_sha="$(git rev-parse origin/main)"
if [[ "$source_sha" != "$main_sha" ]]; then
  print -u2 "Checkout is $source_sha; latest origin/main is $main_sha."
  print -u2 'Switch to the exact latest origin/main revision before installing the Android nightly.'
  exit 1
fi

if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != 24 ]]; then
  print -u2 'The Android nightly requires Node 24.'
  exit 1
fi

: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
if [[ -z "${NDK_HOME:-}" ]]; then
  ndk_candidate="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
  if [[ -z "$ndk_candidate" ]]; then
    print -u2 "No Android NDK found under $ANDROID_HOME/ndk."
    exit 1
  fi
  export NDK_HOME="$ndk_candidate"
fi
adb="$ANDROID_HOME/platform-tools/adb"
if [[ ! -x "$adb" ]]; then
  print -u2 "adb not found at $adb."
  exit 1
fi

devices=("${(@f)$($adb devices | awk 'NR>1 && $2 == "device" {print $1}')}")
devices=(${devices:#})
if (( ${#devices} == 0 )); then
  print -u2 'No adb device is connected and authorized.'
  exit 1
fi
if (( ${#devices} > 1 )) && [[ -z "${STATION_ANDROID_SERIAL:-}" ]]; then
  print -u2 "Multiple adb devices connected: ${devices[*]}."
  print -u2 'Set STATION_ANDROID_SERIAL to choose one.'
  exit 1
fi
serial="${STATION_ANDROID_SERIAL:-${devices[1]}}"

npm ci
npm run build:ui
npx tauri android init
node scripts/apply-android-native-bootstrap.mjs

# The 16 KB page-alignment linker flags must ride RUSTFLAGS: an environment
# RUSTFLAGS replaces target rustflags instead of merging with
# src-desktop/.cargo/config.toml (see docs/guides/android-build.md).
RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384' \
  npx tauri android build -t aarch64 --debug --apk

apk="$repo_root/src-desktop/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
if [[ ! -f "$apk" ]]; then
  print -u2 "Android build did not produce $apk."
  exit 1
fi

node scripts/check-android-16kb-alignment.mjs "$apk"

apk_sha="$(shasum -a 256 "$apk" | awk '{print $1}')"
print "Built $source_sha (apk sha256 $apk_sha)."

package='io.kontourai.station.debug'
# Debug-id nightly: one dev package per device, replaced in place. -r keeps
# app data; a signature mismatch (different build host) needs a manual
# uninstall, which stays a human decision because it deletes app data.
if ! "$adb" -s "$serial" install -r "$apk"; then
  print -u2 "adb install failed. If the error is a signature mismatch, run:"
  print -u2 "  $adb -s $serial uninstall $package   # deletes the app's data"
  exit 1
fi

activity="$("$adb" -s "$serial" shell cmd package resolve-activity --brief "$package" </dev/null | tail -1 | tr -d '\r')"
activity_class="${activity#"$package/"}"
relative_activity_pattern='^\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$'
qualified_activity_pattern='^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$'
valid_activity=0
if [[ "$activity" == "$package/"* ]] &&
  [[ "$activity_class" =~ $relative_activity_pattern || "$activity_class" =~ $qualified_activity_pattern ]]; then
  valid_activity=1
fi
if (( ! valid_activity )); then
  print -u2 "Installed, but could not resolve a launch activity for $package."
  exit 1
fi
"$adb" -s "$serial" shell am start -n "$activity" >/dev/null

# Android may take a few seconds to create the process after am start. Probe
# immediately, then retry at a fixed cadence for a bounded total window: a
# successful install is never reported red solely because process creation won
# a race, and a process that never appears remains a hard failure.
launch_readiness_timeout_seconds=10
pid_list_pattern='^[1-9][0-9]*([[:space:]]+[1-9][0-9]*)*$'
package_running=0
for (( readiness_elapsed_seconds = 0; readiness_elapsed_seconds <= launch_readiness_timeout_seconds; readiness_elapsed_seconds++ )); do
  process_ids=''
  pidof_succeeded=0
  if process_ids="$("$adb" -s "$serial" shell pidof "$package")"; then
    pidof_succeeded=1
    process_ids="${process_ids//$'\r'/}"
    while [[ "$process_ids" == [[:space:]]* ]]; do
      process_ids="${process_ids#?}"
    done
    while [[ "$process_ids" == *[[:space:]] ]]; do
      process_ids="${process_ids%?}"
    done
  fi
  if (( pidof_succeeded )) && [[ "$process_ids" =~ $pid_list_pattern ]]; then
    package_running=1
    break
  fi
  if (( readiness_elapsed_seconds < launch_readiness_timeout_seconds )); then
    sleep 1
  fi
done
if (( ! package_running )); then
  print -u2 "Installed, but $package is not running within ${launch_readiness_timeout_seconds}s of launch."
  exit 1
fi

print "PASS: Station Android nightly $source_sha installed and running on $serial."
