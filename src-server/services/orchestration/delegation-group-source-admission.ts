import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertLifecycleEligible,
  claimableMultiCursorSteps,
  definitionIdentity,
  type FlowDurableStepClaim,
  flowRunHead,
  flowRuntimeRoot,
  loadRun,
  validateDurableStepClaim,
  withRunMutationLock,
} from '@kontourai/flow';
import type { DelegationExecutionBindingV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { withoutLockedProjectOverrides } from '../../domain/managed-settings.js';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../runtime/conversation/local-grant-observation-owner.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerForRequest,
  stationControlCallerRecordSources,
} from '../../runtime/mcp/station-control-caller.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  getDirectSocketAddress,
  isRuntimeRequestPrincipalCurrent,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { outsideStationServerScope } from '../../security/station-server-scope.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import { execGit } from '../../utils/git-exec.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../utils/internal-api-token.js';
import { expandTilde } from '../../utils/paths.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';
import {
  readProjectRepository,
  resolveProjectRepositoryForRead,
} from '../projects/git-read-repository.js';
import { ProjectBindingsStore } from '../projects/project-binding-store.js';
import { ProjectManifestStore } from '../projects/project-manifest-store.js';
import { ProjectMembershipService } from '../projects/project-membership-service.js';
import { ProjectResourceResolver } from '../projects/project-resource-resolver.js';
import { ProjectService } from '../projects/project-service.js';
import {
  type CanonicalLocalGrantOrigin,
  EnvironmentSecurityService,
} from '../ssh/environment-security-service.js';
import type {
  HomeWriterLease,
  HomeWriterOwner,
} from '../ssh/home-writer-owner.js';
import { captureDelegationCreateCustody } from './create-request-claims.js';
import {
  assertSdkSourceWireCurrentSync,
  beginSdkSourceWire,
  capturedSdkSourceWire,
  disposeSdkSourceWire,
  retireSdkSourceWire,
  sdkDisposalPromise,
} from './delegation-group-sdk-source-wire-owner.js';
import { EventStore } from './event-store.js';
import { OrchestrationService } from './orchestration-service.js';
import {
  reportAdmissionSignatureMatches,
  validateStationReportAdmission,
} from './station-report-group-admission.js';

