#!/bin/sh
set -eu

REPOSITORY="kontourai/station"
ASSET_NAME="station-portable.tar.gz"
CHECKSUM_NAME="${ASSET_NAME}.sha256"
INSTALL_ROOT_MARKER='.station-portable-install-root'
DATA_ROOT_MARKER='.station-portable-data-root'
INSTALL_ROOT_SIGNATURE='station-portable-install-root-v1'
DATA_ROOT_SIGNATURE='station-portable-data-root-v1'

fail() {
  printf 'Station install failed: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

default_bin_dir() {
  printf '%s/.local/bin\n' "$HOME"
}

runtime_channel_was_requested=false
if [ -n "${STATION_CHANNEL+x}" ]; then runtime_channel_was_requested=true; fi
install_root_was_requested=false
if [ -n "${STATION_INSTALL_ROOT+x}" ]; then install_root_was_requested=true; fi
requested_runtime_channel="${STATION_CHANNEL:-stable}"
case "$requested_runtime_channel" in
  stable|beta) ;;
  preview)
    fail 'STATION_CHANNEL=preview is a legacy unqualified channel; rerun with STATION_CHANNEL=beta (or install stable with STATION_CHANNEL=stable)'
    ;;
  *) fail 'STATION_CHANNEL must be stable or beta' ;;
esac

# `node` is the one portable authority for resolving filesystem aliases. Check
# it before normalizing STATION_ROOT or deriving any runtime defaults.
require_command node

normalized_station_root() {
  node -e '
    const [raw, fallback] = process.argv.slice(1);
    process.stdout.write(raw.trim() || fallback);
  ' "${STATION_ROOT:-}" "$HOME/.station"
}

configure_runtime_paths() {
  runtime_channel="$1"
  case "$runtime_channel" in
    stable)
      runtime_release_channel=stable
      runtime_server_port=18141
      runtime_ui_port=18000
      runtime_launcher_name=station
      ;;
    beta)
      runtime_release_channel=preview
      runtime_server_port=28141
      runtime_ui_port=28000
      runtime_launcher_name=station-beta
      ;;
    *) fail "unsupported verified runtime channel: $runtime_channel" ;;
  esac
  station_root="$(normalized_station_root)" || fail 'STATION_ROOT is invalid'
  install_root="${STATION_INSTALL_ROOT:-$station_root/installs/$runtime_channel}"
  bin_dir="${STATION_BIN_DIR:-$(default_bin_dir)}"
  station_home="${STATION_HOME:-$station_root/instances/$runtime_channel}"
  current_link="$install_root/current"
  launcher="$bin_dir/$runtime_launcher_name"
  state_file="$install_root/.station-release-state.json"
}

# A verified release determines the runtime identity.  Once that identity is
# known, use one port resolution for both the pre-promotion build and the
# supervised start.  Keeping this here avoids producing assets for one port
# pair and booting them with another.
resolve_runtime_flags() {
  resolved_server_port="${STATION_INSTALL_SERVER_PORT:-${STATION_SERVER_PORT:-$runtime_server_port}}"
  resolved_ui_port="${STATION_INSTALL_UI_PORT:-${STATION_UI_PORT:-$runtime_ui_port}}"
}

# Uninstall has no release manifest to verify. Its channel therefore comes only
# from the invoking wrapper (or stable's explicit default), never from a stale
# unqualified preview state.
configure_runtime_paths "$requested_runtime_channel"

normalize_runtime_paths() {
  raw_station_home="$station_home"
  raw_install_root="$install_root"
  station_root="$(canonicalize_path "$station_root")" || fail 'STATION_ROOT is invalid'
  station_home="$(canonicalize_path "$station_home")" || fail 'STATION_HOME is invalid'
  install_root="$(canonicalize_path "$install_root")" || fail 'STATION_INSTALL_ROOT is invalid'
  bin_dir="$(canonicalize_path "$bin_dir")" || fail 'STATION_BIN_DIR is invalid'
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [rawHome, rawInstall, root, home, install, rawBin, channel] = process.argv.slice(1);
    const fold = (value) => process.platform === "darwin" ? value.toLowerCase() : value;
    const same = (left, right) => fold(left) === fold(right);
    const inside = (child, parent) => {
      const normalizedChild = fold(child), normalizedParent = fold(parent);
      return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
    };
    const inspectDirectory = (target) => {
      let info;
      try { info = fs.lstatSync(target); } catch (error) {
        if (error && error.code === "ENOENT") return;
        throw error;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) process.exit(2);
    };
    const rejectSelectedLeafLink = (target) => {
      try { if (fs.lstatSync(target).isSymbolicLink()) process.exit(3); }
      catch (error) { if (!error || error.code !== "ENOENT") throw error; }
    };
    inspectDirectory(root);
    for (const name of ["config", "cache", "installs", "instances"])
      inspectDirectory(path.join(root, name));
    inspectDirectory(path.join(root, "instances", "dev"));
    rejectSelectedLeafLink(rawHome);
    rejectSelectedLeafLink(rawInstall);
    if (same(home, root) ||
        ["config", "cache", "installs"].some((name) => inside(home, path.join(root, name))) ||
        same(home, path.join(root, "instances")) ||
        same(home, path.join(root, "instances", "dev"))) process.exit(4);
    const verifiedLeaf = path.join(root, "installs", channel);
    if (inside(install, root) && !same(install, verifiedLeaf)) process.exit(5);
    if (inside(root, home) || inside(root, install)) process.exit(6);
    void rawBin;
  ' "$raw_station_home" "$raw_install_root" "$station_root" "$station_home" "$install_root" "$bin_dir" "$runtime_channel" || \
    fail 'Station runtime paths are invalid, protected, or contain an unsafe selected link'
  current_link="$install_root/current"
  launcher="$bin_dir/$runtime_launcher_name"
  state_file="$install_root/.station-release-state.json"
}

