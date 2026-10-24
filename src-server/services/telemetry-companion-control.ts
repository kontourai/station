import { createHash } from 'node:crypto';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  isProductTelemetryTrends,
  isProductTelemetryTrendWindow,
  type ProductTelemetryTrends,
} from '@kontourai/station-contracts/product-telemetry';
import {
  isTelemetryCompanionOperationId,
  type TelemetryCompanionAction,
  type TelemetryCompanionManagedState,
} from '@kontourai/station-contracts/telemetry-delivery';
import { verifyReleaseManifest } from '@kontourai/station-shared/release-manifest';
import { z } from 'zod/v3';
import PINNED_KEYS from '../../config/release-manifest-keys.json' with {
  type: 'json',
};
import { runInProcessGroup } from '../utils/process-group-exec.js';
import { readTelemetryCompanionHost } from './telemetry-companion.js';
import {
  readCompanionFile,
  verifyTelemetryCompanion,
} from './telemetry-companion-artifact.mjs';
import { readTelemetryCompanionInstallation } from './telemetry-companion-install.js';
import type { CompanionParentVerificationOptions } from './telemetry-companion-release.js';
import {
  captureCompanionHomeCustody,
  companionCustodyDigest,
  companionDurableJson,
  companionErrno,
  companionPrivateDirectory,
  syncCompanionDirectory,
} from './telemetry-companion-storage.js';
import {
  abortableTelemetryOperation,
  readTelemetryJson,
} from './telemetry-response.js';

const id = z.string().refine(isTelemetryCompanionOperationId);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actionSchema = z
  .object({
    protocol: z.literal('station-companion-action/v1'),
    operationId: id,
    installationId: id,
    action: z.enum(['start', 'stop']),
    phase: z.enum(['pending', 'completed', 'unconfirmed']),
    createdAt: z.string().datetime(),
    configuresSending: z.literal(false),
  })
  .strict();
const deploymentSchema = z.object({
  owner: z.string().regex(/^[a-f0-9]{24}$/),
  project: z.string(),
  endpoint: z.string().startsWith('unix://').max(2048),
  daemonId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
  architecture: z.enum(['amd64', 'arm64']),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifestSha256: digest,
  custody: digest,
  homeCustody: z
    .object({
      path: z.string(),
      device: z.string().regex(/^\d+$/),
      inode: z.string().regex(/^\d+$/),
    })
    .strict(),
  ports: z
    .array(
      z
        .number()
        .int()
        .min(1025)
        .max(65535)
        .refine((port) => ![3000, 3141].includes(port)),
    )
    .length(3),
  containerIds: z.array(digest).length(6),
});
const SERVICES = [
  'postgres',
  'receiver',
  'collector',
  'prometheus',
  'tempo',
  'grafana',
];
const VOLUMES = [
  'postgres-data',
  'prometheus-data',
  'tempo-data',
  'grafana-data',
];
const NETWORKS = [
  'product',
  'product-ingress',
  'diagnostics',
  'diagnostics-ingress',
];
const containersSchema = z
  .array(
    z.object({
      Id: digest,
      Image: z.string(),
      State: z.object({
        Running: z.boolean(),
        Paused: z.boolean(),
        Restarting: z.boolean(),
        Status: z.string(),
        Health: z.object({ Status: z.string() }).optional(),
      }),
      Config: z.object({ Labels: z.record(z.string()) }),
      HostConfig: z.object({
        PortBindings: z
          .record(
            z.array(z.object({ HostIp: z.string(), HostPort: z.string() })),
          )
          .nullable(),
      }),
      NetworkSettings: z.object({
        Ports: z.record(
          z
            .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
            .nullable(),
        ),
      }),
    }),
  )
  .length(6);

export class CompanionControlRefusal extends Error {
  constructor(
    readonly reason:
      | 'installation-unavailable'
      | 'custody-mismatch'
      | 'runtime-unavailable'
      | 'artifact-unavailable'
      | 'operation-conflict'
      | 'reconciliation-required',
  ) {
    super(`Companion control refused: ${reason}`);
  }
}

