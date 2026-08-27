import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import {
  BILLING_WAIVER_MAX_EXPIRY_ISO,
  CANDIDATE,
  fixtureRoot,
  MAX_WAIVER_EXPIRY,
  macosInstallerTest,
  OLDER,
  PREVIOUS,
  WAIVER_SUNSET_MS,
} from './fixture.js';
import { runInstallerProcess } from './installer-process.js';

const INSTALLER_PROCESS_TIMEOUT_MS = 25_000;
const INSTALLER_TEST_TIMEOUT_MS = 30_000;

/**
 * The era switch for the `billing-policy` end-to-end case — the ONE place this
 * file consults the real wall clock.
 *
 * The installer validates a candidate expiry against BOTH `Date.now()` (must be
 * in the future) and the policy maximum, in a `node -e` subprocess with no
 * clock-injection seam, so an end-to-end proof of that preflight is necessarily
 * wall-clock dependent:
 *
 * - `'grantable'` (now < maximum): the strongest input the policy accepts is
 *   granted, the cutover completes, and the waiver is rendered into the
 *   LaunchAgent plist.
 * - `'sunset'` (now >= maximum): no value can satisfy both bounds, so the
 *   installer must fail closed in preflight before touching the legacy runtime.
 *
 * Both branches assert real behavior; neither is a conditional green. Pinning
 * one era as a literal is what made this case a time bomb that detonated at the
 * policy's own sunset instant (#1432) — reading the clock instead means the
 * next sunset flips this switch rather than breaking the suite, and revising
 * the sunset needs no edit here at all: only
 * `BILLING_WAIVER_MAX_EXPIRY_ISO` in scripts/station-dogfood-reconcile.mjs
 * and the installer's matching literal change.
 *
 * Because the wall clock can only ever be in one era, BOTH eras are
 * additionally pinned unconditionally at module level, against an injected
 * clock, by the billing-waiver era tests in `promotion-policy.behavior.ts`.
 */
function billingWaiverEra(now: number = Date.now()): 'grantable' | 'sunset' {
  return now < WAIVER_SUNSET_MS ? 'grantable' : 'sunset';
}

