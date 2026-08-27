/**
 * The "Test connection" probe (audit CI-R1/CI-R14).
 *
 * CI-R14's defect was a failure line that named neither the cause nor a next
 * step ("Retry the connection or inspect local SSH forwarding policy."), so
 * every assertion here is about the SENTENCE: a real OpenSSH diagnostic in,
 * a named cause and one actionable next step out.
 */

import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { OPENSSH_CONFIG_RESOLVE_TIMEOUT_MS } from '../openssh-config.js';
import {
  buildSshReachabilityArgs,
  classifySshReachabilityFailure,
  planProcessTreeKill,
  probeSshReachability,
  redactSshDiagnostic,
  SSH_CONFIG_RESOLVE_MAX_SECONDS,
  SSH_HOST_KEY_SCAN_MAX_SECONDS,
  SSH_PROBE_ATTEMPT_MAX_SECONDS,
  SSH_PROBE_MAX_SECONDS,
} from '../openssh-reachability.js';

/** Mirrors `MAX_DETAIL_LENGTH` in the module under test. */
const MAX_DETAIL = 400;

const RESOLVED = [
  'host media-server.local',
  'user dev',
  'port 22',
  'hostname media-server.local',
  'stricthostkeychecking ask',
].join('\n');

function runner(output = RESOLVED) {
  return vi.fn(async () => ({ stdout: output, stderr: '', exitCode: 0 }));
}

function attempt(result: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  spawnFailed?: boolean;
}) {
  return vi.fn(async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode,
    spawnFailed: result.spawnFailed ?? false,
  }));
}

describe('classifySshReachabilityFailure', () => {
  test('a refused connection names the port and asks whether sshd is running', () => {
    const failure = classifySshReachabilityFailure({
      host: '127.0.0.2',
      port: 22,
      stderr: 'ssh: connect to host 127.0.0.2 port 22: Connection refused',
      exitCode: 255,
      spawnFailed: false,
    });
    expect(failure.code).toBe('connection-refused');
    expect(failure.summary).toBe(
      'Connection refused on port 22 — is sshd running on 127.0.0.2?',
    );
    expect(failure.action).toContain('Start the SSH server on 127.0.0.2');
  });

  test('an unresolvable host says so and points at the SSH config', () => {
    const failure = classifySshReachabilityFailure({
      host: 'nope.invalid',
      port: 22,
      stderr:
        'ssh: Could not resolve hostname nope.invalid: nodename nor servname provided',
      exitCode: 255,
      spawnFailed: false,
    });
    expect(failure.code).toBe('host-unknown');
    expect(failure.summary).toContain('No computer named nope.invalid');
    expect(failure.action).toContain('~/.ssh/config');
  });

  test('a refused key names ssh-copy-id, not a generic retry', () => {
    const failure = classifySshReachabilityFailure({
      host: 'box-b',
      port: 22,
      stderr: 'dev@box-b: Permission denied (publickey).',
      exitCode: 255,
      spawnFailed: false,
    });
    expect(failure.code).toBe('auth-rejected');
    expect(failure.action).toContain('ssh-copy-id box-b');
  });

  test('an unconfirmed host key asks for the one-off terminal confirmation', () => {
    const failure = classifySshReachabilityFailure({
      host: 'box-b',
      port: 22,
      stderr: 'Host key verification failed.',
      exitCode: 255,
      spawnFailed: false,
    });
    expect(failure.code).toBe('host-key');
    expect(failure.action).toContain('ssh box-b');
  });

  test('a changed host key never suggests blindly trusting it', () => {
    const failure = classifySshReachabilityFailure({
      host: 'box-b',
      port: 22,
      stderr: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
      exitCode: 255,
      spawnFailed: false,
    });
    expect(failure.code).toBe('host-key');
    expect(failure.action).toContain('ssh-keygen -R box-b');
  });

  test('a missing ssh client blames the local computer, not the remote one', () => {
    const failure = classifySshReachabilityFailure({
      host: 'box-b',
      port: 22,
      stderr: '',
      exitCode: 1,
      spawnFailed: true,
    });
    expect(failure.code).toBe('ssh-not-found');
    expect(failure.action).toContain('OpenSSH client');
  });

  test('an unrecognised diagnostic still carries OpenSSH’s own words and a way forward', () => {
    const failure = classifySshReachabilityFailure({
      host: 'box-b',
      port: 22,
      stderr: 'ssh: something nobody has classified yet',
      exitCode: 255,
      spawnFailed: false,
    });
    expect(failure.code).toBe('unknown');
    expect(failure.action).toContain('something nobody has classified yet');
  });
});

