#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${STATION_REPO:-${SCRIPT_DIR:h:h}}"
INSTANCE="${STATION_INSTANCE:-dogfood}"
STATION_HOME="${STATION_HOME:-$HOME/.station}"
SUPPORT_DIR="${STATION_DOGFOOD_SUPPORT:-$HOME/Library/Application Support/Station Dogfood}"
LOG_DIR="${STATION_DOGFOOD_LOGS:-$HOME/Library/Logs/Station Dogfood}"
SERVER_PORT="${STATION_SERVER_PORT:-3141}"
UI_PORT="${STATION_UI_PORT:-3000}"
CI_BILLING_WAIVER_EXPIRES_AT="${STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT:-}"
LABEL="io.kontourai.station-dogfood"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG="$SUPPORT_DIR/config.json"
RUNNER="$SUPPORT_DIR/bin/station-dogfood-reconcile.mjs"
HEALTH_HELPER="$SUPPORT_DIR/bin/station-dogfood-health.mjs"
CLIENT_PATH_HELPER="$SCRIPT_DIR/../../scripts/station-dogfood-launch-path.mjs"
CLIENT_PATH_HELPER="${CLIENT_PATH_HELPER:A}"
CLIENT_SHIM_DIR="$SUPPORT_DIR/bin/clients"
LEGACY_LABEL="${STATION_DOGFOOD_LEGACY_LABEL:-}"
LEGACY_PLIST="${STATION_DOGFOOD_LEGACY_PLIST:-}"
LEGACY_WORKTREE="${STATION_DOGFOOD_LEGACY_WORKTREE:-}"
LEGACY_RUNTIME="${STATION_DOGFOOD_LEGACY_RUNTIME:-$LEGACY_WORKTREE}"
LEGACY_RUNNER="${STATION_DOGFOOD_LEGACY_RUNNER:-}"
LEGACY_INSTANCE_STATE=""
LEGACY_HOST=""
typeset -a LEGACY_HEALTH_HOST_ARGS
LEGACY_SHA=""
LEGACY_ROLLBACK_PATH=""
STAGED_RELEASE_PATH=""
STAGED_RELEASE_SHA=""

fail() {
  print -u2 "Station dogfood preflight failed: $1"
  exit 1
}

resolve_executable() {
  local name="$1"
  local resolved
  resolved="$(whence -p "$name" 2>/dev/null)" || fail "$name is required but was not found on PATH"
  [[ -x "$resolved" ]] || fail "$name resolved to a non-executable path: $resolved"
  print -r -- "${resolved:A}"
}

