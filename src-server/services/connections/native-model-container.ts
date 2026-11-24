// UNWIRED #91: authenticated issuance, staged publication and native image qualification remain required.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Writable } from 'node:stream';
import { writeJsonFile } from '@kontourai/station-shared/json-file-storage';
import { z } from 'zod/v3';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../infra/process-utils.js';
import {
  type NativeModelChannelRequest,
  NativeModelStdioChannel,
} from './native-model-stdio-channel.js';
import {
  NATIVE_DELEGATION_RPC_PATH,
  type NativeModelRequest,
} from './native-model-stdio-protocol.js';

const label = 'station.native-model-owner';
const digest = /^sha256:[a-f0-9]{64}$/;
const containerId = /^[a-f0-9]{64}$/;
const ownedContainer = z.object({
  Id: z.string(),
  Image: z.string(),
  Config: z.object({ Labels: z.record(z.string()).nullable() }),
});
const inspectedContainer = z.object({
  Id: z.string(),
  Image: z.string(),
  Config: z.object({
    User: z.string(),
    Labels: z.record(z.string()).nullable(),
  }),
  State: z.object({ Running: z.boolean() }),
  HostConfig: z.object({
    NetworkMode: z.string(),
    ReadonlyRootfs: z.boolean(),
    Privileged: z.boolean(),
    CapAdd: z.array(z.string()).nullable(),
    CapDrop: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
    PidMode: z.string(),
    IpcMode: z.string(),
    Memory: z.number(),
    MemorySwap: z.number(),
    NanoCpus: z.number(),
    PidsLimit: z.number(),
    Binds: z.array(z.string()).nullable(),
    Devices: z.array(z.unknown()).nullable(),
    DeviceRequests: z.array(z.unknown()).nullable(),
    VolumesFrom: z.array(z.string()).nullable(),
    Tmpfs: z.record(z.string()),
    LogConfig: z.object({ Type: z.string() }),
  }),
  NetworkSettings: z.object({ Networks: z.record(z.unknown()) }),
  Mounts: z.array(z.object({ Type: z.string(), Destination: z.string() })),
});

export interface NativeModelContainerOptions {
  /** Server-owned namespace-generation id; reusing it never starts another worker. */
  namespaceId: string;
  /** Server-selected immutable image containing /station/native-model-worker.mjs. */
  imageId: string;
  dockerExecutable: string;
  /** Captured local daemon socket; never a worker-supplied URL or mutable context name. */
  endpoint: string;
  controllerRoot: string;
  request(
    input: NativeModelRequest,
    signal: AbortSignal,
  ): NativeModelChannelRequest;
  /** Separate host broker whose presence offers transport only. */
  delegationRpc?(
    input: NativeModelRequest,
    signal: AbortSignal,
  ): NativeModelChannelRequest;
}

type NativeTextLaunchInput = Readonly<{
  engine: 'claude' | 'codex';
  modelId: string;
  /** Server-owned catalog inside the immutable image, never inferred entitlement. */
  modelCatalogPath?: string;
  signal: AbortSignal;
  writePrompt(stdin: Writable): Promise<void>;
}>;

const nativeTextProducerBrand = Symbol('owned native text producer receipt');
interface NativeTextProducerReceipt {
  readonly [nativeTextProducerBrand]: true;
}
type NativeTextProducerFacts = Readonly<{
  engine: 'claude' | 'codex';
  namespaceId: string;
  containerId: string;
  imageId: string;
  executablePath: string;
  executableSha256: string;
  cliVersion: string;
}>;
const nativeTextProducers = new WeakMap<
  NativeTextProducerReceipt,
  {
    owner: NativeModelContainer;
    facts: NativeTextProducerFacts;
  }
>();

const nativeTextReceiptBrand = Symbol('owned native text execution receipt');
interface NativeTextExecutionReceipt {
  readonly [nativeTextReceiptBrand]: true;
}
type NativeTextExecutionFacts = Readonly<{
  engine: 'claude' | 'codex';
  requestedModelId: string;
  namespaceId: string;
  containerId: string;
  imageId: string;
  nativeSessionId: string;
  stdoutSha256: string;
  textSequenceSha256: string;
  terminal: Readonly<{ code: 0; signal: null }>;
}>;
const nativeTextReceipts = new WeakMap<
  NativeTextExecutionReceipt,
  {
    owner: NativeModelContainer;
    facts: NativeTextExecutionFacts;
  }
