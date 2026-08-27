import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateSupervisorConfig } from '../../station-dogfood-reconcile.mjs';
import {
  CANDIDATE,
  createFixture,
  fixtureRoot,
  macosInstallerTest,
} from './fixture.js';
import { runInstallerProcess } from './installer-process.js';

const INSTALLER_ROLLBACK_TIMEOUT_GUARD_MS = 30_000;
const INSTALLER_ROLLBACK_TEST_TIMEOUT_MS =
  INSTALLER_ROLLBACK_TIMEOUT_GUARD_MS + 5_000;

export function registerInstallerStaticAndLaunchdRollback() {
  describe('station dogfood reconcile', () => {
    it('rejects insecure or symlinked supervisor directories', () => {
      const fixture = createFixture({ active: false });
      mkdirSync(fixture.config.supportDir, { recursive: true });
      chmodSync(fixture.config.supportDir, 0o755);
      expect(() => validateSupervisorConfig(fixture.config)).toThrow(
        'permissions must be 0700',
      );

      const realLogs = path.join(
        path.dirname(fixture.config.logDir),
        'real-logs',
      );
      mkdirSync(realLogs, { mode: 0o700 });
      symlinkSync(realLogs, fixture.config.logDir);
      chmodSync(fixture.config.supportDir, 0o700);
      expect(() => validateSupervisorConfig(fixture.config)).toThrow(
        'must be a real directory, not a symlink',
      );
    });

    it('keeps installer capability checks before host mutations and injects deterministic PATH', () => {
      const repoRoot = path.resolve(import.meta.dirname, '../../..');
      const installer = readFileSync(
        path.join(repoRoot, 'ops/dogfood/install-macos.zsh'),
        'utf8',
      );
      const plist = readFileSync(
        path.join(
          repoRoot,
          'ops/dogfood/io.kontourai.station-dogfood.plist.template',
        ),
        'utf8',
      );
      for (const command of [
        'node',
        'npm',
        'git',
        'gh',
        'curl',
        'tailscale',
        'launchctl',
        'plutil',
        'sleep',
      ]) {
        expect(installer).toContain(`resolve_executable ${command}`);
      }
      expect(installer).toContain('NODE_MAJOR == 24');
      expect(installer).toContain('run list --repo kontourai/station');
      expect(installer).toContain('validate-config --config="$TEMP_CONFIG"');
      expect(installer.indexOf('serve status --json')).toBeLessThan(
        installer.indexOf('serve --bg --https=443'),
      );
      expect(installer).toContain('changed an unrelated handler');
      expect(installer).toContain('serve get-config --all >"$SERVE_SNAPSHOT"');
      expect(installer).toContain('serve set-config --all "$SERVE_SNAPSHOT"');
      expect(installer).not.toContain('serve --https=443 --set-path=/ off');
      expect(installer).toContain(
        'restored classic Tailscale Serve status differs from the captured snapshot',
      );
      expect(installer.indexOf('SERVE_MUTATED=1')).toBeLessThan(
        installer.lastIndexOf('serve --bg --https=443'),
      );
      expect(installer).toContain('reconcile --defer-prune --config="$CONFIG"');
      expect(installer).toContain(
        'reconcile --stage-only --defer-prune --config="$CONFIG"',
      );
      expect(installer).not.toContain('/api/system/status');
      expect(installer).toContain(
        '--instance-state="$ACTIVE_PATH/.station/instances/$INSTANCE.json"',
      );
      expect(installer).toContain('"$PLUTIL" -convert json -o -');
      expect(installer).toContain(
        'legacy plist ProgramArguments do not exactly match the verified legacy runner contract',
      );
      expect(installer).toContain(
        'legacy instance record does not prove the configured runtime ownership',
      );
      expect(installer).toContain('STATION_DOGFOOD_LEGACY_RUNTIME');
      expect(installer).toContain(':-$LEGACY_WORKTREE');
      expect(installer).toContain('runtime.uid!==process.getuid()');
      expect(installer).toContain('cwd!==runtime');
      expect(installer).toContain('--legacy-path="$LEGACY_RUNTIME"');
      expect(installer).toContain(
        'legacy instance is not an exact healthy managed runtime',
      );
      expect(installer).toContain('RECONCILE_ATTEMPTED=1');
      expect(installer).toContain('rollback-install --config="$CONFIG"');
      expect(installer).toContain('snapshot_file "$RUNNER"');
      expect(installer).toContain('snapshot_file "$CONFIG"');
      expect(installer).toContain('snapshot_file "$SUPPORT_DIR/state.json"');
      expect(installer).toContain(
        'snapshot_directory "$CLIENT_SHIM_DIR" "$CLIENT_SHIM_SNAPSHOT"',
      );
      expect(installer).toContain(
        'restore_directory "$CLIENT_SHIM_SNAPSHOT" "$CLIENT_SHIM_DIR"',
      );
      expect(installer).toContain(
        '--materialize=1 --input="$CLIENT_DISCOVERY" --shim="$CLIENT_SHIM_DIR" --root="$SUPPORT_DIR/bin"',
      );
      expect(installer).toContain(
        'LAUNCH_PATH="$CLIENT_SHIM_DIR:$OPERATIONAL_LAUNCH_PATH"',
      );
      expect(installer).toContain(
        'mkdir -m 0700 -p "$SUPPORT_DIR/bin" "$LOG_DIR"',
      );
      expect(installer).toContain('existing dogfood config differs');
      expect(installer).toContain('error.code === "ECONNREFUSED"');
      expect(installer).toContain('server + 1, server + 2');
      const deferred = installer.indexOf('reconcile --defer-prune');
      const staged = installer.indexOf('reconcile --stage-only');
      const adopted = installer.indexOf('adopt-legacy --config="$CONFIG"');
      const legacyBootout = installer.indexOf(
        'bootout "gui/$UID/$LEGACY_LABEL"',
      );
      const bootstrap = installer.lastIndexOf('bootstrap "gui/$UID"');
      const kickstart = installer.lastIndexOf('kickstart "gui/$UID/$LABEL"');
      const launchdVerified = installer.lastIndexOf(
        'launchd did not keep the managed supervisor running',
      );
      const committed = installer.lastIndexOf('RECONCILE_ATTEMPTED=0');
      const prune = installer.lastIndexOf('prune --config="$CONFIG"');
      expect(deferred).toBeGreaterThanOrEqual(0);
      expect(staged).toBeGreaterThanOrEqual(0);
      expect(adopted).toBeGreaterThanOrEqual(0);
      expect(adopted).toBeLessThan(staged);
      expect(staged).toBeLessThan(legacyBootout);
      expect(deferred).toBeLessThan(bootstrap);
      expect(bootstrap).toBeLessThan(kickstart);
      expect(kickstart).toBeLessThan(launchdVerified);
      expect(launchdVerified).toBeLessThan(committed);
      expect(committed).toBeLessThan(prune);
      expect(installer).toContain(
        'restore_file "$STATE_SNAPSHOT" "$SUPPORT_DIR/state.json"',
      );
      expect(installer).toContain('serve set-config --all "$SERVE_SNAPSHOT"');
      expect(installer).toContain('restore_file "$PLIST_SNAPSHOT" "$PLIST"');
      expect(plist).toContain('<string>__PATH__</string>');
      expect(plist).toContain('<integer>63</integer>');
      expect(plist).toContain('<string>supervise</string>');
      expect(plist).toContain('<key>KeepAlive</key>');
      expect(plist).toContain('<key>ExitTimeOut</key>');
      expect(plist).not.toContain('<key>StartInterval</key>');
    });

    macosInstallerTest.each([
      'delayed',
      'bootout-error',
      'never-unloads',
    ] as const)(
      'executes the installer rollback transaction for %s launchd convergence',
      async (launchMode) => {
        const root = fixtureRoot();
        const repoRoot = path.resolve(import.meta.dirname, '../../..');
        const home = path.join(root, 'home');
        const support = path.join(root, 'support');
        const logs = path.join(root, 'logs');
        const fakeBin = path.join(root, 'fake-bin');
        const launchAgents = path.join(home, 'Library', 'LaunchAgents');
        const plist = path.join(
          launchAgents,
          'io.kontourai.station-dogfood.plist',
        );
        const oldPlist = path.join(root, 'old.plist');
        const shim = path.join(support, 'bin', 'clients');
        const oldTarget = path.join(root, 'old-codex');
        const launchState = path.join(root, 'launch-state');
        const serveState = path.join(root, 'serve-state');
        const launchLog = path.join(root, 'launch.log');
        mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
        mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
        mkdirSync(shim, { recursive: true, mode: 0o700 });
        writeFileSync(oldTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        symlinkSync(oldTarget, path.join(shim, 'codex'));
        writeFileSync(
          plist,
          '<plist><key>PATH</key><string>OLD_PATH</string></plist>\n',
          {
            mode: 0o600,
          },
        );
        copyFileSync(plist, oldPlist);
        writeFileSync(launchState, 'loaded');

        const stub = (name: string, source: string) =>
          writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${source}\n`, {
            mode: 0o700,
          });
        for (const name of ['npm', 'gh', 'curl', 'ps']) {
          stub(name, 'exit 0');
        }
        stub(
          'git',
          `case " $* " in *' worktree remove --force '*) for target in "$@"; do :; done; rm -rf "$target";; esac
exit 0`,
        );
        const realNode = process.execPath;
        stub(
          'node',
          `case "$1" in
  *station-dogfood-reconcile.mjs)
    case "$2" in
      validate-config) printf '{"ok":true}\n'; exit 0;;
      reconcile)
        case " $* " in *' --stage-only '*)
          candidate="$SUPPORT_TEST/releases/${CANDIDATE}"
          mkdir -p "$candidate/dist-server-dogfood"
          printf '{"sha":"${CANDIDATE}"}\n' > "$candidate/dist-server-dogfood/station-build.json"
          printf '{"action":"staged","sha":"${CANDIDATE}","candidatePath":"%s","candidateCreated":true}\n' "$candidate"
          exit 0;;
        esac;;
    esac;;
esac
exec "$REAL_NODE" "$@"`,
        );
        stub('plutil', 'exit 0');
        stub(
          'tailscale',
          `
if [ "$1" = status ]; then printf '%s\\n' '{"Self":{"DNSName":"station.test.ts."}}'; exit 0; fi
if [ "$1" = serve ] && [ "$2" = status ]; then
  if [ -f "$SERVE_STATE" ]; then printf '%s\\n' '{"Web":{"station.test.ts:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:39010"}}}}}'; else printf '%s\\n' '{}'; fi
  exit 0
fi
if [ "$1" = serve ] && [ "$2" = get-config ]; then [ "$3" = --all ] && printf '%s\\n' '{}'; exit 0; fi
if [ "$1" = serve ] && [ "$2" = set-config ]; then rm -f "$SERVE_STATE"; exit 0; fi
if [ "$1" = serve ] && [ "$2" = --bg ]; then : > "$SERVE_STATE"; exit 0; fi
if [ "$1" = serve ]; then rm -f "$SERVE_STATE"; exit 0; fi
exit 1`,
        );
        stub(
          'launchctl',
          `
if [ "$1" = print ]; then
  case "$2" in */io.kontourai.station-dogfood)
    state="$(cat "$LAUNCH_STATE" 2>/dev/null)"
    case "$state" in pending:*) count="\${state#pending:}"; if [ "$count" -le 1 ]; then printf unloaded > "$LAUNCH_STATE"; exit 1; fi; printf 'pending:%s' "$((count-1))" > "$LAUNCH_STATE";; esac
    [ "$state" = loaded ] || [ "\${state#pending:}" != "$state" ] && { printf 'state = running\\nruns = 1\\n'; exit 0; }
    exit 1;; esac
  exit 0
