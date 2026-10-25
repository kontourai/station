import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempDisposableSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_MODEL_POLICY } from '../index.js';
import { openSqliteModelStorage } from '../sqlite.js';
import { key } from './fixture.js';
import { completedGeneration } from './r2-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const immutableBase = '17b366c0983d7e97715b6f24d2f182ce49bfaf36';
const immutableSources = [
  'sqlite',
  'codecs',
  'command-codec',
  'decisions',
  'encoding',
  'policy',
  'receipts',
  'records',
  'retention',
  'types',
];
const immutableGitEnvironment = {
  ...process.env,
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};
const gitVersion = spawnSync('git', ['--version'], {
  encoding: 'utf8',
  env: immutableGitEnvironment,
  windowsHide: true,
  maxBuffer: 64 * 1024,
});
const missingGit =
  gitVersion.error &&
  'code' in gitVersion.error &&
  gitVersion.error.code === 'ENOENT';
if (gitVersion.error && !missingGit) throw gitVersion.error;
if (!missingGit && gitVersion.status !== 0)
  throw Error('Unable to inspect Git version; not a compatibility verdict');
const version = /^git version (\d+)\.(\d+)\./.exec(gitVersion.stdout ?? '');
// Conservative execution prerequisite, not a claim about the first Git release supporting the variables.
const noFetchGit =
  version &&
  (Number(version[1]) > 2 ||
    (Number(version[1]) === 2 && Number(version[2]) >= 50));
const prerequisite =
  !missingGit && noFetchGit
    ? spawnSync('git', ['cat-file', '--batch-check'], {
        input: `${immutableSources.map((file) => `${immutableBase}:packages/agent-runtime/src/${file}.ts`).join('\n')}\n`,
        encoding: 'utf8',
        env: immutableGitEnvironment,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      })
    : null;
if (prerequisite?.error) throw prerequisite.error;
const missingCheckout =
  prerequisite &&
  prerequisite.status !== 0 &&
  prerequisite.stderr.includes('not a git repository');
if (prerequisite && !missingCheckout && prerequisite.status !== 0)
  throw Error(
    'Unable to inspect immutable Git prerequisite; this is not a compatibility verdict',
  );
const missingSources = prerequisite?.stdout
  .split('\n')
  .some((line) => line.endsWith(' missing'));
const skipReason = missingGit
  ? 'Git executable absent; immutable old-code compatibility NOT VERIFIED'
  : !noFetchGit
    ? 'Git 2.50+ required by the conservative no-lazy-fetch prerequisite; compatibility NOT VERIFIED'
    : missingCheckout || missingSources
      ? `immutable Git sources at ${immutableBase} absent (for example a shallow/source-only checkout); compatibility NOT VERIFIED`
      : null;
