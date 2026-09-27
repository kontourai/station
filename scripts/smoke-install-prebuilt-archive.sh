#!/usr/bin/env bash
# Installs a prebuilt server archive through install.sh's public-manifest path
# on a host with NO Node.js on PATH (#2675 B2), then:
#   - the install downloads the pinned Node.js only to verify and extract;
#   - `start` serves the archive's prebuilt build and never builds;
#   - `station upgrade` moves to a second archive with no manifest URL in the
#     environment (the install state records it) and no download (the
#     installed archive's Node.js verifies);
#   - the installed version's own install.sh uninstalls it.
#
#   scripts/smoke-install-prebuilt-archive.sh <first archive> <second archive> <work dir>
#
# Each archive needs its builder descriptor (<archive>.json) beside it, and
# both must be the preview ring (vX.Y.Z-preview.N) for this host. The
# manifests are signed with a throwaway key under the pinned release key id,
# through install.sh's test-only key override; nothing is published. This
# script runs Node.js itself (to sign), but every installer and launcher run
# gets a PATH without it.
set -euo pipefail

first_archive="$1"
second_archive="$2"
work="$3"
repo="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)"
server_port="${SMOKE_SERVER_PORT:-3441}"
ui_port="${SMOKE_UI_PORT:-3300}"
serve_port="${SMOKE_SERVE_PORT:-8768}"

rm -rf "$work"
mkdir -p "$work/serve" "$work/home"
smoke_home="$work/home"
station_root="$smoke_home/.station"
install_root="$station_root/installs/beta"
station_home="$station_root/instances/beta"
launcher="$smoke_home/.local/bin/station-beta"

# A PATH with the base OS tools and no Node.js. A directory that holds node
# is replaced by links to everything else in it.
no_node_path=""
for dir in /usr/bin /bin /usr/sbin /sbin; do
  [ -d "$dir" ] || continue
  if [ -e "$dir/node" ]; then
    farm="$work/no-node$(printf '%s' "$dir" | tr / -)"
    mkdir -p "$farm"
    for entry in "$dir"/*; do
      case "${entry##*/}" in node|npm|npx|corepack) continue ;; esac
      ln -s "$entry" "$farm/${entry##*/}"
    done
    dir="$farm"
  fi
  no_node_path="${no_node_path:+$no_node_path:}$dir"
done
if env PATH="$no_node_path" sh -c 'command -v node' >/dev/null 2>&1; then
  echo "the no-Node PATH still resolves node: $no_node_path" >&2
  exit 1
fi

node -e '
  const { generateKeyPairSync } = require("node:crypto");
  const fs = require("node:fs");
  const [privatePath, publicPath] = process.argv.slice(1);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.writeFileSync(publicPath, publicKey.export({ format: "pem", type: "spki" }));
' "$work/private.pem" "$work/serve/public.pem"

# Serves <archive> as its version's asset and signs serve/preview.json for it.
publish() {
  archive="$1"
  descriptor="$archive.json"
  tag="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).release.ref' "$descriptor")"
  mkdir -p "$work/serve/$tag"
  cp "$archive" "$work/serve/$tag/"
  node -e '
    const fs = require("node:fs");
    const [descriptorPath, output, base] = process.argv.slice(1);
    const d = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    const [os, arch] = d.target.split("-");
    const version = d.release.ref.slice(1);
    fs.writeFileSync(output, `${JSON.stringify({
      schemaVersion: 2,
      channel: d.release.releaseChannel,
      version,
      releaseTag: d.release.ref,
      sourceSha: d.release.sha,
      publishedAt: new Date().toISOString(),
      nodeVersion: d.node.version,
      launcherProtocol: { min: 1, max: 1 },
      artifacts: [{ os, arch, name: d.name, url: `${base}${d.release.ref}/${d.name}`, sha256: d.sha256, size: d.size, format: d.format }],
    }, null, 2)}\n`);
  ' "$descriptor" "$work/payload.json" "http://127.0.0.1:$serve_port/"
  STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS=1 node "$repo/scripts/ecosystem-manifest.mjs" create \
    --payload "$work/payload.json" \
    --private-key "$work/private.pem" \
    --key-id station-portable-release-2026-09 \
    --output "$work/serve/preview.json" >&2
  printf '%s\n' "${tag#v}"
}