canonicalize_path() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const absolute = path.resolve(process.argv[1]);
    const parsed = path.parse(absolute);
    let cursor = parsed.root;
    const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const next = path.join(cursor, segments[index]);
      let info;
      try { info = fs.lstatSync(next); } catch (error) {
        if (error && error.code === "ENOENT") {
          process.stdout.write(path.resolve(cursor, ...segments.slice(index)));
          process.exit(0);
        }
        throw error;
      }
      cursor = info.isSymbolicLink() ? fs.realpathSync(next) : next;
    }
    process.stdout.write(path.resolve(cursor));
  ' "$1"
}

# Freeze all persisted and launched roots before any later cwd change.
normalize_runtime_paths

launcher_is_owned() {
  [ -f "$launcher" ] && [ ! -L "$launcher" ] || return 1
  node -e '
    const fs = require("node:fs");
    const [path, channel, stationRoot, home, root, current] = process.argv.slice(1);
    const text = fs.readFileSync(path, "utf8");
    const sq = String.fromCharCode(39);
    const q = (value) => sq + value.split(sq).join(`${sq}"${sq}"${sq}`) + sq;
    const expected = [
      "#!/bin/sh", "# station-owned-launcher-v1",
      `export STATION_CHANNEL=${q(channel)}`,
      `export STATION_ROOT=${q(stationRoot)}`,
      `export STATION_HOME=${q(home)}`,
      `export STATION_INSTALL_ROOT=${q(root)}`,
      `exec ${q(`${current}/station`)} "$@"`, ""
    ].join("\n");
    if (text !== expected) process.exit(1);
  ' "$launcher" "$runtime_channel" "$station_root" "$station_home" "$install_root" "$current_link"
}

assert_launcher_safe() {
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    launcher_is_owned || fail "refusing to replace a launcher not owned by the $runtime_channel install: $launcher"
  fi
}

write_staged_launcher() {
  staged_launcher="$bin_dir/.station-launcher-$runtime_channel.$$"
  rm -f "$staged_launcher"
  node -e '
    const fs = require("node:fs");
    const [path, channel, stationRoot, home, root, current] = process.argv.slice(1);
    const sq = String.fromCharCode(39);
    const q = (value) => sq + value.split(sq).join(`${sq}"${sq}"${sq}`) + sq;
    const text = [
      "#!/bin/sh", "# station-owned-launcher-v1",
      `export STATION_CHANNEL=${q(channel)}`,
      `export STATION_ROOT=${q(stationRoot)}`,
      `export STATION_HOME=${q(home)}`,
      `export STATION_INSTALL_ROOT=${q(root)}`,
      `exec ${q(`${current}/station`)} "$@"`, ""
    ].join("\n");
    fs.writeFileSync(path, text, { encoding: "utf8", mode: 0o755, flag: "wx" });
    fs.chmodSync(path, 0o755);
    const fd = fs.openSync(path, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$staged_launcher" "$runtime_channel" "$station_root" "$station_home" "$install_root" "$current_link" || \
    fail 'could not stage the channel launcher'
}

launcher_points_to_current() {
  launcher_is_owned
}

assert_safe_remove_target() {
  target="$1"
  [ -n "$target" ] || fail 'refusing to remove an empty path'
  [ ! -L "$target" ] || fail "refusing to remove a symlinked root: $target"
  if [ -e "$target" ]; then
    node -e '
      const fs = require("node:fs");
      const info = fs.lstatSync(process.argv[1]);
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        process.exit(1);
      }
    ' "$target" || fail "refusing to remove a root owned by another user: $target"
  fi
  canonical_target="$(canonicalize_path "$target")"
  canonical_home="$(canonicalize_path "$HOME")"
  case "$canonical_home/" in
    "$canonical_target/"*) fail "refusing to remove HOME or its ancestor: $target" ;;
  esac
  [ "$canonical_target" != "/" ] || fail 'refusing to remove /'
}

assert_roots_do_not_overlap() {
  canonical_install_root="$(canonicalize_path "$install_root")"
  canonical_station_home="$(canonicalize_path "$station_home")"
  case "$canonical_station_home/" in
    "$canonical_install_root/"*)
      fail 'STATION_HOME and STATION_INSTALL_ROOT must not overlap so uninstall can preserve data'
      ;;
  esac
  case "$canonical_install_root/" in
    "$canonical_station_home/"*)
      fail 'STATION_HOME and STATION_INSTALL_ROOT must not overlap so uninstall can preserve data'
      ;;
  esac
}

# The installer owns exactly one channel leaf. It must never claim a shared
# root or container, even when STATION_HOME is deliberately outside the root:
# uninstall removes INSTALL_ROOT and must not be able to erase profiles,
# another runtime, cache, or all channel installs.
assert_install_root_is_channel_leaf() {
  canonical_install_root="$(canonicalize_path "$install_root")"
  canonical_station_root="$(canonicalize_path "$station_root")"
  for shared in \
    "$canonical_station_root" \
    "$canonical_station_root/config" \
    "$canonical_station_root/instances" \
    "$canonical_station_root/cache" \
    "$canonical_station_root/installs"; do
    case "$shared/" in
      "$canonical_install_root/"*)
        fail "STATION_INSTALL_ROOT must be a channel leaf, not a Station shared root or container: $install_root"
        ;;
    esac
  done
  for protected in \
    "$canonical_station_root/config" \
    "$canonical_station_root/instances" \
    "$canonical_station_root/cache"; do
    case "$canonical_install_root/" in
      "$protected/"*)
        fail "STATION_INSTALL_ROOT must not be inside protected Station data: $install_root"
        ;;
    esac
  done
  expected_channel_leaf="$canonical_station_root/installs/$runtime_channel"
  case "$canonical_install_root" in
    "$canonical_station_root/installs"|"$canonical_station_root/installs/"*)
      [ "$canonical_install_root" = "$expected_channel_leaf" ] || \
        fail "STATION_INSTALL_ROOT must be the verified $runtime_channel channel leaf: $install_root"
      ;;
  esac
}

