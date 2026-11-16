import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  PromotionGithubClient,
  publicationIdentity,
} from '../release-promotion.mjs';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

const temporary = trackTempDirs();
const cli = resolve(import.meta.dirname, '../release-promotion.mjs');

test.each([
  ['rc', 'v0.2.0-rc.3', 'v0.2.0-rc.3'],
  ['promote', 'v0.2.0-rc.3', 'v0.2.0'],
  ['stable', 'v0.2.0', 'v0.2.0'],
])(
  'the real publication CLI resolves %s without provider credentials or effects',
  { timeout: FIXTURE_TEST_TIMEOUT_MS },
  async (mode, tag, publicationTag) => {
    const result = await runBoundedFixture(
      process.execPath,
      [cli, 'identity', '--mode', mode, '--tag', tag],
      {
        env: {
          ...process.env,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          GOOGLE_PLAY_ACCESS_TOKEN: '',
          APPLE_API_PRIVATE_KEY: '',
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mode,
      producerTag: tag,
      publicationTag,
      version: '0.2.0',
    });
  },
);

test.each([
  ['rc', 'v0.2.0'],
  ['promote', 'v0.2.0'],
  ['stable', 'v0.2.0-rc.3'],
  ['rc', 'v0.2.0-rc.0'],
  ['rc', 'v0.2.0-rc.99'],
  ['rc', 'v0.2.0-preview.3'],
  ['unknown', 'v0.2.0'],
])('rejects %s/%s before publication', (mode, tag) => {
  expect(() => publicationIdentity(mode, tag)).toThrow();
});

test('GitHub transfer streams the unchanged file to the fixed upload origin and sends no metadata-supplied URL', async () => {
  const directory = temporary('station-promotion-upload-');
  const bytes = Buffer.from('exact candidate bytes\n');
  const name = 'station-v0.2.0-rc.3-windows-x86_64.msi';
  writeFileSync(join(directory, name), bytes);
  const request = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input);
    expect(url).toBe(
      `https://uploads.github.com/repos/kontourai/station/releases/23/assets?name=${name}`,
    );
    expect(options?.method).toBe('POST');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer fixture-token',
      'Content-Length': String(bytes.length),
    });
    expect(
      Buffer.from(await new Response(options?.body).arrayBuffer()),
    ).toEqual(bytes);
    return Response.json({
      name,
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  });
  const client = new PromotionGithubClient({
    repository: 'kontourai/station',
    token: 'fixture-token',
    request,
  });
  await expect(
    client.upload(23, { name, size: bytes.length }, directory),
  ).resolves.toMatchObject({ name, size: bytes.length });
  expect(request).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(directory, name))).toEqual(bytes);
});

test('final tag creation uses create-only refs rather than a ref update or repository push', async () => {
  const request = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input);
    expect(url).toBe('https://api.github.com/repos/kontourai/station/git/refs');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({
      ref: 'refs/tags/v0.2.0',
      sha: 'a'.repeat(40),
    });
    return Response.json({ ref: 'refs/tags/v0.2.0' });
  });
  const client = new PromotionGithubClient({
    repository: 'kontourai/station',
    token: 'fixture-token',
    request,
  });
  await client.createRef('v0.2.0', 'a'.repeat(40));
  expect(request).toHaveBeenCalledTimes(1);
});

test('GitHub metadata redirects and non-success responses fail without credential-bearing follow-up calls', async () => {
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response('', {
        status: 302,
        headers: { location: 'https://foreign.invalid/credential-sink' },
      }),
  );
  const client = new PromotionGithubClient({
    repository: 'kontourai/station',
    token: 'fixture-token',
    request,
  });
  await expect(client.release('v0.2.0-rc.3')).rejects.toThrow('status 302');
  expect(request).toHaveBeenCalledTimes(1);
});

const repository = resolve(import.meta.dirname, '../..');
const publishWorkflow = load(
  readFileSync(
    join(repository, '.github/workflows/publish-release.yml'),
    'utf8',
  ),
) as {
  jobs: { resolve: { steps: Array<{ name?: string; run?: string }> } };
};
const sourceResolve = publishWorkflow.jobs.resolve.steps.find(
  (step) => step.name === 'Resolve tag to one immutable commit',
)?.run;
const branchGuard = publishWorkflow.jobs.resolve.steps.find(
  (step) =>
    step.name === 'Require the protected default-branch publication policy',
)?.run;

