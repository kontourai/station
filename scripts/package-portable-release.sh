#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT_DIR="$ROOT/dist-release"
SHA=${STATION_RELEASE_SHA:-}
REF=${STATION_RELEASE_REF:-${GITHUB_REF_NAME:-}}
CREATED_AT=${STATION_RELEASE_CREATED_AT:-}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || { echo 'error: --output-dir requires a value' >&2; exit 1; }
      OUTPUT_DIR=$2
      shift 2
      ;;
    --ref)
      [[ $# -ge 2 ]] || { echo 'error: --ref requires a value' >&2; exit 1; }
      REF=$2
      shift 2
      ;;
    --sha)
      [[ $# -ge 2 ]] || { echo 'error: --sha requires a value' >&2; exit 1; }
      SHA=$2
      shift 2
      ;;
    --created-at)
      [[ $# -ge 2 ]] || { echo 'error: --created-at requires a value' >&2; exit 1; }
      CREATED_AT=$2
      shift 2
      ;;
    --help|-h)
      echo 'Usage: scripts/package-portable-release.sh [--output-dir DIR] [--ref REF] [--sha SHA]'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

ARCHIVE_NAME=station-portable.tar.gz
ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"

SHA=${SHA:-$(git -C "$ROOT" rev-parse HEAD)}
if [[ -z "$REF" ]]; then
  REF=$(git -C "$ROOT" describe --tags --exact-match "$SHA" 2>/dev/null || git -C "$ROOT" rev-parse --abbrev-ref "$SHA")
fi

if [[ ! "$SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "error: STATION_RELEASE_SHA must be a full 40-character Git SHA" >&2
  exit 1
fi
if [[ "$REF" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  CHANNEL=stable
  PRERELEASE=false
elif [[ "$REF" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-preview\.([1-9][0-9]*)$ ]]; then
  CHANNEL=preview
  PRERELEASE=true
else
  echo "error: release ref must be vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-preview.N (without leading zeroes)" >&2
  exit 1
fi
RING_MANIFEST_NAME="station-release-ring-${CHANNEL}.json"
RING_MANIFEST_PATH="$OUTPUT_DIR/$RING_MANIFEST_NAME"

if [[ -z "$CREATED_AT" ]]; then
  COMMIT_EPOCH=$(git -C "$ROOT" show -s --format=%ct "$SHA")
  CREATED_AT=$(node -e 'process.stdout.write(new Date(Number(process.argv[1]) * 1000).toISOString())' "$COMMIT_EPOCH")
fi

node -e '
  const [sha, ref, createdAt] = process.argv.slice(1);
  const createdAtMillis = Date.parse(createdAt);
  if (
    !/^[0-9a-f]{40}$/i.test(sha) ||
    !ref.trim() ||
    !Number.isFinite(createdAtMillis) ||
    new Date(createdAtMillis).toISOString() !== createdAt
  ) {
    process.stderr.write("error: invalid portable release provenance\n");
    process.exit(1);
  }
' "$SHA" "$REF" "$CREATED_AT"

mkdir -p "$OUTPUT_DIR"
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/station-portable.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT

mkdir -p "$TEMP_DIR/station"
node -e '
  const fs = require("node:fs");
  const [path, sha, ref, createdAt, releaseChannel, prerelease] = process.argv.slice(1);
  // install.sh verifies schemaVersion 2 with the stable/stable, beta/preview
  // channel pairing; the runtime channel is derived from the release channel.
  const channel = releaseChannel === "preview" ? "beta" : "stable";
  fs.writeFileSync(path, `${JSON.stringify({ schemaVersion: 2, sha, ref, createdAt, channel, releaseChannel, prerelease: prerelease === "true" }, null, 2)}\n`);
' "$TEMP_DIR/station/.station-release.json" "$SHA" "$REF" "$CREATED_AT" "$CHANNEL" "$PRERELEASE"
MANIFEST_TOUCH_TIME=$(node -e '
  const date = new Date(process.argv[1]);
  const pad = (value) => String(value).padStart(2, "0");
  process.stdout.write(`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}.${pad(date.getUTCSeconds())}`);
' "$CREATED_AT")
TZ=UTC touch -t "$MANIFEST_TOUCH_TIME" "$TEMP_DIR/station/.station-release.json"

GIT_DIR=$(git -C "$ROOT" rev-parse --absolute-git-dir)
(
  cd "$TEMP_DIR"
  git --git-dir="$GIT_DIR" --work-tree="$ROOT" archive \
    --format=tar \
    --prefix=station/ \
    --add-file=station/.station-release.json \
    "$SHA" > station-portable.tar
  if ! tar -tvf station-portable.tar | awk '
    BEGIN { valid = 1 }
    {
      type = substr($0, 1, 1)
      if (type != "-" && type != "d") valid = 0
    }
    END { exit valid == 1 ? 0 : 1 }
  '; then
    echo 'error: portable release contains an unsupported entry type' >&2
    exit 1
  fi
  gzip -n -9 -c station-portable.tar > "$ARCHIVE_PATH"
)

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM=$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')
else
  CHECKSUM=$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')
fi
printf '%s  %s\n' "$CHECKSUM" "$ARCHIVE_NAME" > "$CHECKSUM_PATH"

ARCHIVE_DIGEST="$CHECKSUM"
CHECKSUM_DIGEST=$(node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$CHECKSUM_PATH")
node -e '
  const fs = require("node:fs");
  const [path, channel, prerelease, ref, sha, createdAt, archiveDigest, checksumDigest] = process.argv.slice(1);
  const manifest = {
    schemaVersion: 1,
    channel,
    prerelease: prerelease === "true",
    ref,
    sha,
    createdAt,
    archive: { name: "station-portable.tar.gz", sha256: archiveDigest },
    checksum: { name: "station-portable.tar.gz.sha256", sha256: checksumDigest },
  };
  fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "$RING_MANIFEST_PATH" "$CHANNEL" "$PRERELEASE" "$REF" "$SHA" "$CREATED_AT" "$ARCHIVE_DIGEST" "$CHECKSUM_DIGEST"

printf 'Created %s\nCreated %s\nCreated %s\n' "$ARCHIVE_PATH" "$CHECKSUM_PATH" "$RING_MANIFEST_PATH"
