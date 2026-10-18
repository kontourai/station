#!/usr/bin/env bash
set -euo pipefail
: "${RELEASE_CHANNEL:?}" "${RELEASE_TAG:?}" "${RUNTIME_CHANNEL:?}"
source_temp="$RUNNER_TEMP/install-source-$RELEASE_CHANNEL"
mkdir -p "$source_temp"
scripts/package-portable-release.sh --output-dir "$RELEASE_DIR" --ref "$RELEASE_TAG"
runtime_channel="$RUNTIME_CHANNEL"
release_channel="$RELEASE_CHANNEL"
launcher_name=station
if [ "$runtime_channel" = beta ]; then launcher_name=station-beta; fi
launcher="$SMOKE_HOME/.local/bin/$launcher_name"
# Mirror install.sh's default roots for HOME=$SMOKE_HOME without
# overrides: $station_root/installs|instances/$runtime_channel.
station_root="$SMOKE_HOME/.station"
install_root="$station_root/installs/$runtime_channel"
station_home="$station_root/instances/$runtime_channel"
mkdir -p "$SMOKE_HOME/fake-bin"
cat >"$SMOKE_HOME/fake-bin/codex" <<'EOF'
#!/bin/sh
echo 'codex-cli 1.0.0-smoke'
EOF
cat >"$SMOKE_HOME/fake-bin/claude" <<'EOF'
#!/bin/sh
echo 'claude 1.0.0-smoke'
EOF
cat >"$SMOKE_HOME/fake-bin/kiro-cli" <<'EOF'
#!/bin/sh
echo 'kiro-cli 1.0.0-smoke'
EOF
cat >"$SMOKE_HOME/fake-bin/rustc" <<'EOF'
#!/bin/sh
echo 'rustc 1.90.0-smoke'
EOF
# The public manifest path must stay unauthenticated; a reachable gh
# here would hide a regression back onto the authenticated path.
cat >"$SMOKE_HOME/fake-bin/gh" <<'EOF'
#!/bin/sh
echo 'gh must not run in the public installer path' >&2
exit 99
EOF
chmod +x "$SMOKE_HOME/fake-bin/"*

# install.sh's public manifest path requires three distinct fixture
# origins: artifacts, the signed manifest, and its verification key.
serve_dir="$source_temp/fixture-serve"
manifests_dir="$source_temp/fixture-manifests"
keys_dir="$source_temp/fixture-keys"
mkdir -p "$serve_dir" "$manifests_dir" "$keys_dir"
cp "$RELEASE_DIR/station-portable.tar.gz" "$serve_dir/"
provenance="$(tar -xOzf "$serve_dir/station-portable.tar.gz" station/.station-release.json)"
source_sha="$(printf '%s' "$provenance" | jq -r .sha)"
release_tag="$(printf '%s' "$provenance" | jq -r .ref)"
version="${release_tag#v}"
printf 'install-smoke macOS cask fixture\n' >"$serve_dir/station-$version-macos-universal.dmg"
node -e '
  const { generateKeyPairSync } = require("node:crypto");
  const fs = require("node:fs");
  const [privatePath, publicPath] = process.argv.slice(1);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.writeFileSync(publicPath, publicKey.export({ format: "pem", type: "spki" }));
' "$source_temp/manifest-private.pem" "$keys_dir/public.pem"