describe('buildSshReachabilityArgs', () => {
  test('explicitly verifies against the operator known_hosts file and never accepts or writes a host key', () => {
    const args = buildSshReachabilityArgs('media-server');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('UpdateHostKeys=no');
    expect(args.some((value) => value.startsWith('UserKnownHostsFile='))).toBe(
      true,
    );
    expect(args.slice(-4)).toEqual([
      'media-server',
      'sh',
      '-c',
      "printf '%s\\n' __station_ssh_reachable__; exec node --version",
    ]);
  });

  test('refuses a host string that could be read as a flag or a shell metacharacter', () => {
    expect(() =>
      buildSshReachabilityArgs('-oProxyCommand=touch /tmp/x'),
    ).toThrow();
    expect(() => buildSshReachabilityArgs('box-b; rm -rf /')).toThrow();
  });

  test("verifies against the store this host RESOLVES to, in ssh's own order", () => {
    const args = buildSshReachabilityArgs('media-server', [
      '/tmp/work_known_hosts',
      '/tmp/known_hosts',
    ]);
    expect(args).toContain(
      'UserKnownHostsFile=/tmp/work_known_hosts /tmp/known_hosts',
    );
    expect(args).not.toContain(
      `UserKnownHostsFile=${join(homedir(), '.ssh', 'known_hosts')}`,
    );
  });

  test('a resolved path containing spaces reaches ssh as one file', () => {
    // OpenSSH splits this option value on whitespace, so an unquoted path
    // with a space silently becomes two trust stores, neither of them real.
    expect(
      buildSshReachabilityArgs('media-server', [
        '/tmp/Application Support/known_hosts',
      ]),
    ).toContain('UserKnownHostsFile="/tmp/Application Support/known_hosts"');
  });

  test("an unresolvable config falls back to OpenSSH's own default, never to nothing", () => {
    expect(buildSshReachabilityArgs('media-server', [])).toContain(
      `UserKnownHostsFile=${join(homedir(), '.ssh', 'known_hosts')}`,
    );
  });
});

/**
 * sol review finding 3: `failure.detail` and the `config`/`unknown` action
 * lines carry OpenSSH stderr, which is not Station's text — a `ProxyCommand`
 * is an arbitrary program whose output lands there verbatim, and the probe is
 * reachable by any authenticated remote credential.
 */
describe('redactSshDiagnostic', () => {
  const ESC = '\u001b';
  // Assembled at runtime: an OpenAI-key-shaped LITERAL in a tracked file
  // is what the repo's own secret scan exists to stop, and a fixture is
  // not an exception to that.
  const FAKE_SECRET = ['sk', 'abc123def456ghi789jkl012mno345'].join('-');
  const PROXY_STDERR = [
    `${ESC}[31mProxyCommand${ESC}[0m: tunnel --token=${FAKE_SECRET} failed`,
    `Warning: Identity file ${homedir()}/.ssh/id_ed25519 not accessible.`,
    'read /etc/ssh/ssh_config',
    'ssh: connect to host box-b port 22: Connection refused',
  ].join('\n');

  test("a ProxyCommand's own stderr loses its secret, its escape sequences and the operator's home", () => {
    // A BEL and a NUL ride along: OpenSSH does not emit them, but the
    // program behind a ProxyCommand can, and they are how a terminal is
    // driven rather than read.
    const redacted = redactSshDiagnostic(`${PROXY_STDERR}\u0007\u0000`);

    // The secret itself, and any fragment of it, is gone.
    expect(redacted).not.toContain(FAKE_SECRET);
    expect(redacted).not.toContain('abc123def456');
    expect(redacted).toContain('[REDACTED]');

    // No escape sequence and no bare control byte survives to a terminal.
    expect(redacted).not.toContain(ESC);
    expect(redacted).not.toContain('[31m');
    expect(
      [...redacted].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      }),
    ).toBe(true);

    // The operator's home becomes `~` — non-identifying, and still the
    // actionable half of the sentence. Ordering is what makes this work:
    // `redactDeep` replaces any absolute path with `[REDACTED_PATH]`, so
    // running it BEFORE the home rewrite would erase the path wholesale.
    expect(redacted).not.toContain(homedir());
    expect(redacted).toContain('~/.ssh/id_ed25519');

    // A path OUTSIDE the home is not the operator's own and is removed.
    expect(redacted).not.toContain('/etc/ssh/ssh_config');
    expect(redacted).toContain('[REDACTED_PATH]');

    // The diagnostic that names the cause is still readable.
    expect(redacted).toContain(
      'ssh: connect to host box-b port 22: Connection refused',
    );
  });

  test('an escape sequence hidden inside a token cannot reassemble it after stripping', () => {
    // Controls are stripped FIRST for exactly this reason: stripping after
    // the secret patterns ran would rejoin the halves into a live secret.
    const redacted = redactSshDiagnostic(
      `token=${FAKE_SECRET.slice(0, 15)}${ESC}[0m${FAKE_SECRET.slice(15)}`,
    );
    expect(redacted).not.toContain(FAKE_SECRET);
    expect(redacted).not.toContain('abc123def456');
  });

  test('output is bounded to the last 400 characters, where OpenSSH puts its conclusion', () => {
    const redacted = redactSshDiagnostic(
      `${'x'.repeat(4_000)} the actual cause`,
    );
    expect(redacted.length).toBe(MAX_DETAIL + 1);
    expect(redacted.startsWith('…')).toBe(true);
    expect(redacted.endsWith('the actual cause')).toBe(true);
  });
});

