/**
 * SSH device hosts (#1973): the target grammar and every argument vector.
 * These are the guards that keep an operator-typed target from becoming an
 * ssh option, and keep Station from ever accepting an unconfirmed host key.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  buildSshDeviceCommandArgs,
  buildSshDeviceForwardArgs,
  classifySshDeviceFailure,
  forwardListeningPort,
  isSshDeviceTarget,
  parseSshDeviceTarget,
  REMOTE_NODE_MISSING_EXIT,
  remoteLoaderCommand,
  SSH_DEVICE_BASE_OPTIONS,
  SshDeviceTargetError,
  sshDeviceEnvironment,
} from '../ssh-device-target.js';

describe('the ssh target grammar', () => {
  test.each([
    ['mac-mini', { host: 'mac-mini' }],
    ['build.local', { host: 'build.local' }],
    ['brian@mac-mini', { user: 'brian', host: 'mac-mini' }],
    ['brian@10.0.0.7:2222', { user: 'brian', host: '10.0.0.7', port: 2222 }],
    ['linux-box:22', { host: 'linux-box', port: 22 }],
    ['me@[fe80::1]:2200', { user: 'me', host: 'fe80::1', port: 2200 }],
    ['[::1]', { host: '::1' }],
    ['ci_runner.example.com', { host: 'ci_runner.example.com' }],
  ])('accepts %s', (value, parsed) => {
    expect(parseSshDeviceTarget(value)).toEqual(parsed);
    expect(isSshDeviceTarget(value)).toBe(true);
  });

  test.each([
    // Option injection, in every position ssh would read one.
    '-oProxyCommand=touch /tmp/pwned',
    '-oProxyCommand=sh',
    'host -oProxyCommand=x',
    '-p22',
    '--',
    'brian@-oProxyCommand=x',
    '-brian@host',
    'brian@host:-1',
    'brian@host -L 1:2:3',
    // Shell and ssh-token characters.
    'host;id',
    'host$(id)',
    'host`id`',
    "host'x",
    'host"x',
    'host|x',
    'host&x',
    'host%h',
    'host=x',
    'host/x',
    'host\\x',
    'a@b@c',
    '@host',
    'user@',
    ' host',
    'host ',
    'ho st',
    'host\n',
    'host\0',
    // Ports.
    'host:0',
    'host:65536',
    'host:022',
    'host:',
    'host:22:22',
    // Brackets.
    '[host]',
    '[::1',
    '[::1]x',
    '[::1]:',
    'x@[1.2.3.4:5]',
    '[:::::]',
    '[1.2.3.4]',
    // Size and type.
    '',
    'a'.repeat(256),
    42,
    null,
    undefined,
    { host: 'x' },
  ])('refuses %j', (value) => {
    expect(() => parseSshDeviceTarget(value)).toThrow(SshDeviceTargetError);
    expect(isSshDeviceTarget(value)).toBe(false);
  });
});

/** The index of `--`; everything after it is a destination or remote command. */
const endOfOptions = (args: readonly string[]) => args.indexOf('--');

