/** Opt-in, create-only Docker lifecycle controls. No worker, native engine or model runs. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeModelContainer } from '../src-server/services/connections/native-model-container.js';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { acquireHeavyCheckSlot } from './lib/heavy-check-slots.mjs';
import { runLabCommand } from './lib/local-collaboration-process.mjs';

if (!process.argv.includes('--run-real-local-lab'))
  throw Error(
    'Pass --run-real-local-lab to create and remove owned Docker fixtures.',
  );
const slot = await acquireHeavyCheckSlot({
  label: 'lab:native-container-lifecycle',
});
process.once('exit', slot.release);
const root = process.cwd();
const head = execFileSyncBounded('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
assert.match(
  process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD ?? '',
  /^[a-f0-9]{40}$/,
);
assert.equal(head, process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD);
const docker = process.env.CHILD_WORK_DOCKER_EXECUTABLE;
const endpointValue = process.env.CHILD_WORK_DOCKER_ENDPOINT;
const image = process.env.CHILD_WORK_DOCKER_IMAGE_ID;
assert.ok(docker && isAbsolute(docker));
assert.ok(endpointValue);
assert.ok(endpointValue.startsWith('unix:///'));
const endpoint = endpointValue;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const artifacts = realpathSync(
  mkdtempSync(join(tmpdir(), 'child-work-native-lifecycle-')),
);
const dockerConfig = join(artifacts, 'docker-config');
mkdirSync(dockerConfig, { mode: 0o700 });
writeFileSync(join(dockerConfig, 'config.json'), '{}\n', { mode: 0o600 });
const prefix = ['--host', endpoint, '--config', dockerConfig];
const command = async (args: string[]) =>
  (
    await runLabCommand(docker, [...prefix, ...args], root, 10_000)
  ).stdout.trim();
const daemon = await command(['info', '--format', '{{.ID}}']);
assert.ok(daemon);
assert.equal(
  await command(['image', 'inspect', image!, '--format', '{{.Id}}']),
  image,
);

type Created = { id: string; name: string; label: string };
type Events = { creates: Created[]; starts: number; removals: string[] };
type Control = {
  loseCreate: boolean;
  holdCreate: boolean;
  releaseCreate: boolean;
};
const receipt: {
  sourceHead: string;
  sourceSha256s: Record<string, string>;
  nativeEngineQualified: false;
  portableAuthorityQualified: false;
  modelRequests: number;
  controls: Array<{ name: string; passed: boolean }>;
  failure?: { phase: string; message: string };
  cleanupFailures: string[];
} = {
  sourceHead: head,
  sourceSha256s: Object.fromEntries(
    [
      'scripts/child-work-native-container-lifecycle-lab.ts',
      'src-server/services/connections/native-model-container.ts',
      'pnpm-lock.yaml',
    ].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    ]),
  ),
  nativeEngineQualified: false,
  portableAuthorityQualified: false,
  modelRequests: 0,
  controls: [],
  cleanupFailures: [],
};
const save = () =>
  writeFileSync(
    join(artifacts, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
let phase = 'prepare';

async function fixture(name: string, control: Control) {
  const directory = join(artifacts, name);
  mkdirSync(directory, { mode: 0o700 });
  const controllers = join(directory, 'controllers');
  mkdirSync(controllers, { mode: 0o700 });
  const config = join(directory, 'control.json');
  const events = join(directory, 'events.json');
  writeFileSync(config, JSON.stringify(control), { mode: 0o600 });
  writeFileSync(
    events,
    JSON.stringify({ creates: [], starts: 0, removals: [] }),
    { mode: 0o600 },
  );
  const wrapper = join(directory, 'docker.mjs');
  writeFileSync(
    wrapper,
    `#!${process.execPath}
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSyncBounded} from ${JSON.stringify(join(root, 'scripts/lib/bounded-capture.mjs'))};
const args=process.argv.slice(2), config=${JSON.stringify(config)}, events=${JSON.stringify(events)};
const read=()=>JSON.parse(fs.readFileSync(events,'utf8'));
const store=value=>fs.writeFileSync(events,JSON.stringify(value),{mode:0o600});
try {
  if(args[4]==='start'){const value=read();value.starts++;store(value);}
  const output=execFileSyncBounded(${JSON.stringify(docker)},args,{encoding:'utf8',timeout:8000,maxBuffer:65536});
  if(args[4]==='create'){
    const value=read(),id=output.trim();assert.match(id,/^[a-f0-9]{64}$/);
    value.creates.push({id,name:args[args.indexOf('--name')+1],label:args[args.indexOf('--label')+1]});store(value);
    const selected=JSON.parse(fs.readFileSync(config,'utf8'));
    if(selected.holdCreate){const until=Date.now()+3000;while(!JSON.parse(fs.readFileSync(config,'utf8')).releaseCreate){if(Date.now()>=until)throw Error('create barrier expired');await delay(10);}}
    if(selected.loseCreate){process.stderr.write('controlled lost create reply\\n');process.exitCode=73;}else process.stdout.write(output);
  }else{
    if(args[4]==='rm'){const value=read();value.removals.push(output.trim());store(value);}
    process.stdout.write(output);
  }
}catch(error){process.stderr.write(String(error.message)+'\\n');process.exitCode=1;}
`,
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);
  const container = NativeModelContainer.prepare({
    namespaceId: `${name}-${randomUUID()}`,
    imageId: image!,
    dockerExecutable: wrapper,
    endpoint,
    controllerRoot: controllers,
    request: () => {
      receipt.modelRequests++;
      throw Error('A create-only lifecycle control must never request a model');
    },
  });
  const read = (): Events => JSON.parse(readFileSync(events, 'utf8'));
  return { container, config, read };
}

async function inspect(created: Created) {
  assert.equal(await command(['info', '--format', '{{.ID}}']), daemon);
  const value = JSON.parse(
    await command([
      'inspect',
      '--type',
      'container',
      '--format',
      '{{json .}}',
      created.id,
    ]),
  );
  const [key, nonce] = created.label.split('=');
  assert.equal(key, 'station.native-model-owner');
  assert.ok(nonce);
  assert.equal(value.Id, created.id);
  assert.equal(value.Image, image);
  assert.equal(value.Config.Labels[key!], nonce);
  return value;
}

async function cleanup(created: Created) {
  assert.equal(await command(['info', '--format', '{{.ID}}']), daemon);
  const ids = await command([
    'container',
    'ls',
    '--all',
    '--no-trunc',
    '--filter',
    `id=${created.id}`,
    '--format',
    '{{.ID}}',
  ]);
  if (!ids) return;
  assert.equal(ids, created.id);
  await inspect(created);
  assert.equal(await command(['rm', '--force', created.id]), created.id);
}

async function run(
  name: string,
  control: Control,
  body: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  phase = name;
  const value = await fixture(name, control);
  try {
    await body(value);
    assert.equal(value.read().starts, 0);
    assert.equal(value.read().creates.length, 1);
    assert.equal(receipt.modelRequests, 0);
    receipt.controls.push({ name, passed: true });
  } finally {
    for (const created of value.read().creates) {
      try {
        await cleanup(created);
      } catch (error) {
        receipt.cleanupFailures.push(String(error));
      }
    }
    save();
  }
  assert.deepEqual(
    receipt.cleanupFailures,
    [],
    'owned fixtures must settle before the next control',
  );
}

try {
  await run(
    'cancel-during-create',
    { loseCreate: false, holdCreate: true, releaseCreate: false },
    async (f) => {
      const starting = f.container.start();
      void starting.catch(() => {});
      const until = Date.now() + 5000;
      while (!f.read().creates.length) {
        assert.ok(
          Date.now() < until,
          'actual Docker create must reach the held reply',
        );
        await delay(10);
      }
      const closing = f.container.close();
      void closing.catch(() => {});
      writeFileSync(
        f.config,
        JSON.stringify({
          loseCreate: false,
          holdCreate: true,
          releaseCreate: true,
        }),
      );
      await assert.rejects(starting, /native_container_already_retiring/);
      await closing;
      assert.equal(f.container.inspect().removed, true);
    },
  );
  await run(
    'lost-create-reply',
    { loseCreate: true, holdCreate: false, releaseCreate: false },
    async (f) => {
      await assert.rejects(
        f.container.start(),
        /native_container_command_failed/,
      );
      const created = f.read().creates[0];
      assert.ok(created, 'actual Docker create must precede reply loss');
      await inspect(created);
      assert.equal(f.container.inspect().containerId, undefined);
      await f.container.close();
      assert.equal(f.container.inspect().removed, true);
      assert.equal(f.container.inspect().containerId, created.id);
      assert.equal(f.read().removals.at(-1), created.id);
    },
  );
  await run(
    'foreign-name-refusal-and-retry',
    { loseCreate: true, holdCreate: false, releaseCreate: false },
    async (f) => {
      await assert.rejects(
        f.container.start(),
        /native_container_command_failed/,
      );
      const created = f.read().creates[0];
      assert.ok(created);
      await inspect(created);
      await command(['rename', created.id, `displaced-${randomUUID()}`]);
      const foreignLabel = `station.native-model-owner=${randomUUID()}`;
      const foreignId = await command([
        'create',
        '--pull=never',
        '--name',
        created.name,
        '--label',
        foreignLabel,
        '--network',
        'none',
        '--read-only',
        '--user',
        '10001:10001',
        '--entrypoint',
        '/usr/local/bin/node',
        image!,
      ]);
      assert.match(foreignId, /^[a-f0-9]{64}$/);
      const foreign = {
        id: foreignId,
        name: created.name,
        label: foreignLabel,
      };
      try {
        await assert.rejects(f.container.close());
        assert.equal(
          f.container.inspect().containerId,
          undefined,
          'foreign discovery must not become owned identity',
        );
        await inspect(foreign);
        assert.deepEqual(
          f.read().removals,
          [],
          'cleanup must not target a foreign nonce',
        );
      } finally {
        await cleanup(foreign);
        await command(['rename', created.id, created.name]);
      }
      await f.container.close();
      assert.equal(f.container.inspect().removed, true);
      assert.equal(f.container.inspect().containerId, created.id);
    },
  );
  await run(
    'absent-name-is-not-release',
    { loseCreate: true, holdCreate: false, releaseCreate: false },
    async (f) => {
      await assert.rejects(
        f.container.start(),
        /native_container_command_failed/,
      );
      const created = f.read().creates[0];
      assert.ok(created);
      await inspect(created);
      await cleanup(created);
      await assert.rejects(f.container.close());
      assert.equal(f.container.inspect().removed, false);
      assert.equal(f.container.inspect().containerId, undefined);
      assert.deepEqual(f.read().removals, []);
    },
  );
  assert.deepEqual(receipt.cleanupFailures, []);
} catch (error) {
  receipt.failure = { phase, message: String(error) };
  process.exitCode = 1;
} finally {
  save();
  console.log(JSON.stringify({ artifacts, ...receipt }));
}
