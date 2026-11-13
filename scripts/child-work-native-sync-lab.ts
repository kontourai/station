/**
 * Opt-in current-native prerequisites for child-work context sync.
 * Synthetic loopback Messages replies exercise real CLI tool effects; they do
 * not qualify provider billing, portable authority, or the full sync caller.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  createSdkMcpServer,
  query,
  type SDKControlRequest,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v3';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../src-server/services/infra/process-utils.js';

if (!process.argv.includes('--run-real-local-lab'))
  throw new Error(
    'Pass --run-real-local-lab to start isolated native CLI processes.',
  );
assert.ok(
  ['--exercise-plugin', '--exercise-settings', '--exercise-agent'].filter(
    (flag) => process.argv.includes(flag),
  ).length <= 1,
  'Run additional cohorts separately within the existing request cap.',
);
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error(
    'This bounded lab currently binds the darwin-arm64 executable.',
  );

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const sdk = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(
  readFileSync(join(sdkRoot, 'manifest.json'), 'utf8'),
);
const executable = join(
  root,
  'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
);
const artifacts = mkdtempSync(join(tmpdir(), 'child-work-native-sync-lab-'));
const workspace = join(artifacts, 'workspace');
const home = join(artifacts, 'home');
const registry = join(artifacts, 'owned-processes');
const plugin = join(artifacts, 'plugin');
const pluginToken = randomUUID();
const pluginCalls: { method: string; phase?: string }[] = [];
const pluginToolName = 'mcp__plugin_child-work-probe_probe__mark';
for (const directory of [workspace, home, registry])
  mkdirSync(directory, { recursive: true, mode: 0o700 });

const permissionState = z
  .object({
    managedOnly: z.boolean(),
    rules: z.array(
      z
        .object({
          behavior: z.enum(['allow', 'deny', 'ask']),
          source: z.string(),
          rule: z.string(),
          notInEffect: z.boolean().optional(),
        })
        .passthrough(),
    ),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

type Phase = {
  kind: 'write' | 'sdk-mcp' | 'plugin-mcp' | 'agent-write';
  restricted: boolean;
  marker: string;
  requests: number;
  permissions?: z.infer<typeof permissionState>;
  childRequests?: number;
  agentToolUseId?: string;
  childToolUseId?: string;
  change?:
    | 'replace-permissions'
    | 'clear-permissions'
    | 'default-mode'
    | 'bypass-mode';
};
let phase: Phase | undefined;
const requests: {
  phase: string;
  bytes: number;
  sha256: string;
  toolNames: string[];
}[] = [];
const processes: {
  pid?: number;
  exit: unknown;
  close: unknown;
  groupClosed: boolean;
}[] = [];
const observations: unknown[] = [];
assert.match(
  process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD ?? '',
  /^[a-f0-9]{40}$/,
);
const receipt: Record<string, unknown> = {
  sourceHead: process.env.CHILD_WORK_NATIVE_LAB_SOURCE_HEAD,
  driverSha256: createHash('sha256')
    .update(readFileSync(import.meta.filename))
    .digest('hex'),
  scope: 'native-effect-conformance-only',
  sdkVersion: sdk.version,
  bundledCliVersion: manifest.version,
  contextSyncQualified: false,
  providerBillingQualified: false,
  portableAuthorityQualified: false,
  requests,
  pluginCalls,
  processes,
  observations,
};
const save = () =>
  writeFileSync(
    join(artifacts, 'receipt.json'),
    JSON.stringify(receipt, null, 2),
  );

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error('native_request_body_limit');
      chunks.push(Buffer.from(chunk));
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/mcp') {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      assert.equal(request.headers.authorization, `Bearer ${pluginToken}`);
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (pluginCalls.length >= 48)
        throw new Error('native_plugin_request_limit');
      pluginCalls.push({ method: value.method, phase: phase?.marker });
      if (value.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      // This stateless fixture does not implement optional pre-initialize discovery.
      if (value.method === 'server/discover') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: value.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
        return;
      }
      let result: unknown;
      switch (value.method) {
        case 'initialize':
          result = {
            protocolVersion: value.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'child-work-probe', version: '1.0.0' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'mark',
                description: 'Write the isolated plugin conformance marker',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          };
          break;
        case 'tools/call':
          assert.equal(phase?.kind, 'plugin-mcp');
          assert.equal(value.params.name, 'mark');
          assert.ok(phase);
          writeFileSync(phase.marker, 'native plugin effect\n');
          result = {
            content: [{ type: 'text', text: 'plugin marker written' }],
          };
          break;
        default:
          throw new Error(`unexpected_plugin_method:${value.method}`);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }));
      return;
    }
    if (path === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (request.method !== 'POST' || path !== '/v1/messages' || !phase)
      throw new Error(`unhandled_native_request:${request.method}:${path}`);
    if (requests.length >= 24) throw new Error('native_model_request_limit');
    const body = Buffer.concat(chunks);
    const value = JSON.parse(body.toString('utf8'));
    requests.push({
      phase: `${phase.kind}:${phase.restricted ? 'restricted' : 'ordinary'}:${phase.change ?? 'unchanged'}`,
      bytes,
      sha256: createHash('sha256').update(body).digest('hex'),
      toolNames: (value.tools ?? []).map(
        (entry: { name: string }) => entry.name,
      ),
    });
    writeFileSync(join(artifacts, `request-${requests.length}.json`), body);
    const first = phase.requests++ === 0;
    const childPrompt = `CHILD_PROBE_${phase.marker}: use Write once to create the conformance marker, then finish.`;
    const lastUser = [...(value.messages ?? [])]
      .reverse()
      .find((message: { role?: string }) => message.role === 'user');
    const childStart =
      phase.kind === 'agent-write' &&
      !first &&
      (typeof lastUser?.content === 'string'
        ? lastUser.content.startsWith(childPrompt)
        : Array.isArray(lastUser?.content) &&
          lastUser.content.some(
            (part: { type?: string; text?: string }) =>
              part.type === 'text' && part.text?.startsWith(childPrompt),
          ));
    const childResult =
      phase.kind === 'agent-write' &&
      phase.childToolUseId !== undefined &&
      Array.isArray(lastUser?.content) &&
      lastUser.content.some(
        (part: { type?: string; tool_use_id?: string }) =>
          part.type === 'tool_result' &&
          part.tool_use_id === phase?.childToolUseId,
      );
    if (childStart || childResult)
      phase.childRequests = (phase.childRequests ?? 0) + 1;
    const invoke = first || childStart;
    const toolUseId = `tool-${randomUUID()}`;
    if (phase.kind === 'agent-write' && first) phase.agentToolUseId = toolUseId;
    if (childStart) phase.childToolUseId = toolUseId;
    const content = invoke
      ? {
          type: 'tool_use',
          id: toolUseId,
          name:
            childStart || phase.kind === 'write'
              ? 'Write'
              : phase.kind === 'agent-write'
                ? 'Agent'
                : phase.kind === 'plugin-mcp'
                  ? pluginToolName
                  : 'mcp__probe__mark',
          input: {},
        }
      : { type: 'text', text: '' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type: string, data: Record<string, unknown>) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    emit('message_start', {
      message: {
        id: `msg-${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: value.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    emit('content_block_start', { index: 0, content_block: content });
    emit('content_block_delta', {
      index: 0,
      delta: invoke
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify(
              childStart || phase.kind === 'write'
                ? { file_path: phase.marker, content: 'native effect\n' }
                : phase.kind === 'agent-write'
                  ? {
                      description: 'Isolated native marker control',
                      subagent_type: 'general-purpose',
                      run_in_background: false,
                      prompt: childPrompt,
                    }
                  : {},
            ),
          }
        : { type: 'text_delta', text: 'DONE' },
    });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', {
      delta: {
        stop_reason: invoke ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    });
    emit('message_stop', {});
    response.end();
  } catch (error) {
    receipt.transportFailure = String(error);
    save();
    if (!response.headersSent)
      response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: String(error) },
      }),
    );
  }
});

async function runPhase(input: Phase, resume?: string): Promise<string> {
  phase = input;
  const controller = new AbortController();
  const owned: ReturnType<typeof spawnOwnedChild>[] = [];
  const closes: Promise<unknown>[] = [];
  const messages: SDKMessage[] = [];
  let inspectRules:
    | (() => Promise<z.infer<typeof permissionState>>)
    | undefined;
  const sdkMcp = createSdkMcpServer({
    name: 'probe',
    tools: [
      tool('mark', 'Write the isolated conformance marker', {}, async () => {
        writeFileSync(input.marker, 'native MCP effect\n');
        return { content: [{ type: 'text', text: 'marker written' }] };
      }),
    ],
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: artifacts,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_API_KEY: 'synthetic-local-only',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_AGENT_SDK_VERSION: sdk.version,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
  let ready!: () => void;
  const start = new Promise<void>((done) => {
    ready = done;
  });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await start;
    yield {
      type: 'user',
      session_id: resume ?? '',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: 'Use the supplied conformance tool once, then reply DONE.',
      },
    };
  }
  const deadline = setTimeout(
    () => controller.abort(new Error('native_phase_deadline')),
    60_000,
  );
  let session: ReturnType<typeof query> | undefined;
  try {
    session = query({
      prompt: prompt(),
      options: {
        cwd: workspace,
        env,
        resume,
        persistSession: true,
        pathToClaudeCodeExecutable: executable,
        model: 'claude-sonnet-4-5',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        ...(process.argv.includes('--managed-only')
          ? { managedSettings: { allowManagedPermissionRulesOnly: true } }
          : {}),
        ...(input.kind === 'plugin-mcp'
          ? { plugins: [{ type: 'local' as const, path: plugin }] }
          : {}),
        maxTurns: 3,
        abortController: controller,
        systemPrompt:
          'This is an isolated native protocol conformance fixture.',
        ...(input.restricted ? { tools: [], disallowedTools: ['*'] } : {}),
        spawnClaudeCodeProcess(options: SpawnOptions) {
          const handle = spawnOwnedChild(options.command, options.args, {
            cwd: workspace,
            env,
            registryDir: registry,
            owner: {
              pid: process.pid,
              instanceId: artifacts,
              bootId: artifacts,
              birth: null,
            },
          });
          owned.push(handle);
          const record: (typeof processes)[number] = {
            pid: handle.proc.pid,
            exit: null,
            close: null,
            groupClosed: false,
          };
          processes.push(record);
          handle.proc.on('exit', (code, signal) => {
            record.exit = { code, signal };
          });
          const close = once(handle.proc, 'close').then(([code, signal]) => {
            record.close = { code, signal };
          });
          closes.push(close);
          let stderrBytes = 0;
          const stderr: Buffer[] = [];
          handle.proc.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= 256 * 1024) stderr.push(Buffer.from(chunk));
            else controller.abort(new Error('native_stderr_evidence_limit'));
          });
          void close.then(() =>
            writeFileSync(
              join(artifacts, `stderr-${record.pid}.txt`),
              Buffer.concat(stderr),
            ),
          );
          const { stdin, stdout } = handle.proc;
          assert.ok(stdin && stdout, 'native SDK requires owned pipes');
          const forwarded = new PassThrough();
          const decoder = new StringDecoder('utf8');
          let buffered = '';
          let pending:
            | {
                id: string;
                resolve(value: z.infer<typeof permissionState>): void;
                reject(error: unknown): void;
              }
            | undefined;
          controller.signal.addEventListener(
            'abort',
            () => {
              pending?.reject(controller.signal.reason);
              pending = undefined;
            },
            { once: true },
          );
          inspectRules = () =>
            new Promise((resolve, reject) => {
              assert.equal(pending, undefined);
              const request: SDKControlRequest = {
                type: 'control_request',
                request_id: randomUUID(),
                request: { subtype: 'list_permission_rules' },
              };
              pending = { id: request.request_id, resolve, reject };
              stdin.write(`${JSON.stringify(request)}\n`, (error) => {
                if (!error) return;
                pending?.reject(error);
                pending = undefined;
              });
            });
          stdout.on('data', (chunk: Buffer) => {
            buffered += decoder.write(chunk);
            if (Buffer.byteLength(buffered) > 4 * 1024 * 1024) {
              controller.abort(new Error('native_protocol_frame_limit'));
              return;
            }
            let newline: number;
            while ((newline = buffered.indexOf('\n')) !== -1) {
              const line = buffered.slice(0, newline);
              buffered = buffered.slice(newline + 1);
              let frame;
              try {
                frame = JSON.parse(line);
              } catch {
                controller.abort(new Error('native_protocol_invalid_json'));
                return;
              }
              if (
                pending &&
                frame.type === 'control_response' &&
                frame.response?.request_id === pending.id
              ) {
                const waiter = pending;
                pending = undefined;
                const decoded = permissionState.safeParse(
                  frame.response?.response?.state,
                );
                if (frame.response.subtype !== 'success' || !decoded.success)
                  waiter.reject(
                    new Error('native_permission_observation_unavailable'),
                  );
                else waiter.resolve(decoded.data);
              } else forwarded.write(`${line}\n`);
            }
          });
          stdout.on('end', () => {
            const tail = buffered + decoder.end();
            if (tail) forwarded.write(tail);
            forwarded.end();
            pending?.reject(new Error('native_permission_observation_closed'));
            pending = undefined;
          });
          return Object.assign(handle.proc, { stdin, stdout: forwarded });
        },
      },
    });
    // Install after native initialization: tools:[] alone does not constrain
    // tools that a caller subsequently adds through SDK MCP.
    const initialized = await session.initializationResult();
    assert.equal(initialized.claude_code_version, manifest.version);
    const mcp = await session.setMcpServers(
      input.kind === 'plugin-mcp' ? {} : { probe: sdkMcp },
    );
    assert.deepEqual(mcp.errors, {});
    switch (input.change) {
      case 'replace-permissions':
        await session.applyFlagSettings({
          permissions: { allow: ['*'], deny: [] },
        });
        break;
      case 'clear-permissions':
        await session.applyFlagSettings({ permissions: null });
        break;
      case 'default-mode':
        await session.setPermissionMode('default');
        break;
      case 'bypass-mode':
        await session.setPermissionMode('default');
        await session.setPermissionMode('bypassPermissions');
        break;
    }
    assert.ok(inspectRules);
    input.permissions = await inspectRules();
    assert.equal(input.permissions.errors?.length ?? 0, 0);
    if (process.argv.includes('--managed-only'))
      assert.equal(input.permissions.managedOnly, true);
    if (input.restricted)
      assert.ok(
        input.permissions.rules.some(
          (rule) =>
            rule.source === 'cliArg' &&
            rule.behavior === 'deny' &&
            rule.rule === '*' &&
            rule.notInEffect !== true,
        ),
        'wildcard deny is effective in the actual native CLI',
      );
    ready();
    for await (const message of session) {
      messages.push(message);
      if (
        messages.length > 128 ||
        Buffer.byteLength(JSON.stringify(messages)) > 4 * 1024 * 1024
      )
        throw new Error('native_message_evidence_limit');
    }
    const result = [...messages]
      .reverse()
      .find((message) => message.type === 'result');
    assert.ok(result && result.type === 'result');
    assert.equal(result.is_error, false);
    assert.equal(result.subtype, 'success');
    if (resume) assert.equal(result.session_id, resume);
    assert.equal(existsSync(input.marker), !input.restricted);
    assert.equal(
      input.requests,
      input.kind === 'agent-write' && !input.restricted ? 4 : 2,
    );
    if (input.kind === 'agent-write') {
      assert.equal(input.childRequests ?? 0, input.restricted ? 0 : 2);
      if (!input.restricted) {
        assert.ok(
          messages.some(
            (message) =>
              message.type === 'assistant' &&
              message.parent_tool_use_id === input.agentToolUseId &&
              message.message.content.some(
                (block) => block.type === 'tool_use' && block.name === 'Write',
              ),
          ),
          'the observed Write belongs to the actual native child',
        );
      }
    }
    observations.push({ ...input, nativeSessionId: result.session_id, result });
    return result.session_id;
  } finally {
    clearTimeout(deadline);
    ready();
    session?.close();
    await Promise.all(
      owned.map(async (handle, index) => {
        await terminateProcessTree(handle.proc, {
          graceMs: 2_000,
          killConfirmMs: 2_000,
        });
        await closes[index];
        const record = processes.find(
          (entry) => entry.pid === handle.proc.pid,
        )!;
        assert.ok(handle.proc.pid);
        record.groupClosed = !groupExists(handle.proc.pid);
        assert.equal(
          record.groupClosed,
          true,
          'owned process group must retire',
        );
        handle.release();
      }),
    );
    writeFileSync(
      join(
        artifacts,
        `messages-${input.kind}-${input.restricted}-${observations.length}.json`,
      ),
      JSON.stringify(messages, null, 2),
    );
    save();
  }
}

try {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(executable)) digest.update(chunk);
  receipt.executableSha256 = digest.digest('hex');
  assert.equal(
    receipt.executableSha256,
    manifest.platforms['darwin-arm64'].checksum,
  );
  receipt.lockfileSha256 = createHash('sha256')
    .update(readFileSync(join(root, 'pnpm-lock.yaml')))
    .digest('hex');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(plugin, '.claude-plugin/plugin.json'),
    JSON.stringify({
      name: 'child-work-probe',
      version: '1.0.0',
      description: 'Isolated native conformance fixture',
    }),
  );
  writeFileSync(
    join(plugin, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        probe: {
          type: 'http',
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: `Bearer ${pluginToken}` },
        },
      },
    }),
  );
  const nativeSessions = new Map<Phase['kind'], string>();
  const kinds: Phase['kind'][] = ['write', 'sdk-mcp'];
  if (process.argv.includes('--exercise-plugin')) kinds.push('plugin-mcp');
  if (process.argv.includes('--exercise-agent')) kinds.push('agent-write');
  for (const kind of kinds) {
    const native = await runPhase({
      kind,
      restricted: false,
      marker: join(workspace, `${kind}-ordinary.txt`),
      requests: 0,
    });
    nativeSessions.set(kind, native);
    await runPhase(
      {
        kind,
        restricted: true,
        marker: join(workspace, `${kind}-restricted.txt`),
        requests: 0,
      },
      native,
    );
    await runPhase(
      {
        kind,
        restricted: false,
        marker: join(workspace, `${kind}-resumed.txt`),
        requests: 0,
      },
      native,
    );
  }
  if (process.argv.includes('--exercise-settings')) {
    const native = nativeSessions.get('sdk-mcp');
    assert.ok(native);
    for (const change of [
      'replace-permissions',
      'clear-permissions',
      'default-mode',
      'bypass-mode',
    ] as const) {
      await runPhase(
        {
          kind: 'sdk-mcp',
          restricted: true,
          change,
          marker: join(workspace, `sdk-mcp-${change}.txt`),
          requests: 0,
        },
        native,
      );
    }
  }
  assert.equal(receipt.transportFailure, undefined);
  receipt.status = 'PASS_SCOPED_ENGINE_EFFECTS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.failure =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((done) => server.close(() => done()));
  save();
  process.stdout.write(
    `${JSON.stringify({ artifacts, status: receipt.status, contextSyncQualified: false })}\n`,
  );
}