>();

function nativeTextCompletion(engine: 'claude' | 'codex', stdout: string) {
  if (engine === 'claude') {
    const result = z
      .object({
        type: z.literal('result'),
        subtype: z.literal('success'),
        is_error: z.literal(false),
        num_turns: z.literal(1),
        session_id: z.string().uuid(),
        result: z.string(),
        permission_denials: z.array(z.unknown()).max(0),
      })
      .parse(JSON.parse(stdout));
    return { nativeSessionId: result.session_id, texts: [result.result] };
  }
  const events = stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) =>
      z
        .object({
          type: z.enum([
            'thread.started',
            'turn.started',
            'item.completed',
            'turn.completed',
          ]),
          thread_id: z.string().uuid().optional(),
          item: z
            .object({
              id: z.string().min(1),
              type: z.enum(['agent_message', 'reasoning']),
              text: z.string(),
            })
            .optional(),
        })
        .parse(JSON.parse(line)),
    );
  const first = events[0];
  if (
    first?.type !== 'thread.started' ||
    !first.thread_id ||
    events[1]?.type !== 'turn.started' ||
    events.at(-1)?.type !== 'turn.completed'
  )
    throw new Error('native_text_completion_unconfirmed');
  const texts: string[] = [],
    ids = new Set<string>();
  for (const event of events.slice(2, -1)) {
    if (
      event.type !== 'item.completed' ||
      !event.item ||
      ids.has(event.item.id)
    )
      throw new Error('native_text_completion_unconfirmed');
    ids.add(event.item.id);
    if (event.item.type === 'agent_message') texts.push(event.item.text);
  }
  if (!texts.length) throw new Error('native_text_completion_unconfirmed');
  return { nativeSessionId: first.thread_id, texts };
}

interface OwnedNativeTextRun {
  /** Native program result. A later cleanup failure cannot overwrite it. */
  readonly result: Promise<
    Readonly<{
      stdout: string;
      stderr: string;
      terminal: Readonly<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>;
    }>
  >;
  /** Owned exec-client/tree settlement, separate from container removal. */
  readonly settled: Promise<void>;
  close(): Promise<void>;
}

/** Owns only namespace/model-channel lifetime. It does not issue delegation authority. */
export class NativeModelContainer {
  readonly #nonce = randomUUID();
  readonly #name = `station-native-${this.#nonce}`;
  readonly #directory: string;
  readonly #config: string;
  readonly #registry: string;
  readonly #environment: NodeJS.ProcessEnv;
  #id: string | undefined;
  #daemon: string | undefined;
  #channel: NativeModelStdioChannel | undefined;
  #delegationRpcMounted = false;
  #ready: { port: number; uid: number | null } | undefined;
  #engaged = false;
  #removed = false;
  #removal: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #retiring = false;
  #createSubmitted = false;
  #textSubmitted = false;
  #textSettled = false;
  #textRun: OwnedNativeTextRun | undefined;
  #textSelection:
    | Readonly<{
        engine: NativeTextLaunchInput['engine'];
        modelId: string;
        brokered: boolean;
      }>
    | undefined;
  #textReceipt: NativeTextExecutionReceipt | undefined;
  #producerObservation: Promise<NativeTextProducerReceipt> | undefined;

