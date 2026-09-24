/**
 * The program Station runs on an SSH device host (#1973), executed for real
 * — exactly as sshd would: the login shell runs the joined remote command
 * words, `node` reads the header line from stdin — but on this machine,
 * with a private HOME, and without ssh in between.
 *
 * What this proves that a unit test of the argv cannot: the constant
 * loader actually runs the program; the install publishes only a tree whose
 * every file matches the manifest; and a hub started in `start` mode runs
 * under Station's REAL guard with the per-launch secret — a request without
 * the secret is refused by the hub process itself — and stops when the
 * session's stdin closes.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildHubGuardSource,
  HUB_GUARD_SECRET_ENV,
} from '../../toolchain/device-hub-guard.js';
import {
  HUB_ENV_ALLOWLIST,
  HUB_EXTRA_ENV,
  HUB_LAUNCH_ARGS,
} from '../../toolchain/device-hub-supervisor.js';
import { buildHubBundle, writeHubBundle } from '../ssh-device-hub-bundle.js';
import type { RemoteDeviceHostParams } from '../ssh-device-remote-script.js';
import { createEventReader, remoteHeader } from '../ssh-device-session.js';
import {
  REMOTE_NODE_MISSING_EXIT,
  remoteLoaderCommand,
} from '../ssh-device-target.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const OWNER = 'a'.repeat(24);
const VERSION = '0.10.1';

/** The remote program, run the way sshd runs it: `$SHELL -c "<words>"`. */
function runRemote(home: string) {
  // The prelude puts `$HOME/.local/bin` first on PATH (a common user-level
  // Node location); pin it to THIS node so the run does not depend on
  // whichever node the machine has in /opt/homebrew or /usr/local.
  const bin = join(home, '.local', 'bin');
  if (!existsSync(join(bin, 'node'))) {
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, 'node'));
  }
  const child = spawn('/bin/sh', ['-c', remoteLoaderCommand().join(' ')], {
    env: {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  cleanups.push(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Gone.
    }
  });
  const events: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  child.stdout.on(
    'data',
    createEventReader((event) => {
      events.push(event);
      for (const waiter of waiters.splice(0)) waiter();
    }),
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  const next = async (name: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find((event) => event.event === name);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(
          `no ${name} event; stderr: ${stderr}; events: ${JSON.stringify(events)}`,
        );
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  };
  return { child, events, exited, next, stderr: () => stderr };
}

async function runToEnd(
  home: string,
  params: RemoteDeviceHostParams,
  payload?: (stdin: NodeJS.WritableStream) => Promise<void>,
) {
  const run = runRemote(home);
  run.child.stdin.write(remoteHeader(params));
  if (payload) await payload(run.child.stdin);
  run.child.stdin.end();
  const code = await run.exited;
  return { code, events: run.events, stderr: run.stderr() };
}

/** A tiny stand-in hub tree: prints its port like expo-device-hub, answers everything. */
function fakeHubTree(): string {
  const install = tempDir('station-fake-hub-');
  const entry = join(
    install,
    'node_modules',
    'expo-device-hub',
    'dist',
    'server',
    'cli.mjs',
  );
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    [
      "import http from 'node:http';",
      "import { readFileSync } from 'node:fs';",
      // A test may make the stand-in slow to report its port (~/.hub-delay).
      "let delay = 0; try { delay = Number(readFileSync(process.env.HOME + '/.hub-delay', 'utf8')) || 0; } catch {}",
      "const server = http.createServer((req, res) => { res.end('hub:' + req.url); });",
      "server.listen(0, '127.0.0.1', () => setTimeout(() => console.log('Local: http://localhost:' + server.address().port), delay));",
    ].join('\n'),
  );
  writeFileSync(
    join(install, 'node_modules', 'expo-device-hub', 'package.json'),
    JSON.stringify({ name: 'expo-device-hub', version: VERSION }),
  );
  return install;
}