/**
 * sol delta finding 4. The real-process test next door proves the POSIX path
 * with `pgrep`/`ps` and actual process groups, which by construction says
 * nothing about Windows — where negative-pid signalling does not exist and
 * the old code silently fell into its catch, killing only `ssh` and leaving
 * a `ProxyCommand` descendant alive. The branch is a pure function so the
 * selection is provable on any host; NO real Windows run backs it (disclosed
 * — the Windows behaviour of `taskkill` itself is untested here).
 */
/**
 * sol delta finding 5. `Retry-After` was the ATTEMPT's ceiling alone, so a
 * caller who waited exactly that long could arrive while the first probe was
 * still resolving or scanning and collect a second 429 — a header that tells
 * you when to come back and is wrong.
 */
describe('SSH_PROBE_MAX_SECONDS', () => {
  test("is the sum of the probe's three sequential legs, not any one of them", () => {
    expect(SSH_PROBE_MAX_SECONDS).toBe(
      SSH_CONFIG_RESOLVE_MAX_SECONDS +
        SSH_PROBE_ATTEMPT_MAX_SECONDS +
        SSH_HOST_KEY_SCAN_MAX_SECONDS,
    );
    // Every leg is a real, non-zero cost, so the total is strictly larger
    // than the attempt the header used to report.
    for (const leg of [
      SSH_CONFIG_RESOLVE_MAX_SECONDS,
      SSH_PROBE_ATTEMPT_MAX_SECONDS,
      SSH_HOST_KEY_SCAN_MAX_SECONDS,
    ]) {
      expect(leg).toBeGreaterThan(0);
      expect(SSH_PROBE_MAX_SECONDS).toBeGreaterThan(leg);
    }
  });

  test('each leg matches the timeout its own runner actually applies', () => {
    // `ssh -G` is bounded by the config module's exported constant — the
    // header cannot drift from the timeout without this failing.
    expect(SSH_CONFIG_RESOLVE_MAX_SECONDS * 1_000).toBe(
      OPENSSH_CONFIG_RESOLVE_TIMEOUT_MS,
    );
  });
});

describe('planProcessTreeKill', () => {
  test('POSIX platforms signal the whole process group', () => {
    for (const platform of ['darwin', 'linux', 'freebsd'] as const) {
      expect(planProcessTreeKill(platform, 4321)).toEqual({
        kind: 'signal-group',
        pid: 4321,
        signal: 'SIGKILL',
      });
    }
  });

  test('Windows walks the child list with taskkill instead, because it has no process groups', () => {
    expect(planProcessTreeKill('win32', 4321)).toEqual({
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/T', '/F', '/PID', '4321'],
    });
  });

  test('the Windows plan asks for the TREE and forces it — either flag missing leaves a ProxyCommand alive', () => {
    const plan = planProcessTreeKill('win32', 99);
    if (plan.kind !== 'taskkill') throw new Error('expected a taskkill plan');
    expect(plan.args).toContain('/T');
    expect(plan.args).toContain('/F');
    // The pid is passed as its own argv element, never interpolated into a
    // command string a shell would parse.
    expect(plan.args).toEqual(expect.arrayContaining(['/PID', '99']));
  });
});

