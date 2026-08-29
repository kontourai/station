#!/usr/bin/env bash
set -euo pipefail

case "${STATION_ECOSYSTEM_PUBLISH:-0}" in
  0)
    echo 'External ecosystem publishing is inert by default; dry-run completed at the publish boundary.'
    ;;
  1)
    test -n "${STATION_ECOSYSTEM_MANIFEST_PUBLISH_COMMAND:-}" || {
      echo 'Owner-enabled publishing requires an explicit manifest publish command.' >&2
      exit 1
    }
    test -n "${STATION_ECOSYSTEM_HOMEBREW_TAP_PUBLISH_COMMAND:-}" || {
      echo 'Owner-enabled publishing requires an explicit Homebrew tap publish command.' >&2
      exit 1
    }
    sh -c "$STATION_ECOSYSTEM_MANIFEST_PUBLISH_COMMAND"
    sh -c "$STATION_ECOSYSTEM_HOMEBREW_TAP_PUBLISH_COMMAND"
    ;;
  *)
    echo 'STATION_ECOSYSTEM_PUBLISH must be 0 or 1.' >&2
    exit 1
    ;;
esac
