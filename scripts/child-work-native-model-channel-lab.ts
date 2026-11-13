/** Opt-in kernel/channel prerequisite. No native-engine, billing or authority qualification. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { NativeModelContainer } from '../src-server/services/connections/native-model-container.js';
import { runLabCommand } from './lib/local-collaboration-process.mjs';

if (!process.argv.includes('--run-real-local-lab'))
  throw new Error(
    'Pass --run-real-local-lab to build an isolated model-channel image and start its owned container.',
  );
const base =
  'node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const root = resolve(import.meta.dirname, '..');
const artifacts = realpathSync(
  mkdtempSync(join(tmpdir(), 'child-work-native-model-container-')),
);
const context = join(artifacts, 'image');
const dockerConfig = join(artifacts, 'docker-config');
for (const directory of [context, dockerConfig])
  mkdirSync(directory, { mode: 0o700 });
writeFileSync(join(dockerConfig, 'config.json'), '{}\n', {
  flag: 'wx',
  mode: 0o600,
});
const controllerCanary = `host-only-${randomUUID()}`;
const requests: unknown[] = [];
let deliveries = 0;
const receipt: Record<string, unknown> = {
  sourceHead: process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD,
  driverSha256: createHash('sha256')
    .update(readFileSync(import.meta.filename))
    .digest('hex'),
  baseImage: base,
  nativeEngineQualified: false,
  portableAuthorityQualified: false,
  providerBillingQualified: false,
  requests,
};
const save = () =>
  writeFileSync(
    join(artifacts, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
let container: NativeModelContainer | undefined;
try {
  assert.match(
    process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD ?? '',
    /^[a-f0-9]{40}$/,
  );
  const docker = process.env.CHILD_WORK_DOCKER_EXECUTABLE;
  assert.ok(docker && docker.startsWith('/'));
  const endpoint = process.env.CHILD_WORK_DOCKER_ENDPOINT;
  assert.ok(endpoint);
  assert.ok(endpoint.startsWith('unix:///'));
  const prefix = ['--host', endpoint, '--config', dockerConfig];
  await build({
    entryPoints: [
      join(
        root,
        'src-server/services/connections/native-model-stdio-worker.ts',
      ),
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: join(context, 'native-model-worker.mjs'),
    legalComments: 'eof',
    logLevel: 'silent',
  });
  receipt.workerSha256 = createHash('sha256')
    .update(readFileSync(join(context, 'native-model-worker.mjs')))
    .digest('hex');
  writeFileSync(
    join(context, 'Dockerfile'),
    `FROM ${base}\nCOPY native-model-worker.mjs /station/native-model-worker.mjs\nUSER 10000:10001\n`,
  );
  // This explicit lab owns the cache addition. Serving creation always uses --pull=never.
  await runLabCommand(docker, [...prefix, 'pull', base], root, 120_000);
  const iidFile = join(artifacts, 'image-id');
  await runLabCommand(
    docker,
    [
      ...prefix,
      'build',
      '--network',
      'none',
      '--pull=false',
      '--iidfile',
      iidFile,
      context,
    ],
    root,
    120_000,
  );
  const imageId = readFileSync(iidFile, 'utf8').trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  receipt.imageId = imageId;
  container = NativeModelContainer.prepare({
    namespaceId: `model-probe-${randomUUID()}`,
    imageId,
    dockerExecutable: docker,
    endpoint,
    controllerRoot: artifacts,
    request: (input, signal) => {
      signal.throwIfAborted();
      assert.equal(input.method, 'POST');
      assert.equal(input.path, '/v1/messages');
      assert.deepEqual(JSON.parse(input.body.toString('utf8')), {
        model: 'fixture',
        input: 'model channel probe',
      });
      assert.ok(!JSON.stringify(input).includes(controllerCanary));
      requests.push({
        path: input.path,
        headers: input.headers,
        bodySha256: createHash('sha256').update(input.body).digest('hex'),
      });
      return {
        response: Promise.resolve(
          new Response('MODEL_CHANNEL_REPLY', {
            headers: { 'content-type': 'text/plain' },
          }),
        ),
        settled: Promise.resolve(),
        invokeDelivery: async (write) => {
          deliveries++;
          write();
        },
      };
    },
  });
  await container.start();
  const connection = container.connection();
  const probe = `
    const fs = require('node:fs');
    const net = require('node:net');
    (async () => {
      const reply = await fetch(process.env.NATIVE_MODEL_URL + '/v1/messages', {method:'POST',headers:{authorization:'Bearer '+process.env.NATIVE_MODEL_KEY},body:JSON.stringify({model:'fixture',input:'model channel probe'})});
      const model = await reply.text();
      let rootWrite;try{fs.writeFileSync('/forbidden-native-probe','x');rootWrite='allowed';}catch(error){rootWrite=error.code;}
      fs.writeFileSync('/workspace/native-probe.txt','private staged data');
      const egress = await new Promise((done,reject)=>{const socket=net.connect({host:'203.0.113.1',port:443});socket.once('connect',()=>{socket.destroy();done('connected');});socket.once('error',(error)=>done(error.code));socket.setTimeout(1000,()=>{socket.destroy();done('timeout');});});
      process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),model,status:reply.status,rootWrite,egress,canary:process.env.HOST_CONTROLLER_CANARY??null,dockerSocket:fs.existsSync('/var/run/docker.sock')}));
    })().catch(()=>{process.exitCode=1;});`;
  // The scoped bridge key is transferred through this owned command's env, never argv.
  const runner = join(artifacts, 'probe.mjs');
  writeFileSync(
    runner,
    `import {spawn} from 'node:child_process';
    import {executeOwnedCommand,captureOwnedProcessOutput,terminateSuiteExecution,waitForSuiteSettlement} from ${JSON.stringify(new URL('./lib/owned-process.mjs', import.meta.url).href)};
    const execution=executeOwnedCommand(${JSON.stringify(docker)},${JSON.stringify([...prefix, 'exec', '--user', '10001:10001', '--env', 'NATIVE_MODEL_URL', '--env', 'NATIVE_MODEL_KEY', connection.containerId, '/usr/local/bin/node', '-e', probe])},spawn,'native container probe',{env:{PATH:process.env.PATH,HOME:${JSON.stringify(artifacts)},NATIVE_MODEL_URL:${JSON.stringify(connection.baseUrl)},NATIVE_MODEL_KEY:${JSON.stringify(connection.token)},HOST_CONTROLLER_CANARY:${JSON.stringify(controllerCanary)}},stdio:['ignore','pipe','pipe']});
    const capture=captureOwnedProcessOutput(execution,{maxBytes:65536});let timer;
    try{const terminal=await Promise.race([execution.completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('probe deadline')),10000);})]);if(terminal.status!==0)throw Error('probe failed');}
    finally{clearTimeout(timer);const stopped=await terminateSuiteExecution(execution,{waitForSuiteSettlement,terminationGraceMs:2000,terminationForceMs:2000,processLabel:'native container probe'});if(!stopped.settled||stopped.errors.length)throw Error('probe unsettled');}
    const result=capture.finish();if(result.truncated||result.invalidUtf8)throw Error('probe output invalid');process.stdout.write(result.stdout.text);`,
  );
  const result = JSON.parse(
    (await runLabCommand(process.execPath, [runner], root, 15_000)).stdout,
  );
  receipt.probe = result;
  assert.equal(result.status, 200);
  assert.equal(result.model, 'MODEL_CHANNEL_REPLY');
  assert.equal(result.uid, 10001);
  assert.equal(result.gid, 10001);
  assert.equal(result.rootWrite, 'EROFS');
  assert.equal(result.egress, 'ENETUNREACH');
  assert.equal(result.canary, null);
  assert.equal(result.dockerSocket, false);
  assert.equal(requests.length, 1);
  assert.ok(deliveries >= 3);
  receipt.deliveries = deliveries;
  await container.close();
  receipt.closed = container.inspect();
  assert.equal(container.inspect().removed, true);
  assert.equal(container.inspect().modelChannel?.pending, 0);
  receipt.status = 'PASS_SCOPED_CONTAINER_MODEL_CHANNEL';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure =
    error instanceof Error
      ? { message: error.message, stack: error.stack, cause: error.cause }
      : String(error);
  process.exitCode = 1;
} finally {
  if (container)
    try {
      await container.close();
    } catch (error) {
      receipt.cleanupFailure = String(error);
      receipt.status = 'FAIL';
      process.exitCode = 1;
    }
  save();
  process.stdout.write(
    `${JSON.stringify({ artifacts, status: receipt.status })}\n`,
  );
}
