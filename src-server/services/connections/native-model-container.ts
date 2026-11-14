// UNWIRED #91: authenticated issuance, staged publication and native image qualification remain required.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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
import type { NativeModelRequest } from './native-model-stdio-protocol.js';

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
  #ready: { port: number; uid: number | null } | undefined;
  #engaged = false;
  #removed = false;
  #removal: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #retiring = false;
  #createSubmitted = false;

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
      this.#channel = new NativeModelStdioChannel(
        { input: stdin, output: stdout, settled, stop },
        (input, signal) => {
          const admitted = (async () => {
            if (!this.#engaged || this.#retiring)
              throw new Error('native_container_not_engaged');
            await this.#inspect(true);
            signal.throwIfAborted();
            if (!this.#engaged || this.#retiring)
              throw new Error('native_container_not_engaged');
            return this.options.request(input, signal);
          })();
          return {
            response: admitted.then((owner) => owner.response),
            settled: admitted.then((owner) => owner.settled),
            invokeDelivery: async (write) =>
              (await admitted).invokeDelivery(write),
          };
        },
      );
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

  inspect() {
    return {
      containerId: this.#id,
      imageId: this.options.imageId,
      engaged: this.#engaged,
      removed: this.#removed,
      modelChannel: this.#channel?.inspect(),
      journalDirectory: this.#directory,
    };
  }

  close(): Promise<void> {
    this.#retiring = true;
    this.#engaged = false;
    if (!this.#closing)
      this.#closing = (async () => {
        let failure: unknown;
        if (this.#channel)
          try {
            await this.#channel.close();
          } catch (error) {
            failure = error;
          }
        else if (this.#id)
          try {
            await this.#remove();
          } catch (error) {
            failure = error;
          }
        await this.#starting?.catch(() => {});
        if (!this.#removed) {
          if (!this.#createSubmitted) this.#removed = true;
          else if (this.#id) await this.#remove();
          else {
            await this.#journal('create-unconfirmed');
            throw new Error('native_container_creation_unconfirmed');
          }
        }
        await this.#journal(failure ? 'removed-channel-failed' : 'removed');
        if (failure) throw failure;
      })();
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
