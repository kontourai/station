import { spawn } from 'node:child_process';
import { requireOpenSshAlias } from './openssh-config.js';

export const SSH_LAUNCH_PROTOCOL_VERSION = 1;
const MAX_OUTPUT_BYTES = 256 * 1024;
const LAUNCH_KEY_PATTERN = /^[0-9a-f-]{36}$/i;
// Printable ASCII only, bounded length. Wide enough to carry `station
// start`'s own structured port-conflict message (station#1133 live-
// verification finding) as well as the narrower single-token details
// (a version string, a port number, an elapsed-seconds count) — but still a
// closed, safe shape: no control characters, no ANSI escapes, no unicode
// homoglyphs, capped length. Only ever populated from our own `fail()`
// helper's closed-enum `error` field, never from raw/unclassified stderr.
const SAFE_DETAIL_PATTERN = /^[\x20-\x7e]{1,200}$/;

export type OpenSshLaunchFailureReason =
  | 'node-not-found'
  | 'unsupported-node-version'
  | 'project-unavailable'
  | 'port-in-use'
  | 'readiness-timeout'
  | 'protocol-violation'
  | 'requires-build'
  | 'port-conflict'
  | 'launch-failed';

const FAILURE_REASONS = new Set<OpenSshLaunchFailureReason>([
  'node-not-found',
  'unsupported-node-version',
  'project-unavailable',
  'port-in-use',
  'readiness-timeout',
  'protocol-violation',
  'requires-build',
  'port-conflict',
  'launch-failed',
]);

export class OpenSshLaunchError extends Error {
  readonly reason: OpenSshLaunchFailureReason;

  constructor(reason: OpenSshLaunchFailureReason, message: string) {
    super(message);
    this.name = 'OpenSshLaunchError';
    this.reason = reason;
  }
}

export interface OpenSshLaunchResult {
  remotePort: number;
  serverKind: 'managed' | 'external';
}

export interface OpenSshLaunchInput {
  alias: string;
  controlPath: string;
  remoteProjectPath: string;
  /**
   * A stable per-environment key (the SSH environment profile's own id) used
   * to namespace the remote state directory (`~/.station/ssh-launch/<key>/`)
   * so a managed launch can be found and reused across reconnects without
   * colliding with any other saved environment that targets the same host.
   */
  launchKey: string;
  /**
   * The environment profile's configured remote port. Used only to detect
   * an already-running *unmanaged* Station to attach to — the actual
   * managed port (fresh or reused) is chosen independently and returned in
   * the result.
   */
  targetPort: number;
  timeoutMs?: number;
}

export type OpenSshLaunchRunner = (
  input: OpenSshLaunchInput,
) => Promise<OpenSshLaunchResult>;

interface LaunchProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type RunLaunchProcess = (input: {
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}) => Promise<LaunchProcessResult>;