if [[ "$STATION_HOME" != /* || "$REPO_ROOT" != /* || "$SUPPORT_DIR" != /* || "$LOG_DIR" != /* ]]; then
  print -u2 "STATION_HOME, STATION_REPO, support, and log paths must be absolute"
  exit 1
fi

# Resolve every executable needed by the installer or periodic runner before
# mutating Tailscale Serve or launchd. The generated LaunchAgent gets only the
# deterministic directory list below; it never inherits an interactive shell's
# aliases, functions, shims, or mutable PATH ordering.
NODE="$(resolve_executable node)"
NPM="$(resolve_executable npm)"
GIT="$(resolve_executable git)"
GH="$(resolve_executable gh)"
CURL="$(resolve_executable curl)"
TAILSCALE="$(resolve_executable tailscale)"
LAUNCHCTL="$(resolve_executable launchctl)"
PLUTIL="$(resolve_executable plutil)"
PS="$(resolve_executable ps)"
LSOF="$(resolve_executable lsof)"
SLEEP="$(resolve_executable sleep)"
[[ -f "$CLIENT_PATH_HELPER" && ! -L "$CLIENT_PATH_HELPER" ]] || fail "client PATH helper is missing or symlinked: $CLIENT_PATH_HELPER"

# Read the major version as raw bytes, never as a rendered value. `node -p`
# prints strings verbatim but sends every other result through `util.inspect`,
# which colourises whenever colour is enabled — and npm exports FORCE_COLOR=3
# into every script it runs, so `-p 'Number(...)'` handed this parse
# "\e[33m24\e[39m" instead of "24" and the installer died on its own validity
# guard (#984). `process.stdout.write` emits bytes rather than a rendering, so
# no present or future colour setting can reach it; forcing colour off for this
# one call would instead depend on node continuing to honour that switch.
NODE_MAJOR="$("$NODE" -e 'process.stdout.write(process.versions.node.split(".")[0])')" || fail "node could not report its version"
[[ "$NODE_MAJOR" == <-> ]] || fail "node returned an invalid major version: $NODE_MAJOR"
(( NODE_MAJOR == 24 )) || fail "Node.js 24.x is required (found $("$NODE" --version)); run 'nvm install 24 && nvm use 24' or activate .nvmrc"
# Absolute maximum expiry the zero-step billing CI waiver will ever accept.
# #347 set this at 2026-08-01T06:00:00Z; the owner revised the policy on
# 2026-08-01 (issue #1443, option b: re-sunset rather than retire) to
# 2026-09-01T06:00:00Z, because hosted CI billing is deferred to August and
# dogfood auto-promotion rides this waiver plus the local evidence protocol
# until then. Nothing else about the policy changes: the expiry must still be
# BOTH in the future AND no later than this maximum, so past the maximum the
# installer fails closed with no reinstall path — exactly as #347 requires.
# This literal and BILLING_WAIVER_MAX_EXPIRY_ISO in
# scripts/station-dogfood-reconcile.mjs are the two authorities; revise both
# together (the cutover-matrix behavior test pins this literal against that
# exported constant).
if [[ -n "$CI_BILLING_WAIVER_EXPIRES_AT" ]]; then
  CI_BILLING_WAIVER_EXPIRES_AT="$(CI_BILLING_WAIVER_EXPIRES_AT="$CI_BILLING_WAIVER_EXPIRES_AT" "$NODE" -e '
    const raw=process.env.CI_BILLING_WAIVER_EXPIRES_AT;
    const expiry=Date.parse(raw);
    const maximum=Date.parse("2026-09-01T06:00:00Z");
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)||!Number.isFinite(expiry)||expiry<=Date.now()||expiry>maximum) throw new Error("billing waiver expiry must be an exact future ISO timestamp no later than 2026-09-01T06:00:00Z");
    process.stdout.write(new Date(expiry).toISOString());
  ')" || fail "invalid STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT"
fi
"$NPM" --version >/dev/null || fail "npm is installed but cannot run"
"$GIT" --version >/dev/null || fail "git is installed but cannot run"
"$GH" auth status >/dev/null 2>&1 || fail "gh must be authenticated for GitHub Actions reads"
"$GH" run list --repo kontourai/station --limit 1 --json databaseId,headSha,status,conclusion,event,workflowName,url >/dev/null 2>&1 || fail "gh must support authenticated run list with JSON fields"
"$CURL" --version >/dev/null || fail "curl is installed but cannot run"
TAILSCALE_STATUS="$("$TAILSCALE" status --json)" || fail "tailscale status --json failed; log into Tailscale first"
SERVE_BEFORE="$("$TAILSCALE" serve status --json)" || fail "tailscale must support serve status --json"
"$TAILSCALE" serve get-config --help >/dev/null 2>&1 || fail "tailscale must support serve get-config"
"$TAILSCALE" serve set-config --help >/dev/null 2>&1 || fail "tailscale must support serve set-config"
"$LAUNCHCTL" print "gui/$UID" >/dev/null 2>&1 || fail "launchctl cannot access the current GUI user domain"
"$PLUTIL" -lint "$SCRIPT_DIR/io.kontourai.station-dogfood.plist.template" >/dev/null || fail "plutil could not validate the LaunchAgent template"
"$PS" -o lstart= -o command= -p $$ >/dev/null || fail "ps must expose process start and command identity"
"$LSOF" -nP -iTCP:1 -sTCP:LISTEN -t >/dev/null 2>&1 || [[ "$?" == 1 ]] || fail "lsof must support bounded TCP listener ownership inspection"

if [[ -n "$LEGACY_LABEL$LEGACY_PLIST$LEGACY_WORKTREE$LEGACY_RUNTIME$LEGACY_RUNNER" ]]; then
  [[ -n "$LEGACY_LABEL" && -n "$LEGACY_PLIST" && -n "$LEGACY_WORKTREE" && -n "$LEGACY_RUNTIME" && -n "$LEGACY_RUNNER" ]] || fail "legacy migration requires label, plist, runner, source worktree, and runtime together"
  [[ "$LEGACY_PLIST" == /* && "$LEGACY_WORKTREE" == /* && "$LEGACY_RUNTIME" == /* && "$LEGACY_RUNNER" == /* ]] || fail "legacy plist, runner, source worktree, and runtime must be absolute"
  [[ "$LEGACY_LABEL" != "$LABEL" && "$LEGACY_PLIST" != "$PLIST" ]] || fail "legacy updater identity must be distinct from the canonical supervisor"
  LEGACY_INSTANCE_STATE="$LEGACY_RUNTIME/.station/instances/$INSTANCE.json"
  LEGACY_PLIST_JSON="$("$PLUTIL" -convert json -o - "$LEGACY_PLIST")" || fail "legacy plist could not be parsed structurally"
  LEGACY_LABEL="$LEGACY_LABEL" LEGACY_PLIST="$LEGACY_PLIST" LEGACY_RUNNER="$LEGACY_RUNNER" LEGACY_PLIST_JSON="$LEGACY_PLIST_JSON" "$NODE" -e '
    const fs=require("node:fs");
    const plist=fs.lstatSync(process.env.LEGACY_PLIST);
    if(!plist.isFile()||plist.isSymbolicLink()) throw new Error("legacy plist must be a real file");
    const runner=fs.lstatSync(process.env.LEGACY_RUNNER);
    if(!runner.isFile()||runner.isSymbolicLink()) throw new Error("legacy runner must be a real file");
    if(process.getuid&&(plist.uid!==process.getuid()||runner.uid!==process.getuid())) throw new Error("legacy migration inputs must be owned by the current user");
    const parsed=JSON.parse(process.env.LEGACY_PLIST_JSON);
    if(parsed.Label!==process.env.LEGACY_LABEL) throw new Error("legacy plist Label does not exactly match explicit legacy label");
    if(!Array.isArray(parsed.ProgramArguments)||parsed.ProgramArguments.length!==1||parsed.ProgramArguments[0]!==process.env.LEGACY_RUNNER) throw new Error("legacy plist ProgramArguments do not exactly match the verified legacy runner contract");
  '
  LEGACY_RUNTIME="$LEGACY_RUNTIME" "$NODE" -e '
    const fs=require("node:fs"); const runtime=fs.lstatSync(process.env.LEGACY_RUNTIME);
    if(!runtime.isDirectory()||runtime.isSymbolicLink()) throw new Error("legacy runtime must be a real directory");
    if(process.getuid&&runtime.uid!==process.getuid()) throw new Error("legacy runtime must be owned by the current user");
  '
  LEGACY_HOST="$(LEGACY_INSTANCE_STATE="$LEGACY_INSTANCE_STATE" LEGACY_RUNTIME="$LEGACY_RUNTIME" INSTANCE="$INSTANCE" SERVER_PORT="$SERVER_PORT" UI_PORT="$UI_PORT" "$NODE" -e '
    const fs=require("node:fs");
    const state=JSON.parse(fs.readFileSync(process.env.LEGACY_INSTANCE_STATE,"utf8"));
    const runtime=fs.realpathSync(process.env.LEGACY_RUNTIME);
    let cwd;
    try { cwd=typeof state.cwd==="string"&&state.cwd.startsWith("/")?fs.realpathSync(state.cwd):null; } catch { cwd=null; }
    if(cwd!==runtime||state.instanceId!==process.env.INSTANCE||!(state.host==="127.0.0.1"||state.host==="0.0.0.0")||state.serverPort!==Number(process.env.SERVER_PORT)||state.uiPort!==Number(process.env.UI_PORT)||!state.build?.sha||!Number.isInteger(state.serverPid)) throw new Error("legacy instance record does not prove the configured runtime ownership");
    process.stdout.write(state.host);
  ')" || fail "legacy instance record does not prove the configured runtime ownership"
  [[ "$LEGACY_HOST" == "0.0.0.0" ]] && LEGACY_HEALTH_HOST_ARGS=(--allow-wildcard-host)
  LEGACY_HEALTH_BEFORE="$("$NODE" "$REPO_ROOT/scripts/station-dogfood-health.mjs" --instance-state="$LEGACY_INSTANCE_STATE" --timeout-ms=3000 "${LEGACY_HEALTH_HOST_ARGS[@]}")" || fail "legacy instance is not an exact healthy managed runtime"
  LEGACY_SHA="$(LEGACY_HEALTH_BEFORE="$LEGACY_HEALTH_BEFORE" "$NODE" -e 'const h=JSON.parse(process.env.LEGACY_HEALTH_BEFORE); if(!h.healthy||!h.identity?.sha||!h.identity?.bootId) process.exit(1); process.stdout.write(h.identity.sha)')" || fail "legacy health did not provide exact SHA and boot identity"
  LEGACY_BOOT_ID="$(LEGACY_HEALTH_BEFORE="$LEGACY_HEALTH_BEFORE" "$NODE" -e 'const h=JSON.parse(process.env.LEGACY_HEALTH_BEFORE); if(!h.healthy||!h.identity?.bootId) process.exit(1); process.stdout.write(h.identity.bootId)')" || fail "legacy health did not provide exact boot identity"
  LEGACY_INSTANCE_ID="$(LEGACY_HEALTH_BEFORE="$LEGACY_HEALTH_BEFORE" "$NODE" -e 'const h=JSON.parse(process.env.LEGACY_HEALTH_BEFORE); if(!h.healthy||!h.identity?.instanceId) process.exit(1); process.stdout.write(h.identity.instanceId)')" || fail "legacy health did not provide exact instance identity"
fi

typeset -a LAUNCH_PATH_DIRS
for executable in "$NODE" "$NPM" "$GIT" "$GH" "$CURL" "$TAILSCALE" "$LAUNCHCTL" "$PLUTIL" "$PS" "$LSOF" "$SLEEP"; do
  directory="${executable:h}"
  (( ${LAUNCH_PATH_DIRS[(Ie)$directory]} )) || LAUNCH_PATH_DIRS+=("$directory")
done
for directory in /usr/bin /bin /usr/sbin /sbin; do
  (( ${LAUNCH_PATH_DIRS[(Ie)$directory]} )) || LAUNCH_PATH_DIRS+=("$directory")
done
OPERATIONAL_LAUNCH_PATH="${(j/:/)LAUNCH_PATH_DIRS}"
LAUNCH_PATH="$CLIENT_SHIM_DIR:$OPERATIONAL_LAUNCH_PATH"

# Shell startup is evaluated exactly once, here, with a bounded helper. Only
# absolute resolutions for Station's supported client names survive into the
# private shim set; captured PATH directories never enter launchd.
CLIENT_DISCOVERY="$(mktemp "${TMPDIR:-/tmp}/station-dogfood-client-path.XXXXXX")"
cleanup_client_discovery() {
  local exit_status=$?
  trap - EXIT
  rm -f "$CLIENT_DISCOVERY"
  exit $exit_status
}
trap cleanup_client_discovery EXIT
LOGIN_SHELL="$("$NODE" -p 'require("node:os").userInfo().shell || ""' 2>/dev/null || true)"
[[ -n "$LOGIN_SHELL" ]] || LOGIN_SHELL="${SHELL:-}"
"$NODE" "$CLIENT_PATH_HELPER" --shell="$LOGIN_SHELL" --output="$CLIENT_DISCOVERY"
DISCOVERY_WARNING="$(DISCOVERY="$CLIENT_DISCOVERY" "$NODE" -e 'const v=JSON.parse(require("node:fs").readFileSync(process.env.DISCOVERY,"utf8")); process.stdout.write(v.warning ?? "")')"
if [[ -n "$DISCOVERY_WARNING" ]]; then
  print -u2 "WARNING: optional chat-client discovery failed: $DISCOVERY_WARNING"
  print -u2 "WARNING: Station will use its deterministic operational PATH. Rerun ops/dogfood/install-macos.zsh to refresh after fixing the login shell."
else
  DISCOVERY="$CLIENT_DISCOVERY" "$NODE" -e '
    const v=JSON.parse(require("node:fs").readFileSync(process.env.DISCOVERY,"utf8"));
    for (const item of v.rejected) console.error(`Station ignored a login PATH entry: ${item.reason}`);
    for (const [name,target] of Object.entries(v.selected)) console.error(`Station selected ${name}: ${target}`);
  '
fi

TAILNET_HOST="$(TAILSCALE_STATUS="$TAILSCALE_STATUS" "$NODE" -e '
  const status = JSON.parse(process.env.TAILSCALE_STATUS);
  const name = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!name) throw new Error("Tailscale Self.DNSName is unavailable");
  process.stdout.write(name);
')"
TAILNET_URL="https://$TAILNET_HOST"
STALE_SERVE_ROOT_PROXY="$(SERVE_BEFORE="$SERVE_BEFORE" TARGET="http://127.0.0.1:$UI_PORT" HOSTPORT="$TAILNET_HOST:443" LEGACY_TRANSACTION="$([[ -n "$LEGACY_LABEL$LEGACY_PLIST$LEGACY_WORKTREE$LEGACY_RUNNER" ]] && print 1 || print 0)" "$NODE" -e '
  const status = JSON.parse(process.env.SERVE_BEFORE || "{}");
  const host = process.env.HOSTPORT;
  const root = status.Web?.[host]?.Handlers?.["/"];
  const proxy = root?.Proxy;
  if (root && proxy !== process.env.TARGET) {
    if(process.env.LEGACY_TRANSACTION!=="1"||Object.keys(root).length!==1||typeof proxy!=="string") throw new Error(`refusing to replace existing Tailscale Serve root handler ${JSON.stringify(root)}`);
    let parsed;
    try { parsed=new URL(proxy); } catch { throw new Error(`refusing non-URL Tailscale Serve root proxy ${JSON.stringify(proxy)}`); }
    if(parsed.protocol!=="http:"||parsed.hostname!=="127.0.0.1"||parsed.username||parsed.password||parsed.pathname!=="/"||parsed.search||parsed.hash) throw new Error(`refusing non-loopback Tailscale Serve root proxy ${JSON.stringify(proxy)}`);
    process.stdout.write(parsed.origin);
  }
  if (status.AllowFunnel?.[host] === true) {
    throw new Error("refusing installation while Funnel is enabled on the HTTPS listener");
  }
')"

TEMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/station-dogfood-config.XXXXXX")"
TXN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/station-dogfood-transaction.XXXXXX")"
SERVE_SNAPSHOT="$TXN_DIR/serve.json"
SERVE_VERIFY="$TXN_DIR/serve-verify.json"
SERVE_STATUS_VERIFY="$TXN_DIR/serve-status-verify.json"
PLIST_SNAPSHOT="$TXN_DIR/plist"
RUNNER_SNAPSHOT="$TXN_DIR/runner"
HEALTH_HELPER_SNAPSHOT="$TXN_DIR/health-helper"
CONFIG_SNAPSHOT="$TXN_DIR/config"
STATE_SNAPSHOT="$TXN_DIR/state"
CLIENT_SHIM_SNAPSHOT="$TXN_DIR/clients"
LEGACY_PLIST_SNAPSHOT="$TXN_DIR/legacy-plist"
LEGACY_RUNNER_SNAPSHOT="$TXN_DIR/legacy-runner"
PRIOR_PLIST=0
PRIOR_RUNNER=0
PRIOR_HEALTH_HELPER=0
PRIOR_CONFIG=0
PRIOR_STATE=0
PRIOR_CLIENT_SHIM=0
PRIOR_LAUNCHD_LOADED=0
PRIOR_LEGACY_LOADED=0
SERVE_MUTATED=0
LAUNCHD_MUTATED=0
RECONCILE_ATTEMPTED=0
CUTOVER_STARTED=0
PROMOTION_ATTEMPTED=0
"$TAILSCALE" serve get-config --all >"$SERVE_SNAPSHOT"
"$LAUNCHCTL" print "gui/$UID/$LABEL" >/dev/null 2>&1 && PRIOR_LAUNCHD_LOADED=1
if [[ -n "$LEGACY_LABEL" ]]; then
  "$LAUNCHCTL" print "gui/$UID/$LEGACY_LABEL" >/dev/null 2>&1 && PRIOR_LEGACY_LOADED=1
  (( PRIOR_LEGACY_LOADED )) || fail "explicit legacy updater is not loaded; refusing ambiguous migration"
fi
verify_stale_serve_root() {
  [[ -n "$STALE_SERVE_ROOT_PROXY" ]] || return 0
  "$LAUNCHCTL" print "gui/$UID/$LEGACY_LABEL" >/dev/null 2>&1 || fail "stale Station root migration requires the legacy updater to remain loaded"
  if "$LAUNCHCTL" print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    fail "stale Station root migration requires the canonical supervisor to remain unloaded"
  fi
  SERVE_RECHECK="$("$TAILSCALE" serve status --json)" || fail "could not recheck stale Tailscale Serve root"
  SERVE_BEFORE="$SERVE_BEFORE" SERVE_RECHECK="$SERVE_RECHECK" "$NODE" -e '
    const canonical=(value)=>value&&typeof value==="object"?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])]))):value;
    if(JSON.stringify(canonical(JSON.parse(process.env.SERVE_BEFORE)))!==JSON.stringify(canonical(JSON.parse(process.env.SERVE_RECHECK)))) throw new Error("Tailscale Serve state changed during stale-root preflight");
  ' || fail "Tailscale Serve state changed during stale-root preflight"
  STALE_ROOT_IDENTITY_STATUS="$("$CURL" --disable --silent --show-error --noproxy '*' --proto '=http' --max-redirs 0 --connect-timeout 1 --max-time 3 --output /dev/null --write-out '%{http_code}' "$STALE_SERVE_ROOT_PROXY/__station/identity")" || fail "stale-root identity probe did not complete"
  [[ "$STALE_ROOT_IDENTITY_STATUS" == "404" ]] || fail "stale-root identity probe returned $STALE_ROOT_IDENTITY_STATUS instead of exact not-found proof"
}
if [[ -n "$STALE_SERVE_ROOT_PROXY" ]]; then
  (( PRIOR_LEGACY_LOADED == 1 && PRIOR_LAUNCHD_LOADED == 0 )) || fail "stale Station root migration requires a loaded legacy updater and unloaded canonical supervisor"
  verify_stale_serve_root
fi
restore_file() {
  local snapshot="$1" target="$2" existed="$3"
  rm -f "$target"
  if (( existed )); then
    cp -p "$snapshot" "$target"
    SNAPSHOT="$snapshot" TARGET="$target" "$NODE" -e '
      const fs=require("node:fs");
      const a=fs.readFileSync(process.env.SNAPSHOT), b=fs.readFileSync(process.env.TARGET);
      const sa=fs.statSync(process.env.SNAPSHOT), sb=fs.statSync(process.env.TARGET);
      if(!a.equals(b)||sa.uid!==sb.uid||sa.gid!==sb.gid||(sa.mode&0o777)!==(sb.mode&0o777)) process.exit(1);
    ' || return 1
  fi
  [[ "$existed" == 1 || ! -e "$target" ]]
}
cleanup_transaction_release() {
  local release_path="$1" release_sha="$2"
  [[ -n "$release_path" ]] || return 0
  RELEASE_PATH="$release_path" RELEASE_SHA="$release_sha" SUPPORT_DIR="$SUPPORT_DIR" "$NODE" -e '
    const fs=require("node:fs"), path=require("node:path");
    const release=process.env.RELEASE_PATH, sha=process.env.RELEASE_SHA.toLowerCase();
    const parent=path.join(process.env.SUPPORT_DIR,"releases");
    if(path.dirname(release)!==parent||!new RegExp(`^${sha}(?:--release-[0-9a-f-]{36})?$`,"i").test(path.basename(release))) throw new Error("transaction release path is outside the exact managed release slot");
    let info;
    try { info=fs.lstatSync(release); } catch(error) { if(error?.code==="ENOENT") process.exit(0); throw error; }
    if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid())) throw new Error("transaction release must be a real owned directory");
    const manifest=JSON.parse(fs.readFileSync(path.join(release,"dist-server-dogfood","station-build.json"),"utf8"));
    if(String(manifest.sha).toLowerCase()!==sha) throw new Error("transaction release manifest SHA mismatch");
  ' || return 1
  [[ ! -e "$release_path" && ! -L "$release_path" ]] && return 0
  "$GIT" -C "$REPO_ROOT" worktree remove --force "$release_path" || return 1
  [[ ! -e "$release_path" && ! -L "$release_path" ]]
}
snapshot_file() {
  local source="$1" snapshot="$2"
  SOURCE="$source" "$NODE" -e '
    const fs=require("node:fs"); const info=fs.lstatSync(process.env.SOURCE);
    if(!info.isFile()||info.isSymbolicLink()) throw new Error(`${process.env.SOURCE} must be a real file`);
    if(process.getuid&&info.uid!==process.getuid()) throw new Error(`${process.env.SOURCE} is not owned by the current user`);
  '
  cp -p "$source" "$snapshot"
}
snapshot_directory() {
  local source="$1" snapshot="$2"
  SOURCE="$source" "$NODE" -e '
    const fs=require("node:fs"); const info=fs.lstatSync(process.env.SOURCE);
    if(!info.isDirectory()||info.isSymbolicLink()) throw new Error(`${process.env.SOURCE} must be a real directory`);
    if(process.getuid&&info.uid!==process.getuid()) throw new Error(`${process.env.SOURCE} is not owned by the current user`);
    if((info.mode&0o777)!==0o700) throw new Error(`${process.env.SOURCE} permissions must be 0700`);
  '
  "$NODE" "$CLIENT_PATH_HELPER" --shim="$source" --root="$SUPPORT_DIR/bin" --snapshot="$snapshot" || return 1
}
wait_launchd_unloaded() {
  local label="${1:-$LABEL}"
  local attempt
  local attempts="${STATION_DOGFOOD_LAUNCHD_WAIT_ATTEMPTS:-120}"
  local interval="${STATION_DOGFOOD_LAUNCHD_WAIT_INTERVAL:-0.1}"
  [[ "$attempts" == <-> && "$attempts" -ge 1 && "$attempts" -le 600 ]] || return 1
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    "$LAUNCHCTL" print "gui/$UID/$label" >/dev/null 2>&1 || return 0
    "$SLEEP" "$interval"
  done
  return 1
}
restore_directory() {
  local snapshot="$1" target="$2" existed="$3"
  if (( existed )); then
    "$NODE" "$CLIENT_PATH_HELPER" --shim="$target" --root="$SUPPORT_DIR/bin" --restore="$snapshot" || return 1
    [[ -d "$target" && ! -L "$target" ]] || return 1
  else
    rm -rf "$target" || return 1
    [[ ! -e "$target" && ! -L "$target" ]] || return 1
  fi
}
if [[ -e "$PLIST" || -L "$PLIST" ]]; then
  snapshot_file "$PLIST" "$PLIST_SNAPSHOT"
  PRIOR_PLIST=1
fi
if [[ -n "$LEGACY_LABEL" ]]; then
  snapshot_file "$LEGACY_PLIST" "$LEGACY_PLIST_SNAPSHOT"
  snapshot_file "$LEGACY_RUNNER" "$LEGACY_RUNNER_SNAPSHOT"
  LEGACY_SNAPSHOT_JSON="$("$PLUTIL" -convert json -o - "$LEGACY_PLIST_SNAPSHOT")" || fail "captured legacy plist could not be parsed structurally"
  LEGACY_LABEL="$LEGACY_LABEL" LEGACY_RUNNER="$LEGACY_RUNNER" LEGACY_SNAPSHOT_JSON="$LEGACY_SNAPSHOT_JSON" "$NODE" -e '
    const parsed=JSON.parse(process.env.LEGACY_SNAPSHOT_JSON);
    if(parsed.Label!==process.env.LEGACY_LABEL||!Array.isArray(parsed.ProgramArguments)||parsed.ProgramArguments.length!==1||parsed.ProgramArguments[0]!==process.env.LEGACY_RUNNER) throw new Error("captured legacy plist no longer matches the verified launch contract");
  '
fi
rollback_install() {
  local exit_status=$?
  local restore_failed=0
  local launchd_unloaded=1
  if (( CUTOVER_STARTED )) && "$LAUNCHCTL" print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    launchd_unloaded=0
    if "$LAUNCHCTL" bootout "gui/$UID/$LABEL" >/dev/null 2>&1 && wait_launchd_unloaded; then
      launchd_unloaded=1
    else
      restore_failed=1
      print -u2 "CRITICAL: launchd state is unknown; managed files were not restored. Run '$LAUNCHCTL bootout gui/$UID/$LABEL' and confirm '$LAUNCHCTL print gui/$UID/$LABEL' reports absent before manual recovery from $TXN_DIR."
    fi
  fi
  if (( launchd_unloaded && RECONCILE_ATTEMPTED && PROMOTION_ATTEMPTED )) && [[ -x "$RUNNER" && -f "$CONFIG" ]]; then
    local rollback_snapshot="$STATE_SNAPSHOT"
    local rollback_existed="$PRIOR_STATE"
    if (( PRIOR_LEGACY_LOADED )); then
      rollback_snapshot="$LEGACY_STATE_SNAPSHOT"
      rollback_existed=1
    fi
    PATH="$LAUNCH_PATH" "$NODE" "$RUNNER" rollback-install --config="$CONFIG" --state-snapshot="$rollback_snapshot" --state-existed="$rollback_existed" >/dev/null 2>&1 || restore_failed=1
  fi
  if (( SERVE_MUTATED )); then
    "$TAILSCALE" serve set-config --all "$SERVE_SNAPSHOT" >/dev/null 2>&1 || { print -u2 "CRITICAL: failed to restore captured Tailscale Serve configuration"; restore_failed=1; }
    "$TAILSCALE" serve get-config --all >"$SERVE_VERIFY" 2>/dev/null || { print -u2 "CRITICAL: failed to verify restored Tailscale Serve configuration"; restore_failed=1; }
    SERVE_SNAPSHOT="$SERVE_SNAPSHOT" SERVE_VERIFY="$SERVE_VERIFY" "$NODE" -e '
      const fs = require("node:fs");
      if (fs.readFileSync(process.env.SERVE_SNAPSHOT, "utf8") !== fs.readFileSync(process.env.SERVE_VERIFY, "utf8")) {
        throw new Error("CRITICAL: restored Tailscale Serve configuration differs from the captured snapshot");
      }
    ' || restore_failed=1
    "$TAILSCALE" serve status --json >"$SERVE_STATUS_VERIFY" 2>/dev/null || restore_failed=1
    SERVE_BEFORE="$SERVE_BEFORE" SERVE_STATUS_VERIFY="$SERVE_STATUS_VERIFY" "$NODE" -e '
      const fs = require("node:fs");
      const canonical = (value) => value && typeof value === "object"
        ? Array.isArray(value)
          ? value.map(canonical)
          : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
        : value;
      const before = canonical(JSON.parse(process.env.SERVE_BEFORE));
      const restored = canonical(JSON.parse(fs.readFileSync(process.env.SERVE_STATUS_VERIFY, "utf8")));
      if (JSON.stringify(before) !== JSON.stringify(restored)) {
        throw new Error("CRITICAL: restored classic Tailscale Serve status differs from the captured snapshot");
      }
    ' || restore_failed=1
  fi
  if (( LAUNCHD_MUTATED )); then
    if (( launchd_unloaded )); then
      restore_file "$STATE_SNAPSHOT" "$SUPPORT_DIR/state.json" "$PRIOR_STATE" || restore_failed=1
      cleanup_transaction_release "$STAGED_RELEASE_PATH" "$STAGED_RELEASE_SHA" || restore_failed=1
      if (( CUTOVER_STARTED == 0 )); then
        cleanup_transaction_release "$LEGACY_ROLLBACK_PATH" "$LEGACY_SHA" || restore_failed=1
      fi
      restore_file "$RUNNER_SNAPSHOT" "$RUNNER" "$PRIOR_RUNNER" || restore_failed=1
      restore_file "$HEALTH_HELPER_SNAPSHOT" "$HEALTH_HELPER" "$PRIOR_HEALTH_HELPER" || restore_failed=1
      restore_file "$CONFIG_SNAPSHOT" "$CONFIG" "$PRIOR_CONFIG" || restore_failed=1
      restore_directory "$CLIENT_SHIM_SNAPSHOT" "$CLIENT_SHIM_DIR" "$PRIOR_CLIENT_SHIM" || restore_failed=1
      restore_file "$PLIST_SNAPSHOT" "$PLIST" "$PRIOR_PLIST" || restore_failed=1
    fi
    if (( CUTOVER_STARTED && PRIOR_LAUNCHD_LOADED && restore_failed == 0 )); then
      "$LAUNCHCTL" bootstrap "gui/$UID" "$PLIST" >/dev/null 2>&1 || restore_failed=1
      "$LAUNCHCTL" print "gui/$UID/$LABEL" >/dev/null 2>&1 || restore_failed=1
    elif (( CUTOVER_STARTED && restore_failed == 0 )) && "$LAUNCHCTL" print "gui/$UID/$LABEL" >/dev/null 2>&1; then
      restore_failed=1
    fi
    if (( CUTOVER_STARTED && PRIOR_LEGACY_LOADED && restore_failed == 0 )); then
      SNAPSHOT="$LEGACY_RUNNER_SNAPSHOT" TARGET="$LEGACY_RUNNER" "$NODE" -e 'const fs=require("node:fs"); if(!fs.readFileSync(process.env.SNAPSHOT).equals(fs.readFileSync(process.env.TARGET))) process.exit(1)' || restore_failed=1
      "$LAUNCHCTL" bootstrap "gui/$UID" "$LEGACY_PLIST_SNAPSHOT" >/dev/null 2>&1 || restore_failed=1
      "$LAUNCHCTL" print "gui/$UID/$LEGACY_LABEL" >/dev/null 2>&1 || restore_failed=1
      local restored_state="$LEGACY_INSTANCE_STATE"
      if ! "$NODE" "$REPO_ROOT/scripts/station-dogfood-health.mjs" --instance-state="$restored_state" --timeout-ms=3000 "${LEGACY_HEALTH_HOST_ARGS[@]}" >/dev/null 2>&1; then
        restored_state="$LEGACY_ROLLBACK_PATH/.station/instances/$INSTANCE.json"
      fi
      local restored_health
      restored_health="$("$NODE" "$REPO_ROOT/scripts/station-dogfood-health.mjs" --instance-state="$restored_state" --timeout-ms=3000 "${LEGACY_HEALTH_HOST_ARGS[@]}" 2>/dev/null)" || restore_failed=1
      LEGACY_SHA="$LEGACY_SHA" RESTORED_HEALTH="$restored_health" "$NODE" -e '
        const h=JSON.parse(process.env.RESTORED_HEALTH||"null");
        if(!h?.healthy||h.identity?.sha!==process.env.LEGACY_SHA) throw new Error("restored legacy runtime identity/readiness does not match captured A");
      ' >/dev/null 2>&1 || restore_failed=1
      if [[ "$restored_state" == "$LEGACY_INSTANCE_STATE" ]]; then
        cleanup_transaction_release "$LEGACY_ROLLBACK_PATH" "$LEGACY_SHA" || restore_failed=1
      fi
    fi
    if (( restore_failed && launchd_unloaded )); then
      print -u2 "CRITICAL: managed files did not restore cleanly; launchd is confirmed unloaded. Inspect $TXN_DIR before retrying installation."
    fi
  fi
  rm -f "$TEMP_CONFIG"
  rm -f "$CLIENT_DISCOVERY"
  if (( restore_failed )); then
    print -u2 "CRITICAL: rollback evidence retained at $TXN_DIR"
    exit 1
  fi
  rm -rf "$TXN_DIR"
  exit $exit_status
}
trap rollback_install EXIT
REPO_ROOT="$REPO_ROOT" INSTANCE="$INSTANCE" STATION_HOME="$STATION_HOME" SUPPORT_DIR="$SUPPORT_DIR" LOG_DIR="$LOG_DIR" SERVER_PORT="$SERVER_PORT" UI_PORT="$UI_PORT" TAILNET_URL="$TAILNET_URL" CONFIG="$TEMP_CONFIG" "$NODE" -e '
  const fs = require("node:fs");
  const value = {
    version: 1,
    repo: process.env.REPO_ROOT,
    githubRepo: "kontourai/station",
    instance: process.env.INSTANCE,
    stationHome: process.env.STATION_HOME,
    supportDir: process.env.SUPPORT_DIR,
    logDir: process.env.LOG_DIR,
    serverPort: Number(process.env.SERVER_PORT),
    uiPort: Number(process.env.UI_PORT),
    tailnetUrl: process.env.TAILNET_URL,
  };
  fs.writeFileSync(process.env.CONFIG, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(process.env.CONFIG, 0o600);
'
"$NODE" "$REPO_ROOT/scripts/station-dogfood-reconcile.mjs" validate-config --config="$TEMP_CONFIG" >/dev/null
if [[ -f "$CONFIG" ]]; then
  EXISTING_CONFIG="$CONFIG" NEW_CONFIG="$TEMP_CONFIG" LEGACY_WORKTREE="$LEGACY_WORKTREE" PRIOR_LEGACY_LOADED="$PRIOR_LEGACY_LOADED" PRIOR_LAUNCHD_LOADED="$PRIOR_LAUNCHD_LOADED" GIT="$GIT" "$NODE" -e '
    const {execFileSync}=require("node:child_process");
    const fs=require("node:fs");
    const canonical=(value)=>value&&typeof value==="object"?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])]))):value;
    const before=canonical(JSON.parse(fs.readFileSync(process.env.EXISTING_CONFIG,"utf8")));
    const next=canonical(JSON.parse(fs.readFileSync(process.env.NEW_CONFIG,"utf8")));
    if(JSON.stringify(before)===JSON.stringify(next)) process.exit(0);
    const beforeWithoutRepo={...before}; delete beforeWithoutRepo.repo;
    const nextWithoutRepo={...next}; delete nextWithoutRepo.repo;
    if(JSON.stringify(beforeWithoutRepo)!==JSON.stringify(nextWithoutRepo)) throw new Error("existing dogfood config differs beyond repo; semantic reinstall changes require a separate migration");
    if(process.env.PRIOR_LEGACY_LOADED!=="1"||process.env.PRIOR_LAUNCHD_LOADED!=="0"||!process.env.LEGACY_WORKTREE) throw new Error("repo-only migration requires every explicit legacy input, a loaded legacy updater, and an unloaded canonical supervisor");
    if(next.repo!==process.env.LEGACY_WORKTREE) throw new Error("repo-only migration target must exactly equal the explicit legacy worktree");
    const inspectDirectory=(directory,label)=>{
      if(!directory||!require("node:path").isAbsolute(directory)) throw new Error(`${label} repo must be absolute`);
      const stat=fs.lstatSync(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(directory)!==directory) throw new Error(`${label} repo must be a real non-symlink directory`);
      if(typeof process.getuid==="function"&&stat.uid!==process.getuid()) throw new Error(`${label} repo must be owned by the current user`);
    };
    const git=(repo,...args)=>execFileSync(process.env.GIT,["-C",repo,...args],{
      encoding:"utf8",
      stdio:["ignore","pipe","ignore"],
      timeout:5000,
      maxBuffer:1024*1024,
      windowsHide:true,
    }).trim();
    const exactOrigin=(repo,label)=>{
      const origin=git(repo,"remote","get-url","origin").replace(/\.git$/,"");
      if(!/^(?:git@github\.com:|https:\/\/github\.com\/)kontourai\/station$/.test(origin)) throw new Error(`${label} repo origin is not exactly kontourai/station`);
    };
    inspectDirectory(before.repo,"existing"); inspectDirectory(next.repo,"migration target");
    exactOrigin(before.repo,"existing"); exactOrigin(next.repo,"migration target");
    if(git(next.repo,"status","--porcelain")!=="") throw new Error("repo-only migration target must be clean");
    if(git(next.repo,"symbolic-ref","--short","HEAD")!=="dogfood/main") throw new Error("repo-only migration target must be attached to dogfood/main");
    if(git(next.repo,"rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}")!=="origin/main") throw new Error("repo-only migration target must track origin/main");
    if(git(next.repo,"rev-parse","HEAD")!==git(next.repo,"rev-parse","origin/main")) throw new Error("repo-only migration target must equal the intended origin/main source");
  '
fi
ALLOW_OCCUPIED="$([[ ( -f "$SUPPORT_DIR/state.json" && "$PRIOR_LAUNCHD_LOADED" == 1 ) || "$PRIOR_LEGACY_LOADED" == 1 ]] && print 1 || print 0)" SERVER_PORT="$SERVER_PORT" UI_PORT="$UI_PORT" "$NODE" -e '
  const net = require("node:net");
  (async () => {
    const server = Number(process.env.SERVER_PORT);
    const ports = [server, server + 1, server + 2, Number(process.env.UI_PORT)];
    const occupied = await Promise.all(ports.map((port) => new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(port); });
      socket.once("timeout", () => { socket.destroy(); reject(new Error(`port ${port} probe timed out`)); });
      socket.once("error", (error) => {
        if (error.code === "ECONNREFUSED") resolve(null);
        else reject(new Error(`port ${port} probe failed: ${error.code ?? error.message}`));
      });
    })));
    const conflicts = occupied.filter(Boolean);
    if (conflicts.length && process.env.ALLOW_OCCUPIED !== "1") {
      throw new Error(`ports already in use (${conflicts.join(", ")}); refusing to adopt or stop an unmanaged service. Follow the controlled migration procedure first.`);
    }
  })().catch((error) => { console.error(error.message); process.exit(1); });
'
if [[ -e "$RUNNER" || -L "$RUNNER" ]]; then snapshot_file "$RUNNER" "$RUNNER_SNAPSHOT"; PRIOR_RUNNER=1; fi
if [[ -e "$HEALTH_HELPER" || -L "$HEALTH_HELPER" ]]; then snapshot_file "$HEALTH_HELPER" "$HEALTH_HELPER_SNAPSHOT"; PRIOR_HEALTH_HELPER=1; fi
if [[ -e "$CONFIG" || -L "$CONFIG" ]]; then snapshot_file "$CONFIG" "$CONFIG_SNAPSHOT"; PRIOR_CONFIG=1; fi
if [[ -e "$SUPPORT_DIR/state.json" || -L "$SUPPORT_DIR/state.json" ]]; then snapshot_file "$SUPPORT_DIR/state.json" "$STATE_SNAPSHOT"; PRIOR_STATE=1; fi
if [[ -e "$CLIENT_SHIM_DIR" || -L "$CLIENT_SHIM_DIR" ]]; then snapshot_directory "$CLIENT_SHIM_DIR" "$CLIENT_SHIM_SNAPSHOT"; PRIOR_CLIENT_SHIM=1; fi
LAUNCHD_MUTATED=1
mkdir -m 0700 -p "$SUPPORT_DIR/bin" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 0700 "$SUPPORT_DIR" "$SUPPORT_DIR/bin" "$LOG_DIR"
"$NODE" "$CLIENT_PATH_HELPER" --materialize=1 --input="$CLIENT_DISCOVERY" --shim="$CLIENT_SHIM_DIR" --root="$SUPPORT_DIR/bin"
LOG_DIR="$LOG_DIR" "$NODE" -e '
  const fs = require("node:fs");
  for (const name of ["station-update.log", "station-runtime.log", "station-lifecycle.jsonl", "station-launchd.log", "station-launchd-error.log"]) {
    const file = require("node:path").join(process.env.LOG_DIR, name);
    if (fs.existsSync(file)) {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${file} must be a real file, not a symlink`);
      if (process.getuid && info.uid !== process.getuid()) throw new Error(`${file} is not owned by the current user`);
    } else {
      fs.closeSync(fs.openSync(file, "wx", 0o600));
    }
    fs.chmodSync(file, 0o600);
  }
'
install -m 0755 "$REPO_ROOT/scripts/station-dogfood-reconcile.mjs" "$RUNNER"
install -m 0755 "$REPO_ROOT/scripts/station-dogfood-health.mjs" "$HEALTH_HELPER"
install -m 0600 "$TEMP_CONFIG" "$CONFIG"

LEGACY_STATE_SNAPSHOT="$TXN_DIR/legacy-adopted-state"
if (( PRIOR_LEGACY_LOADED )); then
  (( PRIOR_LAUNCHD_LOADED == 0 )) || fail "legacy adoption requires the canonical supervisor to remain unloaded"
  INACTIVE_CANONICAL_STATE_ARGS=()
  if (( PRIOR_STATE )); then
    INACTIVE_CANONICAL_STATE_ARGS+=(
      --inactive-canonical-state="$STATE_SNAPSHOT"
      --legacy-label="$LEGACY_LABEL"
      --legacy-plist="$LEGACY_PLIST"
      --legacy-plist-snapshot="$LEGACY_PLIST_SNAPSHOT"
      --legacy-runner="$LEGACY_RUNNER"
      --legacy-runner-snapshot="$LEGACY_RUNNER_SNAPSHOT"
    )
  fi
  ADOPT_OUT="$(PATH="$LAUNCH_PATH" "$NODE" "$RUNNER" adopt-legacy --config="$CONFIG" --legacy-path="$LEGACY_RUNTIME" --instance-state="$LEGACY_INSTANCE_STATE" --legacy-sha="$LEGACY_SHA" --legacy-boot-id="$LEGACY_BOOT_ID" --legacy-instance-id="$LEGACY_INSTANCE_ID" "${LEGACY_HEALTH_HOST_ARGS[@]}" "${INACTIVE_CANONICAL_STATE_ARGS[@]}")"
  LEGACY_ROLLBACK_PATH="$(ADOPT_OUT="$ADOPT_OUT" LEGACY_SHA="$LEGACY_SHA" "$NODE" -e '
    const outcome=JSON.parse(process.env.ADOPT_OUT.trim().split("\n").at(-1));
    if(outcome.action!=="adopted"||outcome.sha!==process.env.LEGACY_SHA||!outcome.rollbackPath) throw new Error("legacy adoption did not retain exact rollback A");
    process.stdout.write(outcome.rollbackPath);
  ')"
  cp -p "$SUPPORT_DIR/state.json" "$LEGACY_STATE_SNAPSHOT"
fi

# Build the immutable desired candidate while the verified legacy runtime A
# continues serving through its adopted runtimePath. Only a durable,
# manifest-validated staged release permits the cutover boundary below.
STAGE_OUT="$(PATH="$LAUNCH_PATH" "$NODE" "$RUNNER" reconcile --stage-only --defer-prune --config="$CONFIG")"
STAGED_RELEASE_PATH="$(STAGE_OUT="$STAGE_OUT" "$NODE" -e '
  const outcome=JSON.parse(process.env.STAGE_OUT.trim().split("\n").at(-1));
  if(outcome.action!=="staged"||!outcome.candidatePath||typeof outcome.candidateCreated!=="boolean") throw new Error("stage-only did not return transaction release provenance");
  if(outcome.candidateCreated) process.stdout.write(outcome.candidatePath);
')"
STAGED_RELEASE_SHA="$(STAGE_OUT="$STAGE_OUT" "$NODE" -e '
  const outcome=JSON.parse(process.env.STAGE_OUT.trim().split("\n").at(-1));
  if(outcome.candidateCreated) process.stdout.write(outcome.sha);
')"
if [[ "${STATION_DOGFOOD_INJECT_FAILURE:-}" == "after-stage-before-cutover" ]]; then
  fail "injected failure after adoption and staging before cutover"
fi

# This updates only the HTTPS root handler. It never enables Funnel and never
# uses `tailscale serve reset`, so handlers on other ports and paths survive.
verify_stale_serve_root
SERVE_MUTATED=1
"$TAILSCALE" serve --bg --https=443 "http://127.0.0.1:$UI_PORT"
SERVE_AFTER="$("$TAILSCALE" serve status --json)"
SERVE_BEFORE="$SERVE_BEFORE" SERVE_AFTER="$SERVE_AFTER" TARGET="http://127.0.0.1:$UI_PORT" HOSTPORT="$TAILNET_HOST:443" "$NODE" -e '
  const before = JSON.parse(process.env.SERVE_BEFORE);
  const status = JSON.parse(process.env.SERVE_AFTER);
  const host = process.env.HOSTPORT;
  if (status.Web?.[host]?.Handlers?.["/"]?.Proxy !== process.env.TARGET) {
    throw new Error("Tailscale Serve did not retain the expected loopback proxy");
  }
  if (status.AllowFunnel?.[host] === true) throw new Error("Funnel is enabled; refusing to continue");
  const unrelated = (input) => {
    const copy = structuredClone(input);
    const web = copy.Web ?? {};
    if (web[host]?.Handlers) {
      delete web[host].Handlers["/"];
      if (Object.keys(web[host].Handlers).length === 0) delete web[host];
    }
    if (Object.keys(web).length === 0) delete copy.Web;
    return copy;
  };
  const canonical = (value) => value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
  if (JSON.stringify(canonical(unrelated(before))) !== JSON.stringify(canonical(unrelated(status)))) {
    throw new Error("Tailscale Serve changed an unrelated handler; refusing installation");
  }
'

NODE_PATH="$NODE" RUNNER_PATH="$RUNNER" CONFIG_PATH="$CONFIG" LAUNCH_PATH="$LAUNCH_PATH" LAUNCHD_OUT="$LOG_DIR/station-launchd.log" LAUNCHD_ERR="$LOG_DIR/station-launchd-error.log" CI_BILLING_WAIVER_EXPIRES_AT="$CI_BILLING_WAIVER_EXPIRES_AT" TEMPLATE="$SCRIPT_DIR/io.kontourai.station-dogfood.plist.template" PLIST="$PLIST" "$NODE" -e '
  const fs = require("node:fs");
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  let template = fs.readFileSync(process.env.TEMPLATE, "utf8");
  const replacements = {
    __NODE__: process.env.NODE_PATH,
    __RUNNER__: process.env.RUNNER_PATH,
    __CONFIG__: process.env.CONFIG_PATH,
    __PATH__: process.env.LAUNCH_PATH,
    __LAUNCHD_OUT__: process.env.LAUNCHD_OUT,
    __LAUNCHD_ERR__: process.env.LAUNCHD_ERR,
    __CI_BILLING_WAIVER_EXPIRES_AT__: process.env.CI_BILLING_WAIVER_EXPIRES_AT,
  };
  for (const [key, value] of Object.entries(replacements)) template = template.replaceAll(key, escape(value));
  fs.writeFileSync(process.env.PLIST, template);
'
"$PLUTIL" -lint "$PLIST"
PLIST="$PLIST" LAUNCH_PATH="$LAUNCH_PATH" CLIENT_SHIM_DIR="$CLIENT_SHIM_DIR" OPERATIONAL_LAUNCH_PATH="$OPERATIONAL_LAUNCH_PATH" CI_BILLING_WAIVER_EXPIRES_AT="$CI_BILLING_WAIVER_EXPIRES_AT" "$NODE" -e '
  const source = require("node:fs").readFileSync(process.env.PLIST, "utf8");
  if (!/<string>supervise<\/string>/.test(source) || !/<key>KeepAlive<\/key>\s*<true\/>/.test(source) || !/<key>ExitTimeOut<\/key>\s*<integer>600<\/integer>/.test(source)) {
    throw new Error("dogfood LaunchAgent must retain the persistent supervisor contract");
  }
  const escapeRegex=(value)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  if(!new RegExp(`<key>PATH<\\/key>\\s*<string>${escapeRegex(process.env.LAUNCH_PATH.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"))}<\\/string>`).test(source)) throw new Error("rendered LaunchAgent PATH differs from the computed deterministic PATH");
  if(!process.env.LAUNCH_PATH.startsWith(`${process.env.CLIENT_SHIM_DIR}:`) || process.env.LAUNCH_PATH !== `${process.env.CLIENT_SHIM_DIR}:${process.env.OPERATIONAL_LAUNCH_PATH}`) throw new Error("LaunchAgent PATH must contain only the client shim and deterministic operational PATH");
  const escaped=process.env.CI_BILLING_WAIVER_EXPIRES_AT.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  if(!new RegExp(`<key>STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT<\\/key>\\s*<string>${escapeRegex(escaped)}<\\/string>`).test(source)) throw new Error("rendered LaunchAgent billing waiver policy differs from installer policy");
'
if [[ "${STATION_DOGFOOD_INJECT_FAILURE:-}" == "after-shim-plist" ]]; then
  fail "injected failure after shim and plist replacement"
fi
RECONCILE_ATTEMPTED=1
CUTOVER_STARTED=1
if (( PRIOR_LEGACY_LOADED )); then
  "$LAUNCHCTL" bootout "gui/$UID/$LEGACY_LABEL"
  wait_launchd_unloaded "$LEGACY_LABEL" || fail "legacy updater remained loaded after bootout"
fi
if (( PRIOR_LAUNCHD_LOADED )); then
  "$LAUNCHCTL" bootout "gui/$UID/$LABEL"
  wait_launchd_unloaded "$LABEL" || fail "canonical updater remained loaded after bootout"
fi
if [[ "${STATION_DOGFOOD_INJECT_FAILURE:-}" == "after-cutover" ]]; then
  fail "injected failure after updater cutover"
fi
PROMOTION_ATTEMPTED=1
RECONCILE_OUT="$(PATH="$LAUNCH_PATH" "$NODE" "$RUNNER" reconcile --defer-prune --config="$CONFIG")"
ACTIVE_SHA="$("$NODE" -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!s.active?.sha) process.exit(1); process.stdout.write(s.active.sha)' "$SUPPORT_DIR/state.json")"
ACTIVE_PATH="$("$NODE" -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!s.active?.path) process.exit(1); process.stdout.write(s.active.path)' "$SUPPORT_DIR/state.json")"
LOCAL_HEALTH="$("$NODE" "$HEALTH_HELPER" --instance-state="$ACTIVE_PATH/.station/instances/$INSTANCE.json" --timeout-ms=3000)"
ACTIVE_SHA="$ACTIVE_SHA" LOCAL_HEALTH="$LOCAL_HEALTH" RECONCILE_OUT="$RECONCILE_OUT" "$NODE" -e '
  const stateSha = process.env.ACTIVE_SHA;
  const outcome = JSON.parse(process.env.RECONCILE_OUT.trim().split("\n").at(-1));
  const health = JSON.parse(process.env.LOCAL_HEALTH);
  if (!health.healthy || outcome.sha !== stateSha || health.identity?.sha !== stateSha) throw new Error("synchronous reconcile/state/local identity SHA mismatch");
'
SERVER_PORT="$SERVER_PORT" UI_PORT="$UI_PORT" "$NODE" -e '
  const net = require("node:net");
  const server = Number(process.env.SERVER_PORT);
  const ports = [server, server + 1, server + 2, Number(process.env.UI_PORT)];
  Promise.all(ports.map((port) => new Promise((resolve, reject) => {
    const socket = net.createConnection({host:"127.0.0.1",port});
    socket.setTimeout(2000);
    socket.once("connect",()=>{socket.destroy();resolve();});
    socket.once("timeout",()=>{socket.destroy();reject(new Error(`port ${port} timed out`));});
    socket.once("error",(error)=>reject(new Error(`port ${port} is unhealthy: ${error.message}`)));
  }))).catch((error)=>{console.error(error.message);process.exit(1);});
'
"$LAUNCHCTL" bootstrap "gui/$UID" "$PLIST"
"$LAUNCHCTL" print "gui/$UID/$LABEL" >/dev/null
"$LAUNCHCTL" kickstart "gui/$UID/$LABEL"
LAUNCHD_STARTED=0
for attempt in {1..120}; do
  LAUNCHD_STATUS="$($LAUNCHCTL print "gui/$UID/$LABEL")"
  if [[ "$LAUNCHD_STATUS" =~ 'runs = ([1-9][0-9]*)' ]] &&
     [[ "$LAUNCHD_STATUS" == *'state = running'* ]]; then
    LAUNCHD_STARTED=1
    break
  fi
  sleep 0.5
done
(( LAUNCHD_STARTED )) || fail "launchd did not keep the managed supervisor running"
SERVE_MUTATED=0
LAUNCHD_MUTATED=0
RECONCILE_ATTEMPTED=0
rm -f "$TEMP_CONFIG"
rm -f "$CLIENT_DISCOVERY"
rm -rf "$TXN_DIR"
trap - EXIT
PATH="$LAUNCH_PATH" "$NODE" "$RUNNER" prune --config="$CONFIG" >/dev/null || print -u2 "WARNING: release pruning is pending; the next reconcile will retry"

print "Installed $LABEL"
print "Active SHA: $ACTIVE_SHA"
print "Tailnet URL: $TAILNET_URL"
print "Config: $CONFIG"
print "Status: $NODE $RUNNER status --config=$CONFIG"