it.skipIf(skipReason !== null)(
  `immutable main code opened before and after the additive index still reads and writes the same format${skipReason ? `; prerequisite skip: ${skipReason}` : ''}`,
  async () => {
    const f = await completedGeneration();
    cleanup.push(() => f.close());
    const snapshot = () =>
      [
        'meta',
        'runs',
        'retired',
        'receipts',
        'outbox',
        'projection',
        'bodies',
      ].map((table) =>
        f.database
          .prepare(`SELECT * FROM agent_runtime_${table} ORDER BY rowid`)
          .all(),
      );
    const original = snapshot();
    f.database.exec('DROP INDEX agent_runtime_unresolved');
    const scratch = mkdtempDisposableSync(
      join(tmpdir(), 'runtime-old-format-'),
    );
    cleanup.push(async () => scratch.remove());
    for (const file of immutableSources) {
      writeFileSync(
        join(scratch.path, `${file}.ts`),
        execFileSync(
          'git',
          ['show', `${immutableBase}:packages/agent-runtime/src/${file}.ts`],
          {
            env: immutableGitEnvironment,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          },
        ),
      );
    }
    writeFileSync(
      join(scratch.path, 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    symlinkSync(
      resolve('node_modules'),
      join(scratch.path, 'node_modules'),
      'dir',
    );
    writeFileSync(
      join(scratch.path, 'runner.ts'),
      `
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {openSqliteModelStorage,openSqliteRuntimeBodies,openSqliteRuntimeProjection} from './sqlite.ts';
import {commandDigest} from './decisions.ts';
const fixture=JSON.parse(process.argv[2]);
const database=new DatabaseSync(fixture.path);
database.exec('PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL');
const options={database,policy:fixture.policy,host:()=>fixture.admission};
const bodies=openSqliteRuntimeBodies({database,policy:fixture.policy});
const storage=openSqliteModelStorage(options);
const projection=openSqliteRuntimeProjection({...options,bodies});
process.send('ready-before-index');
await once(process,'message');
const context={liveness:()=> 'live'};
const before=await storage.execute({type:'read',key:fixture.key},context);
const body=await bodies.read(fixture.ref);
const op={type:'cancel',key:fixture.key,expected:before.snapshot.fence,operationId:'old-writer-before-index'};
const write=await storage.execute({...op,digest:commandDigest(op)},context);
const rows=await storage.execute({type:'listOutbox',key:fixture.key,limit:10},context);
await projection.apply(rows.entries[0]);
const projected=await projection.readAudit(fixture.key);
const fresh=openSqliteModelStorage(options);
const freshBodies=openSqliteRuntimeBodies({database,policy:fixture.policy});
const freshProjection=openSqliteRuntimeProjection({...options,bodies});
const projectedFresh=await freshProjection.readAudit(fixture.key);
const after=await fresh.execute({type:'read',key:fixture.key},context);
const raw=new TextEncoder().encode('{"type":"text-delta","id":"old","delta":"OLD"}');
const ref=await freshBodies.put('runtime-ai-sdk-v3-part/1',raw);
const read=await freshBodies.read(ref);
const open={type:'open',spec:after.snapshot.spec,owner:after.snapshot.fence.owner,operationId:'old-writer-after-index'};
const again=await fresh.execute({...open,digest:commandDigest(open)},context);
process.send({before:before.kind,body:body.length,write:write.kind,after:after.snapshot.state,bodyWrite:new TextDecoder().decode(read),again:again.kind,oldProjection:projected.length,freshProjection:projectedFresh.length});
await projection.close();await freshProjection.close();await fresh.close();await freshBodies.close();await storage.close();await bodies.close();database.close();process.disconnect();
`,
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(scratch.path, 'runner.ts'),
        JSON.stringify({
          path: f.path,
          policy: DEFAULT_MODEL_POLICY,
          admission: f.admission,
          key,
          ref: f.pin.request,
        }),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: immutableGitEnvironment,
        windowsHide: true,
      },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    });
    const message = () =>
      new Promise<unknown>((resolveMessage, reject) => {
        const onMessage = (value: unknown) => {
          child.off('exit', onExit);
          resolveMessage(value);
        };
        const onExit = () => {
          child.off('message', onMessage);
          reject(Error(`immutable runner exited: ${stderr}`));
        };
        child.once('message', onMessage);
        child.once('exit', onExit);
      });
    expect(await message()).toBe('ready-before-index');
    const current = openSqliteModelStorage({
      database: f.database,
      policy: DEFAULT_MODEL_POLICY,
      host: f.host,
    });
    cleanup.push(() => current.close());
    expect(snapshot()).toEqual(original);
    const answer = message();
    const exited = once(child, 'exit');
    child.send('index-created');
    expect(await answer).toEqual({
      before: 'found',
      body: f.pin.request.byteLength,
      write: 'applied',
      after: 'cancelled',
      bodyWrite: '{"type":"text-delta","id":"old","delta":"OLD"}',
      again: 'existing',
      oldProjection: 1,
      freshProjection: 1,
    });
    expect((await exited)[0]).toBe(0);
    expect(
      await current.execute({ type: 'read', key }, f.context),
    ).toMatchObject({ kind: 'found', snapshot: { state: 'cancelled' } });
  },
);
