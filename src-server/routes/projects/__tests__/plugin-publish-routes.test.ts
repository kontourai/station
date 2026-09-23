/**
 * `/api/projects/:slug/plugin-publish` over the real handlers and real git
 * (epic #2323 S6).
 *
 * The one stub is `resolvePrincipal`, which is how a test states who is
 * calling; the operator check, the remote guard, the secret check, and every
 * git command are production code. "The remote" is a bare repository in a
 * temp folder, reached through an `insteadOf` rewrite in a throwaway global
 * git config, so the route validates and records an ordinary https address
 * while the push really lands somewhere this test can read back.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { createPluginPublishRoutes } from '../plugin-publish-routes.js';

const OPERATOR: PrincipalRef = {
  id: LOCAL_OPERATOR_PRINCIPAL_ID,
  kind: 'human',
  display: 'Operator',
};
const COLLABORATOR: PrincipalRef = humanPrincipal(
  'device',
  'collaborator-device',
  'Collaborator',
);
const REMOTE_URL = 'https://git.example.test/acme/pulse.git';

let root: string;
let folder: string;
let bare: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writePlugin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ name: 'pulse', version: '1.0.0' }),
  );
  writeFileSync(join(dir, 'index.ts'), 'export {};\n');
}

function bareHeads(): string {
  return run(bare, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'station-plugin-publish-route-'));
  folder = join(root, 'pulse');
  bare = join(root, 'remote.git');
  writePlugin(folder);
  run(root, ['init', '--quiet', '--bare', bare]);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(
    globalConfig,
    [
      '[user]',
      '\tname = Plugin Author',
      '\temail = author@example.test',
      '[init]',
      '\tdefaultBranch = main',
      `[url "${bare}"]`,
      `\tinsteadOf = ${REMOTE_URL}`,
      '',
    ].join('\n'),
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function appFor(caller: PrincipalRef, workspace = () => folder) {
  const app = new Hono();
  app.route(
    '/api/projects/:slug/plugin-publish',
    createPluginPublishRoutes({
      getWorkspacePath: () => workspace(),
      visibility: { resolvePrincipal: () => caller },
      // The fixture's "remote" is a bare repository on disk.
      testOnlyAllowFileTransport: true,
    }),
  );
  return app;
}

async function publish(
  body: Record<string, unknown>,
  caller: PrincipalRef = OPERATOR,
) {
  const response = await appFor(caller).request(
    '/api/projects/pulse/plugin-publish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: (await response.json()) as any };
}

async function inspect(caller: PrincipalRef = OPERATOR) {
  const response = await appFor(caller).request(
    '/api/projects/pulse/plugin-publish',
  );
  return { status: response.status, body: (await response.json()) as any };
}

describe('operator-only', () => {
  test('a collaborator is refused on both routes and nothing changes', async () => {
    expect((await inspect(COLLABORATOR)).status).toBe(403);
    const refused = await publish(
      { message: 'Publish', remoteName: 'origin', remoteUrl: REMOTE_URL },
      COLLABORATOR,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Only the Station operator');
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(bareHeads()).toBe('');
  });

  test('the operator check runs before body validation', async () => {
    const refused = await publish({ nonsense: true }, COLLABORATOR);
    expect(refused.status).toBe(403);
  });
});

describe('remote address guard', () => {
  test.each([
    [`file://${'/tmp/bare.git'}`, 'unsupported-transport'],
    ['/tmp/bare.git', 'unsupported-transport'],
    ['ext::sh%20-c%20id', 'unsupported-transport'],
    ['https://ghp_token@git.example.test/acme/pulse.git', 'credentials-in-url'],
    ['https://user:pass@git.example.test/acme/pulse.git', 'credentials-in-url'],
  ])('refuses %s before touching the folder', async (remoteUrl, code) => {
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(code);
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(bareHeads()).toBe('');
  });

  test('refuses the real bare repository by path, the local push the rewrite stands in for', async () => {
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: bare,
    });
    expect(refused.body.code).toBe('unsupported-transport');
    expect(bareHeads()).toBe('');
  });

  test('refuses an existing remote that carries a token, and never shows the token', async () => {
    run(folder, ['init', '--quiet']);
    run(folder, [
      'remote',
      'add',
      'origin',
      'https://x:ghp_secret@git.example.test/acme/pulse.git',
    ]);
    const view = await inspect();
    expect(JSON.stringify(view.body)).not.toContain('ghp_secret');
    expect(view.body.data.repository.remotes[0]).toMatchObject({
      name: 'origin',
      usable: false,
      refusal: 'credentials-in-url',
    });
    const refused = await publish({ message: 'Publish', remoteName: 'origin' });
    expect(refused.body.code).toBe('credentials-in-url');
    expect(bareHeads()).toBe('');
  });

  test('refuses an existing remote whose push address is local, even when its fetch address is fine', async () => {
    run(folder, ['init', '--quiet']);
    run(folder, ['remote', 'add', 'origin', REMOTE_URL]);
    run(folder, ['remote', 'set-url', '--push', 'origin', bare]);
    const refused = await publish({ message: 'Publish', remoteName: 'origin' });
    expect(refused.body.code).toBe('unsupported-transport');
    expect(bareHeads()).toBe('');
  });
});

describe('secrets', () => {
  test('refuses when an untracked .env would be committed, and initialises nothing', async () => {
    writeFileSync(join(folder, '.env'), 'API_KEY=abc\n');
    const view = await inspect();
    expect(view.body.data.secrets).toEqual([
      { path: '.env', reason: 'environment file' },
    ]);
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('secrets');
    expect(refused.body.secrets).toEqual([
      { path: '.env', reason: 'environment file' },
    ]);
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(bareHeads()).toBe('');
  });

  test('refuses a private key saved under an innocent name', async () => {
    run(folder, ['init', '--quiet']);
    writeFileSync(
      join(folder, 'notes.txt'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n',
    );
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(refused.body.code).toBe('secrets');
    expect(refused.body.secrets).toEqual([
      { path: 'notes.txt', reason: 'contains a private key' },
    ]);
    expect(run(folder, ['remote'])).toBe('');
  });

  test('an ignored .env is not committed and does not block', async () => {
    writeFileSync(join(folder, '.env'), 'API_KEY=abc\n');
    writeFileSync(join(folder, '.gitignore'), '.env\n');
    const published = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(published.status).toBe(201);
    expect(run(bare, ['ls-tree', '--name-only', 'main'])).not.toContain('.env');
  });
});

describe('publishing', () => {
  test('initialises, commits, pushes to the remote, and answers with the install source', async () => {
    const view = await inspect();
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({
      plugin: { name: 'pulse', version: '1.0.0' },
      repository: { state: 'none' },
      secrets: [],
    });
    expect(
      view.body.data.changes
        .map((change: { path: string }) => change.path)
        .sort(),
    ).toEqual(['index.ts', 'plugin.json']);

    const published = await publish({
      message: 'Publish pulse 1.0.0',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(published.status).toBe(201);
    const data = published.body.data;
    expect(data).toMatchObject({
      plugin: { name: 'pulse', version: '1.0.0' },
      branch: 'main',
      remote: { name: 'origin', url: REMOTE_URL },
      installSource: REMOTE_URL,
      installSourceDerived: false,
      installCommand: `station plugin install ${REMOTE_URL}`,
    });
    // The commit the route reports is the one the remote now holds.
    expect(bareHeads()).toBe(`refs/heads/main ${data.commit}`);
    expect(run(bare, ['log', '-1', '--format=%s', 'main'])).toBe(
      'Publish pulse 1.0.0',
    );
    expect(
      run(bare, ['ls-tree', '--name-only', 'main']).split('\n').sort(),
    ).toEqual(['index.ts', 'plugin.json']);

    const after = await inspect();
    expect(after.body.data.repository).toMatchObject({
      state: 'root',
      branch: 'main',
      hasCommits: true,
      remotes: [
        {
          name: 'origin',
          url: REMOTE_URL,
          usable: true,
          installSource: REMOTE_URL,
        },
      ],
    });
    expect(after.body.data.changes).toEqual([]);
  });

  test('never force-pushes over commits the remote has and the folder does not', async () => {
    const first = await publish({
      message: 'First',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(first.status).toBe(201);

    // Someone else pushes to the same remote.
    const other = join(root, 'other');
    run(root, ['clone', '--quiet', bare, other]);
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    run(other, ['add', 'theirs.txt']);
    run(other, ['commit', '--quiet', '-m', 'Theirs']);
    run(other, ['push', '--quiet', 'origin', 'main']);
    const theirs = run(other, ['rev-parse', 'HEAD']);

    writeFileSync(join(folder, 'index.ts'), 'export const v = 2;\n');
    const refused = await publish({ message: 'Mine', remoteName: 'origin' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('push-rejected');
    expect(bareHeads()).toBe(`refs/heads/main ${theirs}`);
  });

  test('refuses to replace an existing remote’s address', async () => {
    run(folder, ['init', '--quiet']);
    run(folder, [
      'remote',
      'add',
      'origin',
      'https://git.example.test/acme/other.git',
    ]);
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(refused.body.code).toBe('remote-mismatch');
    expect(run(folder, ['remote', 'get-url', 'origin'])).toBe(
      'https://git.example.test/acme/other.git',
    );
  });

  test('refuses a folder nested inside another repository', async () => {
    run(root, ['init', '--quiet']);
    const view = await inspect();
    expect(view.body.data.repository).toEqual({ state: 'nested' });
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(refused.body.code).toBe('nested-repository');
    expect(bareHeads()).toBe('');
  });

  test('refuses a folder that is not a plugin', async () => {
    rmSync(join(folder, 'plugin.json'));
    expect((await inspect()).body.data).toEqual({
      plugin: null,
      reason: 'not-a-plugin',
    });
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(refused.body.code).toBe('not-a-plugin');
    expect(existsSync(join(folder, '.git'))).toBe(false);
  });
});

describe('the folder cannot run code as the operator (review H1/H2)', () => {
  function marker(name: string): string {
    return join(root, `${name}-ran`);
  }

  test('viewing (summary) and inspecting a folder with core.fsmonitor runs nothing, and names the key', async () => {
    run(folder, ['init', '--quiet']);
    run(folder, ['config', 'core.fsmonitor', `touch '${marker('fsmonitor')}'`]);
    const summary = await appFor(OPERATOR).request(
      '/api/projects/pulse/plugin-publish?view=summary',
    );
    expect(((await summary.json()) as any).data).toEqual({
      plugin: { name: 'pulse', version: '1.0.0' },
    });
    const view = await inspect();
    expect(view.body.data.repository).toEqual({
      state: 'refused',
      code: 'repository-config-refused',
      keys: ['core.fsmonitor'],
    });
    expect(existsSync(marker('fsmonitor'))).toBe(false);
  });

  test('publishing refuses a repo-local url.insteadOf to ext:: and runs nothing', async () => {
    const script = join(root, 'ext.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker('ext')}'\n`, {
      mode: 0o755,
    });
    run(folder, ['init', '--quiet']);
    run(folder, ['config', `url.ext::sh ${script} .insteadOf`, REMOTE_URL]);
    run(folder, ['config', 'protocol.ext.allow', 'always']);
    run(folder, ['remote', 'add', 'origin', REMOTE_URL]);
    const refused = await publish({ message: 'Publish', remoteName: 'origin' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('repository-config-refused');
    expect(refused.body.keys).toEqual([
      'protocol.ext.allow',
      `url.ext::sh ${script} .insteadof`,
    ]);
    expect(existsSync(marker('ext'))).toBe(false);
    expect(bareHeads()).toBe('');
  });

  test('publishing with a repo-local core.sshCommand is refused and runs nothing', async () => {
    run(folder, ['init', '--quiet']);
    run(folder, ['config', 'core.sshCommand', `touch '${marker('ssh')}'`]);
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: 'git@github.com:acme/pulse.git',
    });
    expect(refused.body.code).toBe('repository-config-refused');
    expect(existsSync(marker('ssh'))).toBe(false);
  });

  test('hooks planted in .git/hooks do not run when publishing', async () => {
    run(folder, ['init', '--quiet']);
    for (const hook of [
      'pre-commit',
      'commit-msg',
      'post-commit',
      'pre-push',
    ]) {
      writeFileSync(
        join(folder, '.git', 'hooks', hook),
        `#!/bin/sh\ntouch '${marker(hook)}'\n`,
        { mode: 0o755 },
      );
    }
    const published = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(published.status).toBe(201);
    for (const hook of [
      'pre-commit',
      'commit-msg',
      'post-commit',
      'pre-push',
    ]) {
      expect(existsSync(marker(hook))).toBe(false);
    }
  });

  test('a .git file pointing elsewhere is refused before git runs', async () => {
    const elsewhere = join(root, 'elsewhere');
    run(root, ['init', '--quiet', elsewhere]);
    writeFileSync(join(folder, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`);
    expect((await inspect()).body.data.repository).toEqual({
      state: 'refused',
      code: 'git-dir-not-directory',
    });
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(refused.body.code).toBe('git-dir-not-directory');
  });

  test('a .git git cannot read is refused, never re-initialised (review M2)', async () => {
    mkdirSync(join(folder, '.git'));
    writeFileSync(
      join(folder, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n',
    );
    expect((await inspect()).body.data.repository).toEqual({
      state: 'refused',
      code: 'repository-unreadable',
    });
    const refused = await publish({
      message: 'Publish',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
    });
    expect(refused.body.code).toBe('repository-unreadable');
    expect(existsSync(join(folder, '.git', 'HEAD'))).toBe(false);
  });

  test('the file-transport allowance cannot be switched on outside tests', () => {
    vi.stubEnv('VITEST', '');
    expect(() =>
      createPluginPublishRoutes({
        getWorkspacePath: () => folder,
        testOnlyAllowFileTransport: true,
      }),
    ).toThrow(/for tests/);
  });
});
