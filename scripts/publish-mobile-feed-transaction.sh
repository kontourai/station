#!/usr/bin/env bash
set -euo pipefail

feed=${1:-}
node scripts/native-update-feed.mjs validate-config
custom_feed=false
if [[ -n "${VITE_NATIVE_APP_UPDATE_FEED_URL:-}" ]]; then
  test -n "$feed" || { echo "Configured native update feed requires a staged feed file" >&2; exit 1; }
  test -s "$feed"
  test -n "${NATIVE_APP_UPDATE_PUBLISH_TOKEN:-}" || { echo "Missing native update provider credential" >&2; exit 1; }
  custom_feed=true
elif [[ -n "$feed" ]]; then
  echo "Refusing a staged feed file without configured native update feed authority" >&2
  exit 1
fi
public=false
complete=false
ambiguous=false

finish() {
  status=$?
  trap - EXIT INT TERM
  if [[ "$public" == true && "$complete" != true && "$ambiguous" != true ]]; then
    if ! gh release edit "$RELEASE_TAG" --draft=true; then
      echo "Failed to re-draft release; release remains public and requires manual recovery." >&2
      exit 75
    fi
    if [[ "$(gh release view "$RELEASE_TAG" --json isDraft --jq '.isDraft' 2>/dev/null || true)" != true ]]; then
      echo "Could not verify re-draft; release remains public or ambiguous and requires manual recovery." >&2
      exit 75
    fi
  fi
  exit "$status"
}
mark_ambiguous() {
  ambiguous=true
  echo "Signal interrupted feed transaction; keeping release public for manual recovery." >&2
  exit 75
}
trap finish EXIT
trap mark_ambiguous INT TERM

set +e
if [[ "$RELEASE_TAG" == *-preview.* ]]; then
  gh release edit "$RELEASE_TAG" --draft=false --prerelease
else
  gh release edit "$RELEASE_TAG" --draft=false --prerelease=false --latest
fi
publish_status=$?
set -e
published_state=$(gh release view "$RELEASE_TAG" --json isDraft --jq '.isDraft' 2>/dev/null || true)
if [[ "$published_state" == false ]]; then
  public=true
elif [[ "$published_state" == true ]]; then
  if [[ "$publish_status" == 0 ]]; then exit 1; fi
  exit "$publish_status"
else
  ambiguous=true
  echo "Could not determine whether release publication committed; manual recovery required." >&2
  exit 75
fi
test "$publish_status" == 0

if [[ "$custom_feed" != true ]]; then
  complete=true
  trap - EXIT INT TERM
  exit 0
fi

if [[ "${STATION_TEST_SIGNAL:-}" == TERM ]]; then kill -TERM $$; fi
if [[ "${STATION_TEST_SIGNAL:-}" == INT ]]; then kill -INT $$; fi

set +e
node scripts/native-update-feed.mjs deploy "$feed"
deploy_status=$?
set -e
if [[ "$deploy_status" == 75 ]]; then
  ambiguous=true
  echo "Feed state is ambiguous; keeping release public for manual recovery." >&2
  exit 75
fi
test "$deploy_status" == 0
complete=true
trap - EXIT INT TERM
