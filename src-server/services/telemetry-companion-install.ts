import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import {
  isTelemetryCompanionOperationId,
  type TelemetryCompanionInstallation,
} from '@kontourai/station-contracts/telemetry-delivery';
import { z } from 'zod/v3';
import type { InstallProvenance } from '../routes/system/install-provenance.js';
import { runInProcessGroup } from '../utils/process-group-exec.js';
import { readTelemetryCompanionHost } from './telemetry-companion.js';
import { readTelemetryCompanionArchivePreparation } from './telemetry-companion-archive.js';
import {
  COMPANION_FILES,
  readCompanionFile,
  verifyTelemetryCompanion,
} from './telemetry-companion-artifact.mjs';
import { materializeTelemetryCompanion } from './telemetry-companion-extract.js';
import {
  type CompanionParentVerificationOptions,
  readTelemetryCompanionVerifiedParent,
} from './telemetry-companion-release.js';
import {
  captureCompanionHomeCustody,
  companionCustodyDigest,
  companionDurableJson,
  companionErrno,
  companionPrivateDirectory,
  syncCompanionDirectory,
} from './telemetry-companion-storage.js';

const installationSchema = z
  .object({
    protocol: z.literal('station-companion-installation/v1'),
    installationId: z.string().refine(isTelemetryCompanionOperationId),
    preparationId: z.string().refine(isTelemetryCompanionOperationId),
    source: z.string().regex(/^[a-f0-9]{40}$/),
    version: z.string().min(1).max(128),
    architecture: z.enum(['amd64', 'arm64']),
    phase: z.enum(['preparing', 'installed', 'failed']),
    createdAt: z.string().datetime(),
    host: z.literal('selected-station'),
    storage: z.literal('managed-docker-volumes'),
    configuresSending: z.literal(false),
  })
  .strict();

async function installationPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (
    !address ||
    typeof address === 'string' ||
    [3000, 3141].includes(address.port)
  )
    throw new Error('Companion port unavailable');
  return address.port;
}

export class CompanionInstallationRefusal extends Error {
  constructor(
    readonly reason:
      | 'unsupported'
      | 'preparation-required'
      | 'qualification-required'
      | 'architecture-mismatch'
      | 'operation-conflict'
      | 'reconciliation-required',
  ) {
    super(`Companion installation refused: ${reason}`);
  }
}

async function installationRoot(home: string, create: boolean) {
  const base = join(await realpath(home), 'telemetry-companion');
  await companionPrivateDirectory(base, create);
  const root = join(base, 'installations');
  await companionPrivateDirectory(root, create);
  return root;
}