async function install(home: string, tree: string) {
  const bundle = buildHubBundle(tree, VERSION);
  const result = await runToEnd(
    home,
    {
      mode: 'install',
      version: VERSION,
      digest: bundle.digest,
      files: bundle.files,
    },
    (stdin) => writeHubBundle(bundle, stdin as never),
  );
  return { bundle, result };
}

const versionDir = (home: string) =>
  join(home, '.station-device-host', 'tools', 'expo-device-hub', VERSION);

describe('the device-host program', () => {
  test('probe reports node and an absent hub, starting and installing nothing', async () => {
    const home = tempDir('station-remote-home-');
    const { code, events } = await runToEnd(home, {
      mode: 'probe',
      owner: OWNER,
      version: VERSION,
      digest: null,
    });
    expect(code).toBe(0);
    const probe = events.find((event) => event.event === 'probe');
    expect(probe).toMatchObject({
      node: process.versions.node,
      nodeOk: true,
      hubInstalled: false,
      hubRunning: false,
    });
    expect(existsSync(join(home, '.station-device-host'))).toBe(false);
  });

  test('the loader finds node on the session PATH, or reports it missing (typed)', async () => {
    const home = tempDir('station-remote-home-');
    const child = spawn('/bin/sh', ['-c', remoteLoaderCommand().join(' ')], {
      env: { HOME: home, PATH: '/nonexistent' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end();
    const code = await new Promise((resolve) => child.once('exit', resolve));
    // Only when no node sits in the prelude's fixed directories either.
    if (
      !['/opt/homebrew/bin/node', '/usr/local/bin/node'].some((path) =>
        existsSync(path),
      )
    ) {
      expect(code).toBe(REMOTE_NODE_MISSING_EXIT);
      expect(stderr).toContain('STATION_DEVICE_HOST_NODE_MISSING');
    } else expect(code).not.toBe(REMOTE_NODE_MISSING_EXIT);
  });

  test('install publishes exactly the manifest, and probe then sees that digest', async () => {
    const home = tempDir('station-remote-home-');
    const tree = fakeHubTree();
    const { bundle, result } = await install(home, tree);
    expect(result.events).toContainEqual({
      event: 'installed',
      already: false,
    });
    for (const file of bundle.files)
      expect(
        createHash('sha256')
          .update(
            readFileSync(join(versionDir(home), bundle.digest, file.path)),
          )
          .digest('hex'),
      ).toBe(file.sha256);
    expect(
      readFileSync(
        join(versionDir(home), bundle.digest, '.install-complete'),
        'utf8',
      ).trim(),
    ).toBe(`${VERSION} ${bundle.digest}`);
    const probe = await runToEnd(home, {
      mode: 'probe',
      owner: OWNER,
      version: VERSION,
      digest: bundle.digest,
    });
    expect(probe.events.find((event) => event.event === 'probe')).toMatchObject(
      {
        hubInstalled: true,
      },
    );
    // A different verified tree (another digest) is not "installed".
    const other = await runToEnd(home, {
      mode: 'probe',
      owner: OWNER,
      version: VERSION,
      digest: 'f'.repeat(64),
    });
    expect(other.events.find((event) => event.event === 'probe')).toMatchObject(
      {
        hubInstalled: false,
      },
    );
  });

  test('L2: a reinstall never deletes a complete tree another hub may run from; a new digest publishes beside it', async () => {
    const home = tempDir('station-remote-home-');
    const tree = fakeHubTree();
    const first = await install(home, tree);
    const firstEntry = join(
      versionDir(home),
      first.bundle.digest,
      'node_modules',
      'expo-device-hub',
      'dist',
      'server',
      'cli.mjs',
    );
    const inode = statSync(firstEntry).ino;
    // The same tree again: already installed, untouched.
    expect((await install(home, tree)).result.events).toContainEqual({
      event: 'installed',
      already: true,
    });
    expect(statSync(firstEntry).ino).toBe(inode);
    // A changed tree (a new pin): published into its OWN directory.
    writeFileSync(
      join(tree, 'node_modules', 'expo-device-hub', 'package.json'),
      JSON.stringify({ name: 'expo-device-hub', version: VERSION, next: 1 }),
    );
    const second = await install(home, tree);
    expect(second.bundle.digest).not.toBe(first.bundle.digest);
    expect(second.result.events).toContainEqual({
      event: 'installed',
      already: false,
    });
    expect(statSync(firstEntry).ino).toBe(inode);
    expect(readdirSync(versionDir(home)).sort()).toEqual(
      [first.bundle.digest, second.bundle.digest].sort(),
    );
  });

  test('L-f: two installers of the same tree race; the one that loses the publish reports success and deletes nothing', async () => {
    const home = tempDir('station-remote-home-');
    const tree = fakeHubTree();
    const bundle = buildHubBundle(tree, VERSION);
    const params = {
      mode: 'install' as const,
      version: VERSION,
      digest: bundle.digest,
      files: bundle.files,
    };
    // Installer 1 has staged everything but not published yet…
    const slow = runRemote(home);
    slow.child.stdin.write(remoteHeader(params));
    await writeHubBundle(bundle, slow.child.stdin as never);
    // …while installer 2 publishes the same digest first.
    const fast = await runToEnd(home, params, (stdin) =>
      writeHubBundle(bundle, stdin as never),
    );
    expect(fast.events).toContainEqual({ event: 'installed', already: false });
    const entry = join(
      versionDir(home),
      bundle.digest,
      'node_modules',
      'expo-device-hub',
      'dist',
      'server',
      'cli.mjs',
    );
    const inode = statSync(entry).ino;
    slow.child.stdin.end();
    expect(await slow.exited).toBe(0);
    expect(slow.events).toContainEqual({ event: 'installed', already: true });
    expect(statSync(entry).ino).toBe(inode);
    // No staging directory is left behind.
    expect(readdirSync(versionDir(home))).toEqual([bundle.digest]);
  });

  test('L-b: an overlapping session of the same owner never removes the newer session’s hub record', async () => {
    const home = tempDir('station-remote-home-');
    const { bundle } = await install(home, fakeHubTree());
    const start = (secret: string) => {
      const run = runRemote(home);
      run.child.stdin.write(
        remoteHeader({
          mode: 'start',
          owner: OWNER,
          version: VERSION,
          digest: bundle.digest,
          secret,
          guardSource: buildHubGuardSource(),
          guardSecretEnv: HUB_GUARD_SECRET_ENV,
          envAllowlist: HUB_ENV_ALLOWLIST,
          extraEnv: { ...HUB_EXTRA_ENV },
          args: HUB_LAUNCH_ARGS,
          entry: ['dist', 'server', 'cli.mjs'],
          readyTimeoutMs: 15_000,
        }),
      );
      return run;
    };
    const record = join(home, '.station-device-host', 'run', OWNER, 'hub.json');
    const a = start(randomBytes(32).toString('hex'));
    await a.next('ready');
    // Session B starts while A's session is still open: B replaces A's hub
    // (and records it at once). B's hub is slow to report its port, so A's
    // session ends — its hub stopped under it — while B's record is the
    // pid-only one written at spawn.
    writeFileSync(join(home, '.hub-delay'), '2000');
    const secretB = randomBytes(32).toString('hex');
    const b = start(secretB);
    expect(await a.exited).toBe(4);
    // A's exit left B's record alone.
    const early = JSON.parse(readFileSync(record, 'utf8'));
    expect(typeof early.pid).toBe('number');
    const readyB = await b.next('ready');
    const recorded = JSON.parse(readFileSync(record, 'utf8'));
    expect(recorded.pid).toBe(early.pid);
    expect(recorded.port).toBe(readyB.port);
    const answer = await fetch(`http://127.0.0.1:${readyB.port}/readyz`, {
      headers: { 'x-station-hub-secret': secretB },
    });
    expect(answer.status).toBe(200);
    b.child.stdin.end();
    await b.next('stopped');
  });

  test('N4: a sentinel-less leftover at the digest path is moved aside, not deleted, and the install publishes', async () => {
    const home = tempDir('station-remote-home-');
    const tree = fakeHubTree();
    const bundle = buildHubBundle(tree, VERSION);
    const leftover = join(versionDir(home), bundle.digest);
    mkdirSync(join(leftover, 'node_modules'), { recursive: true });
    writeFileSync(join(leftover, 'node_modules', 'partial.js'), 'x');
    const { result } = await install(home, tree);
    expect(result.events).toContainEqual({
      event: 'installed',
      already: false,
    });
    expect(
      readFileSync(join(leftover, '.install-complete'), 'utf8').trim(),
    ).toBe(`${VERSION} ${bundle.digest}`);
    const names = readdirSync(versionDir(home));
    const stale = names.filter((name) =>
      name.startsWith(`${bundle.digest}.stale-`),
    );
    expect(stale).toHaveLength(1);
    expect(
      readFileSync(
        join(versionDir(home), stale[0]!, 'node_modules', 'partial.js'),
        'utf8',
      ),
    ).toBe('x');
  });

  test('N5: a start sweeps TMPDIRs of dead sessions, never a live one', async () => {
    const home = tempDir('station-remote-home-');
    const { bundle } = await install(home, fakeHubTree());
    const run = join(home, '.station-device-host', 'run', OWNER);
    const dead = join(run, 'tmp-2147483600');
    const live = join(run, `tmp-${process.pid}`);
    mkdirSync(dead, { recursive: true });
    mkdirSync(live, { recursive: true });
    const session = runRemote(home);
    session.child.stdin.write(
      remoteHeader({
        mode: 'start',
        owner: OWNER,
        version: VERSION,
        digest: bundle.digest,
        secret: randomBytes(32).toString('hex'),
        guardSource: buildHubGuardSource(),
        guardSecretEnv: HUB_GUARD_SECRET_ENV,
        envAllowlist: HUB_ENV_ALLOWLIST,
        extraEnv: { ...HUB_EXTRA_ENV },
        args: HUB_LAUNCH_ARGS,
        entry: ['dist', 'server', 'cli.mjs'],
        readyTimeoutMs: 15_000,
      }),
    );
    await session.next('ready');
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    session.child.stdin.end();
    await session.next('stopped');
  });

  test('a byte that does not match the manifest publishes nothing', async () => {
    const home = tempDir('station-remote-home-');
    const tree = fakeHubTree();
    const bundle = buildHubBundle(tree, VERSION);
    const result = await runToEnd(
      home,
      {
        mode: 'install',
        version: VERSION,
        digest: bundle.digest,
        files: bundle.files,
      },
      async (stdin) => {
        // Same sizes, one flipped byte in the first file.
        const first = bundle.files[0]!;
        const bytes = Buffer.from(
          readFileSync(join(tree, ...first.path.split('/'))),
        );
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        stdin.write(bytes);
        for (const file of bundle.files.slice(1))
          stdin.write(readFileSync(join(tree, ...file.path.split('/'))));
      },
    );
    expect(result.events).toContainEqual({
      event: 'error',
      failure: 'install-failed',
    });
    // Nothing published, and no staging directory left behind either.
    const parent = versionDir(home);
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
  });

  test('a manifest path that leaves the tree is refused before anything is written', async () => {
    const home = tempDir('station-remote-home-');
    for (const path of [
      'node_modules/../../escape.txt',
      '../escape.txt',
      '/etc/escape.txt',
      'node_modules//x',
      'escape.txt',
    ]) {
      const result = await runToEnd(home, {
        mode: 'install',
        version: VERSION,
        digest: 'a'.repeat(64),
        files: [{ path, size: 1, sha256: 'b'.repeat(64), exec: false }],
      });
      expect(result.events).toContainEqual({
        event: 'error',
        failure: 'protocol',
      });
    }
    expect(existsSync(join(home, '.station-device-host'))).toBe(false);
    expect(existsSync(join(home, 'escape.txt'))).toBe(false);
  });

  test('start runs the hub under Station’s guard: no secret, no answer; the session closing stops it', async () => {
    const home = tempDir('station-remote-home-');
    const { bundle } = await install(home, fakeHubTree());
    const secret = randomBytes(32).toString('hex');
    const run = runRemote(home);
    run.child.stdin.write(
      remoteHeader({
        mode: 'start',
        owner: OWNER,
        version: VERSION,
        digest: bundle.digest,
        secret,
        guardSource: buildHubGuardSource(),
        guardSecretEnv: HUB_GUARD_SECRET_ENV,
        envAllowlist: HUB_ENV_ALLOWLIST,
        extraEnv: { ...HUB_EXTRA_ENV },
        args: HUB_LAUNCH_ARGS,
        entry: ['dist', 'server', 'cli.mjs'],
        readyTimeoutMs: 15_000,
      }),
    );
    const ready = await run.next('ready');
    const port = ready.port as number;
    expect(Number.isInteger(port)).toBe(true);
    const base = `http://127.0.0.1:${port}`;
    // The hub process itself refuses a request without the secret…
    expect((await fetch(`${base}/readyz`)).status).toBe(403);
    expect(
      (
        await fetch(`${base}/readyz`, {
          headers: { 'x-station-hub-secret': 'f'.repeat(64) },
        })
      ).status,
    ).toBe(403);
    // …answers Station's allowlisted path with it…
    const ok = await fetch(`${base}/readyz`, {
      headers: { 'x-station-hub-secret': secret },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('hub:/readyz');
    // …and never an exec path, secret or not.
    expect(
      (
        await fetch(`${base}/vendor/serve-sim/exec`, {
          headers: { 'x-station-hub-secret': secret },
        })
      ).status,
    ).toBe(403);
    // The guard was written private to the owner's run directory.
    const guard = join(
      home,
      '.station-device-host',
      'run',
      OWNER,
      'hub-guard.cjs',
    );
    expect(readFileSync(guard, 'utf8')).toBe(buildHubGuardSource());
    // Closing the session's stdin stops the hub.
    run.child.stdin.end();
    await run.next('stopped');
    expect(await run.exited).toBe(0);
    await expect(
      fetch(`${base}/readyz`, {
        headers: { 'x-station-hub-secret': secret },
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow();
  });

  test('start refuses a hub that is not installed, and a malformed request', async () => {
    const home = tempDir('station-remote-home-');
    const base = {
      mode: 'start' as const,
      owner: OWNER,
      version: VERSION,
      digest: 'e'.repeat(64),
      secret: 'c'.repeat(64),
      guardSource: buildHubGuardSource(),
      guardSecretEnv: HUB_GUARD_SECRET_ENV,
      envAllowlist: HUB_ENV_ALLOWLIST,
      extraEnv: { ...HUB_EXTRA_ENV },
      args: HUB_LAUNCH_ARGS,
      entry: ['dist', 'server', 'cli.mjs'],
      readyTimeoutMs: 5_000,
    };
    expect((await runToEnd(home, base)).events).toContainEqual({
      event: 'error',
      failure: 'hub-not-installed',
    });
    // A short secret would leave the guard admitting nothing — refused first.
    expect(
      (await runToEnd(home, { ...base, secret: 'short' })).events,
    ).toContainEqual({ event: 'error', failure: 'protocol' });
    expect(
      (await runToEnd(home, { ...base, owner: '../../x' })).events,
    ).toContainEqual({ event: 'error', failure: 'protocol' });
  });

  test('the AVD lookup refuses anything that is not an emulator serial', async () => {
    const home = tempDir('station-remote-home-');
    expect(
      (await runToEnd(home, { mode: 'avd', serial: 'emulator-5554; id' }))
        .events,
    ).toContainEqual({ event: 'error', failure: 'protocol' });
  });
});