prepare_owned_root() {
  root="$1"
  marker_name="$2"
  signature="$3"
  existing_policy="$4"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, markerName, signature, existingPolicy] = process.argv.slice(1);
    const owner = typeof process.getuid === "function" ? process.getuid() : null;
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootInfo = fs.lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
        (owner !== null && rootInfo.uid !== owner) ||
        (rootInfo.mode & 0o022) !== 0) process.exit(2);
    const marker = path.join(root, markerName);
    if (fs.existsSync(marker)) {
      const info = fs.lstatSync(marker);
      if (!info.isFile() || info.isSymbolicLink() ||
          (owner !== null && info.uid !== owner) ||
          (info.mode & 0o077) !== 0 ||
          fs.readFileSync(marker, "utf8") !== `${signature}\n`) process.exit(3);
      process.stdout.write("managed");
      process.exit(0);
    }
    if (fs.readdirSync(root).length > 0) {
      if (existingPolicy === "preserve") {
        process.stdout.write("preserved");
        process.exit(0);
      }
      process.exit(4);
    }
    const fd = fs.openSync(marker, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${signature}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    process.stdout.write("managed");
  ' "$root" "$marker_name" "$signature" "$existing_policy"
}

prepare_safe_directory() {
  directory="$1"
  node -e '
    const fs = require("node:fs");
    const directory = process.argv[1];
    const owner = typeof process.getuid === "function" ? process.getuid() : null;
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (owner !== null && info.uid !== owner) ||
        (info.mode & 0o022) !== 0) process.exit(1);
  ' "$directory" || fail "directory must be same-user and not group/world writable: $directory"
}

assert_owned_root() {
  root="$1"
  marker_name="$2"
  signature="$3"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, markerName, signature] = process.argv.slice(1);
    const owner = typeof process.getuid === "function" ? process.getuid() : null;
    const rootInfo = fs.lstatSync(root);
    const marker = path.join(root, markerName);
    const markerInfo = fs.lstatSync(marker);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
        !markerInfo.isFile() || markerInfo.isSymbolicLink() ||
        (owner !== null && (rootInfo.uid !== owner || markerInfo.uid !== owner)) ||
        fs.readFileSync(marker, "utf8") !== `${signature}\n`) process.exit(1);
  ' "$root" "$marker_name" "$signature" 2>/dev/null || \
    fail "refusing to remove a root not owned by this installer: $root"
}

safe_remove_tree() {
  target="$1"
  assert_safe_remove_target "$target"
  rm -rf "$target"
}

stop_installed_station() {
  if [ -x "$current_link/station" ]; then
    if ! PATH="$current_link/node_modules/.bin:$PATH" \
      "$current_link/station" stop --base="$station_home"; then
      fail 'could not stop the installed Station; no files were removed'
    fi
  fi
}

start_installed_station() {
  set -- start --base="$station_home" \
    "--port=$resolved_server_port" \
    "--ui-port=$resolved_ui_port"
  PATH="$current_link/node_modules/.bin:$PATH" "$launcher" "$@"
}

replace_link_atomically() {
  target="$1"
  destination="$2"
  pending="$install_root/.link.$$"
  rm -f "$pending"
  ln -s "$target" "$pending"
  node -e '
    const fs = require("node:fs");
    fs.renameSync(process.argv[1], process.argv[2]);
  ' "$pending" "$destination"
}

restore_previous_state() {
  if [ -f "$previous_state_backup" ]; then
    restore_stage="$install_root/.station-release-state.restore.$$"
    node -e '
      const fs = require("node:fs");
      const [source, stage, destination] = process.argv.slice(1);
      fs.copyFileSync(source, stage, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(stage, 0o600);
      const fd = fs.openSync(stage, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(stage, destination);
    ' "$previous_state_backup" "$restore_stage" "$state_file" || return 1
  else
    rm -f "$state_file"
  fi
}

restore_previous_launcher() {
  if [ "$previous_launcher_present" = true ]; then
    restore_launcher_stage="$bin_dir/.station-launcher.restore.$$"
    node -e '
      const fs = require("node:fs");
      fs.copyFileSync(process.argv[1], process.argv[2], fs.constants.COPYFILE_EXCL);
      fs.chmodSync(process.argv[2], 0o755);
      fs.renameSync(process.argv[2], process.argv[3]);
    ' "$previous_launcher_backup" "$restore_launcher_stage" "$launcher" || return 1
  else
    rm -f "$launcher"
  fi
}

restore_previous_release() {
  if [ -n "$previous_release" ]; then
    replace_link_atomically "$previous_release" "$current_link" || return 1
    restore_previous_launcher || return 1
    restore_previous_state || return 1
    start_installed_station >/dev/null 2>&1 || return 1
  else
    rm -f "$current_link" "$launcher"
    restore_previous_state || return 1
  fi
}

fail_with_rollback() {
  failure="$1"
  if restore_previous_release; then
    if [ -n "$previous_release" ]; then
      fail "$failure; the previous release was restored"
    fi
    fail "$failure; the incomplete install was removed"
  fi
  fail "$failure; automatic recovery also failed"
}

uninstall_station() {
  purge_data=false
  if [ "${1:-}" = "--purge-data" ]; then
    purge_data=true
  elif [ -n "${1:-}" ]; then
    fail "unknown uninstall option: $1"
  fi

  if [ -e "$install_root" ] || [ -L "$install_root" ]; then
    assert_safe_remove_target "$install_root"
    assert_owned_root "$install_root" "$INSTALL_ROOT_MARKER" "$INSTALL_ROOT_SIGNATURE"
  fi
  if [ "$purge_data" = true ] && { [ -e "$station_home" ] || [ -L "$station_home" ]; }; then
    assert_safe_remove_target "$station_home"
    assert_owned_root "$station_home" "$DATA_ROOT_MARKER" "$DATA_ROOT_SIGNATURE"
  fi

  stop_installed_station
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    launcher_is_owned || fail "refusing to remove a launcher not owned by the $runtime_channel install: $launcher"
    rm -f "$launcher"
  fi
  if [ -e "$install_root" ] || [ -L "$install_root" ]; then
    safe_remove_tree "$install_root"
  fi
  if [ "$purge_data" = true ] && { [ -e "$station_home" ] || [ -L "$station_home" ]; }; then
    safe_remove_tree "$station_home"
  fi

  printf 'Station uninstalled.\n'
  if [ "$purge_data" = false ]; then
    printf 'Data preserved at %s\n' "$station_home"
  fi
}

assert_safe_remove_target "$install_root"
assert_roots_do_not_overlap
assert_install_root_is_channel_leaf

case "${1:-install}" in
  install) ;;
  uninstall)
    shift
    uninstall_station "${1:-}"
    exit 0
    ;;
  *) fail "usage: install.sh [install|uninstall [--purge-data]]" ;;