function resolutionFixture(mode: string, branch = 'refs/heads/main') {
  const cwd = temporary('station-publication-resolve-');
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  symlinkSync(repository, join(cwd, 'release-policy'), 'dir');
  const log = join(cwd, 'calls');
  writeFileSync(log, '');
  const output = join(cwd, 'output');
  writeFileSync(output, '');
  const version = JSON.parse(
    readFileSync(join(repository, 'package.json'), 'utf8'),
  ).version;
  const tag = mode === 'stable' ? `v${version}` : `v${version}-rc.3`;
  const executable = (name: string, source: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${source}`);
    chmodSync(path, 0o755);
  };
  executable(
    'git',
    `
const {appendFileSync}=await import('node:fs');
const args=process.argv.slice(2);appendFileSync(process.env.CALL_LOG,'git '+args.join(' ')+'\\n');
if(args[0]==='-C')args.splice(0,2);
if(args[0]==='fetch')process.exit(0);
if(args[0]==='rev-parse'){console.log('c'.repeat(40));process.exit(0);}
if(args[0]==='rev-list'){console.log('a'.repeat(40));process.exit(0);}
if(args[0]==='show'){console.log('1750000000');process.exit(0);}
process.exit(8);`,
  );
  executable(
    'gh',
    `
const {appendFileSync}=await import('node:fs');
const args=process.argv.slice(2);appendFileSync(process.env.CALL_LOG,'gh '+args.join(' ')+'\\n');
if(args[0]!=='release'||args[1]!=='view')process.exit(9);
if(args[2]===process.env.RELEASE_TAG){console.log(JSON.stringify({isDraft:process.env.RELEASE_MODE!=='promote',isPrerelease:process.env.RELEASE_MODE!=='stable'}));process.exit(0);}
if(process.env.REPAIR_APP_STORE_FEED_ONLY==='true' && args[2]===process.env.RELEASE_TAG.replace(/-rc\\.[0-9]+$/, '')){if(process.env.FINAL_RELEASE_MISSING==='true')process.exit(1);console.log(JSON.stringify({isDraft:process.env.FINAL_RELEASE_DRAFT==='true',isPrerelease:false}));process.exit(0);}
if(process.env.RELEASE_MODE==='rc')process.exit(91);
console.log(JSON.stringify({isDraft:false,assets:[{name:'latest.json'}]}));`,
  );
  executable(
    'base64',
    `let value='';for await(const part of process.stdin)value+=part;process.stdout.write(Buffer.from(value).toString('base64'));`,
  );
  return {
    cwd,
    log,
    output,
    tag,
    version,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CALL_LOG: log,
      GITHUB_REPOSITORY: 'kontourai/station',
      GITHUB_REF: branch,
      DEFAULT_BRANCH: 'main',
      GITHUB_SHA: 'd'.repeat(40),
      GITHUB_OUTPUT: output,
      GH_TOKEN: 'fixture-token',
      RELEASE_TAG: tag,
      RELEASE_MODE: mode,
      ALLOW_PUBLISHED_POINTER_REPAIR: 'false',
      ALLOW_EMPTY_UPDATER_CHANNEL_BOOTSTRAP: 'false',
    },
  };
}

test.each([
  'published',
  'draft',
  'missing',
  'combined-desktop-repair',
  'wrong-mode',
])(
  'App Store feed-only resolution admits only a completed published promotion: %s',
  { timeout: FIXTURE_TEST_TIMEOUT_MS },
  async (scenario) => {
    const f = resolutionFixture(
      scenario === 'wrong-mode' ? 'stable' : 'promote',
    );
    if (!sourceResolve || !branchGuard)
      throw new Error('missing publication resolve boundary');
    const result = await runBoundedFixture(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        `${branchGuard}\n${sourceResolve}`,
      ],
      {
        cwd: f.cwd,
        env: {
          ...f.env,
          REPAIR_APP_STORE_FEED_ONLY: 'true',
          FINAL_RELEASE_DRAFT: scenario === 'draft' ? 'true' : 'false',
          FINAL_RELEASE_MISSING: scenario === 'missing' ? 'true' : 'false',
          ALLOW_PUBLISHED_POINTER_REPAIR:
            scenario === 'combined-desktop-repair' ? 'true' : 'false',
        },
      },
    );
    if (scenario === 'published') {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(f.output, 'utf8')).toContain(
        'pointer_repair_only=true',
      );
      expect(readFileSync(f.log, 'utf8')).not.toContain('stable-desktop');
    } else expect(result.status).not.toBe(0);
  },
);

test.each(['rc', 'promote', 'stable'])(
  'actual %s resolution preserves producer authority and isolates RC pointer preflights',
  { timeout: FIXTURE_TEST_TIMEOUT_MS },
  async (mode) => {
    const f = resolutionFixture(mode);
    if (!sourceResolve || !branchGuard)
      throw new Error('missing real publication resolve steps');
    const result = await runBoundedFixture(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        `${branchGuard}\n${sourceResolve}`,
      ],
      { cwd: f.cwd, env: f.env },
    );
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(f.output, 'utf8');
    expect(output).toContain(`sha=${'a'.repeat(40)}\n`);
    expect(output).toContain(
      `publication_tag=${mode === 'promote' ? `v${f.version}` : f.tag}\n`,
    );
    expect(output).toContain(`version=${f.version}\n`);
    expect(output).toContain(`policy_sha=${'c'.repeat(40)}\n`);
    const calls = readFileSync(f.log, 'utf8');
    expect(calls).not.toContain('git push');
    expect(calls).not.toContain('update-ref');
    if (mode === 'rc')
      expect(calls).not.toContain('release view stable-desktop');
    else expect(calls).toContain('release view stable-desktop');
  },
);

test('non-default-branch dispatch stops before even read-only GitHub or tag resolution', {
  timeout: FIXTURE_TEST_TIMEOUT_MS,
}, async () => {
  const f = resolutionFixture('rc', 'refs/heads/untrusted');
  if (!sourceResolve || !branchGuard)
    throw new Error('missing real publication resolve steps');
  const result = await runBoundedFixture(
    'bash',
    ['-e', '-c', `${branchGuard}\n${sourceResolve}`],
    { cwd: f.cwd, env: f.env },
  );
  expect(result.status).toBe(1);
  expect(readFileSync(f.log, 'utf8')).toBe('');
});
