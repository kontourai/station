import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  discoverOpenSshAliases,
  discoverOpenSshHosts,
  parseConcreteOpenSshAliases,
  parseOpenSshGOutput,
  redactOpenSshArgs,
  resolveOpenSshHost,
} from '../openssh-config.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const EFFECTIVE_CONFIG = `
hostname brian-media.internal
user brian
port 2222
identityagent /Users/brian/Library/Group Containers/agent.sock
proxyjump tailnet-gateway
stricthostkeychecking ask
userknownhostsfile /Users/brian/.ssh/work_known_hosts /Users/brian/.ssh/known_hosts
`;

describe('OpenSSH effective config', () => {
  test('parses public connection facts without exposing agent paths', () => {
    expect(parseOpenSshGOutput('brian-media', EFFECTIVE_CONFIG)).toEqual({
      alias: 'brian-media',
      hostname: 'brian-media.internal',
      user: 'brian',
      port: 2222,
      identityAgent: 'configured',
      proxyJump: 'tailnet-gateway',
      strictHostKeyChecking: 'ask',
      // sol delta finding 3: the probe has to verify against the store `ssh`
      // itself would use for this host, in `ssh`'s own order, not against an
      // assumed `~/.ssh/known_hosts`.
      userKnownHostsFiles: [
        '/Users/brian/.ssh/work_known_hosts',
        '/Users/brian/.ssh/known_hosts',
      ],
    });
  });

  test('a quoted trust-store path containing spaces survives as one file', () => {
    expect(
      parseOpenSshGOutput(
        'brian-media',
        [
          'hostname brian-media.internal',
          'user brian',
          'port 22',
          'userknownhostsfile "/Users/brian/Application Support/known_hosts"',
        ].join('\n'),
      ).userKnownHostsFiles,
    ).toEqual(['/Users/brian/Application Support/known_hosts']);
  });

  test('a host whose configuration names no trust store reports none, rather than guessing one', () => {
    expect(
      parseOpenSshGOutput(
        'brian-media',
        'hostname brian-media.internal\nuser brian\nport 22\n',
      ).userKnownHostsFiles,
    ).toEqual([]);
  });

  test('uses `ssh -G` with fixed argv and rejects flag-like aliases', async () => {
    const runner = vi.fn(async () => ({
      stdout: EFFECTIVE_CONFIG,
      stderr: '',
      exitCode: 0,
    }));
    await expect(
      resolveOpenSshHost('brian-media', runner),
    ).resolves.toMatchObject({
      hostname: 'brian-media.internal',
    });
    expect(runner).toHaveBeenCalledWith(['-G', '--', 'brian-media']);
    await expect(
      resolveOpenSshHost('-oProxyCommand=bad', runner),
    ).rejects.toThrow('SSH host alias');
  });
});

describe('OpenSSH alias discovery', () => {
  test('keeps only concrete aliases, excluding wildcard and negated patterns', () => {
    expect(
      parseConcreteOpenSshAliases(`
        Host brian-media media.local
        Host=equals-host
        Host *.prod !blocked.prod
        Host "quoted-host"
      `),
    ).toEqual(['brian-media', 'media.local', 'equals-host', 'quoted-host']);
  });

  test('walks bounded Include globs while OpenSSH remains resolution authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-ssh-config-'));
    cleanup.push(root);
    await mkdir(join(root, 'conf.d'));
    await writeFile(
      join(root, 'config'),
      'Include=conf.d/*.conf\nHost primary\n  HostName primary.local\n',
    );
    await writeFile(join(root, 'conf.d', 'media.conf'), 'Host brian-media\n');
    await mkdir(join(root, 'extra'));
    await writeFile(
      join(root, 'conf.d', 'work.conf'),
      'Include extra/*.conf\nHost work-box\n',
    );
    await writeFile(join(root, 'extra', 'nested.conf'), 'Host nested-box\n');
    await expect(
      discoverOpenSshAliases({ configPath: join(root, 'config') }),
    ).resolves.toEqual(['brian-media', 'nested-box', 'primary', 'work-box']);
  });

  test('expands stable OpenSSH Include tokens and skips undefined variables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-ssh-tokens-'));
    cleanup.push(root);
    await mkdir(join(root, 'token-config'));
    await mkdir(join(root, 'conditional-config'));
    await mkdir(join(root, `short-${hostname().split('.')[0]}`));
    await mkdir(join(root, 'bare-variable'));
    await writeFile(
      join(root, 'config'),
      `Include %d/token-config/*.conf\nInclude %d/short-%L/*.conf\nInclude \${MISSING_CONFIG}/*.conf\nInclude $PLAIN_CONFIG/*.conf\nHost scoped\n  Include %d/conditional-config/*.conf\n`,
    );
    await writeFile(
      join(root, 'token-config', 'host.conf'),
      'Host token-host\n',
    );
    await writeFile(
      join(root, 'conditional-config', 'phantom.conf'),
      'Host phantom-host\n',
    );
    await writeFile(
      join(root, `short-${hostname().split('.')[0]}`, 'host.conf'),
      'Host short-token-host\n',
    );
    await writeFile(
      join(root, 'bare-variable', 'host.conf'),
      'Host bare-variable-phantom\n',
    );
    await expect(
      discoverOpenSshAliases({
        configPath: join(root, 'config'),
        homeDirectory: root,
        env: { PLAIN_CONFIG: 'bare-variable' },
      }),
    ).resolves.toEqual(['scoped', 'short-token-host', 'token-host']);
  });

  test('reports aliases that OpenSSH cannot resolve without dropping good hosts', async () => {
    const runner = vi.fn(async (args: readonly string[]) => {
      if (args.at(-1) === 'missing') throw new Error('unavailable');
      return { stdout: EFFECTIVE_CONFIG, stderr: '', exitCode: 0 };
    });
    await expect(
      discoverOpenSshHosts({ aliases: ['brian-media', 'missing'], runner }),
    ).resolves.toEqual({
      hosts: [expect.objectContaining({ alias: 'brian-media' })],
      unavailableAliases: ['missing'],
    });
  });
});

test('redacts control sockets, forwards, worker payloads, agent sockets, and proxy commands', () => {
  expect(
    redactOpenSshArgs([
      '-S',
      '/tmp/private/control.sock',
      '-L',
      '127.0.0.1:4444:127.0.0.1:3141',
      '-o',
      'IdentityAgent=/private/agent.sock',
      '-o',
      'ProxyCommand=secret-helper token',
      'brian-media',
      'node',
      '-',
      'eyJyZW1vdGVQcm9qZWN0UGF0aCI6Ii9ob21lL2JyaWFuL3ByaXZhdGUifQ',
    ]),
  ).toEqual([
    '-S',
    '<control-path>',
    '-L',
    '<loopback-forward>',
    '-o',
    'IdentityAgent=<redacted>',
    '-o',
    'ProxyCommand=<redacted>',
    'brian-media',
    'node',
    '-',
    '<worker-payload>',
  ]);
});