async function roots(home: string) {
  const base = join(await realpath(home), 'telemetry-companion');
  await companionPrivateDirectory(base, false);
  const root = join(base, 'installations');
  await companionPrivateDirectory(root, false);
  return root;
}
async function currentId(home: string): Promise<string | null> {
  try {
    return z
      .object({ installationId: id })
      .strict()
      .parse(
        JSON.parse(
          (
            await readCompanionFile(
              join(await roots(home), 'current.json'),
              1024,
            )
          ).toString(),
        ),
      ).installationId;
  } catch (error) {
    if (companionErrno(error, 'ENOENT')) return null;
    throw error;
  }
}
export async function readTelemetryCompanionAction(
  home: string,
  installationId: string,
  operationId: string,
): Promise<TelemetryCompanionAction | null> {
  if (
    !isTelemetryCompanionOperationId(installationId) ||
    !isTelemetryCompanionOperationId(operationId)
  )
    throw new Error('Invalid companion action');
  try {
    const directory = join(await roots(home), installationId);
    await companionPrivateDirectory(directory, false);
    const actions = join(directory, 'actions');
    await companionPrivateDirectory(actions, false);
    const operation = join(actions, operationId);
    await companionPrivateDirectory(operation, false);
    const receipt = actionSchema.parse(
      JSON.parse(
        (
          await readCompanionFile(join(operation, 'receipt.json'), 4096)
        ).toString(),
      ),
    );
    if (
      receipt.operationId !== operationId ||
      receipt.installationId !== installationId
    )
      throw new Error('Action identity mismatch');
    return receipt;
  } catch (error) {
    if (companionErrno(error, 'ENOENT')) return null;
    throw error;
  }
}
async function latestAction(home: string, installationId: string) {
  try {
    const value = z
      .object({ operationId: id })
      .strict()
      .parse(
        JSON.parse(
          (
            await readCompanionFile(
              join(await roots(home), installationId, 'current-action.json'),
              1024,
            )
          ).toString(),
        ),
      );
    const action = await readTelemetryCompanionAction(
      home,
      installationId,
      value.operationId,
    );
    if (!action) throw new CompanionControlRefusal('reconciliation-required');
    return action;
  } catch (error) {
    if (companionErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

async function managed(
  home: string,
  installationId: string,
  requireOperator: () => Promise<void>,
  signal: AbortSignal,
) {
  await requireOperator();
  if ((await currentId(home)) !== installationId)
    throw new CompanionControlRefusal('installation-unavailable');
  const receipt = await readTelemetryCompanionInstallation(
    home,
    installationId,
  );
  if (receipt?.phase !== 'installed')
    throw new CompanionControlRefusal('installation-unavailable');
  const directory = join(await roots(home), installationId);
  await companionPrivateDirectory(directory, false);
  const state = deploymentSchema.parse(
    JSON.parse(
      (
        await readCompanionFile(join(directory, 'deployment.json'), 64 * 1024)
      ).toString(),
    ),
  );
  const homeCustody = await captureCompanionHomeCustody(home);
  if (
    JSON.stringify(homeCustody) !== JSON.stringify(state.homeCustody) ||
    state.project !== `station-telemetry-${state.owner}` ||
    new Set(state.containerIds).size !== 6 ||
    new Set(state.ports).size !== 3
  )
    throw new CompanionControlRefusal('custody-mismatch');
  const host = await readTelemetryCompanionHost();
  if (
    host.kind !== 'available' ||
    host.endpoint !== state.endpoint ||
    host.architecture !== state.architecture
  )
    throw new CompanionControlRefusal('runtime-unavailable');
  const custody = companionCustodyDigest(homeCustody, state.daemonId);
  if (custody !== state.custody)
    throw new CompanionControlRefusal('custody-mismatch');
  const raw = async (args: string[], timeout = 5000) =>
    (
      await runInProcessGroup('docker', ['--host', host.endpoint, ...args], {
        env: { ...process.env, DOCKER_CONTEXT: '' },
        timeout,
        maxBuffer: 256 * 1024,
        signal,
        retireDescendantsOnExit: true,
      })
    ).stdout.trim();
  const docker = async (args: string[], timeout = 5000) => {
    await requireOperator();
    signal.throwIfAborted();
    if (
      JSON.stringify(await captureCompanionHomeCustody(home)) !==
      JSON.stringify(homeCustody)
    )
      throw new CompanionControlRefusal('custody-mismatch');
    if ((await raw(['info', '--format', '{{.ID}}'])) !== state.daemonId)
      throw new CompanionControlRefusal('runtime-unavailable');
    await requireOperator();
    const value = await raw(args, timeout);
    await requireOperator();
    return value;
  };
  const inspect = async () => {
    const values = containersSchema.parse(
      JSON.parse(await docker(['inspect', ...state.containerIds])),
    );
    if (
      JSON.stringify(values.map((v) => v.Id).sort()) !==
        JSON.stringify([...state.containerIds].sort()) ||
      JSON.stringify(
        values.map((v) => v.Config.Labels['com.docker.compose.service']).sort(),
      ) !== JSON.stringify([...SERVICES].sort()) ||
      values.some(
        (v) =>
          v.Config.Labels['com.docker.compose.project'] !== state.project ||
          v.Config.Labels['station.telemetry.custody'] !== custody,
      )
    )
      throw new CompanionControlRefusal('custody-mismatch');
    const receiver = values.find(
      (v) => v.Config.Labels['com.docker.compose.service'] === 'receiver',
    );
    if (receiver?.Image !== state.imageId)
      throw new CompanionControlRefusal('custody-mismatch');
    for (const [service, target, index] of [
      ['receiver', 43891, 0],
      ['collector', 4318, 1],
      ['grafana', 3000, 2],
    ] as const) {
      const container = values.find(
        (v) => v.Config.Labels['com.docker.compose.service'] === service,
      );
      const binding = container?.HostConfig.PortBindings?.[`${target}/tcp`];
      if (
        binding?.length !== 1 ||
        binding[0]?.HostIp !== '127.0.0.1' ||
        binding[0]?.HostPort !== String(state.ports[index])
      )
        throw new CompanionControlRefusal('custody-mismatch');
      if (container?.State.Running) {
        const active = container.NetworkSettings.Ports[`${target}/tcp`];
        if (
          active?.length !== 1 ||
          active[0]?.HostIp !== '127.0.0.1' ||
          active[0]?.HostPort !== String(state.ports[index])
        )
          throw new CompanionControlRefusal('custody-mismatch');
      }
    }
    return values;
  };
  const containers = await inspect();
  const image = z
    .array(
      z.object({
        Id: z.string(),
        Config: z.object({ Labels: z.record(z.string()) }),
      }),
    )
    .length(1)
    .parse(JSON.parse(await docker(['image', 'inspect', state.imageId])))[0];
  if (
    !image ||
    image.Id !== state.imageId ||
    image.Config.Labels['station.telemetry.owner'] !== state.owner ||
    image.Config.Labels['station.telemetry.installation'] !== installationId ||
    image.Config.Labels['station.telemetry.custody'] !== custody ||
    image.Config.Labels['station.telemetry.manifest'] !==
      state.manifestSha256 ||
    image.Config.Labels['station.telemetry.source'] !== receipt.source
  )
    throw new CompanionControlRefusal('custody-mismatch');
  for (const [kind, names] of [
    ['volume', VOLUMES],
    ['network', NETWORKS],
  ] as const) {
    const resources = z
      .array(z.object({ Name: z.string(), Labels: z.record(z.string()) }))
      .length(names.length)
      .parse(
        JSON.parse(
          await docker([
            kind,
            'inspect',
            ...names.map((name) => `${state.project}_${name}`),
          ]),
        ),
      );
    if (
      resources.some(
        (resource) =>
          resource.Labels['com.docker.compose.project'] !== state.project ||
          resource.Labels['station.telemetry.custody'] !== custody,
      ) ||
      JSON.stringify(resources.map((v) => v.Name).sort()) !==
        JSON.stringify(names.map((name) => `${state.project}_${name}`).sort())
    )
      throw new CompanionControlRefusal('custody-mismatch');
  }
  return { receipt, state, directory, containers, image, docker, inspect };
}

async function verifyManagedArtifact(
  context: Awaited<ReturnType<typeof managed>>,
  verification?: Pick<CompanionParentVerificationOptions, 'keys'>,
) {
  try {
    const channel = context.image.Config.Labels['station.telemetry.channel'];
    if (!channel) throw new CompanionControlRefusal('artifact-unavailable');
    const intent = z
      .object({ envelope: z.unknown() })
      .parse(
        JSON.parse(
          (
            await readCompanionFile(
              join(context.directory, 'intent.json'),
              1024 * 1024,
            )
          ).toString(),
        ),
      );
    const release = verifyReleaseManifest(
      intent.envelope,
      verification?.keys ?? PINNED_KEYS,
      { expectedChannel: channel },
    );
    if (
      release.sourceSha !== context.receipt.source ||
      release.version !== context.receipt.version ||
      !release.artifacts.some(
        (artifact) =>
          artifact.sha256 ===
            context.image.Config.Labels['station.telemetry.archive'] &&
          artifact.format === 'tar.gz',
      )
    )
      throw new CompanionControlRefusal('artifact-unavailable');
    const snapshot = join(context.directory, 'payload');
    const manifest = await verifyTelemetryCompanion(snapshot);
    const hash = createHash('sha256')
      .update(
        await readCompanionFile(join(snapshot, 'companion-manifest.json')),
      )
      .digest('hex');
    if (
      hash !== context.image.Config.Labels['station.telemetry.manifest'] ||
      manifest.source !== release.sourceSha ||
      !manifest.qualification?.qualifications.some(
        (value) => value.architecture === context.state.architecture,
      )
    )
      throw new CompanionControlRefusal('artifact-unavailable');
  } catch {
    throw new CompanionControlRefusal('artifact-unavailable');
  }
}

async function storageReady(
  context: Awaited<ReturnType<typeof managed>>,
  requireOperator: () => Promise<void>,
  signal: AbortSignal,
) {
  await requireOperator();
  const key = (
    await readCompanionFile(
      join(context.directory, 'secrets/product-operator-key'),
      1024,
    )
  )
    .toString()
    .trim();
  if (!/^sto_[A-Za-z0-9_-]{43}$/.test(key)) return false;
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const response = await abortableTelemetryOperation(
    fetch(`http://127.0.0.1:${context.state.ports[0]}/v1/operator/storage`, {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'manual',
      signal: probeSignal,
    }),
    probeSignal,
  );
  const data = await readTelemetryJson(response, probeSignal);
  await requireOperator();
  return (
    response.status === 200 &&
    z
      .object({
        state: z.literal('ready'),
        scope: z.literal('postgres-schema-v1'),
      })
      .safeParse(data).success
  );
}

export async function readTelemetryCompanionManagedState(
  home: string,
  requireOperator: () => Promise<void>,
  verification?: Pick<CompanionParentVerificationOptions, 'keys'>,
): Promise<TelemetryCompanionManagedState> {
  await requireOperator();
  if (process.platform !== 'win32') await captureCompanionHomeCustody(home);
  const installationId = await currentId(home);
  const result: TelemetryCompanionManagedState = {
    supported: process.platform !== 'win32',
    hasOperationLock: false,
    installation: null,
    latestAction: null,
    runtime: installationId ? 'unavailable' : 'not-installed',
    storage: 'not-checked',
    observedAt: new Date().toISOString(),
  };
  let storeRoot: string | undefined;
  try {
    storeRoot = await roots(home);
    const lock = await lstat(join(storeRoot, 'installation.lock'));
    if (!lock.isFile() || lock.isSymbolicLink())
      throw new Error('Invalid operation lock');
    result.hasOperationLock = true;
  } catch (error) {
    if (!companionErrno(error, 'ENOENT')) throw error;
  }
  if (!installationId) {
    if (
      result.hasOperationLock ||
      (storeRoot && (await readdir(storeRoot)).length > 0)
    )
      result.runtime = 'unavailable';
    await requireOperator();
    return result;
  }
  result.installation = await readTelemetryCompanionInstallation(
    home,
    installationId,
  );
  if (!result.installation)
    throw new CompanionControlRefusal('reconciliation-required');
  result.latestAction = await latestAction(home, installationId);
  try {
    const signal = AbortSignal.timeout(20_000);
    const context = await managed(
      home,
      installationId,
      requireOperator,
      signal,
    );
    const values = context.containers;
    result.runtime = values.every(
      (v) => v.State.Running && !v.State.Paused && !v.State.Restarting,
    )
      ? 'running'
      : values.every(
            (v) =>
              !v.State.Running &&
              ['created', 'exited'].includes(v.State.Status),
          )
        ? 'stopped'
        : 'partial';
    if (result.runtime === 'running') {
      await verifyManagedArtifact(context, verification);
      result.storage = (await storageReady(context, requireOperator, signal))
        ? 'ready'
        : 'unavailable';
    }
  } catch {
    if (result.runtime === 'running') result.storage = 'unavailable';
  }
  await requireOperator();
  return result;
}

export async function controlTelemetryCompanion(
  home: string,
  installationId: string,
  input: {
    operationId: string;
    action: 'start' | 'stop';
    requireOperator(): Promise<void>;
    signal?: AbortSignal;
    verification?: Pick<CompanionParentVerificationOptions, 'keys'>;
  },
): Promise<TelemetryCompanionAction> {
  if (
    !isTelemetryCompanionOperationId(installationId) ||
    !isTelemetryCompanionOperationId(input.operationId) ||
    !['start', 'stop'].includes(input.action)
  )
    throw new Error('Invalid companion action');
  await input.requireOperator();
  const existing = await readTelemetryCompanionAction(
    home,
    installationId,
    input.operationId,
  );
  if (existing) {
    if (existing.action !== input.action)
      throw new CompanionControlRefusal('operation-conflict');
    return existing;
  }
  const root = await roots(home);
  const lockPath = join(root, 'installation.lock');
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (companionErrno(error, 'EEXIST'))
      throw new CompanionControlRefusal('reconciliation-required');
    throw error;
  }
  let identity: { dev: number; ino: number } | undefined;
  let operation: string | undefined;
  const receipt: TelemetryCompanionAction = {
    protocol: 'station-companion-action/v1',
    operationId: input.operationId,
    installationId,
    action: input.action,
    phase: 'pending',
    createdAt: new Date().toISOString(),
    configuresSending: false,
  };
  try {
    identity = await lock.stat();
    await lock.writeFile(
      JSON.stringify({
        installationId,
        operationId: input.operationId,
        pid: process.pid,
      }),
    );
    await lock.sync();
    const prior = await readTelemetryCompanionAction(
      home,
      installationId,
      input.operationId,
    );
    if (prior) {
      if (prior.action !== input.action)
        throw new CompanionControlRefusal('operation-conflict');
      return prior;
    }
    const latest = await latestAction(home, installationId);
    if (input.action === 'start' && latest && latest.phase !== 'completed')
      throw new CompanionControlRefusal('reconciliation-required');
    const signal = AbortSignal.any([
      AbortSignal.timeout(180_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const context = await managed(
      home,
      installationId,
      input.requireOperator,
      signal,
    );
    if (input.action === 'start')
      await verifyManagedArtifact(context, input.verification);
    const actions = join(context.directory, 'actions');
    await companionPrivateDirectory(actions, true);
    const operationDirectory = join(actions, input.operationId);
    operation = operationDirectory;
    await mkdir(operationDirectory, { mode: 0o700 });
    await syncCompanionDirectory(actions);
    await companionDurableJson(join(operation, 'intent.json'), {
      operationId: input.operationId,
      installationId,
      action: input.action,
      custody: context.state.custody,
      daemonId: context.state.daemonId,
      containerIds: context.state.containerIds,
    });
    await companionDurableJson(join(operation, 'receipt.json'), receipt);
    await companionDurableJson(join(context.directory, 'current-action.json'), {
      operationId: input.operationId,
    });
    let sequence = 0;
    const effect = async (args: string[]) => {
      const index = sequence++;
      await companionDurableJson(
        join(operationDirectory, `effect-${index}.json`),
        {
          args,
          state: 'intent',
        },
      );
      await context.inspect();
      const output = await context.docker(args, 90_000);
      await writeFile(join(operationDirectory, `effect-${index}.log`), output, {
        mode: 0o600,
        flag: 'wx',
      });
      await companionDurableJson(
        join(operationDirectory, `effect-${index}.json`),
        {
          args,
          state: 'completed',
        },
      );
    };
    if (input.action === 'stop') {
      await effect(['stop', '--time', '15', ...context.state.containerIds]);
      const values = await context.inspect();
      if (values.some((v) => v.State.Running))
        throw new Error('Companion stop incomplete');
    } else {
      const postgres = context.containers.find(
        (v) => v.Config.Labels['com.docker.compose.service'] === 'postgres',
      );
      if (!postgres) throw new Error('Postgres unavailable');
      await effect(['start', postgres.Id]);
      const deadline = Date.now() + 120_000;
      for (;;) {
        const values = await context.inspect();
        if (
          values.find((v) => v.Id === postgres.Id)?.State.Health?.Status ===
          'healthy'
        )
          break;
        if (Date.now() > deadline)
          throw new Error('Postgres readiness deadline');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await effect([
        'start',
        ...context.state.containerIds.filter((value) => value !== postgres.Id),
      ]);
      for (;;) {
        const values = await context.inspect();
        if (
          values.every(
            (v) => v.State.Running && !v.State.Paused && !v.State.Restarting,
          )
        ) {
          try {
            if (await storageReady(context, input.requireOperator, signal))
              break;
          } catch {
            await input.requireOperator();
          }
        }
        if (Date.now() > deadline)
          throw new Error('Companion storage readiness deadline');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await input.requireOperator();
    signal.throwIfAborted();
    receipt.phase = 'completed';
    await companionDurableJson(join(operation, 'receipt.json'), receipt);
    return receipt;
  } catch (error) {
    if (operation) {
      receipt.phase = 'unconfirmed';
      await companionDurableJson(join(operation, 'receipt.json'), receipt);
    }
    throw error;
  } finally {
    await lock.close();
    if (identity) {
      const entry = await lstat(lockPath);
      if (
        !entry.isSymbolicLink() &&
        entry.dev === identity.dev &&
        entry.ino === identity.ino
      ) {
        await unlink(lockPath);
        await syncCompanionDirectory(root);
      }
    }
  }
}

/** Core retains the receiver operator key; callers receive only validated aggregates. */
export async function readTelemetryCompanionProductTrends(
  home: string,
  window: { from: string; to: string },
  requireOperator: () => Promise<void>,
  requestSignal: AbortSignal,
): Promise<ProductTelemetryTrends> {
  await requireOperator();
  if (!isProductTelemetryTrendWindow(window.from, window.to))
    throw new Error('Invalid product trend window');
  const installationId = await currentId(home);
  if (!installationId)
    throw new CompanionControlRefusal('installation-unavailable');
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(20_000)]);
  const context = await managed(home, installationId, requireOperator, signal);
  if (
    context.containers.some(
      (value) =>
        !value.State.Running || value.State.Paused || value.State.Restarting,
    )
  )
    throw new CompanionControlRefusal('runtime-unavailable');
  await verifyManagedArtifact(context);
  const key = (
    await readCompanionFile(
      join(context.directory, 'secrets/product-operator-key'),
      1024,
    )
  )
    .toString()
    .trim();
  if (!/^sto_[A-Za-z0-9_-]{43}$/.test(key))
    throw new Error('Companion credential unavailable');
  await requireOperator();
  signal.throwIfAborted();
  const url = new URL(
    `http://127.0.0.1:${context.state.ports[0]}/v1/operator/trends`,
  );
  url.search = new URLSearchParams(window).toString();
  const response = await abortableTelemetryOperation(
    fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'manual',
      signal,
    }),
    signal,
  );
  const data = await readTelemetryJson(response, signal, 512 * 1024);
  await requireOperator();
  if (
    response.status !== 200 ||
    !isProductTelemetryTrends(data) ||
    data.window.from !== window.from ||
    data.window.to !== window.to
  )
    throw new Error('Companion product trends unavailable');
  return data;
}
