/** Opt-in kernel/channel prerequisite. No native-engine, billing or authority qualification. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { build } from 'esbuild';
import { NativeModelContainer } from '../src-server/services/connections/native-model-container.js';
import { runLabCommand } from './lib/local-collaboration-process.mjs';

if (!process.argv.includes('--run-real-local-lab'))
  throw new Error(
    'Pass --run-real-local-lab to build an isolated model-channel image and start its owned container.',
  );
const base =
  'node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const includeEngines = process.argv.includes('--with-native-engines');
const engines = [
  {
    name: 'claude',
    version: '2.1.322',
    url: 'https://unpkg.com/@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.322/claude',
    bytes: 341501368,
    sha256: 'f220ca50ea4f3222043ff83cc224a1262e0196e9897acc0871efa94235b0c1fd',
  },
  {
    name: 'codex',
    version: '0.167.0',
    url: 'https://unpkg.com/@openai/codex@0.167.0-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex',
    bytes: 278794648,
    sha256: Buffer.from(
      'L+lNhIVA/ypoaMfrzElBJql0qkCXEWdtFPoDeeSeYUM=',
      'base64',
    ).toString('hex'),
  },
] as const;
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
let currentEngine: string | undefined;
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
  if (includeEngines) {
    receipt.engines = engines;
    for (const engine of engines) {
      const signal = AbortSignal.timeout(120_000);
      const response = await fetch(engine.url, { signal, redirect: 'error' });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      let bytes = 0;
      const hash = createHash('sha256');
      await pipeline(
        Readable.from(response.body),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > engine.bytes)
              return callback(new Error('native_binary_size_exceeded'));
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(join(context, engine.name), {
          flags: 'wx',
          mode: 0o755,
        }),
        { signal },
      );
      assert.equal(bytes, engine.bytes);
      assert.equal(hash.digest('hex'), engine.sha256);
    }
  }
  receipt.sourceSha256s = Object.fromEntries(
    [
      'scripts/child-work-native-model-channel-lab.ts',
      'scripts/lib/local-collaboration-process.mjs',
      'scripts/lib/owned-process.mjs',
      'src-server/services/connections/native-model-container.ts',
      'src-server/services/connections/native-model-stdio-channel.ts',
      'src-server/services/connections/native-model-stdio-protocol.ts',
      'src-server/services/connections/native-model-stdio-worker.ts',
      'src-server/services/infra/process-utils.ts',
      'pnpm-lock.yaml',
    ].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    ]),
  );
  const bundled = await build({
    metafile: true,
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
  receipt.workerInputSha256s = Object.fromEntries(
    Object.keys(bundled.metafile.inputs).map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    ]),
  );
  receipt.workerSha256 = createHash('sha256')
    .update(readFileSync(join(context, 'native-model-worker.mjs')))
    .digest('hex');
  writeFileSync(
    join(context, 'Dockerfile'),
    `FROM ${base}\nCOPY native-model-worker.mjs /station/native-model-worker.mjs\n${includeEngines ? 'COPY claude codex /station/\n' : ''}USER 10000:10001\n`,
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
      if (currentEngine) {
        assert.ok(requests.length < 9, 'native lab request limit');
        assert.equal(input.method, 'POST');
        assert.equal(
          input.path.split('?')[0],
          currentEngine === 'claude' ? '/v1/messages' : '/v1/responses',
        );
        const body = JSON.parse(input.body.toString('utf8'));
        assert.equal(typeof body.model, 'string');
        requests.push({
          engine: currentEngine,
          path: input.path,
          bodySha256: createHash('sha256').update(input.body).digest('hex'),
        });
        const text = `CONFINED_${currentEngine.toUpperCase()}_REPLY`;
        const message = {
          id: `msg_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 8 },
        };
        const output = {
          id: `item_${randomUUID()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        const response = {
          id: `resp_${randomUUID()}`,
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: body.model,
          output: [output],
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        };
        const event = (name: string, data: unknown) =>
          `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        const content =
          currentEngine === 'claude'
            ? event('message_start', {
                type: 'message_start',
                message: { ...message, content: [], stop_reason: null },
              }) +
              event('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              }) +
              event('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              }) +
              event('content_block_stop', {
                type: 'content_block_stop',
                index: 0,
              }) +
              event('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 8 },
              }) +
              event('message_stop', { type: 'message_stop' })
            : event('response.created', {
                type: 'response.created',
                response: { ...response, status: 'in_progress', output: [] },
              }) +
              event('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...output, status: 'in_progress', content: [] },
              }) +
              event('response.content_part.added', {
                type: 'response.content_part.added',
                item_id: output.id,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              }) +
              event('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: output.id,
                output_index: 0,
                content_index: 0,
                delta: text,
              }) +
              event('response.output_text.done', {
                type: 'response.output_text.done',
                item_id: output.id,
                output_index: 0,
                content_index: 0,
                text,
              }) +
              event('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: 0,
                item: output,
              }) +
              event('response.completed', {
                type: 'response.completed',
                response,
              });
        return {
          response: Promise.resolve(
            new Response(
              body.stream === false
                ? JSON.stringify(
                    currentEngine === 'claude' ? message : response,
                  )
                : content,
              {
                headers: {
                  'content-type':
                    body.stream === false
                      ? 'application/json'
                      : 'text/event-stream',
                },
              },
            ),
          ),
          settled: Promise.resolve(),
          invokeDelivery: async (write) => {
            signal.throwIfAborted();
            deliveries++;
            write();
          },
        };
      }
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
  if (includeEngines) {
    const observations = [];
    for (const engine of engines) {
      currentEngine = engine.name;
      const env =
        engine.name === 'claude'
          ? {
              ANTHROPIC_BASE_URL: connection.baseUrl,
              ANTHROPIC_AUTH_TOKEN: connection.token,
              ANTHROPIC_API_KEY: '',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
              DISABLE_TELEMETRY: '1',
              DISABLE_ERROR_REPORTING: '1',
            }
          : {
              STATION_ENGINE_PROXY_KEY: connection.token,
              CODEX_HOME: '/home/native/codex',
            };
      const args =
        engine.name === 'claude'
          ? [
              '--print',
              '--output-format',
              'json',
              '--model',
              'claude-sonnet-4-5',
              '--tools',
              '',
              '--setting-sources',
              '',
              '--max-turns',
              '1',
              'Return the fixed fixture response.',
            ]
          : [
              'exec',
              '--skip-git-repo-check',
              '--ephemeral',
              '--json',
              '--sandbox',
              'danger-full-access',
              '-m',
              'gpt-5.4',
              '-c',
              'model_provider="station-probe"',
              '-c',
              `model_providers.station-probe={name="Isolated fixture",base_url=${JSON.stringify(`${connection.baseUrl}/v1`)},wire_api="responses",env_key="STATION_ENGINE_PROXY_KEY"}`,
              'Return the fixed fixture response.',
            ];
      const engineRunner = join(artifacts, `${engine.name}-runner.mjs`);
      writeFileSync(
        engineRunner,
        `import {spawn} from 'node:child_process';
import {executeOwnedCommand,captureOwnedProcessOutput,terminateSuiteExecution,waitForSuiteSettlement} from ${JSON.stringify(new URL('./lib/owned-process.mjs', import.meta.url).href)};
const execution=executeOwnedCommand(${JSON.stringify(docker)},${JSON.stringify([...prefix, 'exec', '--user', '10001:10001', ...Object.keys(env).flatMap((name) => ['--env', name]), connection.containerId, `/station/${engine.name}`, ...args])},spawn,'confined native engine',{env:{PATH:process.env.PATH,HOME:${JSON.stringify(artifacts)},...${JSON.stringify(env)}},stdio:['ignore','pipe','pipe']});
const capture=captureOwnedProcessOutput(execution,{maxBytes:1048576});let timer;let terminal;
try{terminal=await Promise.race([execution.completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('native engine deadline')),60000);})]);}
finally{clearTimeout(timer);const stopped=await terminateSuiteExecution(execution,{waitForSuiteSettlement,terminationGraceMs:2000,terminationForceMs:2000,processLabel:'confined native engine'});if(!stopped.settled||stopped.errors.length)throw Error('native engine unsettled');}
const result=capture.finish();if(result.truncated||result.invalidUtf8)throw Error('native engine output invalid');process.stdout.write(JSON.stringify({terminal,stdout:result.stdout.text,stderr:result.stderr.text}));`,
      );
      const before: number = requests.length;
      const observed = JSON.parse(
        (await runLabCommand(process.execPath, [engineRunner], root, 65_000))
          .stdout,
      );
      observations.push({ engine: engine.name, ...observed });
      receipt.nativeEngineObservations = observations;
      assert.equal(
        observed.terminal.status,
        0,
        `${engine.name} terminal failure`,
      );
      assert.ok(
        observed.stdout.includes(`CONFINED_${engine.name.toUpperCase()}_REPLY`),
        `${engine.name} model reply missing`,
      );
      assert.ok(
        requests.length > before,
        `${engine.name} made no channel request`,
      );
    }
    currentEngine = undefined;
  }
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