/**
 * station#1133 R1: POSIX `sh` bootstrap piped over SSH stdin (never copied
 * to the remote as a file first). It is idempotent and self-contained:
 *
 *  1. Resolve a Node.js 24.x binary through a version-manager cascade — bare
 *     PATH first, then volta, asdf, mise, fnm, nvm, and nodenv in turn. This
 *     repo's own dogfood hosts need the full cascade (a mise-managed host
 *     defaulting to a newer major on PATH must still find a real 24.x
 *     install via another manager before this fails typed).
 *  2. Consult `~/.station/ssh-launch/<launchKey>/` for a previously managed
 *     port; reuse it without starting a second process if it is still
 *     answering its own readiness endpoint. Readiness, not a recorded pid,
 *     is the reuse signal — a launcher CLI's own process can exit almost
 *     immediately after detaching its long-lived server, so a liveness
 *     check against a launch-time pid alone produces false negatives
 *     against a perfectly healthy, still-running Station.
 *  3. Otherwise, check whether an *unmanaged* Station already answers on the
 *     caller's configured port and attach to it read-only (`serverKind:
 *     "external"`) — this script never adopts or kills a process it did not
 *     start.
 *  4. Otherwise: run under `ssh-launch-<launchKey>` — an instance name this
 *     feature owns exclusively and no operator-managed instance (e.g. a
 *     systemd-managed dogfood deployment) can ever collide with or be
 *     confused for. (Live verification against a real host found an
 *     earlier revision discovering and running directly under an
 *     operator's own already-built instance name, which started/adopted
 *     that instance out from under its service manager — a direct breach
 *     of "never adopt or kill a process it did not start".) Build
 *     directories are instance-scoped (bare `dist-server`/`dist-ui` for the
 *     unnamed `default` instance, `dist-server-<id>`/`dist-ui-<id>`
 *     otherwise), so if this dedicated instance doesn't already have its
 *     own build (from a prior managed launch under this same key), this
 *     DERIVES one — a symlink, never a copy or a rebuild — from whatever
 *     build already exists under any other instance name (preferring the
 *     bare `default` build, then the first other instance-scoped build
 *     found), reusing existing built bytes without ever running under that
 *     build's own instance identity. Refuses fast (`requires-build`) only
 *     if no build exists anywhere under any name — starting is not the
 *     same thing as building, and a build can run many minutes past any
 *     readiness window. Then picks a free server port *and* a free UI port
 *     (Station's own `start` claims four listeners — server, server+1
 *     terminal, server+2 voice, and an independent UI port — and only ever
 *     binds exactly the ports it is given, never a silently different
 *     one), runs `station start --instance=ssh-launch-<launchKey>
 *     --port=<serverPort> --ui-port=<uiPort>` in the foreground (safe once
 *     a build is already guaranteed present — its own synchronous work is
 *     now only pre-flight checks plus a detached, unref'd spawn), and
 *     polls readiness on the reported server port before returning.
 *
 * `remotePort` in the result is always the port this script itself chose or
 * reused — it is never echoed back from the caller's `targetPort`, which is
 * used only for the external-attach check in step 3. (station#1133 live
 * verification against a real host found and fixed an earlier version of
 * this contract that asked the caller to pick the port up front and pass it
 * to `station start` via a caller-chosen "remotePort" input: `station
 * start` genuinely uses whatever port it's given, but with only one port
 * supplied the UI listener silently defaulted to 3000 and collided with an
 * already-running sibling instance on the very first live host tried.)
 *
 * The whole contract is exactly one JSON line on stdout:
 * `{"remotePort":N,"serverKind":"managed"|"external"}`. The client-side
 * parser (`parseOpenSshLaunchResponse`) tolerates unrelated stdout lines
 * ahead of it (some hosts' PAM stack emits chatter on a non-interactive
 * session) by accepting the last line, scanning backward, that parses as a
 * complete contract object — but a stdout with no such line is still a
 * strict `protocol-violation`. Failures are a single bounded JSON object on
 * stderr, `{"error":"<closed-reason>","detail":"<short-safe-token>"}` —
 * `detail` is always a narrow, already-safe token (a version string, a port
 * number, an elapsed-seconds count, or `station start`'s own bounded,
 * printable-ASCII port-conflict message), never arbitrary/unclassified
 * remote output, so this side of the contract can be logged without risking
 * a secret leak. Free-text launch output only ever lands in the remote's
 * own log file under the state directory, inspectable over the same SSH
 * access an operator already has.
 *
 * Two further hardenings from the station#1133 live security review:
 * `node_ready` (the readiness/reuse/external-detect check) verifies a
 * genuine Station handshake plus identity (both endpoints the existing
 * worker probe already checks — `environmentId`, `instanceId`, `sha`,
 * `bootId`), not merely a 200 response, so an unrelated service answering
 * on the target/saved port is never mistaken for a reusable Station. And an
 * atomic `mkdir`-based lock around the whole check-then-launch decision
 * (state-dir reuse check through the `station start` invocation) prevents
 * two concurrent connects for the same launch key from each starting their
 * own Station — the loser waits for the winner rather than racing it.
 */
// A shell parameter expansion like `${1#v}` collides with JS template
// substitution syntax even inside `String.raw` (the backslash needed to
// escape `${` survives raw-ness and becomes a literal, invalid-shell
// backslash). `D` lets the template below spell it as `${D}{1#v}`, which
// concatenates the substituted "$" with the literal "{1#v}" — the shell
// still reads `${1#v}`.
const D = '$';

