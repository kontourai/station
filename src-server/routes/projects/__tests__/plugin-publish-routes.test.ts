/**
 * `/api/projects/:slug/plugin-publish` over the real handlers and real git
 * (#2374, epic #2323 S6).
 *
 * The one stub is `resolvePrincipal`, which is how a test states who is
 * calling; the operator check, the remote guard, the folder walk, the secret
 * check and every git command are production code. "The remote" is a bare
 * repository in a temp folder, reached through an `insteadOf` rewrite in a
 * throwaway global git config, so the route validates an ordinary https
 * address while the push really lands somewhere this test can read back.
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

function bareHeads(): string {
  return run(bare, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'station-plugin-publish-route-'));
  folder = join(root, 'pulse');
  bare = join(root, 'remote.git');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({ name: 'pulse', version: '1.0.0' }),
  );
  writeFileSync(join(folder, 'index.ts'), 'export {};\n');
  run(root, ['init', '--quiet', '--bare', bare]);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(
    globalConfig,
    [
      '[user]',
      '\tname = Station Operator',
      '\temail = operator@example.test',
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

function appFor(caller: PrincipalRef) {
  const app = new Hono();
  app.route(
    '/api/projects/:slug/plugin-publish',
    createPluginPublishRoutes({
      getWorkspacePath: () => folder,
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

async function inspect(caller: PrincipalRef = OPERATOR, query = '') {
  const response = await appFor(caller).request(
    `/api/projects/pulse/plugin-publish${query}`,
  );
  return { status: response.status, body: (await response.json()) as any };
}

const BODY = { remoteUrl: REMOTE_URL, branch: 'main', message: 'Publish' };

describe('operator-only', () => {
  test('a collaborator is refused on both routes and nothing is pushed', async () => {
    expect((await inspect(COLLABORATOR)).status).toBe(403);
    expect((await inspect(COLLABORATOR, '?view=summary')).status).toBe(403);
    const refused = await publish(BODY, COLLABORATOR);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Only the Station operator');
    expect(bareHeads()).toBe('');
  });

  test('the operator check runs before body validation', async () => {
    const refused = await publish({ nonsense: true }, COLLABORATOR);
    expect(refused.status).toBe(403);
  });
});

describe('remote address guard', () => {
  test.each([
    ['file:///tmp/bare.git', 'unsupported-transport'],
    ['/tmp/bare.git', 'unsupported-transport'],
    ['ext::sh%20-c%20id', 'unsupported-transport'],
    ['http://git.example.test/acme/pulse.git', 'unsupported-transport'],
    ['https://ghp_token@git.example.test/acme/pulse.git', 'credentials-in-url'],
    ['https://user:pass@git.example.test/acme/pulse.git', 'credentials-in-url'],
    ['https://127.0.0.1/acme/pulse.git', 'local-host'],
  ])('refuses %s', async (remoteUrl, code) => {
    const refused = await publish({ ...BODY, remoteUrl });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(code);
    expect(bareHeads()).toBe('');
  });

  test('refuses the real bare repository by path, the local push the rewrite stands in for', async () => {
    const refused = await publish({ ...BODY, remoteUrl: bare });
    expect(refused.body.code).toBe('unsupported-transport');
    expect(bareHeads()).toBe('');
  });

  test('refuses a branch name git would read as something else', async () => {
    for (const branch of ['-f', '../main', 'a..b', 'x.lock', 'a/.hidden']) {
      const refused = await publish({ ...BODY, branch });
      expect(refused.body.code).toBe('invalid-branch');
    }
    expect(bareHeads()).toBe('');
  });
});

describe('publishing', () => {
  test('the summary names the plugin; the inspection lists what would be published', async () => {
    expect((await inspect(OPERATOR, '?view=summary')).body.data).toEqual({
      plugin: { name: 'pulse', version: '1.0.0' },
    });
    writeFileSync(join(folder, '.env'), 'TOKEN=x\n');
    const view = await inspect();
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({
      plugin: { name: 'pulse', version: '1.0.0' },
      files: [
        { path: '.env', size: 8 },
        { path: 'index.ts', size: 11 },
        { path: 'plugin.json' },
      ],
      skipped: [],
      secrets: [{ path: '.env', reason: 'environment file' }],
      refusal: {
        code: 'secrets',
        message: expect.stringContaining('look like secrets'),
      },
    });
    expect(bareHeads()).toBe('');
  });

  test('the operator publishes: 201 with the commit and the install command', async () => {
    const published = await publish(BODY);
    expect(published.status).toBe(201);
    expect(published.body.data).toMatchObject({
      plugin: { name: 'pulse', version: '1.0.0' },
      parent: null,
      branch: 'main',
      remoteUrl: REMOTE_URL,
      committer: { name: 'Station Operator', email: 'operator@example.test' },
      installSource: REMOTE_URL,
      installCommand: `station plugin install ${REMOTE_URL}`,
    });
    expect(bareHeads()).toBe(`refs/heads/main ${published.body.data.commit}`);
    // An export: the folder gains no repository.
    expect(existsSync(join(folder, '.git'))).toBe(false);
  });

  test('a refusal answers a fixed sentence and names the files', async () => {
    writeFileSync(join(folder, '.gitattributes'), '*.png filter=lfs\n');
    const refused = await publish(BODY);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      success: false,
      code: 'filter-attributes',
      paths: ['.gitattributes'],
      error: expect.stringContaining('Git LFS'),
    });
  });

  test('the file transport cannot be enabled outside Vitest', () => {
    vi.stubEnv('VITEST', 'false');
    expect(() =>
      createPluginPublishRoutes({
        getWorkspacePath: () => folder,
        testOnlyAllowFileTransport: true,
      }),
    ).toThrow(/for tests/);
  });
});