write_manifest_payload() {
  # JavaScript template literals below are interpreted by Node.
  # shellcheck disable=SC2016
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const [output, serveDir, channel, version, releaseTag, sourceSha] = process.argv.slice(1);
    const digest = (name) => crypto.createHash("sha256").update(fs.readFileSync(`${serveDir}/${name}`)).digest("hex");
    const macos = `station-${version}-macos-universal.dmg`;
    fs.writeFileSync(output, `${JSON.stringify({
      schemaVersion: 1,
      channel,
      version,
      releaseTag,
      sourceSha,
      publishedAt: new Date().toISOString(),
      artifacts: {
        macos: { name: macos, url: `http://127.0.0.1:${process.env.ARTIFACT_PORT}/${macos}`, sha256: digest(macos) },
        portable: { name: "station-portable.tar.gz", url: `http://127.0.0.1:${process.env.ARTIFACT_PORT}/station-portable.tar.gz`, sha256: digest("station-portable.tar.gz") },
      },
    }, null, 2)}\n`);
  ' "$source_temp/manifest-payload.json" "$serve_dir" "$release_channel" "$version" "$release_tag" "$source_sha"
  # The keyId must name a pinned installer key; the throwaway key
  # stands in for its bytes only through the test-only
  # STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL override below.
  STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS=1 node "$GITHUB_WORKSPACE/scripts/ecosystem-manifest.mjs" create \
    --payload "$source_temp/manifest-payload.json" \
    --private-key "$source_temp/manifest-private.pem" \
    --key-id station-portable-release-2026-09 \
    --output "$manifests_dir/manifest.json"
}
write_manifest_payload

node -e '
  require("node:http").createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [] }));
  }).listen(Number(process.env.OLLAMA_PORT), "127.0.0.1");
' >"$source_temp/station-ollama-fixture.log" 2>&1 &
ollama_pid=$!
node scripts/install-smoke-file-server.mjs "${ARTIFACT_PORT}" "$serve_dir" >"$source_temp/station-artifact-server.log" 2>&1 &
artifact_pid=$!
node scripts/install-smoke-file-server.mjs "${MANIFEST_PORT}" "$manifests_dir" >"$source_temp/station-manifest-server.log" 2>&1 &
manifest_pid=$!
node scripts/install-smoke-file-server.mjs "${KEY_PORT}" "$keys_dir" >"$source_temp/station-key-server.log" 2>&1 &
key_pid=$!
cleanup() {
  "$launcher" stop --base="$station_home" >/dev/null 2>&1 || true
  kill "$ollama_pid" "$artifact_pid" "$manifest_pid" "$key_pid" >/dev/null 2>&1 || true
  wait "$ollama_pid" "$artifact_pid" "$manifest_pid" "$key_pid" 2>/dev/null || true
}
trap cleanup EXIT

wait_for_fixture() {
  local label=$1 pid=$2 url=$3 log=$4
  local deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Fixture $label exited before readiness (pid=$pid)." >&2
      tail -100 "$log" >&2 || true
      return 1
    fi
    if curl --noproxy '*' --silent --fail --head --connect-timeout 1 --max-time 2 "$url" >/dev/null; then
      echo "Fixture $label ready (pid=$pid)."
      return 0
    fi
    sleep 0.2
  done
  echo "Fixture $label did not become reachable within 30 seconds (pid=$pid)." >&2
  ps -p "$pid" -o pid=,ppid=,stat=,comm= >&2 || true
  tail -100 "$log" >&2 || true
  return 1
}
wait_for_fixture artifact "$artifact_pid" "http://127.0.0.1:${ARTIFACT_PORT}/station-portable.tar.gz" "$source_temp/station-artifact-server.log"
wait_for_fixture manifest "$manifest_pid" "http://127.0.0.1:${MANIFEST_PORT}/manifest.json" "$source_temp/station-manifest-server.log"
wait_for_fixture key "$key_pid" "http://127.0.0.1:${KEY_PORT}/public.pem" "$source_temp/station-key-server.log"
wait_for_fixture ollama "$ollama_pid" "http://127.0.0.1:${OLLAMA_PORT}/api/tags" "$source_temp/station-ollama-fixture.log"

public_install_env=(
  "STATION_INSTALL_PUBLIC_MANIFEST_URL=http://127.0.0.1:${MANIFEST_PORT}/manifest.json"
  "STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL=http://127.0.0.1:${KEY_PORT}/public.pem"
  STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1
  "STATION_INSTALL_SERVER_PORT=${SERVER_PORT}"
  "STATION_INSTALL_UI_PORT=${UI_PORT}"
)

curl -fsSL "file://$GITHUB_WORKSPACE/install.sh" | env \
  HOME="$SMOKE_HOME" \
  PATH="$SMOKE_HOME/fake-bin:$PATH" \
  STATION_CHANNEL="$RUNTIME_CHANNEL" \
  "${public_install_env[@]}" \
  sh 2>&1 | tee "$source_temp/install.log"

# #2703: install.sh must build the release under the lifecycle
# instance id its start uses. Otherwise the start after install
# prints a second "Building application" and rebuilds, leaving the
# install-time build orphaned beside the one it serves.
build_count=$(grep -c 'Building application' "$source_temp/install.log" || true)
if [ "$build_count" != 1 ]; then
  echo "Expected one build (at install, none at start); saw $build_count" >&2
  exit 1
fi
for build_output in dist-server dist-ui; do
  outputs=$(find "$install_root/current/" -maxdepth 1 -name "$build_output*" | wc -l | tr -d ' ')
  if [ "$outputs" != 1 ]; then
    echo "Expected one $build_output build in the release; saw $outputs" >&2
    exit 1
  fi
done

previous_current=$(readlink "$install_root/current")
env \
  HOME="$SMOKE_HOME" \
  PATH="$SMOKE_HOME/fake-bin:$SMOKE_HOME/.local/bin:$PATH" \
  "${public_install_env[@]}" \
  "$launcher" upgrade
node -e '
  const fs = require("node:fs");
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (state.channel !== process.argv[2]) process.exit(1);
' "$install_root/.station-release-state.json" "$RUNTIME_CHANNEL"

bad_release="$source_temp/release-fails-start"
bad_work="$source_temp/release-fails-start-work"
mkdir -p "$bad_release" "$bad_work"
tar -xzf "$RELEASE_DIR/station-portable.tar.gz" -C "$bad_work"
mv "$bad_work/station/station" "$bad_work/station/station.real"
cat >"$bad_work/station/station" <<'EOF'
#!/bin/bash
if [ "${1:-}" = start ]; then exit 97; fi
exec "$(dirname "$0")/station.real" "$@"
EOF
chmod +x "$bad_work/station/station"
tar -czf "$bad_release/station-portable.tar.gz" -C "$bad_work" station
# Swap the served fixture and re-sign the manifest so the packaged
# upgrade verifies the bad candidate, fails its start, and rolls back.
# The bad candidate reuses the installed version with new bytes, which
# the installer refuses as a possible replay unless the exact version
# is named with STATION_INSTALL_ALLOW_ROLLBACK=1.
cp "$bad_release/station-portable.tar.gz" "$serve_dir/station-portable.tar.gz"
write_manifest_payload
if env \
  HOME="$SMOKE_HOME" \
  PATH="$SMOKE_HOME/fake-bin:$SMOKE_HOME/.local/bin:$PATH" \
  "${public_install_env[@]}" \
  STATION_VERSION="$release_tag" \
  STATION_INSTALL_ALLOW_ROLLBACK=1 \
  "$launcher" upgrade 2>"$source_temp/bad-upgrade.err"
then
  echo "Expected failed candidate start" >&2
  exit 1
fi
test "$(readlink "$install_root/current")" = "$previous_current"
# Fail for the reason under test, not an earlier refusal.
cat "$source_temp/bad-upgrade.err" >&2
grep -q 'the new release did not start' "$source_temp/bad-upgrade.err"
node -e '
  const fs = require("node:fs");
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (state.channel !== process.argv[2]) process.exit(1);
' "$install_root/.station-release-state.json" "$RUNTIME_CHANNEL"

test ! -e "$install_root/current/.git"
HOME="$SMOKE_HOME" \
  PATH="$SMOKE_HOME/fake-bin:$SMOKE_HOME/.local/bin:$PATH" \
  "$launcher" doctor --json >"$source_temp/doctor.json"
jq -e '.exitReady == {chatReady:true,runtimeReady:true}' \
  "$source_temp/doctor.json"
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 \
  -o "$source_temp/station-ui.html" "http://127.0.0.1:${UI_PORT}/"
grep -q '<div id="root"' "$source_temp/station-ui.html"
# EXPECTED_SHA, not GITHUB_SHA: under pull_request_target GITHUB_SHA
# is the BASE tip while the checkout and packager use the PR head.
curl -fsS "http://127.0.0.1:${UI_PORT}/__station/identity" \
  | jq -e --arg sha "$EXPECTED_SHA" '.sha == $sha and (.bootId | length > 0)'

curl -fsSL "file://$GITHUB_WORKSPACE/install.sh" | env \
  HOME="$SMOKE_HOME" \
  STATION_CHANNEL="$RUNTIME_CHANNEL" \
  sh -s uninstall
test ! -e "$install_root"
test -d "$station_home"