export async function readTelemetryCompanionInstallation(
  home: string,
  installationId: string,
): Promise<TelemetryCompanionInstallation | null> {
  if (!isTelemetryCompanionOperationId(installationId))
    throw new Error('Invalid installation ID');
  try {
    const directory = join(await installationRoot(home, false), installationId);
    await companionPrivateDirectory(directory, false);
    const receipt = installationSchema.parse(
      JSON.parse(
        (
          await readCompanionFile(join(directory, 'receipt.json'), 8192)
        ).toString(),
      ),
    );
    if (receipt.installationId !== installationId)
      throw new Error('Installation receipt identity mismatch');
    return receipt;
  } catch (error) {
    if (companionErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

// Fixed code and fixed filenames; generated secrets arrive on stdin, never command arguments.
const PREPARE_SECRET_COPIES = `
const fs = require('node:fs');
const values = JSON.parse(fs.readFileSync(0, 'utf8'));
const owners = {'postgres-password':1000,'database-url':1000,'product-operator-key':1000,'otel-key':1000,'grafana-password':472};
if (fs.readdirSync('/owned').length || JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(Object.keys(owners).sort())) throw Error('Secret destination is not empty or input is invalid');
for (const [name, uid] of Object.entries(owners)) {
  if (typeof values[name] !== 'string' || !values[name].length || values[name].length > 1024) throw Error('Invalid secret input');
  const file = '/owned/' + name;
  fs.writeFileSync(file, values[name], {flag:'wx',mode:0o400});
  fs.chownSync(file, uid, uid);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const directory = fs.openSync('/owned', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
`;

/** Creates stopped, owned services. It never starts them or configures a telemetry destination. */
export async function installTelemetryCompanion(
  provenance: InstallProvenance,
  input: {
    home: string;
    installationId: string;
    preparationId: string;
    requireOperator(): Promise<void>;
    signal?: AbortSignal;
    verification?: CompanionParentVerificationOptions;
  },
): Promise<TelemetryCompanionInstallation> {
  if (process.platform === 'win32')
    throw new CompanionInstallationRefusal('unsupported');
  if (
    !isTelemetryCompanionOperationId(input.installationId) ||
    !isTelemetryCompanionOperationId(input.preparationId)
  )
    throw new Error('Invalid companion installation');
  await input.requireOperator();
  const homeCustody = await captureCompanionHomeCustody(input.home);
  const prior = await readTelemetryCompanionInstallation(
    input.home,
    input.installationId,
  );
  if (prior) {
    if (prior.preparationId !== input.preparationId)
      throw new CompanionInstallationRefusal('operation-conflict');
    return prior;
  }
  const prepared = await readTelemetryCompanionArchivePreparation(
    input.home,
    input.preparationId,
  );
  if (prepared?.phase !== 'authenticated' || !prepared.payloadPrepared)
    throw new CompanionInstallationRefusal('preparation-required');
  const parent = await readTelemetryCompanionVerifiedParent(
    provenance,
    input.verification,
  );
  if (
    parent.kind !== 'verified' ||
    parent.artifact.format !== 'tar.gz' ||
    parent.release.sourceSha !== prepared.source ||
    parent.release.version !== prepared.version ||
    parent.artifact.sha256 !== prepared.artifactSha256 ||
    parent.artifact.size !== prepared.expectedBytes
  )
    throw new CompanionInstallationRefusal('preparation-required');
  const base = join(await realpath(input.home), 'telemetry-companion');
  const preparations = join(base, 'archive-preparations');
  await companionPrivateDirectory(preparations, false);
  const preparation = join(preparations, input.preparationId);
  await companionPrivateDirectory(preparation, false);
  // This can refuse an unavailable cache, but cannot authorize an effect: the signed archive is re-extracted below.
  if (
    !(await verifyTelemetryCompanion(join(preparation, 'payload')))
      .qualification
  )
    throw new CompanionInstallationRefusal('qualification-required');
  const host = await readTelemetryCompanionHost();
  if (host.kind !== 'available' || !host.endpoint.startsWith('unix://'))
    throw new CompanionInstallationRefusal('unsupported');
  await input.requireOperator();
  const root = await installationRoot(input.home, true);
  const lockPath = join(root, 'installation.lock');
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (companionErrno(error, 'EEXIST'))
      throw new CompanionInstallationRefusal('reconciliation-required');
    throw error;
  }
  let lockIdentity: { dev: number; ino: number } | undefined;
  let directoryOwned = false;
  const directory = join(root, input.installationId);
  const receipt: TelemetryCompanionInstallation = installationSchema.parse({
    protocol: 'station-companion-installation/v1',
    installationId: input.installationId,
    preparationId: input.preparationId,
    source: prepared.source,
    version: prepared.version,
    architecture: host.architecture,
    phase: 'preparing',
    createdAt: new Date().toISOString(),
    host: 'selected-station',
    storage: 'managed-docker-volumes',
    configuresSending: false,
  });
  try {
    lockIdentity = await lock.stat();
    await lock.writeFile(
      JSON.stringify({
        installationId: input.installationId,
        pid: process.pid,
      }),
    );
    await lock.sync();
    try {
      await readCompanionFile(join(root, 'current.json'), 1024);
      throw new CompanionInstallationRefusal('reconciliation-required');
    } catch (error) {
      if (!companionErrno(error, 'ENOENT')) throw error;
    }
    await mkdir(directory, { mode: 0o700 });
    directoryOwned = true;
    await syncCompanionDirectory(root);
    await companionDurableJson(join(directory, 'intent.json'), {
      installationId: input.installationId,
      preparationId: input.preparationId,
      envelope: parent.envelope,
      artifact: parent.artifact,
      host: receipt.host,
      storage: receipt.storage,
    });
    await companionDurableJson(join(directory, 'receipt.json'), receipt);
    await companionDurableJson(join(root, 'current.json'), {
      installationId: input.installationId,
    });
    const signal = AbortSignal.any([
      AbortSignal.timeout(600_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const snapshot = join(directory, 'payload');
    await materializeTelemetryCompanion({
      archive: join(preparation, 'parent-archive.tar.gz'),
      destination: snapshot,
      source: parent.release.sourceSha,
      expectedBytes: parent.artifact.size,
      expectedSha256: parent.artifact.sha256,
      signal,
      requireOperator: input.requireOperator,
    });
    const manifest = await verifyTelemetryCompanion(snapshot);
    if (!manifest.qualification)
      throw new CompanionInstallationRefusal('qualification-required');
    const qualification = manifest.qualification?.qualifications.find(
      (value) => value.architecture === host.architecture,
    );
    if (!qualification)
      throw new CompanionInstallationRefusal('architecture-mismatch');
    const owner = randomBytes(12).toString('hex');
    const project = `station-telemetry-${owner}`;
    const image = `station-telemetry:${owner}`;
    const secrets = join(directory, 'secrets');
    const mountedSecrets = join(directory, 'mounted-secrets');
    await companionPrivateDirectory(secrets, true);
    await companionPrivateDirectory(mountedSecrets, true);
    const password = randomBytes(32).toString('base64url');
    const values = {
      'postgres-password': password,
      'database-url': `postgresql://station_telemetry:${password}@postgres:5432/station_telemetry`,
      'product-operator-key': `sto_${randomBytes(32).toString('base64url')}`,
      'otel-key': randomBytes(32).toString('base64url'),
      'grafana-password': randomBytes(32).toString('base64url'),
    };
    for (const [name, value] of Object.entries(values)) {
      await writeFile(join(secrets, name), value, { mode: 0o400, flag: 'wx' });
      const handle = await open(join(secrets, name), 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await syncCompanionDirectory(secrets);
    const effects: Array<{
      label: string;
      state: 'intent' | 'completed' | 'unknown';
    }> = [];
    const state = {
      homeCustody,
      custody: '',
      owner,
      project,
      endpoint: host.endpoint,
      architecture: host.architecture,
      daemonId: '',
      imageId: '',
      manifestSha256: createHash('sha256')
        .update(
          await readCompanionFile(join(snapshot, 'companion-manifest.json')),
        )
        .digest('hex'),
      qualificationEvidence: qualification.evidenceSha256,
      effects,
    };
    const env = {
      ...process.env,
      DOCKER_HOST: host.endpoint,
      DOCKER_CONTEXT: '',
      COMPOSE_FILE: undefined,
      COMPOSE_ENV_FILES: undefined,
      COMPOSE_PROFILES: undefined,
    };
    const raw = async (args: string[], timeout: number, body?: string) => {
      const result = await runInProcessGroup(
        'docker',
        ['--host', host.endpoint, ...args],
        {
          cwd: join(snapshot, 'deployment'),
          env,
          timeout,
          maxBuffer: 256 * 1024,
          signal,
          input: body,
          retireDescendantsOnExit: true,
        },
      );
      return result;
    };
    await input.requireOperator();
    signal.throwIfAborted();
    state.daemonId = (
      await raw(['info', '--format', '{{.ID}}'], 5000)
    ).stdout.trim();
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(state.daemonId))
      throw new Error('Daemon identity unavailable');
    state.custody = companionCustodyDigest(homeCustody, state.daemonId);
    const docker = async (
      args: string[],
      label: string,
      timeout = 30_000,
      body?: string,
    ) => {
      await input.requireOperator();
      signal.throwIfAborted();
      if (
        JSON.stringify(await captureCompanionHomeCustody(input.home)) !==
        JSON.stringify(homeCustody)
      )
        throw new Error('Companion home custody changed');
      if (
        (await raw(['info', '--format', '{{.ID}}'], 5000)).stdout.trim() !==
        state.daemonId
      )
        throw new Error('Companion daemon changed');
      await input.requireOperator();
      const effect = { label, state: 'intent' as const };
      effects.push(effect);
      await companionDurableJson(join(directory, 'deployment.json'), state);
      await input.requireOperator();
      signal.throwIfAborted();
      try {
        const result = await raw(args, timeout, body);
        await writeFile(
          join(directory, `command-${effects.length}.log`),
          result.stdout + result.stderr,
          { mode: 0o600, flag: 'wx' },
        );
        effects[effects.length - 1] = { label, state: 'completed' };
        await companionDurableJson(join(directory, 'deployment.json'), state);
        return result.stdout.trim();
      } catch (error) {
        effects[effects.length - 1] = { label, state: 'unknown' };
        await companionDurableJson(join(directory, 'deployment.json'), state);
        throw error;
      }
    };
    const server = JSON.parse(
      await docker(
        ['version', '--format', '{{json .Server}}'],
        'confirm container architecture',
      ),
    );
    if (server.Os !== 'linux' || server.Arch !== host.architecture)
      throw new Error('Companion host changed');
    for (const [resource, args] of [
      [
        'containers',
        [
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ],
      ],
      ['networks', ['network', 'ls', '--format', '{{.Name}}']],
      ['volumes', ['volume', 'ls', '--format', '{{.Name}}']],
      [
        'image',
        [
          'image',
          'ls',
          '--filter',
          `reference=${image}`,
          '--format',
          '{{.ID}}',
        ],
      ],
    ] as const) {
      const names = (await docker([...args], `check unused ${resource}`))
        .split(/\s+/)
        .filter(Boolean);
      if (
        names.some((name) =>
          resource === 'networks' || resource === 'volumes'
            ? name.startsWith(`${project}_`)
            : true,
        )
      )
        throw new CompanionInstallationRefusal('reconciliation-required');
    }
    // Public release code/config is readable inside containers; its enclosing operation remains private.
    for (const path of [...COMPANION_FILES, 'companion-manifest.json']) {
      await chmod(join(snapshot, path), 0o644);
      for (
        let parentPath = dirname(join(snapshot, path));
        ;
        parentPath = dirname(parentPath)
      ) {
        await chmod(parentPath, 0o755);
        if (parentPath === snapshot) break;
      }
    }
    await docker(
      [
        'build',
        '--label',
        `station.telemetry.owner=${owner}`,
        '--label',
        `station.telemetry.installation=${input.installationId}`,
        '--label',
        `station.telemetry.custody=${state.custody}`,
        '--label',
        `station.telemetry.source=${receipt.source}`,
        '--label',
        `station.telemetry.manifest=${state.manifestSha256}`,
        '--label',
        `station.telemetry.archive=${parent.artifact.sha256}`,
        '--label',
        `station.telemetry.channel=${parent.release.channel}`,
        '-t',
        image,
        snapshot,
      ],
      'build qualified receiver',
      180_000,
    );
    state.imageId = await docker(
      ['image', 'inspect', image, '--format', '{{.Id}}'],
      'capture receiver image',
    );
    if (!/^sha256:[a-f0-9]{64}$/.test(state.imageId))
      throw new Error('Receiver image identity unavailable');
    const runtimeImage = (await readCompanionFile(join(snapshot, 'Dockerfile')))
      .toString()
      .match(/^FROM (\S+@sha256:[a-f0-9]{64})$/m)?.[1];
    if (!runtimeImage) throw new Error('Pinned runtime image unavailable');
    const mount = `type=bind,"source=${mountedSecrets.replaceAll('"', '""')}",target=/owned`;
    await docker(
      [
        'run',
        '--rm',
        '--name',
        `${project}-setup`,
        '--label',
        `station.telemetry.owner=${owner}`,
        '--network',
        'none',
        '--read-only',
        '--user',
        '0:0',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--cap-add',
        'DAC_OVERRIDE',
        '--mount',
        mount,
        '-i',
        '--entrypoint',
        'node',
        runtimeImage,
        '-e',
        PREPARE_SECRET_COPIES,
      ],
      'prepare private container credential copies',
      30_000,
      JSON.stringify(values),
    );
    const services = [
      'postgres',
      'receiver',
      'collector',
      'prometheus',
      'tempo',
      'grafana',
    ];
    const ports = await Promise.all([
      installationPort(),
      installationPort(),
      installationPort(),
    ]);
    if (new Set(ports).size !== 3) throw new Error('Companion ports collided');
    await companionDurableJson(join(directory, 'ports.json'), ports);
    Object.assign(state, { ports });
    Object.assign(env, {
      COMPOSE_PROJECT_NAME: project,
      TELEMETRY_HOME_CUSTODY: state.custody,
      TELEMETRY_PRIVATE_DIR: mountedSecrets,
      TELEMETRY_RECEIVER_IMAGE: state.imageId,
      TELEMETRY_PRODUCT_PORT: String(ports[0]),
      TELEMETRY_OTLP_PORT: String(ports[1]),
      TELEMETRY_GRAFANA_PORT: String(ports[2]),
    });
    const compose = [
      'compose',
      '-p',
      project,
      '-f',
      join(snapshot, 'deployment/compose.yaml'),
    ];
    const graph = z
      .object({
        name: z.literal(project),
        services: z.record(z.unknown()),
        volumes: z.record(
          z.object({ name: z.string(), external: z.boolean().optional() }),
        ),
        networks: z.record(
          z.object({ name: z.string(), external: z.boolean().optional() }),
        ),
      })
      .parse(
        JSON.parse(
          await docker(
            [...compose, 'config', '--format', 'json'],
            'validate managed resource names',
          ),
        ),
      );
    if (
      JSON.stringify(Object.keys(graph.services).sort()) !==
      JSON.stringify([...services].sort())
    )
      throw new Error('Unsupported companion service graph');
    for (const resources of [graph.volumes, graph.networks])
      for (const [name, resource] of Object.entries(resources))
        if (resource.external || resource.name !== `${project}_${name}`)
          throw new Error('Unowned companion resource');
    await docker(
      [
        ...compose,
        'pull',
        'postgres',
        'collector',
        'prometheus',
        'tempo',
        'grafana',
      ],
      'pull pinned dependencies',
      180_000,
    );
    await docker(
      [
        ...compose,
        'up',
        '--no-start',
        '--no-build',
        '--pull',
        'never',
        ...services,
      ],
      'create stopped services',
      60_000,
    );
    const ids = (
      await docker(
        [
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ],
        'capture owned containers',
      )
    )
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length !== services.length)
      throw new Error('Incomplete companion installation');
    if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id)))
      throw new Error('Invalid container identity');
    const containers = z
      .array(
        z.object({
          Id: z.string().regex(/^[a-f0-9]{64}$/),
          State: z.object({
            Running: z.literal(false),
            Status: z.literal('created'),
          }),
          Config: z.object({ Labels: z.record(z.string()) }),
        }),
      )
      .length(services.length)
      .parse(
        JSON.parse(
          await docker(['inspect', ...ids], 'confirm stopped owned containers'),
        ),
      );
    if (
      new Set(containers.map((container) => container.Id)).size !==
        services.length ||
      containers.some(
        (container) =>
          container.Config.Labels['com.docker.compose.project'] !== project,
      ) ||
      JSON.stringify(
        containers
          .map(
            (container) =>
              container.Config.Labels['com.docker.compose.service'],
          )
          .sort(),
      ) !== JSON.stringify([...services].sort())
    )
      throw new Error('Unexpected companion container');
    if (
      containers.some(
        (container) =>
          container.Config.Labels['station.telemetry.custody'] !==
          state.custody,
      )
    )
      throw new Error('Companion custody label unavailable');
    await input.requireOperator();
    signal.throwIfAborted();
    await companionDurableJson(join(directory, 'deployment.json'), {
      ...state,
      containerIds: containers.map((container) => container.Id),
    });
    receipt.phase = 'installed';
    await companionDurableJson(join(directory, 'receipt.json'), receipt);
    return receipt;
  } catch (error) {
    if (!directoryOwned) throw error;
    receipt.phase = 'failed';
    await companionDurableJson(join(directory, 'receipt.json'), receipt);
    throw error;
  } finally {
    await lock.close();
    if (lockIdentity) {
      const current = await lstat(lockPath);
      if (
        !current.isSymbolicLink() &&
        current.dev === lockIdentity.dev &&
        current.ino === lockIdentity.ino
      ) {
        await unlink(lockPath);
        await syncCompanionDirectory(root);
      }
    }
  }
}