// Exported so tests can spawn the exact production script directly through a
// real local `sh` (see `__tests__/openssh-launch-bootstrap.test.ts`) — the
// only way to exercise the node-version cascade, state-dir reuse, and
// readiness polling without a real remote host.
export const SSH_LAUNCH_BOOTSTRAP_SOURCE = String.raw`
PROTOCOL_VERSION="$1"
PROJECT_PATH="$2"
TARGET_PORT="$3"
LAUNCH_KEY="$4"
LAST_BAD_VERSION=""
CANDIDATE_NODE=""

fail() {
  reason="$1"
  detail="$2"
  if [ -n "$detail" ]; then
    printf '{"protocolVersion":1,"error":"%s","detail":"%s"}' "$reason" "$detail" 1>&2
  else
    printf '{"protocolVersion":1,"error":"%s"}' "$reason" 1>&2
  fi
  exit 1
}

node_major() {
  ver="${D}{1#v}"
  major="${D}{ver%%.*}"
  case "$major" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$major" ;;
  esac
}

try_node() {
  candidate="$1"
  if [ ! -x "$candidate" ]; then
    command -v "$candidate" >/dev/null 2>&1 || return 1
  fi
  v=$("$candidate" --version 2>/dev/null) || return 1
  m=$(node_major "$v")
  if [ "$m" -eq 24 ] 2>/dev/null; then
    CANDIDATE_NODE="$candidate"
    return 0
  fi
  LAST_BAD_VERSION="$v"
  return 1
}

find_node() {
  try_node node && return 0
  try_node "$HOME/.volta/bin/node" && return 0
  try_node "$HOME/.asdf/shims/node" && return 0
  if [ -f "$HOME/.asdf/asdf.sh" ]; then
    . "$HOME/.asdf/asdf.sh" 2>/dev/null || true
    try_node node && return 0
  fi
  try_node "$HOME/.local/share/mise/shims/node" && return 0
  if command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh 2>/dev/null)" 2>/dev/null || true
    try_node node && return 0
  fi
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env 2>/dev/null)" 2>/dev/null || true
    try_node node && return 0
  fi
  if [ -n "$NVM_DIR" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" 2>/dev/null || true
    try_node node && return 0
  fi
  if [ -f "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh" 2>/dev/null || true
    try_node node && return 0
  fi
  nvm_root="$NVM_DIR"
  [ -n "$nvm_root" ] || nvm_root="$HOME/.nvm"
  if [ -d "$nvm_root/versions/node" ]; then
    for dir in "$nvm_root"/versions/node/v24.*; do
      [ -d "$dir" ] || continue
      try_node "$dir/bin/node" && return 0
    done
  fi
  try_node "$HOME/.nodenv/shims/node" && return 0
  return 1
}

node_ready() {
  port="$1"
  "$CANDIDATE_NODE" -e '
const port = process.argv[1];
const base = "http://127.0.0.1:" + port;
const opts = { signal: AbortSignal.timeout(2000) };
Promise.all([fetch(base + "/.well-known/station/v1", opts), fetch(base + "/api/system/identity", opts)])
  .then(async ([handshakeResponse, identityResponse]) => {
    if (!handshakeResponse.ok || !identityResponse.ok) {
      process.exit(1);
      return;
    }
    const handshake = await handshakeResponse.json();
    const identity = await identityResponse.json();
    const ok =
      handshake && typeof handshake.environmentId === "string" &&
      identity && typeof identity.instanceId === "string" &&
      typeof identity.sha === "string" && typeof identity.bootId === "string";
    process.exit(ok ? 0 : 1);
  })
  .catch(() => process.exit(1));
' "$port" >/dev/null 2>&1
}

wait_ready() {
  port="$1"
  deadline_s="$2"
  elapsed=0
  while [ "$elapsed" -lt "$deadline_s" ]; do
    node_ready "$port" && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

pick_ports() {
  "$CANDIDATE_NODE" -e '
const net = require("node:net");
function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
(async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    let serverPort;
    try {
      serverPort = await pickFreePort();
    } catch {
      continue;
    }
    // station start also claims serverPort+1 (terminal), serverPort+2
    // (voice), and serverPort+3 (consent, station#3677); all four plus a
    // separate ui port must be simultaneously free and distinct
    // (validateLifecyclePorts in lifecycle.ts).
    if (serverPort > 65532) continue;
    const [terminalFree, voiceFree, consentFree] = await Promise.all([
      checkPort(serverPort + 1),
      checkPort(serverPort + 2),
      checkPort(serverPort + 3),
    ]);
    if (!terminalFree || !voiceFree || !consentFree) continue;
    // A second independent pickFreePort() call is NOT used here: several
    // OSes (observed on macOS) hand out ephemeral ports sequentially, so a
    // freshly-closed listener immediately followed by another listen(0)
    // deterministically returns serverPort+1 every time - exactly the
    // terminal port we just reserved, guaranteeing a collision on every
    // attempt. Probing fixed, widely-spaced offsets from serverPort avoids
    // depending on the OS ephemeral allocator behavior at all.
    let uiPort = null;
    for (let offset = 1000; offset <= 10000; offset += 1000) {
      let candidate = serverPort + offset;
      if (candidate > 65535) candidate -= 65000;
      if (
        candidate < 1 ||
        candidate === serverPort ||
        candidate === serverPort + 1 ||
        candidate === serverPort + 2 ||
        candidate === serverPort + 3
      ) {
        continue;
      }
      if (await checkPort(candidate)) {
        uiPort = candidate;
        break;
      }
    }
    if (uiPort === null) continue;
    process.stdout.write(serverPort + " " + uiPort);
    return;
  }
  process.exit(1);
})();
'
}

[ "$PROTOCOL_VERSION" = "1" ] || fail protocol-violation
case "$TARGET_PORT" in ''|*[!0-9]*) fail protocol-violation ;; esac
case "$LAUNCH_KEY" in ''|*[!A-Za-z0-9_-]*) fail protocol-violation ;; esac

case "$PROJECT_PATH" in
  '~') PROJECT_DIR="$HOME" ;;
  '~/'*) PROJECT_DIR="$HOME/${D}{PROJECT_PATH#~/}" ;;
  *) PROJECT_DIR="$PROJECT_PATH" ;;
esac
if [ ! -d "$PROJECT_DIR" ]; then
  fail project-unavailable
fi
PROJECT_DIR=$(cd "$PROJECT_DIR" 2>/dev/null && pwd -P) || fail project-unavailable
STATION_BIN="$PROJECT_DIR/station"
if [ ! -x "$STATION_BIN" ]; then
  fail project-unavailable
fi

if ! find_node; then
  if [ -n "$LAST_BAD_VERSION" ]; then
    detail=$(printf '%s' "$LAST_BAD_VERSION" | tr -cd 'A-Za-z0-9._-' | cut -c1-32)
    fail unsupported-node-version "$detail"
  fi
  fail node-not-found
fi

STATE_DIR="$HOME/.station/ssh-launch/$LAUNCH_KEY"
mkdir -p "$STATE_DIR" 2>/dev/null || fail launch-failed
PORT_FILE="$STATE_DIR/port"
LOG_FILE="$STATE_DIR/station.log"
LAUNCH_LOG_FILE="$STATE_DIR/launch.log"

# Two concurrent connects for the same launchKey (e.g. two clients/devices
# racing) must not both pass the reuse/external checks below and each start
# their own Station. mkdir is atomic on every POSIX filesystem, so it
# doubles as a mutex: the loser waits rather than failing outright, since
# the winner may simply be mid-launch and reuse will then see a healthy
# port. The trap releases the lock on every exit path, including every
# fail() call (which itself calls exit).
LOCK_DIR="$STATE_DIR/lock"
LOCK_WAIT=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  LOCK_WAIT=$((LOCK_WAIT + 1))
  if [ "$LOCK_WAIT" -ge 60 ]; then
    fail launch-failed
  fi
  sleep 1
done
trap 'rm -rf "$LOCK_DIR" 2>/dev/null' EXIT

if [ -f "$PORT_FILE" ]; then
  SAVED_PORT=$(cat "$PORT_FILE" 2>/dev/null)
  case "$SAVED_PORT" in ''|*[!0-9]*) SAVED_PORT="" ;; esac
  if [ -n "$SAVED_PORT" ] && node_ready "$SAVED_PORT"; then
    printf '{"protocolVersion":1,"remotePort":%s,"serverKind":"managed"}\n' "$SAVED_PORT"
    exit 0
  fi
  rm -f "$PORT_FILE"
fi

if node_ready "$TARGET_PORT"; then
  printf '{"protocolVersion":1,"remotePort":%s,"serverKind":"external"}\n' "$TARGET_PORT"
  exit 0
fi

# A managed launch never triggers station's own build (a build is not a
# launch — station#1133 live-verification finding #1: an unbuilt instance
# ran npm run build:ui inside the readiness window and blew it, then failed
# outright on an environment-specific Rollup error).
#
# station#1133 live-verification finding #3: a managed launch MUST run
# under an instance name this feature owns exclusively, never one an
# operator's own tooling manages. An earlier revision discovered an
# already-built instance (e.g. a systemd-managed dogfood host's own named
# instance) and ran station start UNDER THAT DISCOVERED NAME — which
# started/adopted the operator's own service-managed instance out from
# under it: systemd and Station then disagreed about who owned the
# process, and the operator had to manually stop it before the service
# could cleanly restart. That directly broke this feature's own "never
# adopt or kill a process it did not start" promise.
#
# The fix keeps discovery for what it's legitimately good for — finding an
# ALREADY-BUILT layout to avoid a needless build — but never runs under the
# discovered name. STATION_INSTANCE is always this exact launch key's own
# dedicated instance ("ssh-launch-<launchKey>"), which can never collide
# with or be confused for any instance an operator separately manages.
# Build directories are instance-scoped (lifecycle.ts resolveBuildPaths —
# bare dist-server/dist-ui for the unnamed 'default' instance,
# dist-server-<id>/dist-ui-<id> otherwise), so the dedicated instance needs
# its own dist-server-ssh-launch-<launchKey>/dist-ui-ssh-launch-<launchKey>
# pair to be considered installed. If a previous managed launch under this
# same key already created them, reuse as-is. Otherwise, DERIVE them (a
# symlink, not a copy or a rebuild) from whatever build is already present
# under any other instance name — preferring the bare 'default' build, then
# the first other instance-scoped build found — so an existing build is
# reused without ever running under that build's own instance identity.
# Only when no build exists anywhere under any name does this refuse fast
# with requires-build, which remains a legitimate, meaningful refusal.
STATION_INSTANCE="ssh-launch-$LAUNCH_KEY"
OWN_SERVER_BUILD="$PROJECT_DIR/dist-server-$STATION_INSTANCE"
OWN_UI_BUILD="$PROJECT_DIR/dist-ui-$STATION_INSTANCE"
if [ ! -d "$OWN_SERVER_BUILD" ] || [ ! -d "$OWN_UI_BUILD" ]; then
  SOURCE_SERVER_BUILD=""
  SOURCE_UI_BUILD=""
  if [ -d "$PROJECT_DIR/dist-server" ] && [ -d "$PROJECT_DIR/dist-ui" ]; then
    SOURCE_SERVER_BUILD="$PROJECT_DIR/dist-server"
    SOURCE_UI_BUILD="$PROJECT_DIR/dist-ui"
  else
    for candidate_dir in "$PROJECT_DIR"/dist-server-*; do
      [ -d "$candidate_dir" ] || continue
      candidate_id="${D}{candidate_dir#"$PROJECT_DIR"/dist-server-}"
      candidate_ui_dir="$PROJECT_DIR/dist-ui-$candidate_id"
      if [ -d "$candidate_ui_dir" ]; then
        SOURCE_SERVER_BUILD="$candidate_dir"
        SOURCE_UI_BUILD="$candidate_ui_dir"
        break
      fi
    done
  fi
  if [ -z "$SOURCE_SERVER_BUILD" ]; then
    fail requires-build
  fi
  ln -sfn "$SOURCE_SERVER_BUILD" "$OWN_SERVER_BUILD" || fail requires-build
  ln -sfn "$SOURCE_UI_BUILD" "$OWN_UI_BUILD" || fail requires-build
fi

PORTS=$(pick_ports)
case "$PORTS" in *' '*) : ;; *) fail port-in-use ;; esac
SERVER_PORT="${D}{PORTS%% *}"
UI_PORT="${D}{PORTS##* }"
case "$SERVER_PORT" in ''|*[!0-9]*) fail port-in-use ;; esac
case "$UI_PORT" in ''|*[!0-9]*) fail port-in-use ;; esac

PATH="$(dirname "$CANDIDATE_NODE"):$PATH"
export PATH
cd "$PROJECT_DIR" || fail project-unavailable

# station#1133 live-verification finding: station start allocates
# EXACTLY the --port/--ui-port it is given (never a silently different
# port), and only ever does real work synchronously (pre-flight checks,
# then a detached, unref'd spawn) once a build already exists — guaranteed
# above (reusing whichever instance's build was actually found). So this
# can safely run in the foreground: its own exit code and captured output
# are the direct, reliable signal for a port conflict or any other
# pre-flight failure, instead of inferring failure from a readiness poll
# against a port the failed process never bound.
START_OUTPUT=$("$STATION_BIN" start --instance="$STATION_INSTANCE" --port="$SERVER_PORT" --ui-port="$UI_PORT" --host=127.0.0.1 --log="$LOG_FILE" 2>&1)
START_CODE=$?
printf '%s\n' "$START_OUTPUT" >> "$LAUNCH_LOG_FILE"
if [ "$START_CODE" -ne 0 ]; then
  case "$START_OUTPUT" in
    *'ports overlap another live Station instance'*)
      detail=$(printf '%s' "$START_OUTPUT" | tr '\n' ' ' | tr -cd ' -~' | cut -c1-200)
      fail port-conflict "$detail"
      ;;
  esac
  fail launch-failed
fi

echo "$SERVER_PORT" > "$PORT_FILE"

READY_DEADLINE_S="$STATION_SSH_LAUNCH_READY_TIMEOUT_S"
[ -n "$READY_DEADLINE_S" ] || READY_DEADLINE_S=45
if wait_ready "$SERVER_PORT" "$READY_DEADLINE_S"; then
  printf '{"protocolVersion":1,"remotePort":%s,"serverKind":"managed"}\n' "$SERVER_PORT"
  exit 0
fi
rm -f "$PORT_FILE"
fail readiness-timeout "$READY_DEADLINE_S"
`;

function safeRemotePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Remote Station port must be between 1 and 65535');
  }
  return value;
}

function safeLaunchKey(value: string): string {
  if (!LAUNCH_KEY_PATTERN.test(value)) {
    throw new Error('SSH launch key is invalid');
  }
  return value;
}

function safeRemoteProjectPathArg(value: string): string {
  if (
    !value ||
    value.length > 4096 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('Remote project path is invalid');
  }
  return value;
}

/**
 * Standard bulletproof POSIX single-quote escape: close the quote, emit an
 * escaped literal quote, reopen the quote. The result is safe to place
 * inside a POSIX shell command line regardless of what characters `value`
 * contains — no character inside a single-quoted string is special to the
 * shell except `'` itself, which this never leaves unescaped.
 */
function posixShellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * station#1133 security fix (live-verified RCE, reported by independent
 * review): OpenSSH does **not** treat trailing command arguments as an
 * argv-safe array the way `spawn(cmd, [...args])` does locally. Per `ssh(1)`,
 * when more than one command argument follows the destination, ssh joins
 * them with spaces into a single string and the remote sshd hands that
 * string to the login shell as `$SHELL -c "<string>"`. An earlier version of
 * this function passed `remoteProjectPath` (an arbitrary, operator-supplied
 * path with no shell-metacharacter restriction — deliberately, since a
 * legitimate path can contain spaces, parens, etc.) as one of four separate
 * trailing arguments; anything in it that was a shell metacharacter (`;`,
 * backticks, `$()`, `|`, a newline, ...) executed on the remote host on
 * every connect. Fixed by assembling the entire remote command as ONE
 * already-POSIX-quoted string — ssh's join-with-spaces then has nothing
 * left to reinterpret, since there is only one trailing argument — mirroring
 * the discipline the sibling worker probe already applies via a base64url
 * payload (opaque, no shell metacharacters possible by construction); this
 * takes the equivalent, per-argument-quoting route instead so a legitimate
 * path containing spaces continues to reach the remote script unmangled.
 */