describe('ssh argument vectors', () => {
  test('a command session: fixed options, the target after `--`, a constant remote command', () => {
    const args = buildSshDeviceCommandArgs(
      parseSshDeviceTarget('brian@10.0.0.7:2222'),
    );
    const end = endOfOptions(args);
    expect(end).toBeGreaterThan(0);
    expect(args.slice(0, end)).toEqual([
      '-T',
      ...SSH_DEVICE_BASE_OPTIONS,
      '-o',
      'ClearAllForwardings=yes',
      '-l',
      'brian',
      '-p',
      '2222',
    ]);
    expect(args[end + 1]).toBe('10.0.0.7');
    expect(args.slice(end + 2)).toEqual(remoteLoaderCommand());
  });

  test('the remote command is identical for every target (no input reaches it)', () => {
    const a = buildSshDeviceCommandArgs(parseSshDeviceTarget('mac-mini'));
    const b = buildSshDeviceCommandArgs(parseSshDeviceTarget('x@y.z:2'));
    expect(a.slice(endOfOptions(a) + 2)).toEqual(b.slice(endOfOptions(b) + 2));
    const [sh, dashC, program] = remoteLoaderCommand();
    expect([sh, dashC]).toEqual(['sh', '-c']);
    // One single-quoted word for the login shell.
    expect(program?.startsWith("'")).toBe(true);
    expect(program?.endsWith("'")).toBe(true);
  });

  test('BatchMode is on and host-key checking is strict on EVERY invocation', () => {
    const target = parseSshDeviceTarget('mac-mini');
    for (const args of [
      buildSshDeviceCommandArgs(target),
      buildSshDeviceForwardArgs(target, 40001, 50001),
    ]) {
      const options = args
        .slice(0, endOfOptions(args))
        .filter((_, index, all) => all[index - 1] === '-o');
      expect(options).toContain('BatchMode=yes');
      expect(options).toContain('StrictHostKeyChecking=yes');
      expect(options).toContain('UpdateHostKeys=no');
      expect(options).toContain('ForwardAgent=no');
      expect(options).toContain('PermitLocalCommand=no');
      // Never relaxed, in any spelling.
      for (const option of options) {
        expect(option).not.toMatch(
          /^StrictHostKeyChecking=(no|off|accept-new)$/i,
        );
        expect(option).not.toMatch(/^UserKnownHostsFile=/i);
        expect(option).not.toMatch(/^BatchMode=no$/i);
        expect(option).not.toMatch(/^ProxyCommand=/i);
      }
    }
  });

  test('the forward: numeric loopback on both ends, ServerAlive and ExitOnForwardFailure', () => {
    const args = buildSshDeviceForwardArgs(
      parseSshDeviceTarget('linux-box'),
      40001,
      50001,
    );
    const end = endOfOptions(args);
    expect(args[0]).toBe('-N');
    expect(args).toContain('ExitOnForwardFailure=yes');
    // H1: ssh must say when IT holds the listener (DEBUG1 prints that line).
    expect(args[args.indexOf('LogLevel=DEBUG1') - 1]).toBe('-o');
    expect(args).toContain('ServerAliveInterval=10');
    expect(args).toContain('ServerAliveCountMax=3');
    expect(args[args.indexOf('-L') + 1]).toBe(
      '127.0.0.1:40001:127.0.0.1:50001',
    );
    // No remote command: the destination is the last word.
    expect(args.slice(end + 1)).toEqual(['linux-box']);
  });

  test('forward ports must be real ports', () => {
    const target = parseSshDeviceTarget('linux-box');
    for (const [local, remote] of [
      [0, 50001],
      [40001, 70000],
      [1.5, 50001],
      [Number.NaN, 50001],
    ] as const)
      expect(() => buildSshDeviceForwardArgs(target, local, remote)).toThrow(
        SshDeviceTargetError,
      );
  });

  test('ssh runs with an allowlisted environment: the agent socket, never Station secrets', () => {
    expect(
      sshDeviceEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/me',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        ANTHROPIC_API_KEY: 'secret',
        STATION_TOKEN: 'secret',
        LC_STATION: 'secret',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
  });
});

describe('the forward-listening line (H1)', () => {
  test('only ssh\u2019s own whole debug1 line, for a real port, counts', () => {
    expect(
      forwardListeningPort(
        'debug1: Local forwarding listening on 127.0.0.1 port 41000.',
      ),
    ).toBe(41000);
    expect(
      forwardListeningPort(
        'debug1: Local forwarding listening on 127.0.0.1 port 41000.\r',
      ),
    ).toBe(41000);
    for (const line of [
      'debug1: Remote: debug1: Local forwarding listening on 127.0.0.1 port 41000.',
      'banner debug1: Local forwarding listening on 127.0.0.1 port 41000.',
      'debug1: Local forwarding listening on ::1 port 41000.',
      'debug1: Local forwarding listening on 127.0.0.1 port 41000. extra',
    ])
      expect(forwardListeningPort(line)).toBeUndefined();
  });
});

describe('ssh failures are typed', () => {
  test('D1: a REAL DEBUG1 transcript is classified by its non-debug lines only', () => {
    // A refused login at DEBUG1 is still auth-failed…
    expect(
      classifySshDeviceFailure({
        stderr: readFileSync(
          new URL(
            './fixtures/openssh-10.3p1-debug1-auth-denied.txt',
            import.meta.url,
          ),
          'utf8',
        ),
        exitCode: 255,
      }),
    ).toBe('auth-failed');
    // …but a bind race after a GOOD login is a forward failure, not a
    // "keyboard-interactive" prompt the debug negotiation mentions.
    expect(
      classifySshDeviceFailure({
        stderr: readFileSync(
          new URL(
            './fixtures/openssh-10.3p1-debug1-forward-bind-race.txt',
            import.meta.url,
          ),
          'utf8',
        ),
        exitCode: 255,
      }),
    ).toBe('forward-failed');
  });

  test('an unknown host key is host-key-unverified (never silently accepted)', () => {
    expect(
      classifySshDeviceFailure({
        stderr:
          'No ED25519 host key is known for mac-mini and you have requested strict checking.\r\nHost key verification failed.\r\n',
        exitCode: 255,
      }),
    ).toBe('host-key-unverified');
  });

  test('a changed host key is host-key-changed', () => {
    expect(
      classifySshDeviceFailure({
        stderr:
          '@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n',
        exitCode: 255,
      }),
    ).toBe('host-key-changed');
  });

  test.each([
    ['brian@localhost: Permission denied (publickey,password).', 'auth-failed'],
    [
      'Could not open a connection to your authentication agent.',
      'auth-failed',
    ],
    ['ssh: connect to host x port 22: Connection refused', 'unreachable'],
    [
      'ssh: Could not resolve hostname x: nodename nor servname provided',
      'unreachable',
    ],
    ['ssh: connect to host x port 22: Operation timed out', 'timeout'],
    [
      'bind [127.0.0.1]:40001: Address already in use\nCould not request local forwarding.',
      'forward-failed',
    ],
  ] as const)('%s → %s', (stderr, failure) => {
    expect(classifySshDeviceFailure({ stderr, exitCode: 255 })).toBe(failure);
  });

  test('node missing on the host, and ssh missing here', () => {
    expect(
      classifySshDeviceFailure({
        stderr: 'STATION_DEVICE_HOST_NODE_MISSING\n',
        exitCode: REMOTE_NODE_MISSING_EXIT,
      }),
    ).toBe('node-missing');
    expect(
      classifySshDeviceFailure({
        stderr: '',
        exitCode: null,
        spawnFailed: true,
      }),
    ).toBe('ssh-unavailable');
  });
});
