#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCodexDockerWorker } from '@kontourai/flow-agents/docker-worker';
import { startProviderProxy } from '@kontourai/flow-agents/provider-broker';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const command = (program, args, cwd = root) =>
  execFileSyncBounded(program, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
const { values } = parseArgs({
  options: { image: { type: 'string' }, 'output-root': { type: 'string' } },
});
const image = values.image;
assert.match(
  image ?? '',
  /^sha256:[a-f0-9]{64}$/,
  'Supply --image with an immutable local Docker image ID',
);
const output = resolve(
  values['output-root'] ?? join(root, '.kontourai/repair-worker-qualification'),
);
const id = randomUUID();
const sourceRevision = command('git', ['rev-parse', 'HEAD']);
const sourceStatus = command('git', ['status', '--porcelain']);
const scriptDigest = hash(await readFile(fileURLToPath(import.meta.url)));
const flowAgentsVersion = JSON.parse(
  await readFile(
    require.resolve('@kontourai/flow-agents/package.json'),
    'utf8',
  ),
).version;
const executionModules = {};
for (const name of ['docker-worker', 'provider-broker']) {
  executionModules[name] = hash(
    await readFile(require.resolve(`@kontourai/flow-agents/${name}`)),
  );
}
const runId = `station-repair-qualification-${id}`;
const network = `station-repair-${id}`;
const temporary = await mkdtemp(
  join(tmpdir(), 'station-repair-qualification-'),
);
const workspace = join(temporary, 'workspace');
const treatment = join(temporary, 'treatment');
const input = join(temporary, 'input');
const credentials = join(temporary, 'credentials');
const oracle = join(temporary, 'oracle');
const artifacts = join(output, id);
function responseEvents(item, sequence) {
  const response = {
    id: `resp_qualification_${sequence}`,
    object: 'response',
    status: 'completed',
    model: 'station-repair-fixture',
    output: [item],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
    },
  };
  return [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        ...item,
        arguments: item.arguments === undefined ? undefined : '',
      },
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

let broker;
let networkId;
let result;
const failures = [];
try {
  for (const path of [
    workspace,
    treatment,
    input,
    credentials,
    oracle,
    artifacts,
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const contextFile = join(input, 'request.json');
  const syntheticCredential = `qualification-only-${randomUUID()}`;
  const credentialFile = join(credentials, 'credential.json');
  await writeFile(credentialFile, syntheticCredential, { mode: 0o600 });
  await writeFile(join(oracle, 'answer'), 'not-mounted', { mode: 0o600 });
  await writeFile(join(workspace, 'repair.txt'), 'before\n');
  await writeFile(
    contextFile,
    JSON.stringify({
      canonical_workspace: 'controlled-qualification-fixture',
      unit_scope: ['repair.txt'],
      forbiddenPaths: [
        credentialFile,
        join(oracle, 'answer'),
        root,
        homedir(),
        '/var/run/docker.sock',
      ],
    }),
    { mode: 0o400 },
  );
  await writeFile(
    join(treatment, 'probe.py'),
    `import json, os
context = json.load(open('/context/request.json'))
assert all(not os.path.exists(p) for p in context['forbiddenPaths']), 'host-only path is visible'
assert not any(k in os.environ for k in ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK']), 'ambient credential channel present'
for p in ['/qualification-root-write', '/treatment/qualification-write']:
    try:
        with open(p, 'w') as f: f.write('forbidden')
    except OSError:
        pass
    else:
        raise AssertionError('read-only scope was writable')
json.dump({'host_paths_absent': True, 'ambient_credential_channels_absent': True, 'root_and_treatment_read_only': True}, open('/workspace/isolation.json', 'w'))
`,
    { mode: 0o400 },
  );
  networkId = command('docker', [
    'network',
    'create',
    '--label',
    `station.repair.qualification=${id}`,
    network,
  ]);
  const admitted = JSON.parse(
    command('docker', ['network', 'inspect', networkId]),
  )[0];
  assert.equal(admitted.Id, networkId);
  assert.equal(admitted.Internal, false);
  let forwarded = 0;
  broker = await startProviderProxy({
    apiKey: syntheticCredential,
    model: 'station-repair-fixture',
    reasoningEffort: 'medium',
    maxRequests: 4,
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(
        request.headers.authorization,
        `Bearer ${syntheticCredential}`,
      );
      const body = JSON.parse(request.body);
      assert.equal(JSON.stringify(body).includes(syntheticCredential), false);
      forwarded += 1;
      let item;
      if (forwarded === 1) {
        const tool = body.tools?.find(
          (candidate) =>
            candidate.type === 'function' &&
            ['exec_command', 'shell_command', 'shell'].includes(candidate.name),
        );
        assert.ok(tool, 'The real CLI must offer a known shell tool');
        const shell = 'echo after > repair.txt';
        const args =
          tool.name === 'exec_command'
            ? { cmd: shell, max_output_tokens: 256 }
            : tool.name === 'shell_command'
              ? { command: shell }
              : { command: ['sh', '-c', shell] };
        item = {
          type: 'function_call',
          id: 'fc_qualification',
          call_id: 'call_qualification',
          name: tool.name,
          arguments: JSON.stringify(args),
        };
      } else {
        assert.equal(
          forwarded,
          2,
          'The fixture permits one command and one final response',
        );
        assert.ok(
          body.input.some((entry) => entry.type === 'function_call_output'),
          'Completion must follow a real tool result',
        );
        item = {
          type: 'message',
          id: 'msg_qualification',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Controlled repair completed.',
              annotations: [],
            },
          ],
        };
      }
      return new Response(responseEvents(item, forwarded), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const options = {
    image,
    workspace,
    sourceRoot: treatment,
    contextFile,
    artifactRoot: artifacts,
    model: 'station-repair-fixture',
    reasoningEffort: 'medium',
    timeoutMs: 60_000,
    providerProxy: broker,
    network,
    runId,
    ownerId: id,
    forbiddenMountRoots: [
      { kind: 'controller', path: root },
      { kind: 'credentials', path: credentials },
      { kind: 'credentials', path: homedir() },
      { kind: 'hidden-oracle', path: oracle },
    ],
    workspaceSetup: {
      bootstrap: 'python3 /treatment/probe.py',
      prompt:
        'Perform the controlled fixture repair and report completion. Work only in repair.txt.',
      metadata: {
        qualification: 'controlled-provider-transport; no model inference',
      },
    },
  };
  await assert.rejects(
    runCodexDockerWorker({
      ...options,
      sourceRoot: credentials,
      invocationId: `${id}-negative`,
    }),
    /worker mounted a forbidden root/,
  );
  assert.equal(
    broker.counters.forwarded,
    0,
    'Forbidden mounts must refuse before provider dispatch',
  );
  assert.equal(
    command('docker', [
      'ps',
      '-aq',
      '--filter',
      `label=kontour.worker.run=${runId}`,
    ]),
    '',
    'Refused worker must be removed',
  );
  const receipt = await runCodexDockerWorker({
    ...options,
    invocationId: `${id}-positive`,
  });
  assert.deepEqual(receipt.terminal, {
    status: 0,
    timeout: false,
    overflow: false,
    signal: null,
  });
  assert.equal(receipt.container_removed, true);
  assert.equal(receipt.observed.controller_mounted, false);
  assert.equal(receipt.observed.credentials_mounted, false);
  assert.equal(receipt.observed.hidden_oracles_mounted, false);
  assert.equal(receipt.observed.network_admission.id, networkId);
  assert.equal(receipt.usage.complete, true);
  assert.equal(
    await readFile(join(workspace, 'repair.txt'), 'utf8'),
    'after\n',
  );
  const paths = command('git', ['diff', '--name-only', 'HEAD'], workspace);
  assert.equal(paths, 'repair.txt');
  const patch = command('git', ['diff', '--binary', 'HEAD'], workspace);
  await writeFile(join(artifacts, 'repair.patch'), `${patch}\n`, {
    flag: 'wx',
    mode: 0o400,
  });
  const isolation = JSON.parse(
    await readFile(join(workspace, 'isolation.json'), 'utf8'),
  );
  assert.equal(
    command('docker', [
      'ps',
      '-aq',
      '--filter',
      `label=kontour.worker.run=${runId}`,
    ]),
    '',
  );
  assert.equal(command('git', ['rev-parse', 'HEAD']), sourceRevision);
  assert.equal(command('git', ['status', '--porcelain']), sourceStatus);
  assert.equal(
    hash(await readFile(fileURLToPath(import.meta.url))),
    scriptDigest,
  );
  result = {
    schema: 'station.isolated-repair-qualification/v1',
    state: sourceStatus ? 'DIAGNOSTIC_ONLY' : 'PASS',
    source: {
      revision: sourceRevision,
      scriptSha256: scriptDigest,
      dirty: sourceStatus !== '',
      flowAgentsVersion,
      executionModules,
    },
    image,
    network: { id: networkId, internal: false },
    negativeControl: 'credential-root mount refused before provider dispatch',
    isolation,
    receipt,
    provider: {
      mode: broker.transport_mode,
      requests: broker.counters.forwarded,
      observations: broker.evidence,
    },
    patchSha256: hash(`${patch}\n`),
    limits: [
      'controlled synthetic provider responses; no model inference or billing',
      'fixture repository; no Station Task dispatch or publication grant',
      'named bridge; outbound network confinement is not established',
      ...(process.platform === 'linux'
        ? []
        : ['platform-default desktop host UID mapping remains unverified']),
    ],
  };
  assert.equal(JSON.stringify(result).includes(syntheticCredential), false);
} catch (error) {
  failures.push(error);
} finally {
  const cleanup = await Promise.allSettled([
    broker?.close(),
    (async () => {
      if (!networkId) return;
      const networkRecord = JSON.parse(
        command('docker', ['network', 'inspect', networkId]),
      )[0];
      assert.equal(networkRecord.Labels['station.repair.qualification'], id);
      command('docker', ['network', 'rm', networkId]);
    })(),
    rm(temporary, { recursive: true, force: true }),
  ]);
  failures.push(
    ...cleanup
      .filter((entry) => entry.status === 'rejected')
      .map((entry) => entry.reason),
  );
}
if (failures.length)
  throw new AggregateError(failures, 'Qualification or cleanup failed');
result.cleanup = { networkRemoved: true, temporaryWorkspaceRemoved: true };
await writeFile(
  join(artifacts, 'qualification.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  { flag: 'wx', mode: 0o400 },
);
process.stdout.write(
  `${JSON.stringify({
    state: result.state,
    image,
    artifactRoot: await realpath(artifacts),
    limits: result.limits,
  })}\n`,
);
process.exitCode = result.state === 'PASS' ? 0 : 3;