export function buildOpenSshLaunchArgs(input: OpenSshLaunchInput): string[] {
  const alias = requireOpenSshAlias(input.alias);
  const remoteProjectPath = safeRemoteProjectPathArg(input.remoteProjectPath);
  const targetPort = safeRemotePort(input.targetPort);
  const launchKey = safeLaunchKey(input.launchKey);
  const remoteCommand = [
    'sh',
    '-s',
    '--',
    posixShellQuote(String(SSH_LAUNCH_PROTOCOL_VERSION)),
    posixShellQuote(remoteProjectPath),
    posixShellQuote(String(targetPort)),
    posixShellQuote(launchKey),
  ].join(' ');
  return [
    '-S',
    input.controlPath,
    '-T',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'RemoteCommand=none',
    '--',
    alias,
    remoteCommand,
  ];
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
    throw new Error('OpenSSH launch response exceeded the output limit');
  }
  return next;
}

function runSystemLaunchProcess(input: {
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
}): Promise<LaunchProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...input.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: LaunchProcessResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('OpenSSH managed launch timed out'));
    }, input.timeoutMs);
    child.once('error', () =>
      finish(new Error('OpenSSH launch is unavailable')),
    );
    child.stdout.on('data', (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk);
      } catch (error) {
        child.kill('SIGKILL');
        finish(error as Error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        child.kill('SIGKILL');
        finish(error as Error);
      }
    });
    child.once('close', (exitCode) =>
      finish({ stdout, stderr, exitCode: exitCode ?? 1 }),
    );
    child.stdin.end(input.stdin);
  });
}