export function registerCutoverMatrix(cutoverShardIndex: number) {
  describe('station dogfood reconcile', () => {
    const cutoverModes = [
      'success',
      'rollback',
      'rollback-fallback',
      'rollback-candidate-removed',
      'rollback-candidate-symlink',
      'rollback-candidate-sha-mismatch',
      'ownership',
      'origin',
      'decoy',
      'arguments',
      'worktree',
      'wildcard',
      'arbitrary-host',
      'ipv6-wildcard',
      'repo-migration',
      'repo-migration-distinct-runtime',
      'repo-migration-distinct-runtime-cwd-mismatch',
      'repo-migration-distinct-runtime-missing',
      'repo-migration-distinct-runtime-symlink',
      'repo-migration-other-drift',
      'repo-migration-canonical-loaded',
      'repo-migration-missing-legacy',
      'repo-migration-wrong-target',
      'repo-migration-lookalike-origin',
      'repo-migration-dirty',
      'repo-migration-detached',
      'repo-migration-stale',
      'repo-migration-post-discovery-failure',
      'billing-policy',
      'stale-state-success',
      'stale-state-precutover-failure',
      'stale-root',
      'stale-root-rollback',
      'stale-root-identity',
      'stale-root-trailing-identity',
      'stale-root-nonloopback',
      'stale-root-no-legacy',
    ] as const;

    macosInstallerTest.each(
      cutoverModes.filter((_mode, index) => index % 3 === cutoverShardIndex),
    )(
      'executes controlled legacy cutover with exact A rollback proof (%s)',
      async (mode) => {
        const root = fixtureRoot();
        const repoRoot = path.resolve(import.meta.dirname, '../../..');
        const home = path.join(root, 'home');
        const support = path.join(root, 'support');
        const logs = path.join(root, 'logs');
        const fakeBin = path.join(root, 'fake-bin');
        const legacy = path.join(root, 'legacy-worktree');
        const distinctRuntime = mode.startsWith(
          'repo-migration-distinct-runtime',
        );
        const legacyRuntimeTarget = distinctRuntime
          ? path.join(root, 'immutable-legacy-runtime')
          : legacy;
        const legacyRuntime =
          mode === 'repo-migration-distinct-runtime-symlink'
            ? path.join(root, 'legacy-runtime-link')
            : legacyRuntimeTarget;
        const legacyPlist = path.join(root, 'legacy.plist');
        const legacyRunner = path.join(root, 'update-station-dogfood.zsh');
        const wrongRunner = path.join(root, 'wrong-update-station-dogfood.zsh');
        const wrongWorktree = path.join(root, 'wrong-worktree');
        const oldRepo = path.join(root, 'old-repo');
        const launchState = path.join(root, 'launch-state');
        const runtimeSha = path.join(root, 'runtime-sha');
        const harnessLog = path.join(root, 'harness.log');
        const serveSwitched = path.join(root, 'serve-switched');
        const serveConfig = path.join(root, 'serve-config.json');
        const realNode = process.execPath;
        const legacyHost =
          mode === 'wildcard'
            ? '0.0.0.0'
            : mode === 'arbitrary-host'
              ? '192.0.2.10'
              : mode === 'ipv6-wildcard'
                ? '::'
                : '127.0.0.1';
        mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
        mkdirSync(path.join(home, 'Library', 'LaunchAgents'), {
          recursive: true,
          mode: 0o700,
        });
        mkdirSync(path.join(legacy, '.station', 'instances'), {
          recursive: true,
        });
        mkdirSync(path.join(legacyRuntimeTarget, '.station', 'instances'), {
          recursive: true,
        });
        mkdirSync(path.join(wrongWorktree, '.station', 'instances'), {
          recursive: true,
        });
        mkdirSync(oldRepo, { recursive: true });
        const repoMigration = mode.startsWith('repo-migration');
        const migrationTarget = repoMigration ? realpathSync(legacy) : legacy;
        const existingRepo = realpathSync(oldRepo);
        if (repoMigration) {
          mkdirSync(path.join(legacy, 'ops', 'dogfood'), { recursive: true });
          mkdirSync(path.join(legacy, 'scripts'), { recursive: true });
          for (const relative of [
            'ops/dogfood/io.kontourai.station-dogfood.plist.template',
            'scripts/station-dogfood-health.mjs',
            'scripts/station-dogfood-launch-path.mjs',
            'scripts/station-dogfood-reconcile.mjs',
          ]) {
            copyFileSync(
              path.join(repoRoot, relative),
              path.join(legacy, relative),
            );
          }
          mkdirSync(support, { recursive: true });
          writeFileSync(
            path.join(support, 'config.json'),
            `${JSON.stringify(
              {
                version: 1,
                repo: existingRepo,
                githubRepo: 'kontourai/station',
                instance: 'dogfood',
                stationHome: path.join(root, 'station-home'),
                supportDir: support,
                logDir: logs,
                serverPort:
                  mode === 'repo-migration-other-drift' ? 39002 : 39001,
                uiPort: 39010,
                tailnetUrl: 'https://station.test.ts',
              },
              null,
              2,
            )}\n`,
            { mode: 0o600 },
          );
        }
        writeFileSync(legacyRunner, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        writeFileSync(wrongRunner, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        writeFileSync(
          path.join(legacy, '.station', 'instances', 'dogfood.json'),
          JSON.stringify({
            instanceId: 'dogfood',
            host: legacyHost,
            serverPort: 39001,
            uiPort: 39010,
            serverPid: process.pid,
            bootId: '11111111-1111-4111-8111-111111111111',
            build: { sha: PREVIOUS },
            cwd: realpathSync(legacy),
          }),
        );
        if (distinctRuntime) {
          const runtimeState = JSON.parse(
            readFileSync(
              path.join(legacy, '.station', 'instances', 'dogfood.json'),
              'utf8',
            ),
          );
          runtimeState.cwd =
            mode === 'repo-migration-distinct-runtime-cwd-mismatch'
              ? realpathSync(legacy)
              : realpathSync(legacyRuntimeTarget);
          writeFileSync(
            path.join(
              legacyRuntimeTarget,
              '.station',
              'instances',
              'dogfood.json',
            ),
            JSON.stringify(runtimeState),
          );
          if (mode === 'repo-migration-distinct-runtime-symlink') {
            symlinkSync(legacyRuntimeTarget, legacyRuntime);
          }
          if (mode === 'repo-migration-distinct-runtime-missing') {
            rmSync(legacyRuntimeTarget, { recursive: true, force: true });
          }
        }
        writeFileSync(
          legacyPlist,
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<!-- decoy legacy.station-updater ${legacyRunner} ${legacy} -->
<key>Label</key><string>${mode === 'ownership' || mode === 'decoy' ? 'wrong.station-updater' : 'legacy.station-updater'}</string>
<key>ProgramArguments</key><array><string>${mode === 'arguments' ? wrongRunner : legacyRunner}</string></array>
<key>EnvironmentVariables</key><dict><key>DECOY_LABEL</key><string>legacy.station-updater</string><key>DECOY_RUNNER</key><string>${legacyRunner}</string><key>DECOY_WORKTREE</key><string>${legacy}</string></dict>
</dict></plist>`,
        );
        writeFileSync(
          path.join(wrongWorktree, '.station', 'instances', 'dogfood.json'),
          JSON.stringify({
            instanceId: 'dogfood',
            host: '127.0.0.1',
            serverPort: mode === 'repo-migration-wrong-target' ? 39001 : 39999,
            uiPort: 39010,
            serverPid: process.pid,
            bootId: '11111111-1111-4111-8111-111111111111',
            build: { sha: PREVIOUS },
            cwd: realpathSync(wrongWorktree),
          }),
        );
        writeFileSync(
          launchState,
          `legacy=loaded\ncanonical=${mode === 'repo-migration-canonical-loaded' ? 'loaded' : 'unloaded'}\n`,
        );
        writeFileSync(runtimeSha, PREVIOUS);
        const staleStateBytes = `${JSON.stringify({
          version: 1,
          active: {
            sha: OLDER,
            path: path.join(support, 'releases', OLDER),
          },
          previous: null,
          failedCandidates: [{ sha: OLDER, reason: 'historic failure' }],
          recoveryHistory: [],
        })}\n`;
        if (mode.startsWith('stale-state')) {
          mkdirSync(support, { recursive: true, mode: 0o700 });
          writeFileSync(path.join(support, 'state.json'), staleStateBytes, {
            mode: 0o600,
          });
        }
        const stub = (name: string, source: string) =>
          writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${source}\n`, {
            mode: 0o700,
          });
        stub(
          'node',
          `
if [ "$1" = -e ] && printf '%s' "$2" | grep -q 'net.createConnection'; then exit 0; fi
if [ "$HARNESS_MODE" = repo-migration-post-discovery-failure ] && [ "$1" = -e ] && printf '%s' "$2" | grep -q 'Tailscale Self'; then exit 47; fi
case "$1" in
  *station-dogfood-health.mjs)
    state=""
    for arg in "$@"; do case "$arg" in --instance-state=*) state="\${arg#--instance-state=}";; esac; done
    host="$("$REAL_NODE" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).host' "$state")"
    if [ "$HARNESS_MODE" = rollback-fallback ] && [ -f "$SUPPORT_TEST/rollback-started" ] && [ "$state" = "$LEGACY_TEST/.station/instances/dogfood.json" ]; then exit 27; fi
    case " $* " in *' --allow-wildcard-host '*) opted_in=1;; *) opted_in=0;; esac
    if [ "$host" = 0.0.0.0 ] && [ "$opted_in" != 1 ]; then exit 23; fi
    if [ "$host" != 0.0.0.0 ] && [ "$opted_in" = 1 ]; then exit 24; fi
    sha="$(cat "$RUNTIME_SHA")"
    printf '{"healthy":true,"identity":{"instanceId":"dogfood","sha":"%s","bootId":"11111111-1111-4111-8111-111111111111"},"failedChecks":[]}\n' "$sha"
    exit 0;;
  *station-dogfood-reconcile.mjs)
    command="$2"
    case "$command" in
      validate-config) printf '{"ok":true}\n'; exit 0;;
      reconcile)
        case " $* " in
          *' --stage-only '*)
            if printf '%s' "$HARNESS_MODE" | grep -q '^stale-state'; then
              "$REAL_NODE" -e '
                const state=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
                if(state.active?.runtimePath!==process.argv[2]) process.exit(41);
              ' "$SUPPORT_TEST/state.json" "$LEGACY_TEST" || exit $?
            fi
            printf 'stage-a-serving\n' >> "$HARNESS_LOG"
            mkdir -p "$SUPPORT_TEST/releases/${CANDIDATE}/dist-server-dogfood"
            printf '{"sha":"${CANDIDATE}"}\n' > "$SUPPORT_TEST/releases/${CANDIDATE}/dist-server-dogfood/station-build.json"
            printf '{"action":"staged","sha":"${CANDIDATE}","runningSha":"${PREVIOUS}","candidatePath":"%s/releases/${CANDIDATE}","candidateCreated":true}\n' "$SUPPORT_TEST"
            exit 0;;
        esac
        printf 'promote-stop-a-start-b\n' >> "$HARNESS_LOG"
        if [ "$HARNESS_MODE" = rollback ] || [ "$HARNESS_MODE" = rollback-fallback ] || [ "$HARNESS_MODE" = rollback-candidate-removed ] || [ "$HARNESS_MODE" = rollback-candidate-symlink ] || [ "$HARNESS_MODE" = rollback-candidate-sha-mismatch ] || [ "$HARNESS_MODE" = stale-root-rollback ]; then
          [ "$HARNESS_MODE" = rollback-candidate-removed ] && rm -rf "$SUPPORT_TEST/releases/${CANDIDATE}"
          if [ "$HARNESS_MODE" = rollback-candidate-symlink ]; then
            rm -rf "$SUPPORT_TEST/releases/${CANDIDATE}"
            ln -s "$SUPPORT_TEST" "$SUPPORT_TEST/releases/${CANDIDATE}"
          fi
          [ "$HARNESS_MODE" = rollback-candidate-sha-mismatch ] && printf '{"sha":"${OLDER}"}\n' > "$SUPPORT_TEST/releases/${CANDIDATE}/dist-server-dogfood/station-build.json"
          exit 17
        fi
        printf '${CANDIDATE}' > "$RUNTIME_SHA"
        mkdir -p "$SUPPORT_TEST/releases/${CANDIDATE}/.station/instances"
        printf '{"active":{"sha":"${CANDIDATE}","path":"%s/releases/${CANDIDATE}"}}\n' "$SUPPORT_TEST" > "$SUPPORT_TEST/state.json"
        printf '{"action":"promoted","sha":"${CANDIDATE}"}\n'
        exit 0;;
      adopt-legacy)
        if [ "$HARNESS_MODE" = origin ]; then echo 'origin git@github.com:kontourai/station-malware.git does not match configured GitHub repo kontourai/station' >&2; exit 19; fi
        case " $* " in *' --legacy-sha=${PREVIOUS} '*) ;; *) echo 'missing preflight SHA' >&2; exit 43;; esac
        case " $* " in *' --legacy-boot-id=11111111-1111-4111-8111-111111111111 '*) ;; *) echo 'missing preflight boot ID' >&2; exit 44;; esac
        case " $* " in *' --legacy-instance-id=dogfood '*) ;; *) echo 'missing preflight instance ID' >&2; exit 45;; esac
        if [ "$HARNESS_MODE" = repo-migration-distinct-runtime ]; then
          case " $* " in *" --legacy-path=$LEGACY_TEST "*) ;; *) echo 'distinct runtime path was not adopted' >&2; exit 46;; esac
        fi
        if printf '%s' "$HARNESS_MODE" | grep -q '^stale-state'; then
          case " $* " in
            *' --inactive-canonical-state='*' --legacy-label='*' --legacy-plist='*' --legacy-plist-snapshot='*' --legacy-runner='*' --legacy-runner-snapshot='*) ;;
            *) echo 'missing captured legacy launch contract' >&2; exit 42;;
          esac
        fi
        case " $* " in *' --allow-wildcard-host '*) adopt_opt_in=1;; *) adopt_opt_in=0;; esac
        if [ "$HARNESS_MODE" = wildcard ] && [ "$adopt_opt_in" != 1 ]; then exit 25; fi
        if [ "$HARNESS_MODE" != wildcard ] && [ "$adopt_opt_in" = 1 ]; then exit 26; fi
        printf 'adopt-a-with-rollback\n' >> "$HARNESS_LOG"
        mkdir -p "$SUPPORT_TEST/releases/${PREVIOUS}--release-11111111-1111-4111-8111-111111111111/dist-server-dogfood"
        printf '{"sha":"${PREVIOUS}"}\n' > "$SUPPORT_TEST/releases/${PREVIOUS}--release-11111111-1111-4111-8111-111111111111/dist-server-dogfood/station-build.json"
        printf '{"active":{"sha":"${PREVIOUS}","path":"%s/releases/${PREVIOUS}--release-11111111-1111-4111-8111-111111111111","runtimePath":"%s"}}\n' "$SUPPORT_TEST" "$LEGACY_TEST" > "$SUPPORT_TEST/state.json"
        printf '{"action":"adopted","sha":"${PREVIOUS}","rollbackPath":"%s/releases/${PREVIOUS}--release-11111111-1111-4111-8111-111111111111"}\n' "$SUPPORT_TEST"
        exit 0;;
      rollback-install)
        printf 'rollback-to-a\n' >> "$HARNESS_LOG"
        printf '${PREVIOUS}' > "$RUNTIME_SHA"
        rollback="$SUPPORT_TEST/releases/${PREVIOUS}--release-11111111-1111-4111-8111-111111111111"
        mkdir -p "$rollback/.station/instances"
        printf '{"instanceId":"dogfood","host":"127.0.0.1","serverPort":39001,"uiPort":39010,"serverPid":%s,"bootId":"11111111-1111-4111-8111-111111111111","build":{"sha":"${PREVIOUS}"}}' "$$" > "$rollback/.station/instances/dogfood.json"
        : > "$SUPPORT_TEST/rollback-started"
        exit 0;;
      prune) exit 0;;
    esac;;
esac
exec "$REAL_NODE" "$@"`,
        );
        for (const name of ['npm', 'gh', 'ps']) {
          stub(name, 'exit 0');
        }
        stub(
          'curl',
          `case " $* " in
  *' --write-out %{http_code} '*) [ "$HARNESS_MODE" = stale-root-identity ] || [ "$HARNESS_MODE" = stale-root-trailing-identity ] && printf 200 || printf 404;;
esac
exit 0`,
        );
        stub(
          'git',
          `
case " $* " in
  *' worktree remove --force '*) for target in "$@"; do :; done; rm -rf "$target";;
  *' remote get-url origin '*)
    [ "$HARNESS_MODE" = repo-migration-lookalike-origin ] && [ "$2" = "$LEGACY_TEST" ] && printf 'git@github.com:kontourai/station-malware.git\n' || printf 'git@github.com:kontourai/station.git\n';;
  *' status --porcelain '*) [ "$HARNESS_MODE" = repo-migration-dirty ] && printf ' M dirty\n';;
  *' symbolic-ref --short HEAD '*) [ "$HARNESS_MODE" = repo-migration-detached ] && exit 1; printf 'dogfood/main\n';;
  *' rev-parse --abbrev-ref --symbolic-full-name @{upstream} '*) printf 'origin/main\n';;
  *' rev-parse HEAD '*) [ "$HARNESS_MODE" = repo-migration-stale ] && printf '${OLDER}\n' || printf '${CANDIDATE}\n';;
  *' rev-parse origin/main '*) printf '${CANDIDATE}\n';;
esac
exit 0`,
        );
        stub('plutil', 'exec /usr/bin/plutil "$@"');
        stub('sleep', 'exit 0');
        stub(
          'tailscale',
          `
if [ "$1" = status ]; then printf '%s\n' '{"Self":{"DNSName":"station.test.ts."}}'; exit 0; fi
if [ "$1" = serve ] && [ "$2" = status ]; then
  proxy='http://127.0.0.1:39010'
  if [ -f "$SERVE_SWITCHED" ]; then
    proxy="$(cat "$SERVE_SWITCHED")"
  else
    [ "$HARNESS_MODE" = stale-root ] || [ "$HARNESS_MODE" = stale-root-rollback ] || [ "$HARNESS_MODE" = stale-root-identity ] || [ "$HARNESS_MODE" = stale-root-trailing-identity ] || [ "$HARNESS_MODE" = stale-root-no-legacy ] && proxy='http://127.0.0.1:39011'
    [ "$HARNESS_MODE" = stale-root-trailing-identity ] && proxy='http://127.0.0.1:39011/'
    [ "$HARNESS_MODE" = stale-root-nonloopback ] && proxy='http://192.0.2.1:39011'
  fi
  printf '{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true}},"Web":{"station.test.ts:443":{"Handlers":{"/":{"Proxy":"%s"}}},"station.test.ts:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5379"}}}},"AllowFunnel":{"station.test.ts:8443":true}}\n' "$proxy"
  exit 0
fi
if [ "$1" = serve ] && [ "$2" = get-config ]; then [ -f "$SERVE_CONFIG" ] && cat "$SERVE_CONFIG" || printf '%s\n' '{"fixture":"exact","unrelated":{"funnel":false}}'; exit 0; fi
if [ "$1" = serve ] && [ "$2" = set-config ]; then cp "$4" "$SERVE_CONFIG"; rm -f "$SERVE_SWITCHED"; exit 0; fi
if [ "$1" = serve ]; then for target in "$@"; do :; done; case "$target" in http://*) printf '%s' "$target" > "$SERVE_SWITCHED";; esac; exit 0; fi
exit 1`,
        );
        stub(
          'launchctl',
          `
read_state() { sed -n "s/^$1=//p" "$LAUNCH_STATE"; }
write_state() { key="$1" value="$2"; sed "s/^$key=.*/$key=$value/" "$LAUNCH_STATE" > "$LAUNCH_STATE.tmp"; mv "$LAUNCH_STATE.tmp" "$LAUNCH_STATE"; }
if [ "$1" = print ]; then
  case "$2" in
    gui/*/legacy.station-updater) [ "$(read_state legacy)" = loaded ] && { printf 'state = running\nruns = 1\n'; exit 0; }; exit 1;;
    gui/*/io.kontourai.station-dogfood) [ "$(read_state canonical)" = loaded ] && { printf 'state = running\nruns = 1\n'; exit 0; }; exit 1;;
    gui/*) exit 0;;
  esac
fi
if [ "$1" = bootout ]; then
  case "$2" in *legacy.station-updater) printf 'bootout-legacy\n' >> "$HARNESS_LOG"; write_state legacy unloaded;; *io.kontourai.station-dogfood) write_state canonical unloaded;; esac
  exit 0
fi
if [ "$1" = bootstrap ]; then
  case "$3" in *legacy.plist|*legacy-plist) printf 'bootstrap-legacy\n' >> "$HARNESS_LOG"; write_state legacy loaded;; *) write_state canonical loaded;; esac
  exit 0
fi
if [ "$1" = kickstart ]; then exit 0; fi
exit 0`,
        );
        const result = await runInstallerProcess({
          args: [path.join(repoRoot, 'ops/dogfood/install-macos.zsh')],
          timeoutMs: INSTALLER_PROCESS_TIMEOUT_MS,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            HOME: home,
            REAL_NODE: realNode,
            STATION_REPO: repoMigration ? migrationTarget : repoRoot,
            STATION_HOME: path.join(root, 'station-home'),
            STATION_DOGFOOD_SUPPORT: support,
            STATION_DOGFOOD_LOGS: logs,
            STATION_SERVER_PORT: '39001',
            STATION_UI_PORT: '39010',
            STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT:
              mode === 'billing-policy' ? MAX_WAIVER_EXPIRY : undefined,
            STATION_DOGFOOD_INJECT_FAILURE:
              mode === 'stale-state-precutover-failure'
                ? 'after-stage-before-cutover'
                : undefined,
            STATION_DOGFOOD_LEGACY_LABEL:
              mode === 'repo-migration-missing-legacy' ||
              mode === 'stale-root-no-legacy'
                ? undefined
                : 'legacy.station-updater',
            STATION_DOGFOOD_LEGACY_PLIST:
              mode === 'repo-migration-missing-legacy' ||
              mode === 'stale-root-no-legacy'
                ? undefined
                : legacyPlist,
            STATION_DOGFOOD_LEGACY_RUNNER:
              mode === 'repo-migration-missing-legacy' ||
              mode === 'stale-root-no-legacy'
                ? undefined
                : legacyRunner,
            STATION_DOGFOOD_LEGACY_WORKTREE:
              mode === 'repo-migration-missing-legacy' ||
              mode === 'stale-root-no-legacy'
                ? undefined
                : mode === 'worktree' || mode === 'repo-migration-wrong-target'
                  ? wrongWorktree
                  : migrationTarget,
            STATION_DOGFOOD_LEGACY_RUNTIME: distinctRuntime
              ? legacyRuntime
              : undefined,
            SUPPORT_TEST: support,
            LEGACY_TEST:
              mode === 'repo-migration-distinct-runtime'
                ? legacyRuntime
                : migrationTarget,
            RUNTIME_SHA: runtimeSha,
            HARNESS_LOG: harnessLog,
            HARNESS_MODE: mode,
            LAUNCH_STATE: launchState,
            SERVE_SWITCHED: serveSwitched,
            SERVE_CONFIG: serveConfig,
          },
        });
        if (mode === 'repo-migration-post-discovery-failure') {
          expect(result.status).toBe(47);
          expect(result.stdout).not.toContain('Installed');
          expect(existsSync(harnessLog)).toBe(false);
          expect(
            JSON.parse(readFileSync(path.join(support, 'config.json'), 'utf8'))
              .repo,
          ).toBe(existingRepo);
          return;
        }
        if (mode === 'repo-migration-distinct-runtime-cwd-mismatch') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'legacy instance record does not prove the configured runtime ownership',
          );
          expect(existsSync(harnessLog)).toBe(false);
          expect(readFileSync(launchState, 'utf8')).toContain('legacy=loaded');
          return;
        }
        if (mode === 'repo-migration-distinct-runtime-missing') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('ENOENT');
          expect(existsSync(harnessLog)).toBe(false);
          expect(readFileSync(launchState, 'utf8')).toContain('legacy=loaded');
          return;
        }
        if (mode === 'repo-migration-distinct-runtime-symlink') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'legacy runtime must be a real directory',
          );
          expect(existsSync(harnessLog)).toBe(false);
          expect(readFileSync(launchState, 'utf8')).toContain('legacy=loaded');
          return;
        }
        if (mode === 'repo-migration-distinct-runtime') {
          expect(result.status, result.stderr).toBe(0);
        }
        if (mode === 'stale-state-precutover-failure') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'injected failure after adoption and staging before cutover',
          );
          expect(readFileSync(harnessLog, 'utf8').trim().split('\n')).toEqual([
            'adopt-a-with-rollback',
            'stage-a-serving',
          ]);
          expect(readFileSync(path.join(support, 'state.json'), 'utf8')).toBe(
            staleStateBytes,
          );
          expect(readFileSync(runtimeSha, 'utf8')).toBe(PREVIOUS);
          expect(readFileSync(launchState, 'utf8')).toContain('legacy=loaded');
          expect(readdirSync(path.join(support, 'releases'))).toEqual([]);
          return;
        }
        if (
          mode === 'stale-root-identity' ||
          mode === 'stale-root-trailing-identity'
        ) {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'stale-root identity probe returned 200 instead of exact not-found proof',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'stale-root-nonloopback') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'refusing non-loopback Tailscale Serve root proxy',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'stale-root-no-legacy') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'refusing to replace existing Tailscale Serve root handler',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'repo-migration-other-drift') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('differs beyond repo');
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (
          mode === 'repo-migration-canonical-loaded' ||
          mode === 'repo-migration-missing-legacy'
        ) {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('repo-only migration requires');
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'repo-migration-wrong-target') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'target must exactly equal the explicit legacy worktree',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'repo-migration-lookalike-origin') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'origin is not exactly kontourai/station',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'repo-migration-dirty') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('target must be clean');
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'repo-migration-detached') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain('Command failed');
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'repo-migration-stale') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'must equal the intended origin/main',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'ownership') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'legacy plist Label does not exactly match explicit legacy label',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'decoy') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'legacy plist Label does not exactly match explicit legacy label',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'arguments') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'legacy plist ProgramArguments do not exactly match the verified legacy runner contract',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'worktree') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'legacy instance record does not prove the configured runtime ownership',
          );
          expect(existsSync(harnessLog)).toBe(false);
          return;
        }
        if (mode === 'arbitrary-host' || mode === 'ipv6-wildcard') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'legacy instance record does not prove the configured runtime ownership',
          );
          expect(existsSync(harnessLog)).toBe(false);
          expect(readFileSync(launchState, 'utf8')).toContain('legacy=loaded');
          return;
        }
        if (mode === 'origin') {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            'station-malware.git does not match configured GitHub repo kontourai/station',
          );
          expect(existsSync(harnessLog)).toBe(false);
          expect(readFileSync(launchState, 'utf8')).toContain('legacy=loaded');
          return;
        }
        if (mode === 'billing-policy') {
          // The installer is a standalone zsh script and cannot import the
          // reconciler's constant, so the two policy authorities are pinned to
          // each other here. Without this, one could be revised alone and the
          // era branches below would still pass against a divergent installer.
          expect(
            readFileSync(
              path.join(repoRoot, 'ops/dogfood/install-macos.zsh'),
              'utf8',
            ),
          ).toContain(`Date.parse("${BILLING_WAIVER_MAX_EXPIRY_ISO}")`);

          // This case feeds the strongest input the policy accepts — an expiry
          // exactly at the maximum — and asserts whichever contract the wall
          // clock makes true. See `billingWaiverEra` for why the switch exists.
          if (billingWaiverEra() === 'sunset') {
            // Past the maximum an expiry cannot be both in the future and no
            // later than the maximum, so the waiver is ungrantable by design
            // (#347: "August runs remain blocked") and the installer must fail
            // closed in preflight, before it touches the legacy runtime.
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(
              `billing waiver expiry must be an exact future ISO timestamp no later than ${BILLING_WAIVER_MAX_EXPIRY_ISO}`,
            );
            expect(result.stderr).toContain(
              'invalid STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT',
            );
            expect(existsSync(harnessLog)).toBe(false);
            expect(readFileSync(launchState, 'utf8')).toContain(
              'legacy=loaded',
            );
            return;
          }

          // Grantable era: the waiver is accepted, the full cutover runs, and
          // the normalized expiry is substituted into the LaunchAgent plist and
          // re-verified by the installer's own rendered-policy self-check
          // (install-macos.zsh:613-640). This coverage is era-bound: it is the
          // only end-to-end exercise of the plist waiver-rendering path, and it
          // is reachable only while the clock is before the maximum — #1432 had
          // to delete it when the original sunset passed, and it is restored
          // here by the #1443 re-sunset.
          expect(result.status, result.stderr).toBe(0);
          expect(
            readFileSync(harnessLog, 'utf8').trim().split('\n').slice(0, 4),
          ).toEqual([
            'adopt-a-with-rollback',
            'stage-a-serving',
            'bootout-legacy',
            'promote-stop-a-start-b',
          ]);
          expect(
            readFileSync(
              path.join(
                home,
                'Library',
                'LaunchAgents',
                'io.kontourai.station-dogfood.plist',
              ),
              'utf8',
            ),
          ).toContain(`<string>${MAX_WAIVER_EXPIRY}</string>`);
          expect(readFileSync(runtimeSha, 'utf8')).toBe(CANDIDATE);
          return;
        }
        const events = readFileSync(harnessLog, 'utf8').trim().split('\n');
        expect(events.slice(0, 4)).toEqual([
          'adopt-a-with-rollback',
          'stage-a-serving',
          'bootout-legacy',
          'promote-stop-a-start-b',
        ]);
        if (
          mode === 'rollback-candidate-symlink' ||
          mode === 'rollback-candidate-sha-mismatch'
        ) {
          expect(result.status).not.toBe(0);
          expect(events).toContain('rollback-to-a');
          expect(events).not.toContain('bootstrap-legacy');
          expect(readFileSync(runtimeSha, 'utf8')).toBe(PREVIOUS);
          expect(readFileSync(launchState, 'utf8')).toContain(
            'legacy=unloaded',
          );
          expect(result.stderr).toContain('CRITICAL');
          expect(result.stderr).toContain('rollback evidence retained');
          if (mode === 'rollback-candidate-symlink') {
            expect(result.stderr).toContain(
              'transaction release must be a real owned directory',
            );
            expect(
              lstatSync(
                path.join(support, 'releases', CANDIDATE),
              ).isSymbolicLink(),
            ).toBe(true);
          } else {
            expect(result.stderr).toContain(
              'transaction release manifest SHA mismatch',
            );
            expect(existsSync(path.join(support, 'releases', CANDIDATE))).toBe(
              true,
            );
          }
          return;
        }
        if (
          mode === 'success' ||
          mode === 'wildcard' ||
          mode === 'repo-migration' ||
          mode === 'repo-migration-distinct-runtime' ||
          mode === 'stale-state-success' ||
          mode === 'stale-root'
        ) {
          expect(result.status, result.stderr).toBe(0);
          if (
            mode === 'repo-migration' ||
            mode === 'repo-migration-distinct-runtime'
          ) {
            expect(
              JSON.parse(
                readFileSync(path.join(support, 'config.json'), 'utf8'),
              ).repo,
            ).toBe(migrationTarget);
          }
          expect(readFileSync(runtimeSha, 'utf8')).toBe(CANDIDATE);
          expect(
            readFileSync(
              path.join(repoRoot, 'scripts/station-dogfood-reconcile.mjs'),
              'utf8',
            ),
          ).toContain("'--host=127.0.0.1'");
        } else {
          expect(result.status).not.toBe(0);
          expect(events).toContain('rollback-to-a');
          expect(events).toContain('bootstrap-legacy');
          expect(readFileSync(runtimeSha, 'utf8')).toBe(PREVIOUS);
          expect(readFileSync(launchState, 'utf8')).toContain('legacy=loaded');
          expect(result.stderr).not.toContain('CRITICAL');
          if (mode === 'rollback-fallback') {
            expect(
              existsSync(
                path.join(
                  support,
                  'releases',
                  `${PREVIOUS}--release-11111111-1111-4111-8111-111111111111`,
                ),
              ),
            ).toBe(true);
          }
          if (mode === 'stale-root-rollback') {
            expect(existsSync(serveSwitched)).toBe(false);
            expect(readFileSync(serveConfig, 'utf8')).toBe(
              '{"fixture":"exact","unrelated":{"funnel":false}}\n',
            );
          }
        }
      },
      INSTALLER_TEST_TIMEOUT_MS,
    );
  });
}