first_version="$(publish "$first_archive")"
python3 -m http.server "$serve_port" --bind 127.0.0.1 --directory "$work/serve" \
  >"$work/http.log" 2>&1 &
serve_pid=$!
cleanup() {
  env -i HOME="$smoke_home" PATH="$no_node_path" "$launcher" stop --base="$station_home" >/dev/null 2>&1 || true
  kill "$serve_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$serve_port/public.pem" 2>/dev/null && break
  sleep 0.2
done

# The test-only key override and the ports go to every installer run; the
# manifest URL only to the first.
installer_env=(
  HOME="$smoke_home"
  PATH="$no_node_path"
  STATION_CHANNEL=beta
  STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL="http://127.0.0.1:$serve_port/public.pem"
  STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1
  STATION_INSTALL_SERVER_PORT="$server_port"
  STATION_INSTALL_UI_PORT="$ui_port"
)

echo "== install $first_version with no Node.js on PATH"
curl -fsSL "file://$repo/install.sh" | env -i "${installer_env[@]}" \
  STATION_INSTALL_PUBLIC_MANIFEST_URL="http://127.0.0.1:$serve_port/preview.json" \
  sh 2>&1 | tee "$work/install.log"
grep -q 'Downloading Node.js' "$work/install.log"
if grep -q 'Building application' "$work/install.log"; then
  echo 'the archive install built the application' >&2
  exit 1
fi
test "$(readlink "$install_root/current")" = "$(cd "$install_root" && pwd -P)/versions/$first_version"
test -f "$install_root/current/.station-install-complete"
grep -qx '# station-owned-launcher-v2' "$launcher"
if find "$install_root/versions/$first_version" -perm -u+w | grep -q .; then
  echo 'the installed version is writable' >&2
  exit 1
fi
node -e '
  const state = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (state.schemaVersion !== 4 || state.manifestUrl !== process.argv[2]) process.exit(1);
' "$install_root/.station-release-state.json" "http://127.0.0.1:$serve_port/preview.json"
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 \
  "http://127.0.0.1:$ui_port/__station/identity" | tee "$work/identity-1.json"
echo

echo "== station upgrade to the second archive, no manifest URL in the environment"
second_version="$(publish "$second_archive")"
env -i "${installer_env[@]}" "$launcher" upgrade 2>&1 | tee "$work/upgrade.log"
if grep -q 'Downloading Node.js' "$work/upgrade.log"; then
  echo 'the upgrade downloaded Node.js instead of using the installed one' >&2
  exit 1
fi
if grep -q 'Building application' "$work/upgrade.log"; then
  echo 'the archive upgrade built the application' >&2
  exit 1
fi
test "$(readlink "$install_root/current")" = "$(cd "$install_root" && pwd -P)/versions/$second_version"
test -d "$install_root/versions/$first_version"
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 \
  "http://127.0.0.1:$ui_port/__station/identity" | tee "$work/identity-2.json"
echo

echo "== restart: start serves the installed build"
env -i "${installer_env[@]}" "$launcher" stop --base="$station_home" 2>&1 | tee "$work/stop.log"
env -i "${installer_env[@]}" "$launcher" start --base="$station_home" \
  "--port=$server_port" "--ui-port=$ui_port" 2>&1 | tee "$work/start.log"
if grep -q 'Building application' "$work/start.log"; then
  echo 'start built the application' >&2
  exit 1
fi

echo "== uninstall with the installed version's own install.sh"
env -i "${installer_env[@]}" "$install_root/current/install.sh" uninstall 2>&1 | tee "$work/uninstall.log"
test ! -e "$install_root"
test ! -e "$launcher"
test -d "$station_home"
echo 'Prebuilt archive install smoke passed.'