function classifyFailure(stderr: string): OpenSshLaunchError {
  try {
    const parsed = JSON.parse(stderr) as {
      error?: unknown;
      detail?: unknown;
    };
    if (
      typeof parsed.error === 'string' &&
      FAILURE_REASONS.has(parsed.error as OpenSshLaunchFailureReason)
    ) {
      const reason = parsed.error as OpenSshLaunchFailureReason;
      const detail =
        typeof parsed.detail === 'string' &&
        SAFE_DETAIL_PATTERN.test(parsed.detail)
          ? parsed.detail
          : undefined;
      return new OpenSshLaunchError(
        reason,
        detail
          ? `Remote Station launch failed: ${reason} (${detail})`
          : `Remote Station launch failed: ${reason}`,
      );
    }
  } catch {
    // Fall through to the generic reason below — never surface raw stderr.
  }
  return new OpenSshLaunchError(
    'launch-failed',
    'Remote Station launch failed',
  );
}

/**
 * Validates a single candidate line against the exact contract shape —
 * invalid JSON, an unrecognized `serverKind`, or an out-of-range
 * `remotePort` all return `null` rather than throwing, so the caller can
 * keep scanning other lines.
 */
function parseContractLine(line: string): OpenSshLaunchResult | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const response = value as Record<string, unknown>;
  const remotePort = response.remotePort;
  const serverKind = response.serverKind;
  if (
    response.protocolVersion !== SSH_LAUNCH_PROTOCOL_VERSION ||
    !Number.isInteger(remotePort) ||
    (remotePort as number) < 1 ||
    (remotePort as number) > 65_535 ||
    (serverKind !== 'managed' && serverKind !== 'external')
  ) {
    return null;
  }
  return {
    remotePort: remotePort as number,
    serverKind: serverKind as 'managed' | 'external',
  };
}

