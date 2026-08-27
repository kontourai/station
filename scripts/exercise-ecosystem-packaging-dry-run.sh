#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/station-ecosystem-dry-run.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

ARTIFACTS="$WORK/artifacts"
MANIFESTS="$WORK/manifests"
KEYS="$WORK/keys"
FAKE_BIN="$WORK/fake-bin"
mkdir -p "$ARTIFACTS" "$MANIFESTS" "$KEYS" "$FAKE_BIN"

"$ROOT/scripts/package-portable-release.sh" \
  --output-dir "$ARTIFACTS" \
  --ref v0.0.0 \
  --sha "$(git -C "$ROOT" rev-parse HEAD)"
printf 'dry-run macOS cask fixture\n' >"$ARTIFACTS/station-0.0.0-macos-universal.dmg"

node -e '
  const { generateKeyPairSync } = require("node:crypto");
  const fs = require("node:fs");
  const [privatePath, publicPath] = process.argv.slice(1);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.writeFileSync(publicPath, publicKey.export({ format: "pem", type: "spki" }));
' "$WORK/private.pem" "$KEYS/public.pem"

python3 -m http.server 18765 --bind 127.0.0.1 --directory "$ARTIFACTS" >"$WORK/artifacts.log" 2>&1 &
artifact_pid=$!
python3 -m http.server 18766 --bind 127.0.0.1 --directory "$MANIFESTS" >"$WORK/manifests.log" 2>&1 &
manifest_pid=$!
python3 -m http.server 18767 --bind 127.0.0.1 --directory "$KEYS" >"$WORK/keys.log" 2>&1 &
key_pid=$!
cleanup_servers() { kill "$artifact_pid" "$manifest_pid" "$key_pid" >/dev/null 2>&1 || true; }
trap 'cleanup_servers; rm -rf "$WORK"' EXIT

node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const [output, artifactDir, sha] = process.argv.slice(1);
  const digest = (name) => crypto.createHash("sha256").update(fs.readFileSync(`${artifactDir}/${name}`)).digest("hex");
  fs.writeFileSync(output, `${JSON.stringify({
    schemaVersion: 1,
    channel: "stable",
    version: "0.0.0",
    releaseTag: "v0.0.0",
    sourceSha: sha,
    publishedAt: "2026-08-16T00:00:00.000Z",
    artifacts: {
      macos: { name: "station-0.0.0-macos-universal.dmg", url: "http://127.0.0.1:18765/station-0.0.0-macos-universal.dmg", sha256: digest("station-0.0.0-macos-universal.dmg") },
      portable: { name: "station-portable.tar.gz", url: "http://127.0.0.1:18765/station-portable.tar.gz", sha256: digest("station-portable.tar.gz") },
    },
  }, null, 2)}\n`);
' "$WORK/payload.json" "$ARTIFACTS" "$(git -C "$ROOT" rev-parse HEAD)"

STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS=1 node "$ROOT/scripts/ecosystem-manifest.mjs" create \
  --payload "$WORK/payload.json" \
  --private-key "$WORK/private.pem" \
  --key-id station-ecosystem-v1 \
  --output "$MANIFESTS/stable.json"
node "$ROOT/scripts/ecosystem-manifest.mjs" cask \
  --manifest "$MANIFESTS/stable.json" \
  --public-key "$KEYS/public.pem" \
  --output "$WORK/station.rb"
grep -Fqx 'cask "station" do' "$WORK/station.rb"

cat >"$FAKE_BIN/gh" <<'EOF'
#!/bin/sh
echo 'gh must not run in the public installer path' >&2
exit 99
EOF
chmod +x "$FAKE_BIN/gh"

HOME="$WORK/home" \
PATH="$FAKE_BIN:$PATH" \
GH_TOKEN='' \
GITHUB_TOKEN='' \
STATION_INSTALL_PUBLIC_MANIFEST_URL=http://127.0.0.1:18766/stable.json \
STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL=http://127.0.0.1:18767/public.pem \
STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1 \
STATION_INSTALL_NO_START=1 \
sh "$ROOT/install.sh"

echo 'Ecosystem packaging dry-run reached the external publish boundary without publishing.'