export class SourceRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function refuse(code: string): never {
  throw new SourceRefusal(code);
}
function sha(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
function json(value: unknown): string {
  if (value === undefined) refuse('non_json_source');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${json(v)}`)
    .join(',')}}`;
}
function id(value: string) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value)
  )
    refuse('invalid_identifier');
  return value;
}
function stamp(path: string) {
  const s = lstatSync(path, { bigint: true });
  return [
    s.dev,
    s.ino,
    s.mode,
    s.nlink,
    s.size,
    s.mtimeNs,
    s.ctimeNs,
    s.birthtimeNs,
  ].join(':');
}
function identity(path: string) {
  const s = lstatSync(path, { bigint: true });
  return [s.dev, s.ino, s.birthtimeNs].join(':');
}
function privateDirectory(path: string) {
  const s = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700
  )
    refuse('private_store_unavailable');
}
function readRegular(path: string, max: number, privateFile = false): Buffer {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > max ||
    (privateFile &&
      (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600))
  )
    refuse('unsupported_file');
  const expected = stamp(path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const held = fstatSync(fd);
    if (held.dev !== before.dev || held.ino !== before.ino)
      refuse('source_changed');
    const buffer = Buffer.alloc(Math.min(max, held.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    if (
      bytes.length > max ||
      bytes.length !== held.size ||
      stamp(path) !== expected
    )
      refuse('source_changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function durableCreate(
  directory: string,
  name: string,
  bytes: string,
  assertCurrent: () => void,
) {
  if (Buffer.byteLength(bytes) > 128 * 1024) refuse('receipt_bound_exceeded');
  privateDirectory(directory);
  const directoryIdentity = identity(directory);
  const temporary = join(directory, `.candidate-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertCurrent();
    privateDirectory(directory);
    if (identity(directory) !== directoryIdentity)
      refuse('private_store_changed');
    linkSync(temporary, join(directory, name));
    unlinkSync(temporary);
    const dir = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    if (error instanceof SourceRefusal) throw error;
    refuse('durability_unconfirmed');
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      // biome-ignore lint/correctness/noUnsafeFinally: unexpected cleanup failure must refuse publication.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
export type Selection = Readonly<{ projectSlug: string; resourceId?: string }>;
export type Subject = Readonly<{ groupId: string; workItemId: string }>;
export type RuntimeSourceRequestContext = Parameters<
  ReturnType<typeof createOrchestrationRequestPrincipalResolver>
>[0];
type SourceTuple = DelegationExecutionBindingV2['source'];
type Snapshot = Awaited<ReturnType<typeof captureSource>>['observed'];
const DOMAIN = 'station.private.local-group.source-observation.v1';
const MAX_FILES = 256;
const MAX_BYTES = 2 * 1024 * 1024;
const OPTIONS = { timeoutMs: 5000 };

type SourceObservationWitness = {
  top: string;
  gitDir: string;
  commonDir: string;
  identities: { root: string; git: string; common: string };
  files: ReadonlyArray<{ path: string; stamp: string }>;
  directories: ReadonlyArray<readonly [string, string]>;
  generatedDirectories: ReadonlyArray<readonly [string, string]>;
};

function sourceObservationOwner(
  witness: SourceObservationWitness,
  metadataBefore: string,
  metadata: () => string,
  assertProjectCurrent: () => void,
): () => void {
  const captured = structuredClone(witness);
  return () => {
    assertProjectCurrent();
    const { top, gitDir, commonDir, identities } = captured;
    if (
      metadata() !== metadataBefore ||
      realpathSync(top) !== top ||
      identity(top) !== identities.root ||
      identity(gitDir) !== identities.git ||
      identity(commonDir) !== identities.common
    )
      refuse('source_changed');
    for (const file of captured.files)
      if (stamp(join(top, file.path)) !== file.stamp) refuse('source_changed');
    for (const [path, held] of captured.directories)
      if (stamp(join(top, path)) !== held) refuse('source_changed');
    for (const [path, held] of captured.generatedDirectories)
      if (
        identity(join(top, path)) !== held ||
        realpathSync(join(top, path)) !== join(top, path)
      )
        refuse('source_changed');
  };
}

async function captureSource(
  home: string,
  selection: Selection,
  protectRead: <Value>(read: () => Value) => Value = (read) => read(),
) {
  id(selection.projectSlug);
  const deadline = performance.now() + 15_000;
  const requireTime = () => {
    if (performance.now() >= deadline) refuse('source_observation_deadline');
  };
  const storage = new FileStorageAdapter(home);
  const projects = new ProjectService(storage);
  const revision = protectRead(() =>
    storage.projectRevision(selection.projectSlug),
  );
  const assertProjectCurrent = revision.assertCurrent?.bind(revision);
  if (!assertProjectCurrent) refuse('project_currentness_unavailable');
  const project = protectRead(() => projects.getProject(selection.projectSlug));
  if (!isDeepStrictEqual(project, revision.value) || !project.workingDirectory)
    refuse('project_unavailable');
  const manifests = new ProjectManifestStore(home, storage);
  const bindings = new ProjectBindingsStore(home);
  const resolver = new ProjectResourceResolver({
    homeDir: home,
    source: storage,
    manifests,
    bindings,
  });
  const manifest = protectRead(() =>
    manifests.readProjectManifest(project.slug),
  );
  const metadataFileWitness = (path: string) => {
    try {
      if (realpathSync(path) !== path) refuse('unsupported_project_metadata');
      const before = stamp(path);
      protectRead(() => readRegular(path, 512 * 1024));
      if (stamp(path) !== before) refuse('source_changed');
      return before;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const metadata = () =>
    protectRead(() => {
      const currentProject = withoutLockedProjectOverrides(project);
      const record = manifests.readRecord(project.slug);
      return json({
        // The captured Project revision is checked separately; composition still reads live layouts.
        project: currentProject,
        manifest: record
          ? manifests.composeManifest(record, currentProject)
          : null,
        bindings: bindings.read(),
        fileWitnesses: [
          join(home, 'projects', project.slug, 'project.json'),
          manifests.manifestPath(project.slug),
          bindings.path,
        ].map(metadataFileWitness),
      });
    });
  const metadataBefore = metadata();
  const resolution = await resolver.resolveProjectResource(
    project.slug,
    selection.resourceId,
  );
  if (metadata() !== metadataBefore) refuse('source_changed');
  if (resolution.state !== 'bound') refuse('resource_unavailable');
  const resource = manifest?.repos.find((r) => r.id === resolution.resourceId);
  if (
    manifest &&
    (!resource || (resource.kind !== 'git' && resource.kind !== 'local-only'))
  )
    refuse('unsupported_resource');
  const root = realpathSync(resolve(expandTilde(project.workingDirectory)));
  const top = realpathSync(resolution.path);
  // This finite candidate supports the Project's exact main checkout only.
  if (top !== root) refuse('execution_worktree_owner_unavailable');
  const repository = await resolveProjectRepositoryForRead(root, top, {
    ...OPTIONS,
    storage: 'read',
  });
  if (!repository.ok || repository.top !== top)
    refuse('repository_confinement_refused');
  const identities = {
    root: identity(top),
    git: identity(repository.gitDir),
    common: identity(repository.commonDir),
  };
  const generatedFlowRoot = relative(top, flowRuntimeRoot(top))
    .split(sep)
    .join('/');
  if (
    !generatedFlowRoot ||
    isAbsolute(generatedFlowRoot) ||
    generatedFlowRoot.split('/').includes('..')
  )
    refuse('flow_runtime_confinement_unavailable');
  const isGeneratedFlow = (path: string) =>
    path === generatedFlowRoot || path.startsWith(`${generatedFlowRoot}/`);
  const read = await readProjectRepository(root, top, OPTIONS, async (repo) => {
    const run = async (args: string[], input?: Buffer) => {
      requireTime();
      const result = await execGit([...repo.repoArgs, ...args], {
        cwd: repo.top,
        timeout: Math.min(5000, Math.ceil(deadline - performance.now())),
        maxBuffer: 128 * 1024,
        input,
        windowsHide: true,
      });
      requireTime();
      return result.stdout;
    };
    const cleanStatus = async () => {
      const status = await run([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
      ]);
      return status
        .split('\0')
        .filter(Boolean)
        .every((record) => {
          if (!record.startsWith('!! ')) return false;
          const path = record.slice(3).replace(/\/$/, '');
          return (
            isGeneratedFlow(path) || generatedFlowRoot.startsWith(`${path}/`)
          );
        });
    };
    const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
      refuse('unsupported_head');
    if (!(await cleanStatus())) refuse('dirty_source_unsupported');
    const stage = (await run(['ls-files', '--stage', '-z']))
      .split('\0')
      .filter(Boolean);
    const flags = (await run(['ls-files', '-v', '-z']))
      .split('\0')
      .filter(Boolean);
    if (
      stage.length > MAX_FILES ||
      flags.length !== stage.length ||
      flags.some((f) => !f.startsWith('H '))
    )
      refuse('unsupported_index');
    const tree = await run(['ls-tree', '-rz', '--full-tree', head]);
    const files: Array<{
      path: string;
      mode: string;
      hash: string;
      stamp: string;
    }> = [];
    const retainedFiles: Array<{
      path: string;
      mode: string;
      encoding: 'base64';
      content: string;
    }> = [];
    const expectedTree: string[] = [];
    let bytes = 0;
    for (const entry of stage) {
      const match =
        /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([^\0]+)$/.exec(entry);
      if (!match) refuse('unsupported_index');
      const [, mode, blob, path] = match;
      if (isGeneratedFlow(path)) refuse('tracked_flow_runtime_unsupported');
      if (
        !/^[A-Za-z0-9._/-]+$/.test(path) ||
        path
          .split('/')
          .some(
            (p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git',
          )
      )
        refuse('unsupported_path');
      const absolute = join(top, path);
      if (realpathSync(absolute) !== absolute) refuse('unsupported_path');
      const before = stamp(absolute);
      const content = protectRead(() =>
        readRegular(absolute, MAX_BYTES - bytes),
      );
      bytes += content.length;
      if (bytes > MAX_BYTES) refuse('source_bound_exceeded');
      if (((lstatSync(absolute).mode & 0o111) !== 0) !== (mode === '100755'))
        refuse('dirty_source_unsupported');
      if (
        (await run(['hash-object', '--stdin'], content)).trim() !== blob ||
        stamp(absolute) !== before
      )
        refuse('dirty_source_unsupported');
      files.push({ path, mode, hash: sha(content), stamp: before });
      retainedFiles.push({
        path,
        mode,
        encoding: 'base64',
        content: content.toString('base64'),
      });
      expectedTree.push(`${mode} blob ${blob}\t${path}\0`);
    }
    if (tree !== expectedTree.join('')) refuse('dirty_index_unsupported');
    const filePaths = new Set(files.map((f) => f.path));
    const directories: Array<[string, string]> = [];
    const generatedDirectories: Array<[string, string]> = [];
    let entries = 0;
    function walk(relative: string) {
      const absolute = join(top, relative);
      const before = stamp(absolute);
      const dir = lstatSync(absolute);
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        realpathSync(absolute) !== absolute
      )
        refuse('unsupported_path');
      for (const name of readdirSync(absolute).sort()) {
        if (relative === '' && name === '.git') continue;
        if (++entries > 512) refuse('source_bound_exceeded');
        const next = relative ? `${relative}/${name}` : name;
        const stat = lstatSync(join(top, next));
        if (next === generatedFlowRoot) {
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            realpathSync(join(top, next)) !== join(top, next)
          )
            refuse('unsupported_flow_runtime');
          generatedDirectories.push([next, identity(join(top, next))]);
          continue;
        }
        if (stat.isDirectory() && !stat.isSymbolicLink()) walk(next);
        else if (!filePaths.has(next)) refuse('untracked_source_unsupported');
      }
      if (stamp(absolute) !== before) refuse('source_changed');
      directories.push([relative, before]);
    }
    walk('');
    if (!(await cleanStatus())) refuse('source_changed');
    if ((await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== head)
      refuse('source_changed');
    for (const file of files)
      if (stamp(join(top, file.path)) !== file.stamp) refuse('source_changed');
    for (const [path, s] of directories)
      if (stamp(join(top, path)) !== s) refuse('source_changed');
    for (const [path, held] of generatedDirectories)
      if (identity(join(top, path)) !== held) refuse('source_changed');
    return { head, files, directories, generatedDirectories, retainedFiles };
  });
  if (!read.ok) refuse(`git_read_${read.state}`);
  requireTime();
  assertProjectCurrent();
  if (metadata() !== metadataBefore || !(await repository.unchanged()))
    refuse('source_changed');
  const { retainedFiles, ...observation } = read.value;
  const snapshotSerialization = json({
    format: 'station.source-files.v1',
    files: retainedFiles,
  });
  const observed = {
    projectId: project.id,
    projectSlug: project.slug,
    portableProjectId: manifest?.id ?? null,
    resourceId: resolution.resourceId ?? null,
    resourceKind: resource?.kind ?? 'legacy-local',
    root,
    top,
    gitDir: repository.gitDir,
    commonDir: repository.commonDir,
    identities,
    metadata: sha(metadataBefore),
    ...observation,
  };
  const assertObservationOwnersCurrentSync = sourceObservationOwner(
    {
      top,
      gitDir: repository.gitDir,
      commonDir: repository.commonDir,
      identities,
      files: observation.files,
      directories: observation.directories,
      generatedDirectories: observation.generatedDirectories,
    },
    metadataBefore,
    metadata,
    assertProjectCurrent,
  );
  assertObservationOwnersCurrentSync();
  return {
    observed,
    assertObservationOwnersCurrentSync,
    snapshotSerialization,
  };
}

type SourceRecordBase = {
  kind: 'source-class-only';
  id: string;
  issuedAt: number;
  expiresAt: number;
  principalId: string;
  hostContextId: string;
  privateHostContextWitness: string;
  subject: Subject;
  selection: Selection;
  observed: Snapshot;
};
type SessionCustody = {
  kind: 'station-control-session';
  sessionId: string;
  principalId: string;
  localProjectId: string;
  projectSlug: string;
  projectScope: ProjectMembershipScope;
  conversationId: string | null;
  tenantId: string | null;
};
type RecordV1 = SourceRecordBase & {
  schema: 1;
  principalCredentialHash: string;
};
type RecordV2 = SourceRecordBase & {
  schema: 2;
  sessionCustody: SessionCustody;
};
type SourceRecord = RecordV1 | RecordV2;
const sessionCredentialAuthorities = new WeakMap<
  object,
  {
    request: Request;
    identityDigest: string;
    hostContextId: string;
    privateHostContextWitness: string;
    projectSlug: string;
    agentId: string;
    assertMayCapture(): void;
    assertCurrent(): void;
    withObservationScope<T>(check: () => T): T;
  }
>();

/** Private request-bound Session custody; its identity comes only from this owner. */
export type StationControlSourceCredentialAuthority = object;

export function readStationControlSourceCredentialAuthority(
  capability: StationControlSourceCredentialAuthority,
  request: Request,
) {
  const held = sessionCredentialAuthorities.get(capability);
  if (!held || held.request !== request)
    refuse('station_control_source_unavailable');
  held.assertCurrent();
  return held;
}
/** Private source custody. Flow launch admission uses its sealed Project/resource observation. */
export class LocalSourceAdmissionOwner {
  readonly #snapshots = new Map<object, SealedState>();
  readonly #nativeSnapshots = new Map<
    object,
    {
      record: NativeTaskSealedRecord;
      serialization: string;
      request: Request;
      receiptPath: string;
      receiptStamp: string;
      assertCurrent(): void;
    }
  >();
  #pendingNativeSeals = 0;
  readonly #flowAdmissions = new WeakMap<object, object>();
  readonly #flowMutations = new Map<string, Promise<void>>();
  #pendingFlowMutations = 0;
  readonly #sdkPrepared = new Map<object, SdkPreparedState>();
  readonly #prepared = new Map<object, PreparedState>();
  #pendingSeals = 0;
  readonly #environment: EnvironmentSecurityService;
  readonly #canonicalLocalGrantOrigin?: CanonicalLocalGrantOrigin;
  readonly #personal = createPersonalRuntimeRequestGuard();
  readonly #home: string;
  readonly #store: string;
  readonly #storeIdentity: string;
  readonly #homeIdentity: string;
  readonly #stationControl?: {
    orchestration: OrchestrationService;
    eventStore: EventStore;
    projects: ProjectService;
    membership: ProjectMembershipService;
    coordinatorEnabled(): boolean;
  };
  constructor(
    home: string,
    environment: EnvironmentSecurityService,
    store: string,
    stationControl?: {
      orchestration: OrchestrationService;
      eventStore: EventStore;
      projects: ProjectService;
      membership: ProjectMembershipService;
      coordinatorEnabled(): boolean;
    },
    canonicalLocalGrantOrigin?: CanonicalLocalGrantOrigin,
  ) {
    this.#environment = environment;
    this.#canonicalLocalGrantOrigin = canonicalLocalGrantOrigin;
    this.#stationControl = stationControl;
    this.#home = realpathSync(home);
    this.#store = realpathSync(store);
    privateDirectory(this.#home);
    privateDirectory(this.#store);
    this.#storeIdentity = identity(this.#store);
    this.#homeIdentity = identity(this.#home);
  }
  #disposePrototype(
    capability: object,
    state: SealedState,
    port?: PreparedSnapshotWire,
  ) {
    if (state.phase === 'disposing' || state.phase === 'quarantined') return;
    state.released = true;
    state.phase = 'disposing';
    const pending: PreparedSnapshotWire[] = [];
    for (const [key, prepared] of this.#prepared) {
      if (prepared.capability === capability) {
        this.#prepared.delete(key);
        pending.push(prepared.port);
      }
    }
    if (port && !pending.includes(port)) pending.push(port);
    try {
      for (const owner of pending) requireSync(owner.disposeSync());
    } catch (error) {
      state.phase = 'quarantined';
      throw error;
    }
    if (this.#snapshots.get(capability) !== state)
      refuse('snapshot_disposal_unconfirmed');
    this.#snapshots.delete(capability);
    state.serialization = '';
  }
  #dropSnapshot(capability: object) {
    this.#flowAdmissions.delete(capability);
    const state = this.#snapshots.get(capability);
    if (!state) return;
    state.released = true;
    if (state.sdk) {
      this.#retireSdk(capability, state);
      return;
    }
    if (
      state.phase === 'preparing' ||
      state.phase === 'consuming' ||
      state.phase === 'disposing' ||
      state.phase === 'quarantined'
    )
      return;
    this.#disposePrototype(capability, state);
  }
  #retireSdk(capability: object, state: SealedState) {
    if (!state.sdk || state.sdk.cleanupQueued) return;
    const sdk = state.sdk;
    sdk.cleanupQueued = true;
    disposeSdkSourceWire(sdk.owner, sdk.handle);
    outsideStationServerScope(() => {
      void sdkDisposalPromise(sdk.owner, sdk.handle).then(() => {
        if (this.#snapshots.get(capability) !== state) return;
        for (const [key, prepared] of this.#sdkPrepared)
          if (prepared.state === state) this.#sdkPrepared.delete(key);
        sdkLeases.delete(sdk.lease);
        this.#snapshots.delete(capability);
        state.serialization = '';
      });
    });
  }
  #reapSnapshots() {
    for (const [capability, state] of this.#snapshots) {
      if (
        Date.now() < state.record.provenance.issuedAt ||
        Date.now() >= state.record.provenance.expiresAt
      )
        this.#dropSnapshot(capability);
    }
    for (const [capability, state] of this.#nativeSnapshots) {
      if (
        Date.now() < state.record.issuedAt ||
        Date.now() >= state.record.expiresAt
      )
        this.releaseRootNativeSnapshot(capability);
    }
  }
  #snapshotCount() {
    return (
      this.#snapshots.size + this.#nativeSnapshots.size + this.#pendingSeals
    );
  }
  #retainedSnapshotBytes() {
    return [
      ...this.#snapshots.values(),
      ...this.#nativeSnapshots.values(),
    ].reduce((size, state) => size + Buffer.byteLength(state.serialization), 0);
  }
  async #authority(
    context: RuntimeSourceRequestContext,
    method: 'GET' | 'POST' = 'POST',
    actionPath:
      | '/api/orchestration/chat'
      | '/api/orchestration/delegations' = '/api/orchestration/chat',
  ) {
    const request = context.req.raw;
    if (request.method !== method) refuse('request_method_unsupported');
    const bound = stationControlRequestAuthority(request);
    if (bound?.kind === 'caller') {
      if (
        !this.#personal(request) ||
        request.method !== method ||
        request.headers.has(INTERNAL_TENANT_HEADER)
      )
        refuse('station_control_source_unavailable');
      const owners = this.#stationControl;
      if (
        !owners ||
        !(owners.membership instanceof ProjectMembershipService) ||
        !(owners.orchestration instanceof OrchestrationService) ||
        !(owners.eventStore instanceof EventStore) ||
        !(owners.projects instanceof ProjectService)
      )
        refuse('station_control_source_unavailable');
      if (realpathSync(this.#environment.getProjectHomeDir()) !== this.#home)
        refuse('home_context_mismatch');
      const callerRecords = createStationControlCallerRecordResolver(
        stationControlCallerRecordSources({
          orchestrationService: owners.orchestration,
          eventStore: owners.eventStore,
          coordinatorEnabled: owners.coordinatorEnabled,
          getProject: (slug) => owners.projects.getProject(slug),
        }),
      );
      const resolve = () =>
        resolveStationControlCallerForRequest(request, callerRecords);
      const callerToken = request.headers.get(
        STATION_CONTROL_CALLER_TOKEN_HEADER,
      );
      const caller = resolve();
      if (
        !caller ||
        caller.assurance !== 'bound' ||
        caller.principal?.source !== 'session-owner' ||
        !caller.principal.elevationEligible ||
        caller.projectIdSource !== 'session-record' ||
        !caller.localProjectId ||
        !caller.projectSlug ||
        !isDeepStrictEqual(bound.caller, caller)
      )
        refuse('station_control_source_unavailable');
      const projectAction = method === 'GET' ? 'view' : 'execute';
      const initialAdmissions = owners.membership
        .admissionsForResolvedPrincipal(caller.principal.id)
        .filter(
          ({ scope, member }) =>
            scope.localProjectId === caller.localProjectId &&
            scope.localProjectSlug === caller.projectSlug &&
            member.actions.includes(projectAction),
        );
      if (initialAdmissions.length !== 1)
        refuse('station_control_project_unavailable');
      const capturedScope = structuredClone(initialAdmissions[0]!.scope);
      const sessionCustody: SessionCustody = {
        kind: 'station-control-session',
        sessionId: caller.sessionId,
        principalId: caller.principal.id,
        localProjectId: caller.localProjectId,
        projectSlug: caller.projectSlug,
        projectScope: capturedScope,
        conversationId: caller.conversationId ?? null,
        tenantId: request.headers.get(INTERNAL_TENANT_HEADER),
      };
      const host = await this.#environment.readExistingRecord();
      if (capturedScope.stationId !== host.environmentId)
        refuse('station_control_project_unavailable');
      const contextBinding = json([DOMAIN, host.environmentId]);
      const localEnvironment = new EnvironmentSecurityService({
        homeDir: this.#home,
      });
      const witness =
        this.#environment.signRevisionEvidenceAuthorityBinding(contextBinding);
      const assertCurrent = () =>
        this.#environment.withCurrentAuthority(() => {
          request.signal.throwIfAborted();
          const now = resolve();
          if (
            !this.#personal(request) ||
            !callerToken ||
            request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER) !==
              callerToken ||
            stationControlRequestAuthority(request) !== bound ||
            !now ||
            !isDeepStrictEqual(now, caller) ||
            !isRuntimeRequestPrincipalCurrent(request, this.#environment)
          )
            refuse('station_control_source_unavailable');
          const admitted = owners.membership
            .admissionsForResolvedPrincipal(sessionCustody.principalId)
            .filter(
              ({ scope, member }) =>
                isDeepStrictEqual(scope, capturedScope) &&
                member.actions.includes(projectAction),
            );
          if (admitted.length !== 1)
            refuse('station_control_project_unavailable');
          privateDirectory(this.#home);
          privateDirectory(this.#store);
          if (
            identity(this.#home) !== this.#homeIdentity ||
            identity(this.#store) !== this.#storeIdentity ||
            localEnvironment.signRevisionEvidenceAuthorityBinding(
              contextBinding,
            ) !== witness ||
            this.#environment.signRevisionEvidenceAuthorityBinding(
              contextBinding,
            ) !== witness
          )
            refuse('home_context_mismatch');
        });
      assertCurrent();
      return {
        request,
        principalId: sessionCustody.principalId,
        sessionCustody,
        lease: {
          hostContextId: host.environmentId,
          privateHostContextWitness: witness,
        },
        assertCurrent,
      };
    }
    const headerValues = new Map(
      [INTERNAL_API_TOKEN_HEADER, INTERNAL_INGRESS_IDENTITY_HEADER].map(
        (name) => [name, context.req.header(name)],
      ),
    );
    const address = getDirectSocketAddress(context.env);
    const capturedContext = Object.freeze({
      env: Object.freeze({
        incoming: Object.freeze({
          socket: Object.freeze({ remoteAddress: address }),
        }),
      }),
      req: Object.freeze({
        raw: request,
        header(name: string) {
          if (!headerValues.has(name)) refuse('request_metadata_unsupported');
          return headerValues.get(name);
        },
      }),
    });
    if (realpathSync(this.#environment.getProjectHomeDir()) !== this.#home)
      refuse('home_context_mismatch');
    const lease =
      method === 'POST'
        ? (
            await captureEnvironmentLocalGrantObservationOwner(
              request,
              this.#environment,
              this.#environment,
              undefined,
              this.#canonicalLocalGrantOrigin,
            )
          ).requireCurrentLocalGrant(request)
        : await captureEnvironmentLocalGrantReadOwner(
            request,
            this.#environment,
            this.#environment,
            undefined,
            this.#canonicalLocalGrantOrigin,
          ).then((read) => ({
            ...read,
            privateHostContextWitness:
              this.#environment.signRevisionEvidenceAuthorityBinding(
                json([
                  'station.provider-credential-observation.host-context.v1',
                  read.hostContextId,
                ]),
              ),
          }));
    // Bind the supplied existing environment owner to this exact canonical home.
    const localEnvironment = new EnvironmentSecurityService({
      homeDir: this.#home,
    });
    const contextBinding = json([DOMAIN, lease.hostContextId]);
    if (
      localEnvironment.signRevisionEvidenceAuthorityBinding(contextBinding) !==
      this.#environment.signRevisionEvidenceAuthorityBinding(contextBinding)
    )
      refuse('home_context_mismatch');
    const principalNow = () =>
      createOrchestrationRequestPrincipalResolver({
        environmentSecurityService: this.#environment,
      })(capturedContext);
    const principal = principalNow();
    const assertCurrent = () =>
      this.#environment.withCurrentAuthority(() => {
        lease.assertCurrent();
        if (
          !this.#personal(request) ||
          !isOperatorInPersonNotAgent(request) ||
          principal.id !== LOCAL_OPERATOR_PRINCIPAL_ID ||
          principalNow().id !== principal.id
        )
          refuse('personal_operator_required');
        privateDirectory(this.#home);
        privateDirectory(this.#store);
        if (
          identity(this.#store) !== this.#storeIdentity ||
          identity(this.#home) !== this.#homeIdentity
        )
          refuse('private_store_changed');
        if (
          localEnvironment.signRevisionEvidenceAuthorityBinding(
            contextBinding,
          ) !==
          this.#environment.signRevisionEvidenceAuthorityBinding(contextBinding)
        )
          refuse('home_context_mismatch');
        lease.assertCurrent();
        if (
          method === 'POST'
            ? !runtimeRequestPrincipalMayAccessHttpRoute(
                request,
                this.#environment,
                {
                  method: 'POST',
                  path: actionPath,
                },
              )
            : !isRuntimeRequestPrincipalCurrent(request, this.#environment)
        )
          refuse('source_grant_action_not_authorized');
      });
    assertCurrent();
    return {
      lease,
      principalId: principal.id,
      sessionCustody: undefined,
      assertCurrent,
      request,
    };
  }
  async captureRequestAuthority(context: RuntimeSourceRequestContext) {
    const method = context.req.raw.method;
    if (method !== 'GET' && method !== 'POST')
      refuse('request_method_unsupported');
    const authority = await this.#authority(context, method);
    authority.assertCurrent();
    const ownerIdentity = authority.sessionCustody
      ? `station-control-session/v1:${sha(json(authority.sessionCustody))}`
      : authority.principalId;
    return Object.freeze({
      principalId: authority.principalId,
      hostContextId: authority.lease.hostContextId,
      ownerIdentity,
      assertCurrent: authority.assertCurrent,
    });
  }
  #sourceIdentity(
    authority: SnapshotAuthority,
  ):
    | Pick<RecordV1, 'schema' | 'principalCredentialHash'>
    | Pick<RecordV2, 'schema' | 'sessionCustody'> {
    if (authority.sessionCustody)
      return { schema: 2, sessionCustody: authority.sessionCustody };
    if (!authority.lease.principalCredential)
      refuse('personal_operator_required');
    return {
      schema: 1,
      principalCredentialHash: sha(authority.lease.principalCredential),
    };
  }
  #identityMatches(
    record: SourceRecord,
    authority: SnapshotAuthority,
  ): boolean {
    return record.schema === 1
      ? !Object.hasOwn(record, 'sessionCustody') &&
          !authority.sessionCustody &&
          !!authority.lease.principalCredential &&
          record.principalCredentialHash ===
            sha(authority.lease.principalCredential)
      : !Object.hasOwn(record, 'principalCredentialHash') &&
          !!authority.sessionCustody &&
          isDeepStrictEqual(record.sessionCustody, authority.sessionCustody);
  }
  #assertProject(authority: SnapshotAuthority, observed: Snapshot): void {
    if (
      authority.sessionCustody &&
      (observed.projectId !== authority.sessionCustody.localProjectId ||
        observed.projectSlug !== authority.sessionCustody.projectSlug ||
        observed.portableProjectId !==
          authority.sessionCustody.projectScope.portableProjectId)
    )
      refuse('station_control_project_unavailable');
  }
  #assertSelection(authority: SnapshotAuthority, selected: Selection): void {
    if (
      authority.sessionCustody &&
      selected.projectSlug !== authority.sessionCustody.projectSlug
    )
      refuse('station_control_project_unavailable');
    authority.assertCurrent();
  }
  /** A read returns source facts, never a source-admission receipt. */
  async observe(context: RuntimeSourceRequestContext, selection: Selection) {
    const selected = structuredClone(selection);
    const authority = await this.#authority(context);
    this.#assertSelection(authority, selected);
    const capture = await captureSource(this.#home, selected);
    this.#assertProject(authority, capture.observed);
    authority.assertCurrent();
    capture.assertObservationOwnersCurrentSync();
    return Object.freeze({
      kind: 'source-observation' as const,
      sourceStateId: `sha256:${sha(json(capture.observed))}`,
      dirtyStateFingerprint: null,
      guarantee: 'verified-observation-only' as const,
    });
  }
  /** Calling this explicit operator API admits only the observed source class. */
  async admitSource(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    selection: Selection,
  ): Promise<Readonly<SourceTuple>> {
    const selected =
      selection.resourceId === undefined
        ? { projectSlug: selection.projectSlug }
        : {
            projectSlug: selection.projectSlug,
            resourceId: selection.resourceId,
          };
    const boundSubject = {
      groupId: id(subject.groupId),
      workItemId: id(subject.workItemId),
    };
    const authority = await this.#authority(context);
    this.#assertSelection(authority, selected);
    const capture = await captureSource(this.#home, selected);
    this.#assertProject(authority, capture.observed);
    const issuedAt = Date.now();
    const record: SourceRecord = {
      ...this.#sourceIdentity(authority),
      kind: 'source-class-only',
      id: randomUUID(),
      issuedAt,
      expiresAt: issuedAt + 300_000,
      principalId: authority.principalId,
      hostContextId: authority.lease.hostContextId,
      privateHostContextWitness: authority.lease.privateHostContextWitness,
      subject: boundSubject,
      selection: selected,
      observed: capture.observed,
    };
    const payload = json(record);
    const signature = this.#environment.signRevisionEvidenceAuthorityBinding(
      json([DOMAIN, payload]),
    );
    const finalize = () => {
      authority.assertCurrent();
      capture.assertObservationOwnersCurrentSync();
    };
    finalize();
    durableCreate(
      this.#store,
      `${record.id}.json`,
      json({ payload: record, signature }),
      finalize,
    );
    finalize();
    return this.#tuple(record);
  }
  #tuple(record: SourceRecord): Readonly<SourceTuple> {
    return this.#observationTuple(
      record,
      DOMAIN,
      `sha256:${sha(json(record))}`,
    );
  }
  #observationTuple(
    record: { id: string; hostContextId: string; observed: Snapshot },
    domain: string,
    digest: string,
  ): Readonly<SourceTuple> {
    // These are private host/project-bound observation identities, not global repository IDs.
    const repositoryId = `source-observation-repository:${sha(json([record.hostContextId, record.observed.projectId, record.observed.portableProjectId, record.observed.resourceId, record.observed.commonDir, record.observed.identities.common]))}`;
    return Object.freeze({
      repository_id: repositoryId,
      execution_worktree_id: `source-observation-worktree:${sha(json([repositoryId, record.observed.top, record.observed.gitDir, record.observed.identities]))}`,
      source_state_id: `sha256:${sha(json(record.observed))}`,
      dirty_state_fingerprint: null,
      source_admission_receipt: Object.freeze({
        id: record.id,
        domain,
        digest,
      }),
    });
  }
  /** Private capability, not a DTO. Payload bytes remain in this owner only. */
  async captureSnapshot(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    selection: Selection,
  ) {
    const boundSubject = {
      groupId: id(subject.groupId),
      workItemId: id(subject.workItemId),
    };
    const selected =
      selection.resourceId === undefined
        ? { projectSlug: selection.projectSlug }
        : {
            projectSlug: selection.projectSlug,
            resourceId: selection.resourceId,
          };
    const authority = await this.#authority(context);
    this.#assertSelection(authority, selected);
    this.#reapSnapshots();
    if (this.#snapshotCount() >= 4) refuse('snapshot_capacity_exceeded');
    this.#pendingSeals++;
    try {
      const capture = await captureSource(this.#home, selected);
      this.#assertProject(authority, capture.observed);
      const serialization = capture.snapshotSerialization;
      const retainedBytes = this.#retainedSnapshotBytes();
      if (
        Buffer.byteLength(serialization) > MAX_SNAPSHOT_BYTES ||
        retainedBytes + Buffer.byteLength(serialization) > 12 * 1024 * 1024
      )
        refuse('snapshot_bound_exceeded');
      const issuedAt = Date.now();
      const provenance: SourceRecord = {
        ...this.#sourceIdentity(authority),
        kind: 'source-class-only',
        id: randomUUID(),
        issuedAt,
        expiresAt: issuedAt + 300_000,
        principalId: authority.principalId,
        hostContextId: authority.lease.hostContextId,
        privateHostContextWitness: authority.lease.privateHostContextWitness,
        subject: boundSubject,
        selection: selected,
        observed: capture.observed,
      };
      const record: SealedRecord = {
        schema: 2,
        kind: 'sealed-source-no-tools',
        provenance,
        snapshotDigest: `sha256:${sha(serialization)}`,
        serializedBytes: Buffer.byteLength(serialization),
      };
      const signature = this.#environment.signRevisionEvidenceAuthorityBinding(
        json([SNAPSHOT_DOMAIN, record]),
      );
      const assertAtSeal = () => {
        authority.assertCurrent();
        capture.assertObservationOwnersCurrentSync();
      };
      assertAtSeal();
      const receiptPath = join(this.#store, `snapshot-${provenance.id}.json`);
      durableCreate(
        this.#store,
        `snapshot-${provenance.id}.json`,
        json({ payload: record, signature }),
        assertAtSeal,
      );
      assertAtSeal();
      const source = this.#sealedTuple(record);
      const capability = Object.freeze({});
      this.#snapshots.set(capability, {
        record,
        source,
        serialization,
        assertObservationOwnersCurrentSync:
          capture.assertObservationOwnersCurrentSync,
        receiptPath,
        receiptStamp: stamp(receiptPath),
        phase: 'sealed',
        released: false,
        sdkConsumed: false,
      });
      return Object.freeze({
        source,
        capability,
        guarantee: 'sealed-input-only' as const,
      });
    } finally {
      this.#pendingSeals--;
    }
  }

  // UNWIRED #91: native producer hand-off and execution/funding admission remain required.
  /** Root source capture for a live, server-minted durable Task allocation.
   * This is not a native execution grant; session-parent calls cannot fall back
   * to root authority while ancestor source admission remains unavailable. */
  async captureRootNativeTaskSnapshot(
    context: RuntimeSourceRequestContext,
    selection: Selection,
  ) {
    let custody: ReturnType<typeof captureDelegationCreateCustody>;
    try {
      custody = captureDelegationCreateCustody(context.req.raw);
    } catch {
      refuse('native_task_custody_unavailable');
    }
    if (custody.callerSessionId !== null)
      refuse('native_ancestor_source_admission_unavailable');
    if (
      new URL(context.req.raw.url).pathname !== '/api/orchestration/delegations'
    )
      refuse('native_task_source_action_required');
    const selected =
      selection.resourceId === undefined
        ? { projectSlug: selection.projectSlug }
        : {
            projectSlug: selection.projectSlug,
            resourceId: selection.resourceId,
          };
    const authority: SnapshotAuthority = await this.#authority(
      context,
      'POST',
      '/api/orchestration/delegations',
    );
    const assertCurrent = () => {
      custody.assertCurrent();
      authority.assertCurrent();
      if (
        authority.sessionCustody ||
        custody.principalId !== authority.principalId ||
        !authority.lease.principalCredential
      )
        refuse('native_root_operator_required');
    };
    const protectRead = <Value>(read: () => Value): Value =>
      this.#environment.withCurrentAuthority(() => {
        assertCurrent();
        const value = read();
        assertCurrent();
        return value;
      });
    protectRead(() => this.#assertSelection(authority, selected));
    this.#reapSnapshots();
    if (this.#snapshotCount() >= 4) refuse('snapshot_capacity_exceeded');
    // Retained seals are not evicted or treated as execution/cleanup receipts.
    if (
      readdirSync(this.#store).filter((name) =>
        name.startsWith('native-snapshot-'),
      ).length +
        this.#pendingNativeSeals >=
      1024
    )
      refuse('native_source_receipt_capacity');
    this.#pendingSeals++;
    this.#pendingNativeSeals++;
    try {
      const capture = await captureSource(this.#home, selected, protectRead);
      const serialization = capture.snapshotSerialization;
      if (
        Buffer.byteLength(serialization) > MAX_SNAPSHOT_BYTES ||
        this.#retainedSnapshotBytes() + Buffer.byteLength(serialization) >
          12 * 1024 * 1024
      )
        refuse('snapshot_bound_exceeded');
      const issuedAt = Date.now();
      const credential = authority.lease.principalCredential;
      if (!credential) refuse('native_root_operator_required');
      const record: NativeTaskSealedRecord = {
        schema: 1,
        kind: 'native-task-sealed-source-no-tools',
        id: randomUUID(),
        taskId: custody.taskId,
        principalId: authority.principalId,
        principalCredentialHash: sha(credential),
        hostContextId: authority.lease.hostContextId,
        privateHostContextWitness: authority.lease.privateHostContextWitness,
        issuedAt,
        expiresAt: issuedAt + 300_000,
        selection: selected,
        observed: capture.observed,
        snapshotDigest: `sha256:${sha(serialization)}`,
        serializedBytes: Buffer.byteLength(serialization),
      };
      const assertAtSeal = () =>
        protectRead(() => capture.assertObservationOwnersCurrentSync());
      assertAtSeal();
      const signature = this.#environment.signRevisionEvidenceAuthorityBinding(
        json([NATIVE_TASK_SNAPSHOT_DOMAIN, record]),
      );
      const receiptPath = join(
        this.#store,
        `native-snapshot-${record.id}.json`,
      );
      durableCreate(
        this.#store,
        `native-snapshot-${record.id}.json`,
        json({ payload: record, signature }),
        assertAtSeal,
      );
      assertAtSeal();
      const origin = this.#observationTuple(
        record,
        NATIVE_TASK_SNAPSHOT_DOMAIN,
        `sha256:${sha(json(record))}`,
      );
      const source = Object.freeze({
        ...origin,
        source_state_id: record.snapshotDigest,
        execution_worktree_id: `native-source-task-slot:${sha(json([origin.repository_id, origin.execution_worktree_id, record.principalId, record.taskId]))}`,
      });
      const capability = Object.freeze({});
      this.#nativeSnapshots.set(capability, {
        record,
        serialization,
        request: context.req.raw,
        receiptPath,
        receiptStamp: stamp(receiptPath),
        assertCurrent,
      });
      try {
        this.assertRootNativeSnapshotCurrent(context, capability);
      } catch (error) {
        this.releaseRootNativeSnapshot(capability);
        throw error;
      }
      return Object.freeze({
        source,
        capability,
        taskId: record.taskId,
        guarantee: 'sealed-input-only' as const,
      });
    } finally {
      this.#pendingNativeSeals--;
      this.#pendingSeals--;
    }
  }
  assertRootNativeSnapshotCurrent(
    context: RuntimeSourceRequestContext,
    capability: object,
  ): void {
    const state = this.#nativeSnapshots.get(capability);
    if (!state || state.request !== context.req.raw)
      refuse('native_snapshot_unavailable');
    this.#environment.withCurrentAuthority(() => {
      state.assertCurrent();
      if (
        Date.now() < state.record.issuedAt ||
        Date.now() >= state.record.expiresAt
      )
        refuse('snapshot_expired');
      if (
        stamp(state.receiptPath) !== state.receiptStamp ||
        `sha256:${sha(state.serialization)}` !== state.record.snapshotDigest
      )
        refuse('snapshot_receipt_changed');
      state.assertCurrent();
    });
  }
  releaseRootNativeSnapshot(capability: object): void {
    const state = this.#nativeSnapshots.get(capability);
    if (!state) return;
    state.serialization = '';
    this.#nativeSnapshots.delete(capability);
  }

  async captureStationControlCredentialAuthority(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    capability: object,
    agentId: string,
  ): Promise<StationControlSourceCredentialAuthority> {
    const authority = await this.#authority(context);
    if (!authority.sessionCustody) refuse('station_control_source_unavailable');
    const state = this.#snapshots.get(capability);
    if (!state || state.released || state.sdkConsumed)
      refuse('snapshot_unavailable');
    const boundSubject = {
      groupId: id(subject.groupId),
      workItemId: id(subject.workItemId),
    };
    this.#assertSnapshot(state, authority, boundSubject);
    this.#assertProject(authority, state.record.provenance.observed);
    const token = Object.freeze({});
    const assertCurrent = () => {
      if (state.sdkConsumed)
        this.#assertSnapshotReceipt(state, authority, boundSubject);
      else {
        if (this.#snapshots.get(capability) !== state || state.released)
          refuse('snapshot_unavailable');
        this.#assertSnapshot(state, authority, boundSubject);
      }
      this.#assertProject(authority, state.record.provenance.observed);
      state.assertObservationOwnersCurrentSync();
    };
    sessionCredentialAuthorities.set(
      token,
      Object.freeze({
        request: context.req.raw,
        identityDigest: sha(json(authority.sessionCustody)),
        hostContextId: authority.lease.hostContextId,
        privateHostContextWitness: authority.lease.privateHostContextWitness,
        projectSlug: authority.sessionCustody.projectSlug,
        agentId: id(agentId),
        assertMayCapture: () => {
          assertCurrent();
          if (
            this.#snapshots.get(capability) !== state ||
            state.sdkConsumed ||
            state.released
          )
            refuse('snapshot_unavailable');
          this.#assertSnapshot(state, authority, boundSubject);
        },
        assertCurrent,
        withObservationScope: (check) =>
          this.#environment.withCurrentAuthority(() => {
            assertCurrent();
            return check();
          }),
      }),
    );
    return token;
  }
  #sealedTuple(record: SealedRecord): Readonly<SourceTuple> {
    // Slot identity survives source refresh; each receipt still pins its snapshot.
    const { provenance } = record;
    const origin = this.#tuple(provenance);
    return Object.freeze({
      ...origin,
      source_state_id: record.snapshotDigest,
      execution_worktree_id: `sealed-source-slot:${sha(
        json([
          origin.repository_id,
          origin.execution_worktree_id,
          provenance.principalId,
          provenance.subject.groupId,
          provenance.subject.workItemId,
        ]),
      )}`,
      source_admission_receipt: Object.freeze({
        id: provenance.id,
        domain: SNAPSHOT_DOMAIN,
        digest: `sha256:${sha(json(record))}`,
      }),
    });
  }

  /** Authenticated historical locator only: never admits or prepares source execution. */
  async readHistoricalFlowLocation(input: {
    source: SourceTuple;
    subject: Subject;
    admission: unknown;
    principalId: string;
    hostContextId: string;
    current: () => void;
  }): Promise<{ cwd: string; assertCurrent(): undefined }> {
    const expected = structuredClone(input.source);
    const ref = expected.source_admission_receipt;
    input.current();
    if (
      ref.domain !== SNAPSHOT_DOMAIN ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        ref.id,
      )
    )
      refuse('flow_location_unavailable');
    try {
      const admission = validateStationReportAdmission(input.admission);
      const spec = admission.data.spec;
      const matching = admission.data.envelopes.filter(
        (envelope) =>
          envelope.execution_id === input.subject.workItemId &&
          isDeepStrictEqual(envelope.execution_binding.source, expected),
      );
      if (
        !reportAdmissionSignatureMatches(admission, this.#environment) ||
        spec.groupId !== input.subject.groupId ||
        admission.data.root.authenticated_principal_ref.id !==
          input.principalId ||
        admission.data.root.issuer_host_id !== input.hostContextId ||
        spec.topology.kind !== 'flow' ||
        matching.length !== 1
      )
        refuse('flow_location_unavailable');
      privateDirectory(this.#home);
      privateDirectory(this.#store);
      if (
        identity(this.#home) !== this.#homeIdentity ||
        identity(this.#store) !== this.#storeIdentity
      )
        refuse('flow_location_unavailable');
      const path = join(this.#store, `snapshot-${ref.id}.json`);
      const capturedStamp = stamp(path);
      const encoded = new TextDecoder('utf-8', { fatal: true }).decode(
        readRegular(path, 128 * 1024, true),
      );
      const stored: { payload: SealedRecord; signature: string } =
        JSON.parse(encoded);
      const record = stored.payload;
      if (
        encoded !== json(stored) ||
        Object.keys(stored).sort().join(',') !== 'payload,signature' ||
        stamp(path) !== capturedStamp ||
        stored.signature !==
          this.#environment.signRevisionEvidenceAuthorityBinding(
            json([SNAPSHOT_DOMAIN, record]),
          ) ||
        record.schema !== 2 ||
        record.kind !== 'sealed-source-no-tools' ||
        record.provenance.schema !== 1 ||
        record.provenance.kind !== 'source-class-only' ||
        record.provenance.id !== ref.id ||
        record.provenance.principalId !== input.principalId ||
        `sha256:${record.provenance.principalCredentialHash}` !==
          admission.data.credentialDigest ||
        record.provenance.hostContextId !== input.hostContextId ||
        !isDeepStrictEqual(record.provenance.subject, input.subject) ||
        !isDeepStrictEqual(this.#sealedTuple(record), expected)
      )
        refuse('flow_location_unavailable');
      const observed = record.provenance.observed;
      const assertLocation = (): undefined => {
        input.current();
        if (
          stamp(path) !== capturedStamp ||
          realpathSync(observed.top) !== observed.top ||
          identity(observed.top) !== observed.identities.root ||
          realpathSync(observed.gitDir) !== observed.gitDir ||
          identity(observed.gitDir) !== observed.identities.git ||
          realpathSync(observed.commonDir) !== observed.commonDir ||
          identity(observed.commonDir) !== observed.identities.common
        )
          refuse('flow_location_unavailable');
        return undefined;
      };
      if (
        realpathSync(observed.top) !== observed.top ||
        identity(observed.top) !== observed.identities.root ||
        realpathSync(observed.gitDir) !== observed.gitDir ||
        identity(observed.gitDir) !== observed.identities.git ||
        realpathSync(observed.commonDir) !== observed.commonDir ||
        identity(observed.commonDir) !== observed.identities.common
      )
        refuse('flow_location_unavailable');
      input.current();
      const run = await loadRun(id(spec.topology.runId), observed.top);
      input.current();
      if (
        stamp(path) !== capturedStamp ||
        realpathSync(observed.top) !== observed.top ||
        identity(observed.top) !== observed.identities.root ||
        realpathSync(observed.gitDir) !== observed.gitDir ||
        identity(observed.gitDir) !== observed.identities.git ||
        realpathSync(observed.commonDir) !== observed.commonDir ||
        identity(observed.commonDir) !== observed.identities.common ||
        !isDeepStrictEqual(
          definitionIdentity(run.definition),
          spec.topology.definition,
        )
      )
        refuse('flow_location_unavailable');
      assertLocation();
      return Object.freeze({
        cwd: observed.top,
        assertCurrent: assertLocation,
      });
    } catch (error) {
      if (
        error instanceof SourceRefusal &&
        error.code === 'flow_location_unavailable'
      )
        throw error;
      refuse('flow_location_unavailable');
    }
  }

  // UNWIRED(#91): retained-turn execution must compose this with its own budget and Session admission.
  async readmitSnapshot(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    source: SourceTuple,
  ) {
    const expected = structuredClone(source);
    const boundSubject = {
      groupId: id(subject.groupId),
      workItemId: id(subject.workItemId),
    };
    const request = context.req.raw;
    const authority = await this.#authority(context);
    request.signal.throwIfAborted();
    const ref = expected.source_admission_receipt;
    if (
      ref.domain !== SNAPSHOT_DOMAIN ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        ref.id,
      )
    )
      refuse('receipt_unavailable');
    const directory = openSync(
      this.#store,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } catch {
      refuse('durability_unconfirmed');
    } finally {
      closeSync(directory);
    }
    const receiptPath = join(this.#store, `snapshot-${ref.id}.json`);
    let receiptStamp: string;
    let record: SealedRecord;
    try {
      receiptStamp = stamp(receiptPath);
      const encoded = readRegular(receiptPath, 128 * 1024, true).toString(
        'utf8',
      );
      const stored: { payload: SealedRecord; signature: string } =
        JSON.parse(encoded);
      if (
        encoded !== json(stored) ||
        Object.keys(stored).sort().join(',') !== 'payload,signature' ||
        stamp(receiptPath) !== receiptStamp
      )
        refuse('receipt_unavailable');
      record = stored.payload;
      if (
        stored.signature !==
        this.#environment.signRevisionEvidenceAuthorityBinding(
          json([SNAPSHOT_DOMAIN, record]),
        )
      )
        refuse('receipt_unavailable');
      if (
        record.schema !== 2 ||
        record.kind !== 'sealed-source-no-tools' ||
        (record.provenance.schema !== 1 && record.provenance.schema !== 2) ||
        record.provenance.kind !== 'source-class-only' ||
        record.provenance.id !== ref.id ||
        !Number.isSafeInteger(record.serializedBytes) ||
        record.serializedBytes < 0 ||
        record.serializedBytes > MAX_SNAPSHOT_BYTES ||
        !/^sha256:[0-9a-f]{64}$/.test(record.snapshotDigest)
      )
        refuse('receipt_unavailable');
      const p = record.provenance;
      if (
        p.principalId !== authority.principalId ||
        !this.#identityMatches(p, authority) ||
        p.hostContextId !== authority.lease.hostContextId ||
        p.privateHostContextWitness !==
          authority.lease.privateHostContextWitness ||
        !isDeepStrictEqual(p.subject, boundSubject) ||
        !isDeepStrictEqual(this.#sealedTuple(record), expected)
      )
        refuse('receipt_binding_mismatch');
    } catch (error) {
      if (error instanceof SourceRefusal) throw error;
      refuse('receipt_unavailable');
    }
    const assertCurrent = () => {
      request.signal.throwIfAborted();
      authority.assertCurrent();
      if (
        Date.now() < record.provenance.issuedAt ||
        Date.now() >= record.provenance.expiresAt
      )
        refuse('receipt_expired');
      if (stamp(receiptPath) !== receiptStamp) refuse('receipt_changed');
    };
    this.#assertSelection(authority, record.provenance.selection);
    this.#assertProject(authority, record.provenance.observed);
    assertCurrent();
    this.#reapSnapshots();
    if (this.#snapshotCount() >= 4) refuse('snapshot_capacity_exceeded');
    this.#pendingSeals++;
    try {
      const capture = await captureSource(
        this.#home,
        record.provenance.selection,
      );
      this.#assertProject(authority, capture.observed);
      assertCurrent();
      if (
        !isDeepStrictEqual(capture.observed, record.provenance.observed) ||
        Buffer.byteLength(capture.snapshotSerialization) !==
          record.serializedBytes ||
        `sha256:${sha(capture.snapshotSerialization)}` !== record.snapshotDigest
      )
        refuse('source_changed');
      const retainedBytes = this.#retainedSnapshotBytes();
      if (retainedBytes + record.serializedBytes > 12 * 1024 * 1024)
        refuse('snapshot_bound_exceeded');
      capture.assertObservationOwnersCurrentSync();
      assertCurrent();
      const capability = Object.freeze({});
      this.#snapshots.set(capability, {
        boundRequest: request,
        record,
        source: this.#sealedTuple(record),
        serialization: capture.snapshotSerialization,
        assertObservationOwnersCurrentSync:
          capture.assertObservationOwnersCurrentSync,
        receiptPath,
        receiptStamp,
        phase: 'sealed',
        released: false,
        sdkConsumed: false,
      });
      return Object.freeze({
        capability,
        source: this.#sealedTuple(record),
        guarantee: 'sealed-input-only' as const,
      });
    } finally {
      this.#pendingSeals--;
    }
  }

  // Flow's shared ticket has a five-second wait; queue this owner's calls before entering it.
  async #withFlowMutation<T>(
    key: string,
    assertCurrent: () => void,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertCurrent();
    if (this.#pendingFlowMutations >= 128) refuse('flow_mutation_capacity');
    this.#pendingFlowMutations++;
    const previous = this.#flowMutations.get(key) ?? Promise.resolve();
    const result = previous.then(() => {
      assertCurrent();
      return operation();
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#flowMutations.set(key, tail);
    try {
      return await result;
    } finally {
      this.#pendingFlowMutations--;
      if (this.#flowMutations.get(key) === tail)
        this.#flowMutations.delete(key);
    }
  }

  /** Private source-owned Flow admission. The workspace never crosses the wire. */
  async prepareFlowSnapshot(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    capability: object,
    runIdInput: string,
  ): Promise<SourceFlowLaunchOwner> {
    const runId = id(runIdInput);
    const boundSubject = structuredClone(subject);
    const authority = await this.#authority(context);
    const state = this.#snapshots.get(capability);
    if (!state || state.released || state.phase !== 'sealed')
      refuse('snapshot_unavailable');
    this.#assertSnapshot(state, authority, boundSubject);
    const admission = this.#flowAdmissions.get(capability) ?? Object.freeze({});
    this.#flowAdmissions.set(capability, admission);
    const cwd = state.record.provenance.observed.top;
    const actor = Object.freeze({
      key: authority.principalId,
      kind: 'station-operator',
    });
    const assertCurrent = () =>
      this.#environment.withCurrentAuthority(() => {
        context.req.raw.signal.throwIfAborted();
        if (
          this.#flowAdmissions.get(capability) !== admission ||
          (!state.sdkConsumed &&
            (this.#snapshots.get(capability) !== state || state.released))
        )
          refuse('snapshot_unavailable');
        if (state.sdkConsumed)
          this.#assertSnapshotReceipt(state, authority, boundSubject);
        else this.#assertSnapshot(state, authority, boundSubject);
        state.assertObservationOwnersCurrentSync();
        if (
          !runtimeRequestPrincipalMayAccessHttpRoute(
            context.req.raw,
            this.#environment,
            {
              method: 'POST',
              path: `/api/projects/${encodeURIComponent(state.record.provenance.selection.projectSlug)}/flow/runs/${encodeURIComponent(runId)}/evaluate`,
            },
          )
        )
          refuse('flow_grant_action_not_authorized');
        authority.assertCurrent();
      });
    assertCurrent();
    const run = await loadRun(runId, cwd);
    assertCurrent();
    assertLifecycleEligible('persist', run.state.status);
    if (run.definition.execution?.mode !== 'multi-cursor')
      refuse('flow_multi_cursor_required');
    const definition = Object.freeze(definitionIdentity(run.definition));
    const topology = Object.freeze({
      kind: 'flow' as const,
      runId,
      definition,
      actor,
    });
    const mutationKey = JSON.stringify([cwd, runId]);
    const sourceHome = this.#home;
    const enqueue = <T>(operation: () => Promise<T>, current = assertCurrent) =>
      this.#withFlowMutation(mutationKey, current, operation);
    return Object.freeze({
      topology,
      source: state.source,
      assertCurrent,
      async readSchedule(scope?: {
        owner: HomeWriterOwner;
        lease: HomeWriterLease;
      }) {
        if (scope && scope.owner.homeDir !== sourceHome)
          refuse('flow_home_mismatch');
        const check = scope
          ? () => scope.owner.runWithLease(scope.lease, assertCurrent)
          : assertCurrent;
        check();
        const current = await loadRun(runId, cwd);
        check();
        assertLifecycleEligible('persist', current.state.status);
        if (
          !isDeepStrictEqual(definitionIdentity(current.definition), definition)
        )
          refuse('flow_definition_changed');
        return {
          cwd,
          runHead: flowRunHead(current.state),
          readySteps: claimableMultiCursorSteps(
            current.definition,
            current.state,
          ),
          reportSteps: current.definition.steps
            .filter(
              (step: { id: string; mutable_resources?: readonly unknown[] }) =>
                (step.mutable_resources ?? []).length === 0,
            )
            .map((step: { id: string }) => step.id),
        };
      },
      async withCurrentHead<T>(
        expectedHead: string,
        launch: () => { value: T },
        scope?: { owner: HomeWriterOwner; lease: HomeWriterLease },
      ): Promise<{ value: T }> {
        if (scope && scope.owner.homeDir !== sourceHome)
          refuse('flow_home_mismatch');
        const scopedCurrent = scope
          ? () => scope.owner.runWithLease(scope.lease, assertCurrent)
          : assertCurrent;
        if (!/^[a-f0-9]{64}$/.test(expectedHead)) refuse('flow_head_invalid');
        return enqueue(
          () =>
            withRunMutationLock(runId, cwd, async () => {
              const current = await loadRun(runId, cwd);
              scopedCurrent();
              assertLifecycleEligible('persist', current.state.status);
              if (
                !isDeepStrictEqual(
                  definitionIdentity(current.definition),
                  definition,
                )
              )
                refuse('flow_definition_changed');
              if (flowRunHead(current.state) !== expectedHead)
                refuse('flow_head_changed');
              scopedCurrent();
              return launch();
            }),
          scopedCurrent,
        );
      },
      async withCurrentClaim<T>(
        claimInput: FlowDurableStepClaim,
        launch: () => { value: T },
        scope?: { owner: HomeWriterOwner; lease: HomeWriterLease },
      ): Promise<{ value: T }> {
        if (scope && scope.owner.homeDir !== sourceHome)
          refuse('flow_home_mismatch');
        const scopedCurrent = scope
          ? () => scope.owner.runWithLease(scope.lease, assertCurrent)
          : assertCurrent;
        const expected = structuredClone(claimInput);
        return enqueue(
          () =>
            withRunMutationLock(runId, cwd, async () => {
              const current = await loadRun(runId, cwd);
              scopedCurrent();
              assertLifecycleEligible('persist', current.state.status);
              const claims: unknown = current.state.multi_cursor?.active_claims;
              if (!Array.isArray(claims))
                refuse('flow_active_claim_unavailable');
              const stored = claims.find(
                (value: FlowDurableStepClaim) =>
                  value.claim_id === expected.claim_id,
              );
              if (!stored) refuse('flow_active_claim_unavailable');
              const claim = validateDurableStepClaim(
                current.definition,
                current.state,
                stored,
                new Date(),
              );
              const captured = validateDurableStepClaim(
                current.definition,
                current.state,
                expected,
              );
              const identityOf = ({
                renewed_at: _renewed,
                expires_at: _expires,
                ...identity
              }: FlowDurableStepClaim) => identity;
              if (
                claim.run_id !== runId ||
                !isDeepStrictEqual(claim.actor, actor) ||
                !isDeepStrictEqual(claim.definition, definition) ||
                !isDeepStrictEqual(identityOf(claim), identityOf(captured))
              )
                refuse('flow_claim_binding_changed');
              scopedCurrent();
              return launch();
            }),
          scopedCurrent,
        );
      },
    });
  }
  releaseSnapshot(capability: object): void {
    this.#dropSnapshot(capability);
  }
  prepareSnapshotRetirement(capability: object): () => Promise<void> {
    const state = this.#snapshots.get(capability);
    if (!state) refuse('snapshot_unavailable');
    return async () => {
      this.#dropSnapshot(capability);
      if (state.sdk)
        await retireSdkSourceWire(state.sdk.owner, state.sdk.handle);
      else if (this.#snapshots.get(capability) === state)
        refuse('snapshot_disposal_unconfirmed');
    };
  }
  #assertSnapshot(
    state: SealedState,
    authority: SnapshotAuthority,
    subject: Subject,
  ) {
    this.#assertSnapshotReceipt(state, authority, subject);
    if (`sha256:${sha(state.serialization)}` !== state.record.snapshotDigest)
      refuse('snapshot_content_changed');
  }
  #assertSnapshotReceipt(
    state: SealedState,
    authority: SnapshotAuthority,
    subject: Subject,
  ) {
    if (state.boundRequest && state.boundRequest !== authority.request)
      refuse('snapshot_request_mismatch');
    state.boundRequest?.signal.throwIfAborted();
    authority.assertCurrent();
    const record = state.record.provenance;
    if (
      record.principalId !== authority.principalId ||
      !this.#identityMatches(record, authority) ||
      record.hostContextId !== authority.lease.hostContextId ||
      record.privateHostContextWitness !==
        authority.lease.privateHostContextWitness ||
      !isDeepStrictEqual(record.subject, subject)
    )
      refuse('snapshot_binding_mismatch');
    if (Date.now() < record.issuedAt || Date.now() >= record.expiresAt)
      refuse('snapshot_expired');
    if (stamp(state.receiptPath) !== state.receiptStamp)
      refuse('snapshot_receipt_changed');
  }
  async prepareSdkSnapshot(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    capability: object,
    owner: object,
  ) {
    const boundSubject = structuredClone(subject);
    const authority = await this.#authority(context);
    this.#reapSnapshots();
    const state = this.#snapshots.get(capability);
    if (!state || state.released || state.phase !== 'sealed')
      refuse('snapshot_unavailable');
    this.#assertSnapshot(state, authority, boundSubject);
    state.phase = 'preparing';
    const lease = Object.freeze({});
    let prepared: SdkPreparedState | undefined;
    const assertSourceCurrent = () =>
      this.#assertSnapshot(state, authority, boundSubject);
    sdkLeases.set(
      lease,
      Object.freeze({
        get serialization() {
          assertSourceCurrent();
          return state.serialization;
        },
        get binding() {
          assertSourceCurrent();
          return Object.freeze({
            request: authority.request,
            principalId: authority.principalId,
            hostContextId: authority.lease.hostContextId,
            expiresAtMs: state.record.provenance.expiresAt,
            source: structuredClone(state.source),
          });
        },
        assertDisclosureCurrentSync: () => {
          state.boundRequest?.signal.throwIfAborted();
          authority.assertCurrent();
          const p = state.record.provenance;
          if (Date.now() < p.issuedAt || Date.now() >= p.expiresAt)
            refuse('snapshot_expired');
          return undefined;
        },
        assertCurrentSync: () => {
          this.#assertSnapshot(state, authority, boundSubject);
          return undefined;
        },
        consumeExactSync: (
          actualOwner: object,
          actualHandle: object,
          digest: string,
        ) => {
          if (
            !prepared ||
            prepared.owner !== actualOwner ||
            prepared.handle !== actualHandle ||
            prepared.wireDigest !== digest ||
            prepared.used ||
            state.released
          )
            refuse('sdk_source_consume_mismatch');
          this.#assertSnapshot(state, authority, boundSubject);
          prepared.used = true;
          this.#sdkPrepared.delete(prepared.capability);
          state.sdkConsumed = true;
          state.released = true;
          authority.assertCurrent();
          return undefined;
        },
      }),
    );
    try {
      const handle = beginSdkSourceWire(owner, lease);
      state.sdk = { owner, handle, lease, cleanupQueued: false };
      const captured = await capturedSdkSourceWire(owner, handle);
      if (this.#snapshots.get(capability) !== state || state.released)
        refuse('snapshot_unavailable');
      this.#assertSnapshot(state, authority, boundSubject);
      assertSdkSourceWireCurrentSync(owner, handle);
      this.#assertSnapshot(state, authority, boundSubject);
      state.phase = 'prepared';
      const preparedCapability = Object.freeze({});
      prepared = {
        capability: preparedCapability,
        state,
        owner,
        handle,
        wireDigest: captured.wireDigest,
        used: false,
      };
      this.#sdkPrepared.set(preparedCapability, prepared);
      outsideStationServerScope(() => {
        void sdkDisposalPromise(owner, handle).then(() => {
          this.#retireSdk(capability, state);
        });
      });
      return Object.freeze({
        capability: preparedCapability,
        source: state.source,
        sdkHandle: handle,
        wireDigest: captured.wireDigest,
      });
    } catch (error) {
      state.released = true;
      if (state.sdk) this.#retireSdk(capability, state);
      else {
        sdkLeases.delete(lease);
        state.phase = 'sealed';
        this.#dropSnapshot(capability);
      }
      throw error;
    }
  }
  /** The port is a required trusted transport owner. No production issuer is supplied here. */
  async prepareSnapshot(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    capability: object,
    owner: TrustedFinalWireOwnerPort | undefined,
    request: object,
  ) {
    const boundSubject = structuredClone(subject);
    const authority = await this.#authority(context);
    this.#reapSnapshots();
    const state = this.#snapshots.get(capability);
    if (!state || state.released || state.phase !== 'sealed')
      refuse('snapshot_unavailable');
    if (!owner || typeof owner.prepareSnapshotRequest !== 'function')
      refuse('trusted_final_wire_owner_required');
    this.#assertSnapshot(state, authority, boundSubject);
    state.phase = 'preparing';
    let port: PreparedSnapshotWire | undefined;
    try {
      port = await owner.prepareSnapshotRequest(
        request,
        Object.freeze({
          source: state.source,
          serialization: state.serialization,
          digest: state.record.snapshotDigest,
        }),
      );
      if (this.#snapshots.get(capability) !== state || state.released)
        refuse('snapshot_unavailable');
      if (
        !port ||
        port.request !== request ||
        typeof port.assertCurrentSync !== 'function' ||
        typeof port.consumeExactSync !== 'function' ||
        typeof port.disposeSync !== 'function'
      )
        refuse('trusted_final_wire_owner_required');
      const wire = freezeSnapshotWire(
        port.wire,
        state.serialization,
        state.record.snapshotDigest,
      );
      const wireSerialization = json(wire);
      this.#assertSnapshot(state, authority, boundSubject);
      requireSync(port.assertCurrentSync());
      this.#assertSnapshot(state, authority, boundSubject);
      if (state.released) refuse('snapshot_unavailable');
      state.phase = 'prepared';
      const preparedCapability = Object.freeze({});
      this.#prepared.set(preparedCapability, {
        capability,
        state,
        contextRequest: authority.request,
        subject: boundSubject,
        request,
        port,
        wireSerialization,
        wireDigest: `sha256:${sha(wireSerialization)}`,
        assertAuthorityCurrentSync: () =>
          this.#assertSnapshot(state, authority, boundSubject),
      });
      return Object.freeze({
        capability: preparedCapability,
        source: state.source,
        wireDigest: `sha256:${sha(wireSerialization)}`,
      });
    } catch (error) {
      state.released = true;
      if (port) this.#disposePrototype(capability, state, port);
      else state.phase = 'quarantined';
      throw error;
    }
  }
  /** Single synchronous handoff of the exact sealed request, with no automatic retry. */
  consumeSnapshotSync(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    preparedCapability: object,
    request: object,
  ): void {
    const prepared = this.#prepared.get(preparedCapability);
    if (!prepared) refuse('prepared_snapshot_unavailable');
    if (
      prepared.contextRequest !== context.req.raw ||
      prepared.request !== request ||
      !isDeepStrictEqual(prepared.subject, subject)
    )
      refuse('snapshot_request_mismatch');
    this.#prepared.delete(preparedCapability);
    const state = prepared.state;
    if (state.released || state.phase !== 'prepared')
      refuse('snapshot_unavailable');
    state.phase = 'consuming';
    let fenceCalls = 0;
    try {
      prepared.assertAuthorityCurrentSync();
      requireSync(prepared.port.assertCurrentSync());
      if (
        json(
          freezeSnapshotWire(
            prepared.port.wire,
            state.serialization,
            state.record.snapshotDigest,
          ),
        ) !== prepared.wireSerialization
      )
        refuse('final_wire_changed');
      prepared.assertAuthorityCurrentSync();
      if (state.released) refuse('snapshot_unavailable');
      requireSync(
        prepared.port.consumeExactSync({
          request,
          expectedWireSerialization: prepared.wireSerialization,
          expectedWireDigest: prepared.wireDigest,
          sourceSnapshotDigest: state.record.snapshotDigest,
          assertCurrentSync: () => {
            if (++fenceCalls !== 1) refuse('final_wire_fence_reused');
            if (state.released) refuse('snapshot_unavailable');
            prepared.assertAuthorityCurrentSync();
            return undefined;
          },
        }),
      );
      if (fenceCalls !== 1) refuse('final_wire_fence_missing');
    } finally {
      this.#disposePrototype(prepared.capability, state, prepared.port);
    }
  }
  async reobserve(
    context: RuntimeSourceRequestContext,
    subject: Subject,
    source: SourceTuple,
  ) {
    const expected = structuredClone(source);
    const expectedSubject = structuredClone(subject);
    const authority = await this.#authority(context);
    const ref = expected.source_admission_receipt;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        ref.id,
      ) ||
      ref.domain !== DOMAIN
    )
      refuse('receipt_unavailable');
    const directory = openSync(
      this.#store,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } catch {
      refuse('durability_unconfirmed');
    } finally {
      closeSync(directory);
    }
    const receiptPath = join(this.#store, `${ref.id}.json`);
    const receiptStamp = stamp(receiptPath);
    let stored: { payload: SourceRecord; signature: string };
    try {
      const encoded = readRegular(receiptPath, 128 * 1024, true).toString(
        'utf8',
      );
      stored = JSON.parse(encoded);
      if (stamp(receiptPath) !== receiptStamp) refuse('receipt_changed');
      if (
        encoded !== json(stored) ||
        Object.keys(stored).sort().join(',') !== 'payload,signature'
      )
        refuse('receipt_unavailable');
    } catch {
      refuse('receipt_unavailable');
    }
    const record = stored.payload;
    if (
      stored.signature !==
      this.#environment.signRevisionEvidenceAuthorityBinding(
        json([DOMAIN, json(record)]),
      )
    )
      refuse('receipt_unavailable');
    if (
      (record.schema !== 1 && record.schema !== 2) ||
      record.kind !== 'source-class-only' ||
      record.id !== ref.id ||
      record.principalId !== authority.principalId ||
      !this.#identityMatches(record, authority) ||
      record.hostContextId !== authority.lease.hostContextId ||
      record.privateHostContextWitness !==
        authority.lease.privateHostContextWitness ||
      !isDeepStrictEqual(record.subject, expectedSubject) ||
      !isDeepStrictEqual(this.#tuple(record), expected)
    )
      refuse('receipt_binding_mismatch');
    if (Date.now() < record.issuedAt || Date.now() >= record.expiresAt)
      refuse('receipt_expired');
    this.#assertSelection(authority, record.selection);
    this.#assertProject(authority, record.observed);
    const current = await captureSource(this.#home, record.selection);
    this.#assertProject(authority, current.observed);
    if (!isDeepStrictEqual(current.observed, record.observed))
      refuse('source_changed');
    let used = false;
    const assertObservationOwnersCurrentSync = () => {
      authority.assertCurrent();
      if (Date.now() < record.issuedAt || Date.now() >= record.expiresAt)
        refuse('receipt_expired');
      current.assertObservationOwnersCurrentSync();
      if (stamp(receiptPath) !== receiptStamp) refuse('receipt_changed');
    };
    assertObservationOwnersCurrentSync();
    return Object.freeze({
      source: this.#tuple(record),
      guarantee: 'verified-observation-only' as const,
      assertObservationOwnersCurrentSync,
      finalizeForLaunchSync(): never {
        if (used) refuse('finalizer_already_used');
        used = true;
        assertObservationOwnersCurrentSync();
        // Git's current owner lends no held checkout/snapshot capability through launch.
        return refuse('source_launch_fence_unavailable');
      },
    });
  }
}

const SNAPSHOT_DOMAIN = 'station.private.sealed-source.no-tools.v1';
const NATIVE_TASK_SNAPSHOT_DOMAIN =
  'station.private.native-task-source.seal.v1';
const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
export type SnapshotFinalWire = Readonly<{
  url: string;
  method: 'POST';
  headers: readonly (readonly [string, string])[];
  body: string;
}>;
export interface PreparedSnapshotWire {
  readonly request: object;
  readonly wire: SnapshotFinalWire;
  assertCurrentSync(): undefined;
  consumeExactSync(
    input: Readonly<{
      request: object;
      expectedWireSerialization: string;
      expectedWireDigest: string;
      sourceSnapshotDigest: string;
      assertCurrentSync(): undefined;
    }>,
  ): undefined;
  disposeSync(): unknown;
}
/** Trusted server transport port, never supplied by route/config data. Its implementation must
 * enforce the no-tools/no-filesystem/no-cwd policy at the actual request consumer and use the
 * exact wire envelope. The private v1 body below is prototype-only, not a provider API grant. */
export interface TrustedFinalWireOwnerPort {
  prepareSnapshotRequest(
    request: object,
    input: Readonly<{
      source: Readonly<SourceTuple>;
      serialization: string;
      digest: string;
    }>,
  ): Promise<PreparedSnapshotWire>;
}
type SnapshotAuthority = {
  request: Request;
  principalId: string;
  sessionCustody?: SessionCustody;
  lease: {
    principalCredential?: string;
    hostContextId: string;
    privateHostContextWitness: string;
  };
  assertCurrent(): void;
};
type SealedRecord = {
  schema: 2;
  kind: 'sealed-source-no-tools';
  provenance: SourceRecord;
  snapshotDigest: string;
  serializedBytes: number;
};
type NativeTaskSealedRecord = {
  schema: 1;
  kind: 'native-task-sealed-source-no-tools';
  id: string;
  taskId: string;
  principalId: string;
  principalCredentialHash: string;
  hostContextId: string;
  privateHostContextWitness: string;
  issuedAt: number;
  expiresAt: number;
  selection: Selection;
  observed: Snapshot;
  snapshotDigest: string;
  serializedBytes: number;
};
export interface SourceFlowLaunchOwner {
  readonly topology: Readonly<{
    kind: 'flow';
    runId: string;
    definition: ReturnType<typeof definitionIdentity>;
    actor: { readonly key: string; readonly kind: string };
  }>;
  readonly source: Readonly<SourceTuple>;
  assertCurrent(): void;
  readSchedule(scope?: {
    owner: HomeWriterOwner;
    lease: HomeWriterLease;
  }): Promise<{
    cwd: string;
    runHead: string;
    readySteps: string[];
    reportSteps: string[];
  }>;
  withCurrentHead<T>(
    expectedHead: string,
    launch: () => { value: T },
    scope?: { owner: HomeWriterOwner; lease: HomeWriterLease },
  ): Promise<{ value: T }>;
  withCurrentClaim<T>(
    claim: FlowDurableStepClaim,
    launch: () => { value: T },
    scope?: { owner: HomeWriterOwner; lease: HomeWriterLease },
  ): Promise<{ value: T }>;
}
type SealedState = {
  boundRequest?: Request;
  assertObservationOwnersCurrentSync(): void;
  record: SealedRecord;
  source: Readonly<SourceTuple>;
  serialization: string;
  receiptPath: string;
  receiptStamp: string;
  phase:
    | 'sealed'
    | 'preparing'
    | 'prepared'
    | 'consuming'
    | 'disposing'
    | 'quarantined';
  released: boolean;
  sdkConsumed: boolean;
  sdk?: {
    owner: object;
    handle: object;
    lease: object;
    cleanupQueued: boolean;
  };
};
type PreparedState = {
  capability: object;
  state: SealedState;
  contextRequest: Request;
  subject: Subject;
  request: object;
  port: PreparedSnapshotWire;
  wireSerialization: string;
  wireDigest: string;
  assertAuthorityCurrentSync(): void;
};
function requireSync(value: unknown): void {
  if (value !== undefined) {
    outsideStationServerScope(() => {
      void Promise.resolve(value).catch(() => {});
    });
    refuse('final_wire_port_must_be_synchronous');
  }
}
function freezeSnapshotWire(
  input: SnapshotFinalWire,
  serialization: string,
  digest: string,
): SnapshotFinalWire {
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'body,headers,method,url'
  )
    refuse('final_wire_unsupported');
  if (
    !input ||
    input.method !== 'POST' ||
    typeof input.url !== 'string' ||
    typeof input.body !== 'string' ||
    Buffer.byteLength(input.body) > 4 * 1024 * 1024 ||
    !Array.isArray(input.headers) ||
    input.headers.length > 64
  )
    refuse('final_wire_unsupported');
  const url = new URL(input.url);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    refuse('final_wire_unsupported');
  const headers = input.headers.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some(
        (value) =>
          typeof value !== 'string' ||
          value.length > 8192 ||
          /[\r\n]/.test(value),
      )
    )
      refuse('final_wire_unsupported');
    return Object.freeze([pair[0], pair[1]] as const);
  });
  let body: unknown;
  try {
    body = JSON.parse(input.body);
  } catch {
    refuse('final_wire_body_unsupported');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    refuse('final_wire_body_unsupported');
  const fields = Object.getOwnPropertyDescriptors(body);
  const expectedKeys = [
    'cwd',
    'filesystem',
    'format',
    'instruction',
    'source',
    'tools',
  ];
  if (Object.keys(fields).sort().join(',') !== expectedKeys.join(','))
    refuse('final_wire_body_unsupported');
  const source = fields.source.value;
  if (
    fields.format.value !== 'station.sealed-source.request.v1' ||
    typeof fields.instruction.value !== 'string' ||
    Buffer.byteLength(fields.instruction.value) > 65536 ||
    fields.cwd.value !== null ||
    fields.filesystem.value !== 'none' ||
    !Array.isArray(fields.tools.value) ||
    fields.tools.value.length !== 0
  )
    refuse('snapshot_no_tools_policy_required');
  if (
    !isDeepStrictEqual(source, {
      encoding: 'canonical-json-utf8',
      serialization,
      digest,
    }) ||
    json(body) !== input.body
  )
    refuse('snapshot_payload_mismatch');
  const wire = Object.freeze({
    url: input.url,
    method: input.method,
    headers: Object.freeze(headers),
    body: input.body,
  });
  if (Buffer.byteLength(json(wire)) > 5 * 1024 * 1024)
    refuse('final_wire_unsupported');
  return wire;
}

type SdkPreparedState = {
  capability: object;
  state: SealedState;
  owner: object;
  handle: object;
  wireDigest: string;
  used: boolean;
};
export interface SdkSourceLease {
  readonly serialization: string;
  readonly binding: Readonly<{
    request: Request;
    principalId: string;
    hostContextId: string;
    expiresAtMs: number;
    source: SourceTuple;
  }>;
  assertDisclosureCurrentSync(): undefined;
  assertCurrentSync(): undefined;
  consumeExactSync(owner: object, handle: object, digest: string): undefined;
}
const sdkLeases = new WeakMap<object, SdkSourceLease>();
/** Internal module capability. Tokens are issued only after actual source authorization. */
export function claimSdkSourceLease(token: object): SdkSourceLease {
  const lease = sdkLeases.get(token);
  if (!lease) refuse('sdk_source_lease_unavailable');
  return lease;
}