describe('probeSshReachability', () => {
  test('a successful run reports what it signed in as and what it found', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stdout: '__station_ssh_reachable__\nv24.19.0\n',
        exitCode: 0,
      }),
    });
    expect(evidence.reachable).toBe(true);
    expect(evidence.level).toBe('smoke-passed');
    expect(evidence.summary).toBe(
      'Signed in to dev@media-server.local on port 22 and ran a command there · Node v24.19.0.',
    );
    expect(evidence.resolved).toMatchObject({ user: 'dev', port: 22 });
    expect(evidence.remoteNodeVersion).toBe('v24.19.0');
    expect(evidence.failure).toBeUndefined();
  });

  test('an unmarked zero-exit result is not treated as a completed remote command', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({ stdout: 'v24.19.0\n', exitCode: 0 }),
    });
    expect(evidence.reachable).toBe(false);
  });

  test('a missing Node diagnostic is subordinate to a reached shell, not proof that the fixed command completed', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stdout: '__station_ssh_reachable__\n',
        stderr: 'bash: node: command not found',
        exitCode: 127,
      }),
    });
    expect(evidence.reachable).toBe(false);
    expect(evidence.level).toBe('discovered');
    expect(evidence.summary).toContain('Node.js is not installed there');
    expect(evidence.action).toContain('Install Node.js 20 or newer');
  });

  test('an identity-file error followed by auth rejection is not mistaken for Node missing', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stderr:
          'Warning: Identity file /Users/operator/.ssh/missing_key not accessible: No such file or directory.\ndev@media-server.local: Permission denied (publickey).',
        exitCode: 255,
      }),
    });
    expect(evidence.reachable).toBe(false);
    expect(evidence.failure?.code).toBe('auth-rejected');
  });

  test('a refused connection reports the resolved port, not a guessed one', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(['hostname 10.0.0.5', 'user dev', 'port 2222'].join('\n')),
      attempt: attempt({
        stderr: 'ssh: connect to host 10.0.0.5 port 2222: Connection refused',
        exitCode: 255,
      }),
    });
    expect(evidence.reachable).toBe(false);
    expect(evidence.summary).toBe(
      'Connection refused on port 2222 — is sshd running on 10.0.0.5?',
    );
    expect(evidence.failure?.code).toBe('connection-refused');
    expect(evidence.action).toBeTruthy();
  });

  test('an unknown host carries the scanned fingerprint, the command that records it, and no reachable claim', async () => {
    const scanHostKey = vi.fn(
      async () =>
        `# media-server.local:22 SSH-2.0-OpenSSH_9.6\nmedia-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=\n`,
    );
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stderr: 'Host key verification failed.',
        exitCode: 255,
      }),
      scanHostKey,
    });
    expect(evidence.reachable).toBe(false);
    expect(evidence.failure?.code).toBe('host-key');
    expect(scanHostKey).toHaveBeenCalledWith({
      host: 'media-server.local',
      port: 22,
      keyTypes: ['ed25519', 'ecdsa', 'rsa'],
    });
    // The fingerprint is the SHA-256 of the DECODED key blob, base64 without
    // padding — byte-identical to what `ssh` itself prints.
    expect(evidence.unknownHost).toEqual({
      keyType: 'ssh-ed25519',
      fingerprint: createHash('sha256')
        .update(Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=', 'base64'))
        .digest('base64')
        .replace(/=+$/, '')
        .replace(/^/, 'SHA256:'),
      knownHostsLine:
        'media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=',
      trustCommand: `printf '%s\\n' 'media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=' >> "$HOME/.ssh/known_hosts"`,
    });
    // One derivation: the sentence the user reads is composed FROM the
    // command the Copy button hands over, so they cannot disagree.
    expect(evidence.action).toBe(
      `Station does not accept new host keys. Verify this fingerprint with the computer's owner, then run: printf '%s\\n' 'media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=' >> "$HOME/.ssh/known_hosts", and test again.`,
    );
  });

  /**
   * sol delta finding 1. The command used to be a second, unrestricted
   * `ssh-keyscan … >> known_hosts`. Nothing bound its result to the
   * fingerprint on screen: the host can answer differently the second time,
   * and an unrestricted scan appends EVERY algorithm it offers — so a user
   * who carefully verified an Ed25519 fingerprint could end up trusting an
   * ECDSA key they never saw, which `ssh` may then negotiate.
   */
  test('the trust command appends only the key whose fingerprint was shown, and never re-scans', async () => {
    // The host offers two keys. Only the first is fingerprinted and shown.
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stderr: 'Host key verification failed.',
        exitCode: 255,
      }),
      scanHostKey: vi.fn(
        async () =>
          `media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=\nmedia-server.local ssh-rsa AAAAB3NzaC1yc2FmYWtlLXJzYS1rZXktbWF0ZXJpYWwtZm9yLXRlc3Rz\n`,
      ),
    });

    const command = evidence.unknownHost?.trustCommand ?? '';
    // It carries the literal key material behind the displayed fingerprint…
    expect(command).toContain('AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=');
    // …and NOT the second key, which nobody verified.
    expect(command).not.toContain(
      'AAAAB3NzaC1yc2FmYWtlLXJzYS1rZXktbWF0ZXJpYWwtZm9yLXRlc3Rz',
    );
    // …and it reaches no network at all: no second scan to answer differently.
    expect(command).not.toMatch(/keyscan/i);
    expect(evidence.unknownHost?.knownHostsLine).toBe(
      'media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=',
    );
  });

  test('a second scan returning different bytes cannot change what the command appends', async () => {
    async function probeWith(scanOutput: string) {
      return probeSshReachability({
        hostAlias: 'media-server',
        runner: runner(),
        attempt: attempt({
          stderr: 'Host key verification failed.',
          exitCode: 255,
        }),
        scanHostKey: vi.fn(async () => scanOutput),
      });
    }

    const first = await probeWith(
      `media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=\n`,
    );
    // The same host, scanned again, now answers with entirely different key
    // material — the substitution the old re-scanning command would have
    // silently trusted.
    const second = await probeWith(
      `media-server.local ssh-rsa AAAAB3NzaC1yc2FmYWtlLXJzYS1rZXktbWF0ZXJpYWwtZm9yLXRlc3Rz\n`,
    );

    // Each command is bound to the bytes ITS OWN scan fingerprinted, and the
    // fingerprint the user compared moved with it.
    expect(first.unknownHost?.trustCommand).toContain(
      'AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=',
    );
    expect(first.unknownHost?.trustCommand).not.toContain(
      'AAAAB3NzaC1yc2FmYWtlLXJzYS1rZXktbWF0ZXJpYWwtZm9yLXRlc3Rz',
    );
    expect(second.unknownHost?.trustCommand).toContain(
      'AAAAB3NzaC1yc2FmYWtlLXJzYS1rZXktbWF0ZXJpYWwtZm9yLXRlc3Rz',
    );
    expect(first.unknownHost?.fingerprint).not.toBe(
      second.unknownHost?.fingerprint,
    );
  });

  test('a key line carrying a quote cannot break out of the trust command', async () => {
    // `ssh-keyscan` output is remote-controlled text on its way into a shell
    // command the operator will paste. Rebuilding the line from the three
    // validated fields drops trailing comment text, and single-quoting makes
    // whatever survives inert.
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stderr: 'Host key verification failed.',
        exitCode: 255,
      }),
      scanHostKey: vi.fn(
        async () =>
          `media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U= '; rm -rf /tmp/pwn; echo '\n`,
      ),
    });
    const command = evidence.unknownHost?.trustCommand ?? '';
    expect(command).not.toContain('rm -rf');
    expect(evidence.unknownHost?.knownHostsLine).toBe(
      'media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=',
    );
  });

  /**
   * sol delta finding 3. The probe forced `~/.ssh/known_hosts` while CONNECT
   * honours the configured `UserKnownHostsFile`, so the two asked different
   * questions about the same host. Both failure directions were real: a host
   * trusted only in a configured store failed the creator's probe, and the
   * copied command could make the probe pass by writing the DEFAULT file
   * while CONNECT still refused, because its store stayed empty.
   */
  test('the probe verifies against the configured trust store, and the trust command appends to that same file', async () => {
    const configuredStore = join(tmpdir(), 'station-work_known_hosts');
    // Captured rather than read off the mock's inferred call tuple: the argv
    // IS the assertion here, so it is held in a typed local.
    const seenArgs: string[][] = [];
    const attemptSpy = vi.fn(async (args: readonly string[]) => {
      seenArgs.push([...args]);
      return {
        stdout: '',
        stderr: 'Host key verification failed.',
        exitCode: 255,
        spawnFailed: false,
      };
    });
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(
        [
          'hostname media-server.local',
          'user dev',
          'port 22',
          `userknownhostsfile ${configuredStore}`,
        ].join('\n'),
      ),
      attempt: attemptSpy,
      scanHostKey: vi.fn(
        async () =>
          'media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=\n',
      ),
    });

    // The argv the probe actually ran with — one trust store, the configured
    // one, not the default.
    const args = seenArgs[0] ?? [];
    expect(args).toContain(`UserKnownHostsFile=${configuredStore}`);
    expect(args).not.toContain(
      `UserKnownHostsFile=${join(homedir(), '.ssh', 'known_hosts')}`,
    );

    // And the command appends to THAT file. Appending to the default would
    // be a command that changes nothing a later CONNECT will read.
    expect(evidence.unknownHost?.trustCommand).toContain(
      `>> '${configuredStore}'`,
    );
    expect(evidence.unknownHost?.trustCommand).not.toContain(
      '.ssh/known_hosts',
    );
  });

  test('a host with several configured stores has the new key sent to the first one ssh reads', async () => {
    const first = join(tmpdir(), 'station-first_known_hosts');
    const second = join(tmpdir(), 'station-second_known_hosts');
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(
        [
          'hostname media-server.local',
          'user dev',
          'port 22',
          `userknownhostsfile ${first} ${second}`,
        ].join('\n'),
      ),
      attempt: attempt({
        stderr: 'Host key verification failed.',
        exitCode: 255,
      }),
      scanHostKey: vi.fn(
        async () =>
          'media-server.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=\n',
      ),
    });
    expect(evidence.unknownHost?.trustCommand).toContain(`>> '${first}'`);
    expect(evidence.unknownHost?.trustCommand).not.toContain(second);
  });

  test('a CHANGED host key is never offered a fingerprint to append — that would be one click to trust an interception', async () => {
    const scanHostKey = vi.fn(async () => 'never called');
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stderr:
          '@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@\nHost key verification failed.',
        exitCode: 255,
      }),
      scanHostKey,
    });
    expect(evidence.failure?.code).toBe('host-key');
    expect(scanHostKey).not.toHaveBeenCalled();
    expect(evidence.unknownHost).toBeUndefined();
    expect(evidence.action).toContain('ssh-keygen -R');
  });

  test('a host that will not answer ssh-keyscan keeps the generic host-key action rather than inventing a fingerprint', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stderr: 'Host key verification failed.',
        exitCode: 255,
      }),
      scanHostKey: vi.fn(async () => {
        throw new Error('ssh-keyscan: connect failed');
      }),
    });
    expect(evidence.unknownHost).toBeUndefined();
    expect(evidence.action).toContain('confirm the fingerprint');
  });

  const EVIDENCE_SECRET = ['sk', 'abc123def456ghi789jkl012mno345'].join('-');

  test('the evidence a caller receives carries no raw stderr — detail and the unclassified action are both redacted', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: runner(),
      attempt: attempt({
        stderr: `debug1: nothing classified here token=${EVIDENCE_SECRET} in ${homedir()}/.ssh/config`,
        exitCode: 255,
      }),
    });
    expect(evidence.failure?.code).toBe('unknown');
    for (const text of [
      evidence.failure?.detail ?? '',
      evidence.action ?? '',
    ]) {
      expect(text).not.toContain(EVIDENCE_SECRET);
      expect(text).not.toContain(homedir());
    }
    // The `unknown` action quotes stderr back at the user, so it is the one
    // that would have leaked twice.
    expect(evidence.action).toContain('~/.ssh/config');
  });

  test('an unusable ssh -G resolution still produces named evidence rather than throwing', async () => {
    const evidence = await probeSshReachability({
      hostAlias: 'media-server',
      runner: vi.fn(async () => {
        throw new Error('The system OpenSSH client is unavailable');
      }),
      attempt: attempt({ stderr: '', exitCode: 1, spawnFailed: true }),
    });
    expect(evidence.reachable).toBe(false);
    expect(evidence.failure?.code).toBe('ssh-not-found');
    expect(evidence.summary).toBeTruthy();
  });
});