esac

public_manifest_url="${STATION_INSTALL_PUBLIC_MANIFEST_URL:-}"
if [ -n "$public_manifest_url" ]; then
  required_commands='curl tar npm'
else
  required_commands='curl tar npm gh'
fi
for command_name in $required_commands; do
  require_command "$command_name"
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" = 24 ] || fail "Node.js 24.x is required; found $(node --version)"

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/station-install.XXXXXX")"
state_stage=""
gh_config_dir="$tmp_root/gh-config"
build_home="$tmp_root/build-home"
mkdir -m 700 "$gh_config_dir" "$build_home"
export GH_CONFIG_DIR="$gh_config_dir"
cleanup() {
  if [ -n "$state_stage" ]; then
    rm -f "$state_stage"
  fi
  if [ -n "${staged_launcher:-}" ]; then
    rm -f "$staged_launcher"
  fi
  # The release build intentionally receives an inaccessible GitHub config.
  # Restore owner traversal only inside our private temporary root so the trap
  # can remove it without weakening the build-time credential boundary.
  chmod -R u+rwx "$tmp_root" 2>/dev/null || true
  rm -rf "$tmp_root"
}
trap cleanup EXIT HUP INT TERM

previous_state_backup="$tmp_root/previous-release-state.json"
previous_launcher_backup="$tmp_root/previous-launcher"
previous_launcher_present=false
release_channel="$runtime_release_channel"
version="${STATION_VERSION:-latest}"
if [ "$version" != latest ]; then
  if ! printf '%s' "$version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.([1-9][0-9]*))?$'; then
    fail "invalid STATION_VERSION: $version"
  fi
fi