/**
 * station#1133 security-review finding (MEDIUM): some hosts' PAM stack
 * (e.g. `pam_motd.so`, default on Debian/Ubuntu) can emit stdout chatter for
 * a non-interactive exec session ahead of anything the invoked command
 * itself prints. Strictly requiring exactly one stdout line would make that
 * an unprovoked `protocol-violation` on such hosts. This scans from the end
 * of stdout — our own script always prints its single JSON line last, right
 * before exiting — and accepts the first (from the end) line that parses as
 * a complete, valid contract object; any leading non-JSON or unrelated JSON
 * lines are tolerated. If no line validates, that is still a strict
 * `protocol-violation` — this relaxes *position*, not *shape*.
 */
export function parseOpenSshLaunchResponse(
  result: LaunchProcessResult,
): OpenSshLaunchResult {
  if (result.exitCode !== 0) {
    throw classifyFailure(result.stderr);
  }
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseContractLine(lines[index]);
    if (parsed) return parsed;
  }
  throw new OpenSshLaunchError(
    'protocol-violation',
    'Remote Station launch did not return a valid response line',
  );
}

export function createSystemOpenSshLaunchRunner(
  runProcess: RunLaunchProcess = runSystemLaunchProcess,
): OpenSshLaunchRunner {
  return async (input) => {
    const result = await runProcess({
      args: buildOpenSshLaunchArgs(input),
      stdin: SSH_LAUNCH_BOOTSTRAP_SOURCE,
      timeoutMs: input.timeoutMs ?? 60_000,
    });
    return parseOpenSshLaunchResponse(result);
  };
}
