#!/usr/bin/env bash
# Reclaim runner disk before the four-target Android Rust build by removing
# GitHub-hosted Linux toolchains that Station's Android lane never uses.
#
# All four Android Rust targets (aarch64/armv7/i686/x86_64) must coexist until
# Gradle packages the universal APK/AAB, so this never removes Rust
# (~/.rustup), the Android SDK/NDK (/usr/local/lib/android), or the Java/Node
# toolchains the build depends on. Idempotent: `rm -rf` is a no-op on missing
# paths, so re-runs and no-op environments are safe.
#
# Outside a GitHub-hosted Linux runner those paths either don't exist or
# aren't ours to delete, so the script skips cleanly (exit 0) instead of
# failing the build. On the hosted path it fails closed on df/deletion errors
# and on inadequate post-reclaim free space, so the build dies in seconds
# instead of after a ~10 min ENOSPC (GitHub run 30691724203: 3/4 targets
# built, x86_64 died writing libstation_ai_lib.rlib).
set -euo pipefail

# Refuse to touch anything that isn't a GitHub-hosted Linux runner.
if [[ "${RUNNER_OS:-}" != "Linux" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "Skipping disk reclaim: not a GitHub-hosted Linux runner" \
    "(RUNNER_OS=${RUNNER_OS:-<unset>}, RUNNER_ENVIRONMENT=${RUNNER_ENVIRONMENT:-<unset>})." >&2
  exit 0
fi

# Unused hosted-runner toolchains. Keep this list narrow: the exact set is
# pinned by scripts/__tests__/release-workflow.test.ts so any addition
# (especially under the Android SDK, Rust, Java, or Node roots) fails the test
# suite until consciously updated here.
unused_toolchains=(
  /opt/ghc
  /opt/hostedtoolcache/CodeQL
  /usr/local/.ghcup
  /usr/local/share/boost
  /usr/share/dotnet
)

# Minimum free space (KiB) that must remain after reclaim for the four-target
# Android build to be likely to complete. Grounded in the build's own shape:
# four Rust Android DEBUG targets must coexist until Gradle assembles the
# universal APK/AAB, plus Gradle/NDK working files and the npm resource build.
# Uncertainty: the evidence run died before completing, so no authoritative
# post-reclaim figure exists — the default is deliberately conservative (high
# enough to catch a broken or insufficient reclaim, low enough that a healthy
# hosted runner with a working reclaim clears it with margin). This is a pinned
# constant, NOT an env override: no external value (including 0) may weaken the
# fail-closed floor. Update the constant here once the authoritative hosted run
# reports the real number; the test harness pins this exact value.
# PROVISIONAL: 10 GiB until the authoritative post-reclaim figure is observed.
readonly min_free_kib=10485760 # 10 GiB (provisional)

before_kib="$(df --output=avail -k / | tail -n 1 | tr -d '[:space:]')"

sudo rm -rf -- "${unused_toolchains[@]}"

after_kib="$(df --output=avail -k / | tail -n 1 | tr -d '[:space:]')"

# Fail closed on non-numeric df output before it can silently corrupt the
# threshold comparison below (df/deletion failures are already caught by
# `set -euo pipefail`; this guards a parse slip).
if ! [[ "$before_kib" =~ ^[0-9]+$ && "$after_kib" =~ ^[0-9]+$ && "$min_free_kib" =~ ^[0-9]+$ ]]; then
  echo "Unparseable disk value (before='${before_kib}', after='${after_kib}', min='${min_free_kib}')." >&2
  exit 1
fi

echo "Reclaimed $((after_kib - before_kib)) KiB; ${after_kib} KiB available for Android build (minimum ${min_free_kib} KiB)."

if (( after_kib < min_free_kib )); then
  echo "Insufficient disk after reclaim: ${after_kib} KiB free, need >= ${min_free_kib} KiB." \
    "Failing early to avoid a predictable mid-build ENOSPC." >&2
  exit 1
fi