if [ -n "$public_manifest_url" ]; then
  public_key_url="${STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL:-}"
  [ -n "$public_key_url" ] || fail 'STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL is required for public installation'
  node -e '
    const [manifest, key] = process.argv.slice(1);
    const allowHttp = process.env.STATION_INSTALL_ALLOW_INSECURE_TEST_URLS === "1";
    for (const value of [manifest, key]) {
      const url = new URL(value);
      if (url.protocol !== "https:" && !(allowHttp && ["http:", "file:"].includes(url.protocol))) process.exit(1);
    }
    const manifestUrl = new URL(manifest), keyUrl = new URL(key);
    if (manifestUrl.protocol === "file:" && keyUrl.protocol === "file:") {
      if (require("node:path").dirname(manifestUrl.pathname) === require("node:path").dirname(keyUrl.pathname)) process.exit(1);
    } else if (manifestUrl.origin === keyUrl.origin) process.exit(1);
  ' "$public_manifest_url" "$public_key_url" || \
    fail 'public manifest and signing-key URLs must be distinct HTTPS authorities'
  manifest_file="$tmp_root/station-ecosystem-manifest.json"
  manifest_key="$tmp_root/station-ecosystem-manifest.pem"
  curl -fsSL --retry 3 --retry-connrefused --connect-timeout 10 -o "$manifest_file" -- "$public_manifest_url" || \
    fail 'could not download public ecosystem manifest'
  curl -fsSL --retry 3 --retry-connrefused --connect-timeout 10 -o "$manifest_key" -- "$public_key_url" || \
    fail 'could not download public ecosystem manifest key'
  public_manifest_values="$(node -e '
    const crypto=require("node:crypto"),fs=require("node:fs");
    const [manifestFile,keyFile,manifestUrl]=process.argv.slice(1);
    const canonical=(v)=>Array.isArray(v)?`[${v.map(canonical).join(",")}]`:v&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`:JSON.stringify(v);
    const envelope=JSON.parse(fs.readFileSync(manifestFile,"utf8"));
    if (JSON.stringify(Object.keys(envelope).sort())!==JSON.stringify(["algorithm","keyId","payload","schemaVersion","signature"])||envelope.schemaVersion!==1||envelope.algorithm!=="ed25519"||typeof envelope.signature!=="string") process.exit(1);
    if (!crypto.verify(null,Buffer.from(canonical(envelope.payload)),crypto.createPublicKey(fs.readFileSync(keyFile,"utf8")),Buffer.from(envelope.signature,"base64"))) process.exit(1);
    const p=envelope.payload, a=p?.artifacts?.portable;
    const stable=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
    const preview=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-preview\.([1-9][0-9]*)$/;
    if (JSON.stringify(Object.keys(p||{}).sort())!==JSON.stringify(["artifacts","channel","publishedAt","releaseTag","schemaVersion","sourceSha","version"])||p.schemaVersion!==1||! ["stable","preview"].includes(p.channel)||p.releaseTag!==`v${p.version}`||! ((p.channel==="stable"&&stable.test(p.version))||(p.channel==="preview"&&preview.test(p.version)))||! /^[0-9a-f]{40}$/i.test(p.sourceSha)||typeof p.publishedAt!=="string"||new Date(p.publishedAt).toISOString()!==p.publishedAt||JSON.stringify(Object.keys(p.artifacts||{}).sort())!==JSON.stringify(["macos","portable"])||!a||JSON.stringify(Object.keys(a).sort())!==JSON.stringify(["name","sha256","url"])||a.name!=="station-portable.tar.gz"||! /^[0-9a-f]{64}$/i.test(a.sha256)||typeof a.url!=="string") process.exit(1);
    const artifactUrl=new URL(a.url), manifestOrigin=new URL(manifestUrl).origin;
    const allowTest=process.env.STATION_INSTALL_ALLOW_INSECURE_TEST_URLS==="1";
    if (artifactUrl.protocol!=="https:" && !(allowTest&&["http:","file:"].includes(artifactUrl.protocol))) process.exit(1);
    if (artifactUrl.protocol==="file:" && new URL(manifestUrl).protocol==="file:") {
      if (require("node:path").dirname(artifactUrl.pathname)===require("node:path").dirname(new URL(manifestUrl).pathname)) process.exit(1);
    } else if (artifactUrl.origin===manifestOrigin) process.exit(1);
    process.stdout.write(`${p.channel}\n${p.releaseTag}\n${p.sourceSha}\n${a.url}\n${a.sha256}`);
  ' "$manifest_file" "$manifest_key" "$public_manifest_url")" || fail 'public ecosystem manifest is invalid or its signature did not verify'
  release_channel="$(printf '%s\n' "$public_manifest_values" | sed -n '1p')"
  release_tag="$(printf '%s\n' "$public_manifest_values" | sed -n '2p')"
  release_sha="$(printf '%s\n' "$public_manifest_values" | sed -n '3p')"
  asset_url="$(printf '%s\n' "$public_manifest_values" | sed -n '4p')"
  expected_checksum="$(printf '%s\n' "$public_manifest_values" | sed -n '5p')"
  [ "$version" = latest ] || [ "$version" = "$release_tag" ] || fail 'requested version does not match public ecosystem manifest'
  if [ "$runtime_channel_was_requested" = true ] && [ "$release_channel" != "$runtime_release_channel" ]; then
    fail 'requested channel does not match public ecosystem manifest'
  fi
  archive="$tmp_root/$ASSET_NAME"
  checksum_file="$tmp_root/$CHECKSUM_NAME"
  curl -fsSL --retry 3 --retry-connrefused --connect-timeout 10 -o "$archive" -- "$asset_url" || fail "could not download $ASSET_NAME"
  printf '%s  %s\n' "$expected_checksum" "$ASSET_NAME" > "$checksum_file"
else
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || \
    fail 'GH_TOKEN or GITHUB_TOKEN is required; use the documented authenticated bootstrap command'
  gh auth status --hostname github.com >/dev/null 2>&1 || fail 'authenticated GitHub CLI access is required for signed releases'
  gh attestation verify --help >/dev/null 2>&1 || fail 'GitHub CLI attestation verification support is required'

if [ "$version" = latest ]; then
  release_metadata="$(gh api "repos/$REPOSITORY/releases?per_page=100")" || fail 'could not resolve signed GitHub releases'
  release_metadata="$(printf '%s' "$release_metadata" | node -e '
    const fs = require("node:fs"); const channel = process.argv[1]; const releases = JSON.parse(fs.readFileSync(0,"utf8"));
    const stable = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
    const preview = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-preview\.([1-9]\d*)$/;
    const candidates = releases.filter((r) => !r?.draft && typeof r.tag_name === "string" && (channel === "stable" ? !r.prerelease && stable.test(r.tag_name) : r.prerelease && preview.test(r.tag_name)));
    if (!candidates.length) process.exit(1);
    const parts = (tag) => tag.match(/\d+/g).map(Number);
    candidates.sort((a,b) => { const ap=parts(a.tag_name), bp=parts(b.tag_name); for(let i=0;i<4;i++){const d=(bp[i]||0)-(ap[i]||0);if(d)return d;} return 0; });
    process.stdout.write(JSON.stringify(candidates[0]));
  ' "$release_channel")" || fail "no published $release_channel release is available"
else
  release_metadata="$(gh api "repos/$REPOSITORY/releases/tags/$version")" || fail "could not resolve release $version"
fi

release_tag="$(printf '%s' "$release_metadata" | node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));if(typeof v.tag_name!=="string"||typeof v.target_commitish!=="string")process.exit(1);process.stdout.write(v.tag_name)')" || fail 'release metadata is incomplete'
release_object="$(gh api "repos/$REPOSITORY/git/ref/tags/$release_tag")" || fail "could not resolve immutable source SHA for $release_tag"
release_object_type="$(printf '%s' "$release_object" | node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));if(!["commit","tag"].includes(v?.object?.type)||typeof v.object.sha!=="string")process.exit(1);process.stdout.write(v.object.type)')" || fail 'release tag ref is malformed'
release_sha="$(printf '%s' "$release_object" | node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(v.object.sha)')"
if [ "$release_object_type" = tag ]; then
  annotated_tag="$(gh api "repos/$REPOSITORY/git/tags/$release_sha")" || fail "could not peel annotated tag $release_tag"
  release_sha="$(printf '%s' "$annotated_tag" | node -e '
    const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));
    if (v?.object?.type !== "commit" || typeof v.object.sha !== "string") process.exit(1);
    process.stdout.write(v.object.sha);
  ')" || fail "annotated tag $release_tag does not resolve directly to a commit"
fi
case "$release_sha" in *[!0-9a-fA-F]*|'') fail 'release source SHA is malformed' ;; esac
[ "${#release_sha}" = 40 ] || fail 'release source SHA must be full length'
case "$release_tag" in
  v[0-9]*-preview.[1-9]*) actual_channel=preview ;;
  v[0-9]*.*.*) actual_channel=stable ;;
  *) fail 'release tag does not match a supported ring' ;;
esac
[ "$actual_channel" = "$release_channel" ] || fail 'requested channel does not match the selected release tag'
printf '%s' "$release_metadata" | node -e '
  const fs=require("node:fs"); const [channel, tag]=process.argv.slice(1); const v=JSON.parse(fs.readFileSync(0,"utf8"));
  if (v.draft || v.tag_name !== tag || Boolean(v.prerelease) !== (channel === "preview")) process.exit(1);
' "$release_channel" "$release_tag" || fail 'release metadata channel/prerelease policy is invalid'

resolve_asset_url() {
  printf '%s' "$release_metadata" | node -e '
    const fs=require("node:fs"); const name=process.argv[1]; const v=JSON.parse(fs.readFileSync(0,"utf8"));
    const asset=Array.isArray(v.assets) ? v.assets.find((x)=>x?.name===name) : null;
    if (!asset || typeof asset.url!=="string" || !asset.url.startsWith("https://api.github.com/repos/kontourai/station/releases/assets/")) process.exit(1);
    process.stdout.write(asset.url);
  ' "$1"
}
ring_manifest_name="station-release-ring-$release_channel.json"
manifest_url="${STATION_INSTALL_MANIFEST_URL:-$(resolve_asset_url "$ring_manifest_name")}" || fail "release is missing $ring_manifest_name"
asset_url="${STATION_INSTALL_ASSET_URL:-$(resolve_asset_url "$ASSET_NAME")}" || fail "release is missing $ASSET_NAME"
checksum_url="${STATION_INSTALL_CHECKSUM_URL:-$(resolve_asset_url "$CHECKSUM_NAME")}" || fail "release is missing $CHECKSUM_NAME"
download_release_file() {
  url="$1" destination="$2"
  case "$url" in https://api.github.com/repos/$REPOSITORY/releases/assets/*) gh api -H 'Accept: application/octet-stream' "$url" >"$destination" ;; *) curl -fsSL --retry 3 --retry-connrefused --connect-timeout 10 -o "$destination" -- "$url" ;; esac
}
verify_attestation() {
  artifact="$1"
  gh attestation verify "$artifact" --repo "$REPOSITORY" --signer-workflow "$REPOSITORY/.github/workflows/release.yml" --source-ref "refs/tags/$release_tag" --source-digest "$release_sha" --cert-oidc-issuer 'https://token.actions.githubusercontent.com' --deny-self-hosted-runners || fail "attestation verification failed for $(basename "$artifact")"
}
manifest_file="$tmp_root/$ring_manifest_name"
download_release_file "$manifest_url" "$manifest_file" || fail "could not download $ring_manifest_name"
verify_attestation "$manifest_file"
manifest_values="$(node -e '
  const fs=require("node:fs");const [p,channel,tag,sha]=process.argv.slice(1);const v=JSON.parse(fs.readFileSync(p,"utf8"));
  const keys=Object.keys(v);const expected=["schemaVersion","channel","prerelease","ref","sha","createdAt","archive","checksum"];
  if (JSON.stringify(keys)!==JSON.stringify(expected)||v.schemaVersion!==1||v.channel!==channel||v.prerelease!==(channel==="preview")||v.ref!==tag||v.sha!==sha||typeof v.createdAt!=="string"||new Date(v.createdAt).toISOString()!==v.createdAt||v.archive?.name!=="station-portable.tar.gz"||! /^[0-9a-f]{64}$/i.test(v.archive?.sha256)||v.checksum?.name!=="station-portable.tar.gz.sha256"||! /^[0-9a-f]{64}$/i.test(v.checksum?.sha256))process.exit(1);process.stdout.write(`${v.archive.sha256}\n${v.checksum.sha256}`);
' "$manifest_file" "$release_channel" "$release_tag" "$release_sha")" || fail 'signed release-ring manifest is malformed or does not match the selected release'
archive_manifest_digest="$(printf '%s\n' "$manifest_values" | sed -n '1p')"
checksum_manifest_digest="$(printf '%s\n' "$manifest_values" | sed -n '2p')"
archive="$tmp_root/$ASSET_NAME" checksum_file="$tmp_root/$CHECKSUM_NAME"
download_release_file "$checksum_url" "$checksum_file" || fail "could not download $CHECKSUM_NAME"
verify_attestation "$checksum_file"
download_release_file "$asset_url" "$archive" || fail "could not download $ASSET_NAME"
verify_attestation "$archive"
# The verifier token and configured gh path are permitted only while resolving,
# downloading, and verifying immutable artifacts. Signed Station code executes
# as the current user; this prevents normal credential inheritance, not access
# to other user-readable files and is not an OS sandbox.
unset GH_TOKEN GITHUB_TOKEN
rm -rf "$gh_config_dir"
mkdir -m 000 "$gh_config_dir"
file_digest() { node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"; }
[ "$(file_digest "$checksum_file")" = "$checksum_manifest_digest" ] || fail 'checksum bytes do not match signed manifest'
[ "$(file_digest "$archive")" = "$archive_manifest_digest" ] || fail 'archive bytes do not match signed manifest'

fi

expected_checksum="$(awk 'NR == 1 { print $1 }' "$checksum_file")"
case "$expected_checksum" in
  ''|*[!0-9A-Fa-f]*) fail 'release checksum is malformed' ;;
esac
[ "${#expected_checksum}" = 64 ] || fail 'release checksum must be SHA-256'

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
else
  fail 'sha256sum or shasum is required'
fi
[ "$actual_checksum" = "$expected_checksum" ] || fail 'release checksum did not match'

tar -tvzf "$archive" | awk '
  {
    type = substr($0, 1, 1)
    if (type != "-" && type != "d") exit 1
  }
' || fail 'release archive contains an unsupported entry type'

tar -tzf "$archive" | awk '
  BEGIN { valid = 1; count = 0 }
  {
    count += 1
    if ($0 !~ /^station\// || $0 ~ /(^|\/)\.\.?(\/|$)/) valid = 0
  }
  END { if (count == 0 || valid == 0) exit 1 }
' || fail 'release archive contains an unsafe path'

extract_root="$tmp_root/extract"
mkdir -p "$extract_root"
tar -xzf "$archive" -C "$extract_root"
candidate="$extract_root/station"
[ -x "$candidate/station" ] || fail 'release archive is missing the Station launcher'
[ -f "$candidate/package-lock.json" ] || fail 'release archive is missing package-lock.json'
[ -f "$candidate/.station-release.json" ] || fail 'release archive is missing provenance'
candidate_identity="$(node -e '
  const fs = require("node:fs");
  const [path, sha, ref, releaseChannel] = process.argv.slice(1);
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  let runtimeChannel;
  let provenanceReleaseChannel;
  if (value?.schemaVersion === 2 &&
      ((value.channel === "stable" && value.releaseChannel === "stable") ||
       (value.channel === "beta" && value.releaseChannel === "preview")) &&
      value.prerelease === (value.releaseChannel === "preview")) {
    runtimeChannel = value.channel;
    provenanceReleaseChannel = value.releaseChannel;
  }
  if (!runtimeChannel || value.sha !== sha || value.ref !== ref ||
      provenanceReleaseChannel !== releaseChannel ||
      typeof value.createdAt !== "string" ||
      new Date(value.createdAt).toISOString() !== value.createdAt) {
    process.exit(1);
  }
  process.stdout.write(`${runtimeChannel}\n${provenanceReleaseChannel}`);
' "$candidate/.station-release.json" "$release_sha" "$release_tag" "$release_channel")" || fail 'release provenance is invalid'

# The release ring is authenticated above. Only now translate its public
# stable/preview protocol into the local runtime's stable/beta identity and
# its exact, concurrent-safe roots.
runtime_channel="$(printf '%s\n' "$candidate_identity" | sed -n '1p')"
candidate_release_channel="$(printf '%s\n' "$candidate_identity" | sed -n '2p')"
[ "$candidate_release_channel" = "$release_channel" ] || fail 'release provenance channel does not match the verified release'
if [ "$runtime_channel_was_requested" = true ] || [ -z "$public_manifest_url" ]; then
  [ "$runtime_channel" = "$requested_runtime_channel" ] || \
    fail 'verified release does not match the requested runtime channel'
fi
configure_runtime_paths "$runtime_channel"
normalize_runtime_paths
resolve_runtime_flags
assert_safe_remove_target "$install_root"
assert_roots_do_not_overlap
assert_install_root_is_channel_leaf
if [ -e "$state_file" ] || [ -L "$state_file" ]; then
  expected_install_root="$(canonicalize_path "$install_root")"
  expected_station_root="$(canonicalize_path "$station_root")"
  expected_station_home="$(canonicalize_path "$station_home")"
  node -e '
    const fs = require("node:fs");
    const [p, runtimeChannel, releaseChannel, installRoot, stationRoot, stationHome] = process.argv.slice(1);
    const s = fs.lstatSync(p);
    if (!s.isFile() || s.isSymbolicLink() || (typeof process.getuid === "function" && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0) process.exit(1);
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    if (v?.schemaVersion !== 3 || !((v.channel === "stable" && v.releaseChannel === "stable") || (v.channel === "beta" && v.releaseChannel === "preview")) || typeof v.installRoot !== "string" || typeof v.stationHome !== "string" || typeof v.stationRoot !== "string") process.exit(1);
    const savedRuntime = v.channel;
    const savedRelease = v.releaseChannel;
    if (savedRuntime !== runtimeChannel || savedRelease !== releaseChannel || (v.installRoot && v.installRoot !== installRoot) || (v.stationRoot && v.stationRoot !== stationRoot) || (v.stationHome && v.stationHome !== stationHome)) process.exit(3);
  ' "$state_file" "$runtime_channel" "$release_channel" "$expected_install_root" "$expected_station_root" "$expected_station_home" || {
    state_status=$?
    if [ "$state_status" = 3 ]; then
      fail 'existing install state does not match this verified channel root; remove the explicit root override or reinstall into a new scoped root'
    fi
    fail 'existing install channel state is unsafe or malformed'
  }
fi

release_dir="$install_root/releases/$actual_checksum"
prepare_owned_root "$install_root" "$INSTALL_ROOT_MARKER" "$INSTALL_ROOT_SIGNATURE" reject >/dev/null || \
  fail "STATION_INSTALL_ROOT is not an empty or installer-owned directory: $install_root"
data_root_state="$(prepare_owned_root "$station_home" "$DATA_ROOT_MARKER" "$DATA_ROOT_SIGNATURE" preserve)" || \
  fail "STATION_HOME is not a safe Station data directory: $station_home"
if [ "$data_root_state" = preserved ]; then
  printf 'Using existing Station data without claiming purge ownership: %s\n' "$station_home"
fi
prepare_safe_directory "$install_root/releases"
prepare_safe_directory "$bin_dir"
assert_launcher_safe
previous_release=""
if [ -L "$current_link" ]; then
  previous_release="$(readlink "$current_link")"
fi

release_complete=false
if [ -d "$release_dir" ] && \
  [ -x "$release_dir/station" ] && \
  [ -f "$release_dir/.station-install-complete" ] && \
  [ "$(cat "$release_dir/.station-install-complete")" = "$actual_checksum" ]; then
  release_complete=true
fi

if [ "$release_complete" = false ]; then
  if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
    [ "$previous_release" != "$release_dir" ] || \
      fail 'the active release cache is incomplete; refusing to replace running files'
    safe_remove_tree "$release_dir"
  fi
  printf 'Installing Station dependencies...\n'
  (cd "$candidate" && HOME="$build_home" GH_CONFIG_DIR="$gh_config_dir" npm run dependencies:ci)
  printf 'Building Station...\n'
  (cd "$candidate" && \
    HOME="$build_home" GH_CONFIG_DIR="$gh_config_dir" \
    STATION_CHANNEL="$runtime_channel" STATION_ROOT="$station_root" STATION_HOME="$station_home" \
    ./station build --base="$station_home" \
      "--port=$resolved_server_port" "--ui-port=$resolved_ui_port")
  release_stage="$install_root/releases/.stage.$$"
  if [ -e "$release_stage" ] || [ -L "$release_stage" ]; then
    safe_remove_tree "$release_stage"
  fi
  mv "$candidate" "$release_stage"
  printf '%s\n' "$actual_checksum" >"$release_stage/.station-install-complete"
  node -e '
    const fs = require("node:fs");
    fs.renameSync(process.argv[1], process.argv[2]);
  ' "$release_stage" "$release_dir"
else
  printf 'Station release already installed; reusing verified files.\n'
fi

canonical_install_root="$(canonicalize_path "$install_root")"
canonical_station_root="$(canonicalize_path "$station_root")"
canonical_station_home="$(canonicalize_path "$station_home")"
if [ -f "$state_file" ]; then
  node -e '
    const fs = require("node:fs");
    fs.copyFileSync(process.argv[1], process.argv[2], fs.constants.COPYFILE_EXCL);
    fs.chmodSync(process.argv[2], 0o600);
  ' "$state_file" "$previous_state_backup" || fail 'could not preserve previous install channel state'
fi
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  node -e '
      const fs = require("node:fs");
      fs.copyFileSync(process.argv[1], process.argv[2], fs.constants.COPYFILE_EXCL);
      fs.chmodSync(process.argv[2], 0o755);
    ' "$launcher" "$previous_launcher_backup" || fail 'could not preserve the previous channel launcher'
  previous_launcher_present=true
fi
write_staged_launcher
state_stage="$install_root/.station-release-state.$$"
umask 077
node -e '
  const fs = require("node:fs");
  const [path, channel, releaseChannel, installRoot, stationRoot, stationHome] = process.argv.slice(1);
  fs.writeFileSync(path, `${JSON.stringify({ schemaVersion: 3, channel, releaseChannel, installRoot, stationRoot, stationHome })}\n`, { mode: 0o600, flag: "wx" });
  const fd = fs.openSync(path, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
' "$state_stage" "$runtime_channel" "$release_channel" "$canonical_install_root" "$canonical_station_root" "$canonical_station_home" || fail 'could not stage install channel state'

promoted=false
if [ "$previous_release" != "$release_dir" ]; then
  stop_installed_station
  if ! replace_link_atomically "$release_dir" "$current_link" || \
    ! node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staged_launcher" "$launcher"; then
    fail_with_rollback 'could not publish the new release'
  fi
  promoted=true
else
  # A reused release may still be running from the previous install; the
  # later start must not race that live instance for its own ports.
  stop_installed_station
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staged_launcher" "$launcher" || \
    fail 'could not publish the channel launcher'
fi

if ! node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$state_stage" "$state_file"; then
  if [ "$promoted" = true ]; then
    fail_with_rollback 'could not persist install channel state'
  fi
  fail 'could not persist install channel state'
fi
state_stage=""

if [ "${STATION_INSTALL_NO_START:-0}" != 1 ]; then
  if ! start_installed_station; then
    if [ "$promoted" = true ]; then
      fail_with_rollback 'the new release did not start'
    fi
    fail 'the installed release did not start'
  fi
  for installed_release in "$install_root"/releases/*; do
    [ -d "$installed_release" ] || continue
    if [ "$installed_release" != "$release_dir" ] && \
      [ "$installed_release" != "$previous_release" ]; then
      safe_remove_tree "$installed_release"
    fi
  done
fi

printf '\nStation is installed at %s\n' "$current_link"
printf 'Launcher: %s\n' "$launcher"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add %s to PATH to run station from any directory.\n' "$bin_dir" ;;
esac
if [ "${STATION_INSTALL_NO_START:-0}" = 1 ]; then
  printf 'Start it with: %s start\n' "$launcher"
else
  printf 'Open http://localhost:%s\n' "$resolved_ui_port"
fi