fi
if [ "$1" = bootout ]; then
  printf 'bootout\\n' >> "$LAUNCH_LOG"
  [ "$LAUNCH_MODE" = bootout-error ] && exit 9
  [ "$LAUNCH_MODE" = never-unloads ] && exit 0
  printf 'pending:3' > "$LAUNCH_STATE"; exit 0
fi
if [ "$1" = bootstrap ]; then
  if cmp -s "$PLIST_CHECK" "$OLD_PLIST" && [ "$(readlink "$SHIM_CHECK/codex")" = "$OLD_TARGET" ]; then printf 'bootstrap-restored\\n' >> "$LAUNCH_LOG"; else printf 'bootstrap-corrupt\\n' >> "$LAUNCH_LOG"; fi
  printf loaded > "$LAUNCH_STATE"; exit 0
fi
exit 0`,
        );

        const started = performance.now();
        const result = await runInstallerProcess({
          args: [path.join(repoRoot, 'ops/dogfood/install-macos.zsh')],
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            HOME: home,
            REAL_NODE: realNode,
            SUPPORT_TEST: support,
            STATION_REPO: repoRoot,
            STATION_HOME: path.join(root, 'station-home'),
            STATION_DOGFOOD_SUPPORT: support,
            STATION_DOGFOOD_LOGS: logs,
            STATION_SERVER_PORT: '39001',
            STATION_UI_PORT: '39010',
            STATION_DOGFOOD_INJECT_FAILURE: 'after-shim-plist',
            SERVE_STATE: serveState,
            LAUNCH_STATE: launchState,
            LAUNCH_LOG: launchLog,
            PLIST_CHECK: plist,
            OLD_PLIST: oldPlist,
            SHIM_CHECK: shim,
            OLD_TARGET: oldTarget,
            LAUNCH_MODE: launchMode,
            STATION_DOGFOOD_LAUNCHD_WAIT_ATTEMPTS: '4',
            STATION_DOGFOOD_LAUNCHD_WAIT_INTERVAL: '0.01',
          },
          timeoutMs: INSTALLER_ROLLBACK_TIMEOUT_GUARD_MS,
        });
        const elapsed = performance.now() - started;
        expect(typeof result.stderr).toBe('string');
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'injected failure after shim and plist replacement',
        );
        expect(result.stderr).not.toContain('CRITICAL');
        // This harness launches several real zsh/node processes. Keep the
        // assertion finite while allowing scheduler contention from the 500+
        // file static suite and the real zsh/node process launches below.
        expect(elapsed).toBeLessThan(INSTALLER_ROLLBACK_TIMEOUT_GUARD_MS);
        expect(readFileSync(plist, 'utf8')).toBe(
          readFileSync(oldPlist, 'utf8'),
        );
        expect(realpathSync(path.join(shim, 'codex'))).toBe(
          realpathSync(oldTarget),
        );
        expect(statSync(shim).mode & 0o777).toBe(0o700);
        if (launchMode !== 'delayed') {
          expect(existsSync(path.join(support, 'config.json'))).toBe(false);
          expect(existsSync(path.join(support, 'state.json'))).toBe(false);
          expect(
            existsSync(
              path.join(support, 'bin', 'station-dogfood-reconcile.mjs'),
            ),
          ).toBe(false);
          expect(
            existsSync(path.join(support, 'bin', 'station-dogfood-health.mjs')),
          ).toBe(false);
        }
        expect(existsSync(launchLog)).toBe(false);
      },
      INSTALLER_ROLLBACK_TEST_TIMEOUT_MS,
    );
  });
}