  private constructor(private readonly options: NativeModelContainerOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      !digest.test(options.imageId) ||
      !isAbsolute(options.dockerExecutable) ||
      endpoint.protocol !== 'unix:' ||
      endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !isAbsolute(endpoint.pathname)
    )
      throw new Error('native_container_binding_invalid');
    if (
      !isAbsolute(options.controllerRoot) ||
      realpathSync(options.controllerRoot) !== options.controllerRoot
    )
      throw new Error('native_container_storage_invalid');
    const root = lstatSync(options.controllerRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o077) !== 0
    )
      throw new Error('native_container_storage_invalid');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(options.namespaceId))
      throw new Error('native_container_namespace_invalid');
    this.#directory = join(
      options.controllerRoot,
      createHash('sha256').update(options.namespaceId).digest('hex'),
    );
    mkdirSync(this.#directory, { mode: 0o700 });
    this.#config = join(this.#directory, 'docker-config');
    this.#registry = join(this.#directory, 'owned-processes');
    for (const directory of [this.#config, this.#registry])
      mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(this.#config, 'config.json'), '{}\n', {
      mode: 0o600,
      flag: 'wx',
    });
    this.#environment = {
      PATH: process.env.PATH,
      HOME: this.#directory,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
  }

  static prepare(options: NativeModelContainerOptions): NativeModelContainer {
    return new NativeModelContainer(Object.freeze({ ...options }));
  }

  async start(): Promise<void> {
    if (this.#retiring) throw new Error('native_container_already_retiring');
    if (!this.#starting) this.#starting = this.#start();
    await this.#starting;
    if (
      !this.#engaged ||
      this.#removed ||
      this.#channel?.inspect().admissionClosed
    )
      throw new Error('native_container_not_engaged');
  }

  async #start(): Promise<void> {
    await this.#journal('creating');
    try {
      this.#daemon = (await this.#run(['info', '--format', '{{.ID}}'])).trim();
      if (!this.#daemon || this.#daemon.length > 256)
        throw new Error('native_container_daemon_unavailable');
      if (this.#retiring) throw new Error('native_container_already_retiring');
      this.#createSubmitted = true;
      const output = await this.#run([
        'create',
        '--pull=never',
        '--name',
        this.#name,
        '--label',
        `${label}=${this.#nonce}`,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '10000:10001',
        '--ipc',
        'private',
        '--pids-limit',
        '64',
        '--memory',
        '536870912',
        '--memory-swap',
        '536870912',
        '--cpus',
        '1',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=33554432,mode=1777',
        '--tmpfs',
        '/workspace:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=0770',
        '--tmpfs',
        '/home/native:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001',
        '--log-driver',
        'none',
        '--env',
        'HOME=/home/native',
        '--env',
        'NODE_OPTIONS=',
        '--workdir',
        '/workspace',
        '--interactive',
        '--entrypoint',
        '/usr/local/bin/node',
        this.options.imageId,
        '/station/native-model-worker.mjs',
      ]);
      if (!containerId.test(output.trim()))
        throw new Error('native_container_create_unconfirmed');
      this.#id = output.trim();
      await this.#journal('created');
      await this.#inspect(false);
      if (this.#retiring) throw new Error('native_container_already_retiring');
      const attached = spawnOwnedChild(
        this.options.dockerExecutable,
        this.#args(['start', '--attach', '--interactive', this.#id]),
        {
          env: this.#environment,
          registryDir: this.#registry,
        },
      );
      const { stdin, stdout, stderr } = attached.proc;
      if (!stdin || !stdout || !stderr)
        throw new Error('native_container_attach_unavailable');
      let diagnosticBytes = 0;
      stderr.on('data', (chunk: Buffer) => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > 64 * 1024)
          stdout.destroy(new Error('native_container_attach_output_limit'));
      });
      const settled = new Promise<void>((resolve, reject) => {
        attached.proc.once('error', reject);
        attached.proc.once('close', (code, signal) => {
          if (!this.#removal && (code !== 0 || signal))
            reject(new Error('native_container_attach_failed'));
          else resolve();
        });
      });
      void settled.catch(() => {});
      let stopping: Promise<void> | undefined;
      const stop = () => {
        if (!stopping)
          stopping = (async () => {
            try {
              await this.#remove();
            } finally {
              await terminateProcessTree(attached.proc, {
                graceMs: 1_000,
                killConfirmMs: 1_000,
              });
              await settled;
              attached.release();
            }
          })();
        return stopping;
      };
      const { request, delegationRpc } = this.options;
      this.#channel = new NativeModelStdioChannel(
        { input: stdin, output: stdout, settled, stop },
        (input, signal) => this.#admitRequest(request, input, signal),
        delegationRpc
          ? (input, signal) => this.#admitRequest(delegationRpc, input, signal)
          : undefined,
      );
      this.#delegationRpcMounted = Boolean(delegationRpc);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.#ready = await Promise.race([
          this.#channel.ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('native_container_ready_unconfirmed')),
              10_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (this.#ready.uid !== 10000)
        throw new Error('native_container_uid_mismatch');
      await this.#inspect(true);
      if (this.#retiring) throw new Error('native_container_already_retiring');
      this.#engaged = true;
      await this.#journal('engaged');
    } catch (error) {
      // A lost create response retains its unique intent. Never infer release
      // from one absent PID/name observation or delete a foreign container.
      if (this.#id) {
        try {
          if (this.#channel) await this.#channel.close();
          else await this.#remove();
        } catch {
          await this.#journal('cleanup-unconfirmed');
        }
      } else await this.#journal('create-unconfirmed');
      throw error;
    }
  }

  toJSON() {
    return { transport: 'private-native-model-container' };
  }

  /** The scoped bridge key is not a provider credential or delegation grant. */
  connection() {
    if (
      !this.#engaged ||
      this.#closing ||
      !this.#ready ||
      !this.#channel ||
      !this.#id ||
      this.#channel.inspect().admissionClosed
    )
      throw new Error('native_container_not_engaged');
    return {
      containerId: this.#id,
      baseUrl: `http://127.0.0.1:${this.#ready.port}`,
      token: this.#channel.token,
    };
  }

  #admitRequest(
    owner: NativeModelContainerOptions['request'],
    input: NativeModelRequest,
    signal: AbortSignal,
  ): NativeModelChannelRequest {
    const admitted = (async () => {
      if (!this.#engaged || this.#retiring)
        throw new Error('native_container_not_engaged');
      await this.#inspect(true);
      signal.throwIfAborted();
      if (!this.#engaged || this.#retiring)
        throw new Error('native_container_not_engaged');
      return Reflect.apply(owner, this.options, [input, signal]);
    })();
    return {
      response: admitted.then((request) => request.response),
      settled: admitted.then((request) => request.settled),
      invokeDelivery: async (write) => (await admitted).invokeDelivery(write),
    };
  }

  inspect() {
    return {
      containerId: this.#id,
      imageId: this.options.imageId,
      engaged: this.#engaged,
      removed: this.#removed,
      modelChannel: this.#channel?.inspect(),
      journalDirectory: this.#directory,
      nativeText: {
        submitted: this.#textSubmitted,
        settled: this.#textSettled,
      },
    };
  }

  /** One fixed native text client in the owned namespace. Prompt bytes travel
   * through stdin under the source owner's delivery port, never argv/env. */
  async startText(input: NativeTextLaunchInput): Promise<OwnedNativeTextRun> {
    return this.#startText(input, false);
  }

  /** Explicit relay configuration. The mounted callback still owns effect admission. */
  async startBrokeredText(
    input: NativeTextLaunchInput,
  ): Promise<OwnedNativeTextRun> {
    if (!this.#delegationRpcMounted)
      throw new Error('native_delegation_rpc_unavailable');
    return this.#startText(input, true);
  }

  async #startText(
    input: NativeTextLaunchInput,
    brokered: boolean,
  ): Promise<OwnedNativeTextRun> {
    input = Object.freeze({ ...input });
    if (
      input.modelCatalogPath !== undefined &&
      (input.engine !== 'codex' ||
        !/^\/station\/[A-Za-z0-9._/-]{1,240}\.json$/.test(
          input.modelCatalogPath,
        ) ||
        input.modelCatalogPath.split('/').includes('..'))
    )
      throw new Error('native_text_catalog_invalid');
    if (
      !['claude', 'codex'].includes(input.engine) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.modelId)
    )
      throw new Error('native_text_selection_invalid');
    input.signal.throwIfAborted();
    if (this.#retiring || !this.#engaged || this.#textSubmitted)
      throw new Error('native_text_admission_closed');
    await this.#inspect(true);
    input.signal.throwIfAborted();
    if (this.#retiring || !this.#engaged || this.#textSubmitted || !this.#id)
      throw new Error('native_text_admission_closed');
    const connection = this.connection();
    const brokerArgs = [
      '/station/native-model-worker.mjs',
      '--delegation-rpc-client',
    ];
    const environment = {
      ...(brokered
        ? {
            STATION_NATIVE_RPC_URL: `${connection.baseUrl}${NATIVE_DELEGATION_RPC_PATH}`,
            STATION_NATIVE_RPC_KEY: connection.token,
          }
        : {}),
      ...(input.engine === 'claude'
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
            CODEX_HOME: '/home/native',
          }),
    };
    const args =
      input.engine === 'claude'
        ? [
            '--print',
            '--input-format',
            'text',
            '--output-format',
            'json',
            '--model',
            input.modelId,
            '--tools',
            '',
            '--setting-sources',
            '',
            '--max-turns',
            brokered ? '64' : '1',
            ...(brokered
              ? [
                  '--strict-mcp-config',
                  '--mcp-config',
                  JSON.stringify({
                    mcpServers: {
                      station_delegation: {
                        type: 'stdio',
                        command: '/usr/local/bin/node',
                        args: brokerArgs,
                      },
                    },
                  }),
                  '--allowedTools',
                  'mcp__station_delegation__*',
                ]
              : []),
          ]
        : [
            'exec',
            '--skip-git-repo-check',
            '--ephemeral',
            '--json',
            '--sandbox',
            'danger-full-access',
            '-c',
            'features.shell_tool=false',
            '-c',
            'features.multi_agent=false',
            '-c',
            'features.goals=false',
            ...(brokered
              ? [
                  '-c',
                  `mcp_servers.station_delegation={command="/usr/local/bin/node",args=${JSON.stringify(brokerArgs)},env_vars=["STATION_NATIVE_RPC_URL","STATION_NATIVE_RPC_KEY"],required=true}`,
                ]
              : []),
            '-c',
            'features.view_image=false',
            '-c',
            'web_search="disabled"',
            '-m',
            input.modelId,
            ...(input.modelCatalogPath
              ? [
                  '-c',
                  `model_catalog_json=${JSON.stringify(input.modelCatalogPath)}`,
                ]
              : []),
            '-c',
            'model_provider="station-channel"',
            '-c',
            `model_providers.station-channel={name="Confined model channel",base_url=${JSON.stringify(`${connection.baseUrl}/v1`)},wire_api="responses",env_key="STATION_ENGINE_PROXY_KEY"}`,
            '-',
          ];
    this.#textSubmitted = true;
    this.#textSelection = Object.freeze({
      engine: input.engine,
      modelId: input.modelId,
      brokered,
    });
    const child = spawnOwnedChild(
      this.options.dockerExecutable,
      this.#args([
        'exec',
        '--interactive',
        '--user',
        '10001:10001',
        ...Object.keys(environment).flatMap((name) => ['--env', name]),
        this.#id,
        `/station/${input.engine}`,
        ...args,
      ]),
      {
        env: { ...this.#environment, ...environment },
        registryDir: this.#registry,
      },
    );
    let failure: unknown;
    const completed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.proc.once('error', (error) => {
        failure ??= error;
      });
      child.proc.once('close', (code, signal) => resolve({ code, signal }));
    });
    let closing: Promise<void> | undefined;
    const stop = () =>
      (closing ??= (async () => {
        child.proc.stdin?.destroy();
        await terminateProcessTree(child.proc, {
          graceMs: 1000,
          killConfirmMs: 1000,
        });
        await completed;
        child.release();
        this.#textSettled = true;
      })().catch((error) => {
        closing = undefined;
        throw error;
      }));
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0;
    for (const [stream, chunks] of [
      [child.proc.stdout, stdout],
      [child.proc.stderr, stderr],
    ] as const)
      stream?.on('data', (raw: Buffer) => {
        bytes += raw.length;
        if (bytes <= 1024 * 1024) chunks.push(Buffer.from(raw));
        else {
          failure ??= new Error('native_text_output_limit');
          void stop().catch(() => {});
        }
      });
    child.proc.stdin?.on('error', (error) => {
      failure ??= error;
    });
    const abort = () => {
      failure ??= new Error('native_text_aborted');
      void stop().catch(() => {});
    };
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      failure ??= new Error('native_text_deadline');
      void stop().catch(() => {});
    }, 60_000);
    const result = Promise.resolve().then(async () => {
      try {
        const stdin = child.proc.stdin;
        if (!stdin) throw new Error('native_text_stdin_unavailable');
        if (failure) throw failure;
        input.signal.throwIfAborted();
        await input.writePrompt(stdin);
        if (failure) throw failure;
        input.signal.throwIfAborted();
        stdin.end();
        const terminal = await completed;
        if (failure) throw failure;
        if (terminal.code !== 0 || terminal.signal)
          throw new Error('native_text_failed');
        const decode = (chunks: Buffer[]) =>
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          );
        return Object.freeze({
          stdout: decode(stdout),
          stderr: decode(stderr),
          terminal: Object.freeze(terminal),
        });
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
      }
    });
    const settled = result.then(stop, stop);
    void settled.catch(() => {});
    this.#textRun = Object.freeze({
      result,
      settled,
      close: () => {
        failure ??= new Error('native_text_closed');
        return stop();
      },
    });
    return this.#textRun;
  }

  /** Observe the actual immutable executable in this live namespace. This is
   * neither provider approval nor a host-preparer or financial authority receipt. */
  async captureTextProducerReceipt(): Promise<NativeTextProducerReceipt> {
    await this.#inspect(true);
    if (
      this.#retiring ||
      !this.#engaged ||
      this.#removed ||
      !this.#textSelection ||
      !this.#textRun
    )
      throw new Error('native_text_producer_unavailable');
    this.#producerObservation ??= this.#observeTextProducer();
    return this.#producerObservation;
  }

  async #observeTextProducer(): Promise<NativeTextProducerReceipt> {
    const selection = this.#textSelection,
      id = this.#id;
    if (!selection || !id) throw new Error('native_text_producer_unavailable');
    const executablePath = `/station/${selection.engine}`;
    const executableSha256 = (
      await this.#run([
        'exec',
        '--user',
        '10001:10001',
        id,
        '/usr/local/bin/node',
        '--input-type=module',
        '--eval',
        `import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const path = process.argv[1];
if (await realpath(path) !== path) throw Error('noncanonical native executable');
const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const before = await fd.stat({ bigint: true });
  if (!before.isFile()) throw Error('nonregular native executable');
  const hash = createHash('sha256');
  for await (const chunk of fd.createReadStream({ autoClose: false })) hash.update(chunk);
  const after = await fd.stat({ bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'])
    if (before[key] !== after[key]) throw Error('native executable changed');
  process.stdout.write(hash.digest('hex'));
} finally { await fd.close(); }`,
        executablePath,
      ])
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(executableSha256))
      throw new Error('native_text_producer_unconfirmed');
    const version = (
      await this.#run([
        'exec',
        '--user',
        '10001:10001',
        id,
        executablePath,
        '--version',
      ])
    ).trim();
    const match =
      selection.engine === 'claude'
        ? /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(version)
        : /^codex-cli (\d+\.\d+\.\d+)$/.exec(version);
    await this.#inspect(true);
    if (
      !match ||
      this.#retiring ||
      !this.#engaged ||
      this.#removed ||
      this.#id !== id ||
      this.#textSelection !== selection
    )
      throw new Error('native_text_producer_unconfirmed');
    const receipt: NativeTextProducerReceipt = Object.freeze({
      [nativeTextProducerBrand]: true as const,
    });
    nativeTextProducers.set(receipt, {
      owner: this,
      facts: Object.freeze({
        engine: selection.engine,
        namespaceId: this.options.namespaceId,
        containerId: id,
        imageId: this.options.imageId,
        executablePath,
        executableSha256,
        cliVersion: match[1],
      }),
    });
    return receipt;
  }

  /** Historical observation, bound to its original owner; never a live grant. */
  inspectTextProducerReceipt(
    receipt: NativeTextProducerReceipt,
  ): NativeTextProducerFacts {
    const held = nativeTextProducers.get(receipt);
    if (!held || held.owner !== this)
      throw new Error('native_text_producer_receipt_unavailable');
    return Object.freeze({ ...held.facts });
  }

  /** A completion fact from this owner's actual CLI result, never a grant,
   * billing receipt or proof of namespace/exec cleanup. */
  async captureTextExecutionReceipt(): Promise<NativeTextExecutionReceipt> {
    const run = this.#textRun,
      selection = this.#textSelection;
    if (!run || !selection || !this.#id || selection.brokered)
      throw new Error('native_text_completion_unavailable');
    const result = await run.result;
    if (this.#channel?.inspect().requests !== 1)
      throw new Error('native_text_completion_unconfirmed');
    let completion: ReturnType<typeof nativeTextCompletion>;
    try {
      completion = nativeTextCompletion(selection.engine, result.stdout);
    } catch {
      throw new Error('native_text_completion_unconfirmed');
    }
    if (!this.#textReceipt) {
      const receipt: NativeTextExecutionReceipt = Object.freeze({
        [nativeTextReceiptBrand]: true as const,
      });
      nativeTextReceipts.set(receipt, {
        owner: this,
        facts: Object.freeze({
          engine: selection.engine,
          requestedModelId: selection.modelId,
          namespaceId: this.options.namespaceId,
          containerId: this.#id,
          imageId: this.options.imageId,
          nativeSessionId: completion.nativeSessionId,
          stdoutSha256: createHash('sha256')
            .update(result.stdout)
            .digest('hex'),
          textSequenceSha256: createHash('sha256')
            .update(JSON.stringify(completion.texts))
            .digest('hex'),
          terminal: Object.freeze({ code: 0, signal: null }),
        }),
      });
      this.#textReceipt = receipt;
    }
    return this.#textReceipt;
  }

  inspectTextExecutionReceipt(
    receipt: NativeTextExecutionReceipt,
  ): NativeTextExecutionFacts {
    const state = nativeTextReceipts.get(receipt);
    if (!state || state.owner !== this)
      throw new Error('native_text_receipt_owner_mismatch');
    return Object.freeze(structuredClone(state.facts));
  }

  close(): Promise<void> {
    this.#retiring = true;
    this.#engaged = false;
    if (!this.#closing)
      this.#closing = (async () => {
        const retirements: Promise<void>[] = [];
        if (this.#channel) retirements.push(this.#channel.close());
        else if (this.#id) retirements.push(this.#remove());
        if (this.#textRun) retirements.push(this.#textRun.close());
        const failures: unknown[] = [];
        for (const outcome of await Promise.allSettled(retirements))
          if (outcome.status === 'rejected') failures.push(outcome.reason);
        await this.#starting?.catch(() => {});
        // Preserve ownership of pending source delivery even after its exec closes.
        await this.#textRun?.result.catch(() => {});
        if (!this.#removed) {
          try {
            if (!this.#createSubmitted) this.#removed = true;
            else if (this.#id) await this.#remove();
            else {
              await this.#recoverCreatedIdentity();
              await this.#remove();
            }
          } catch (error) {
            if (!failures.includes(error)) failures.push(error);
          }
        }
        try {
          await this.#journal(
            !this.#removed
              ? 'cleanup-unconfirmed'
              : failures.length
                ? 'removed-channel-failed'
                : 'removed',
          );
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            'native_container_retirement_failed',
          );
      })().catch((error) => {
        this.#closing = undefined;
        throw error;
      });
    return this.#closing;
  }

  #args(args: string[]): string[] {
    return ['--host', this.options.endpoint, '--config', this.#config, ...args];
  }

  async #journal(state: string): Promise<void> {
    await writeJsonFile(
      join(this.#directory, 'owner.json'),
      {
        version: 1,
        state,
        nonce: this.#nonce,
        name: this.#name,
        imageId: this.options.imageId,
        daemon: this.#daemon,
        containerId: this.#id ?? null,
        namespaceId: this.options.namespaceId,
        namespaceRemoved: this.#removed,
        channel: this.#channel
          ? {
              workerSettled: this.#channel.inspect().workerSettled,
              pending: this.#channel.inspect().pending,
              failed: Boolean(this.#channel.inspect().failure),
            }
          : null,
      },
      { maxBytes: 8192 },
    );
  }

  async #inspect(running?: boolean, requireIsolation = true): Promise<void> {
    if (!this.#id) throw new Error('native_container_identity_unavailable');
    if (
      (await this.#run(['info', '--format', '{{.ID}}'])).trim() !== this.#daemon
    )
      throw new Error('native_container_daemon_changed');
    const raw = JSON.parse(
      await this.#run([
        'inspect',
        '--type',
        'container',
        '--format',
        '{{json .}}',
        this.#id,
      ]),
    );
    const identity = ownedContainer.parse(raw);
    if (
      identity.Id !== this.#id ||
      identity.Image !== this.options.imageId ||
      identity.Config.Labels?.[label] !== this.#nonce
    )
      throw new Error('native_container_ownership_mismatch');
    if (!requireIsolation) return;
    const value = inspectedContainer.parse(raw);
    const limits = value.HostConfig;
    if (
      value.Id !== this.#id ||
      value.Image !== this.options.imageId ||
      value.Config.Labels?.[label] !== this.#nonce ||
      value.Config.User !== '10000:10001' ||
      (running !== undefined && value.State.Running !== running) ||
      limits.NetworkMode !== 'none' ||
      (value.State.Running &&
        Object.keys(value.NetworkSettings.Networks).join(',') !== 'none') ||
      !limits.ReadonlyRootfs ||
      limits.Privileged ||
      limits.CapAdd?.length ||
      !limits.CapDrop?.includes('ALL') ||
      !limits.SecurityOpt?.some((option) =>
        /^no-new-privileges(?::true)?$/.test(option),
      ) ||
      limits.PidMode !== '' ||
      limits.IpcMode !== 'private' ||
      limits.Memory !== 536870912 ||
      limits.MemorySwap !== 536870912 ||
      limits.LogConfig.Type !== 'none' ||
      limits.NanoCpus !== 1_000_000_000 ||
      limits.PidsLimit !== 64 ||
      limits.Binds?.length ||
      limits.Devices?.length ||
      limits.DeviceRequests?.length ||
      limits.VolumesFrom?.length ||
      Object.keys(limits.Tmpfs).sort().join(',') !==
        '/home/native,/tmp,/workspace' ||
      value.Mounts.some(
        (mount) =>
          mount.Type !== 'tmpfs' ||
          !['/tmp', '/workspace', '/home/native'].includes(mount.Destination),
      )
    )
      throw new Error('native_container_isolation_mismatch');
  }

  async #recoverCreatedIdentity(): Promise<void> {
    const daemon = this.#daemon;
    if (!this.#createSubmitted || !daemon || this.#id)
      throw new Error('native_container_creation_unconfirmed');
    if ((await this.#run(['info', '--format', '{{.ID}}'])).trim() !== daemon)
      throw new Error('native_container_daemon_changed');
    // A name locates a candidate; original daemon, image and nonce establish ownership.
    const candidate = ownedContainer.parse(
      JSON.parse(
        await this.#run([
          'inspect',
          '--type',
          'container',
          '--format',
          '{{json .}}',
          this.#name,
        ]),
      ),
    );
    if (
      !containerId.test(candidate.Id) ||
      candidate.Image !== this.options.imageId ||
      candidate.Config.Labels?.[label] !== this.#nonce
    )
      throw new Error('native_container_ownership_mismatch');
    if ((await this.#run(['info', '--format', '{{.ID}}'])).trim() !== daemon)
      throw new Error('native_container_daemon_changed');
    this.#id = candidate.Id;
    await this.#journal('created-recovered');
  }

  #remove(): Promise<void> {
    if (!this.#removal)
      this.#removal = (async () => {
        if (this.#removed) return;
        if (!this.#id) throw new Error('native_container_creation_unconfirmed');
        // Cleanup needs ownership, not a still-correct isolation plan.
        await this.#inspect(undefined, false);
        const result = (await this.#run(['rm', '--force', this.#id])).trim();
        if (result !== this.#id)
          throw new Error('native_container_removal_unconfirmed');
        this.#removed = true;
        await this.#journal('container-removed');
      })();
    return this.#removal;
  }

  async #run(args: string[]): Promise<string> {
    const handle = spawnOwnedChild(
      this.options.dockerExecutable,
      this.#args(args),
      { env: this.#environment, registryDir: this.#registry },
    );
    handle.proc.stdin?.end();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let invalid = false;
    for (const stream of [handle.proc.stdout, handle.proc.stderr])
      stream?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) invalid = true;
        else if (stream === handle.proc.stdout) chunks.push(Buffer.from(chunk));
      });
    const completed = new Promise<number | null>((resolve, reject) => {
      handle.proc.once('error', reject);
      handle.proc.once('close', (code) => resolve(code));
    });
    void completed.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('native_container_command_unconfirmed')),
            10_000,
          );
        }),
      ]);
      if (code !== 0 || invalid)
        throw new Error('native_container_command_failed');
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } finally {
      if (timer) clearTimeout(timer);
      await terminateProcessTree(handle.proc, {
        graceMs: 1_000,
        killConfirmMs: 1_000,
      });
      try {
        await completed;
      } finally {
        handle.release();
      }
    }
  }
}
