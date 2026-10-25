import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionOperationPhaseCode } from '@kontourai/station-contracts/action-operation';
import {
  isWalkthroughFileName,
  isWalkthroughId,
  MEDIA_UPLOAD_POLICIES,
  parseWalkthrough,
  WALKTHROUGH_LIMITS,
  WALKTHROUGH_SCHEMA,
  type Walkthrough,
  type WalkthroughFrame,
  type WalkthroughImportOutcome,
  type WalkthroughImportStatus,
  type WalkthroughPage,
  type WalkthroughTranscript,
} from '@kontourai/station-contracts/walkthrough';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import type { ProjectFileTransactions } from '../../domain/project-file-transactions.js';
import { runBoundedToolCapture } from '../devices/device-host-tools.js';
import { JsonFileStore } from '../infra/json-store.js';
import { mediaInputPolicy } from '../media-tools/media-input-policy.js';
import type { MediaToolsResolver } from '../media-tools/media-tools-resolver.js';
import { transferDeadline } from '../media-tools/transfer-deadline.js';
import type {
  ActionOperationActor,
  ActionOperationService,
} from '../operations/action-operation-service.js';
import type {
  Transcriber,
  TranscriptionResult,
} from '../transcription/transcriber.js';
import { selectWalkthroughFrames } from './frame-selection.js';

export class WalkthroughImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 408 | 409 | 413 | 503,
  ) {
    super(message);
  }
}
interface Dependencies {
  files: ProjectFileTransactions;
  resolver: MediaToolsResolver;
  transcriber: Transcriber;
  operations: ActionOperationService;
  diagnostic(error: unknown): void;
}
interface ImportInput {
  projectSlug: string;
  requestId: string;
  originalName: string;
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
  actor: ActionOperationActor;
  /** Re-check current Project identity and drive standing at publication. */
  authorize(): Promise<void>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function boundedFile(path: string, max: number): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error('Walkthrough file exceeds read bound');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > max) throw new Error('Walkthrough file exceeds read bound');
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}
async function upload(
  path: string,
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const file = await open(path, 'wx', 0o600);
  const reader = body.getReader();
  let size = 0;
  const deadline = transferDeadline(
    MEDIA_UPLOAD_POLICIES.walkthrough.idleMs,
    MEDIA_UPLOAD_POLICIES.walkthrough.totalMs,
    signal,
  );
  const abort = () => {
    void reader.cancel(deadline.signal.reason).catch(() => {});
  };
  deadline.signal.addEventListener('abort', abort, { once: true });
  if (deadline.signal.aborted) abort();
  try {
    for (;;) {
      const next = await reader.read();
      deadline.signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > WALKTHROUGH_LIMITS.uploadBytes)
        throw new WalkthroughImportError(
          'Video exceeds 512 MiB upload limit',
          413,
        );
      deadline.progress();
      await file.writeFile(next.value);
    }
    if (!size) throw new WalkthroughImportError('Video is empty', 400);
  } catch (error) {
    if (deadline.signal.aborted)
      throw new WalkthroughImportError(
        signal?.aborted ? 'Video upload aborted' : 'Video upload timed out',
        signal?.aborted ? 400 : 408,
      );
    throw error;
  } finally {
    deadline.dispose();
    deadline.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file.close();
  }
}
function store(path: string) {
  return new JsonFileStore<WalkthroughImportStatus | undefined>(
    path,
    undefined,
    {
      onCorruption: 'throw',
      maxReadBytes: 64 * 1024,
      durableAtomicWrite: true,
    },
  );
}
/** Project-owned immutable imports. Only a directory rename publishes a complete artifact. */
export class WalkthroughService {
  readonly #admissions = new Map<string, Promise<WalkthroughImportStatus>>();
  readonly #running = new Map<string, Promise<void>>();
  #active = 0;
  constructor(private readonly deps: Dependencies) {}
  #report(error: unknown) {
    try {
      this.deps.diagnostic(error);
    } catch {}
  }
  #root(slug: string) {
    return join(this.deps.files.projectDirectory(slug), 'walkthroughs');
  }
  #receipt(slug: string, id: string) {
    if (!UUID.test(id))
      throw new WalkthroughImportError('Invalid import id', 400);
    return store(join(this.#root(slug), '.imports', `${id}.json`));
  }
  #key(slug: string, id: string) {
    return `${slug}\0${id}`;
  }
  async start(input: ImportInput): Promise<WalkthroughImportStatus> {
    if (
      !UUID.test(input.requestId) ||
      !isWalkthroughFileName(input.originalName) ||
      !/\.(mp4|mov|webm)$/i.test(input.originalName)
    )
      throw new WalkthroughImportError(
        'Choose a plain mp4, mov or webm file name and UUID request id',
        400,
      );
    const key = this.#key(input.projectSlug, input.requestId);
    const existing = this.#admissions.get(key);
    if (existing) {
      await input.body.cancel();
      const result = await existing;
      this.#assertActor(result, input.actor);
      return result;
    }
    const admission = this.#start(input).finally(() =>
      this.#admissions.delete(key),
    );
    this.#admissions.set(key, admission);
    return admission;
  }
  #assertActor(status: WalkthroughImportStatus, actor: ActionOperationActor) {
    if (
      status.operation.scope.accountId !== actor.accountId ||
      status.operation.scope.machineId !== actor.machineId
    )
      throw new WalkthroughImportError('Import not found', 404);
  }
  async #start(input: ImportInput) {
    const saved = await this.status(
      input.projectSlug,
      input.requestId,
      input.actor,
    );
    if (saved) {
      await input.body.cancel();
      return saved;
    }
    if (this.#active >= 2)
      throw new WalkthroughImportError(
        'Walkthrough import capacity exhausted',
        503,
      );
    this.#active++;
    let temp: string | undefined;
    let createdOperation: WalkthroughImportStatus['operation'] | undefined;
    try {
      await input.authorize();
      const project = this.deps.files.readProject(input.projectSlug, (v) => v);
      const root = this.#root(input.projectSlug);
      await mkdir(root, { recursive: true, mode: 0o700 });
      temp = join(root, `.pending-${input.requestId}`);
      await rm(temp, { recursive: true, force: true });
      await mkdir(temp, { mode: 0o700 });
      await upload(join(temp, 'input'), input.body, input.signal);
      await input.authorize();
      const id = input.requestId;
      const operation = await this.deps.operations.create(input.actor, {
        id: randomUUID(),
        scope: {
          accountId: input.actor.accountId,
          ...(input.actor.machineId
            ? { machineId: input.actor.machineId }
            : {}),
        },
        title: 'Import Walkthrough',
        cancellation: 'unsupported',
        domain: {
          kind: 'walkthrough-import',
          projectSlug: input.projectSlug,
          walkthroughId: id,
        },
        reentry: {
          kind: 'walkthrough',
          projectSlug: input.projectSlug,
          walkthroughId: id,
        },
        progress: { kind: 'phase', code: 'probe' },
      });
      if (!operation)
        throw new WalkthroughImportError('Import operation unavailable', 503);
      createdOperation = operation;
      const status: WalkthroughImportStatus = { operation };
      this.#receipt(input.projectSlug, id).write(status);
      const pending = temp;
      temp = undefined;
      const key = this.#key(input.projectSlug, id);
      const execution = this.#run(input, status, pending, async (publish) => {
        if (!project.withCurrentRead)
          throw new Error('Project publication authority unavailable');
        await project.withCurrentRead(async () => {
          await input.authorize();
          await publish();
        });
      }).finally(() => {
        this.#active--;
        this.#running.delete(key);
      });
      this.#running.set(key, execution);
      return structuredClone(status);
    } catch (error) {
      if (createdOperation) {
        try {
          await this.deps.operations.update(input.actor, createdOperation.id, {
            expectedRevision: createdOperation.revision,
            status: 'failed',
            errorSummary: 'Walkthrough import receipt could not be saved',
          });
        } catch (updateError) {
          this.#report(updateError);
        }
      }
      this.#active--;
      if (temp) await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
  async #run(
    input: ImportInput,
    status: WalkthroughImportStatus,
    temp: string,
    commit: (publish: () => Promise<void>) => Promise<void>,
  ) {
    const save = () =>
      this.#receipt(input.projectSlug, input.requestId).write(status);
    const update = async (
      phase: ActionOperationPhaseCode,
      terminal?: WalkthroughImportOutcome,
    ) => {
      const current = await this.deps.operations.get(
        input.actor,
        status.operation.id,
      );
      if (!current) throw new Error('Import operation unavailable');
      const result = await this.deps.operations.update(
        input.actor,
        status.operation.id,
        {
          expectedRevision: current.revision,
          status: terminal
            ? terminal.status === 'imported'
              ? 'succeeded'
              : 'failed'
            : 'running',
          progress: { kind: 'phase', code: phase },
          ...(terminal && terminal.status !== 'imported'
            ? { errorSummary: 'Walkthrough import did not complete' }
            : {}),
        },
      );
      if (result.kind !== 'updated')
        throw new Error('Import operation update refused');
      status.operation = result.operation;
      if (terminal) status.outcome = terminal;
      save();
    };
    let outcome: WalkthroughImportOutcome;
    try {
      outcome = await this.#pipeline(
        input,
        temp,
        (phase) => update(phase),
        commit,
      );
    } catch (error) {
      this.#report(error);
      outcome = {
        status: 'failed',
        reason:
          error instanceof WalkthroughImportError
            ? error.message
            : 'Video import failed',
      };
    }
    // Removing the original is part of completion. A cleanup failure stays a visible failure.
    try {
      await rm(temp, { recursive: true, force: true });
    } catch (error) {
      this.#report(error);
      outcome = {
        status: 'failed',
        reason: 'Temporary recording cleanup failed',
      };
    }
    try {
      await update('write', outcome);
    } catch (error) {
      this.#report(error);
    }
  }
  async #pipeline(
    input: ImportInput,
    temp: string,
    phase: (p: ActionOperationPhaseCode) => Promise<void>,
    commit: (publish: () => Promise<void>) => Promise<void>,
  ): Promise<WalkthroughImportOutcome> {
    const pipelineDeadline = Date.now() + 30 * 60_000;
    const run = (
      command: string,
      args: string[],
      options: { timeoutMs: number; maxBuffer: number },
    ) => {
      const remaining = pipelineDeadline - Date.now();
      if (remaining <= 0)
        throw new WalkthroughImportError('Video import deadline exceeded', 503);
      return runBoundedToolCapture(command, args, {
        ...options,
        timeoutMs: Math.min(options.timeoutMs, remaining),
      });
    };
    await input.authorize();
    await phase('probe');
    const tools = await this.deps.resolver.resolveFfmpeg();
    if (tools.status === 'needs-consent')
      return {
        status: 'unavailable',
        reason: 'needs-consent',
        downloads: tools.downloads,
      };
    if (tools.status === 'unsupported-platform')
      return {
        status: 'unavailable',
        reason: 'unsupported-platform',
        platform: tools.platform,
      };
    const source = join(temp, 'input');
    // Constrain demuxing before decoding: an uploaded playlist must not read host files.
    const inputOptions = [
      ...mediaInputPolicy(true),
      ...(/\.webm$/i.test(input.originalName)
        ? ['-f', 'matroska']
        : ['-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0']),
    ];
    const probe = JSON.parse(
      await run(
        tools.paths.ffprobe,
        [
          '-v',
          'error',
          ...inputOptions,
          '-show_entries',
          'format=duration:stream=codec_type,width,height,duration:stream_side_data=rotation:stream_tags=rotate,DURATION',
          '-of',
          'json',
          source,
        ],
        { timeoutMs: 15_000, maxBuffer: 64 * 1024 },
      ),
    );
    const video = probe.streams?.find(
      (s: { codec_type?: string }) => s.codec_type === 'video',
    );
    // Live WebM omits duration. A packet-copy scan is capped at limit+1s;
    // reaching the cap is refusal, never a truncated successful import.
    const scanDuration = async (videoOnly: boolean) => {
      const progress = await run(
        tools.paths.ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          ...inputOptions,
          '-i',
          source,
          '-map',
          videoOnly ? '0:v:0' : '0',
          '-c',
          'copy',
          '-t',
          String(WALKTHROUGH_LIMITS.durationMs / 1000 + 1),
          '-progress',
          'pipe:1',
          '-stats_period',
          '60',
          '-nostats',
          '-f',
          'null',
          '-',
        ],
        { timeoutMs: 120_000, maxBuffer: 64 * 1024 },
      );
      const times = [
        ...progress.matchAll(/out_time_us:(\d+)|out_time_us=(\d+)/g),
      ].map((m) => Number(m[1] ?? m[2]) / 1000);
      const ms = Math.round(Math.max(...times));
      if (!Number.isFinite(ms) || ms < 1 || ms > WALKTHROUGH_LIMITS.durationMs)
        throw new WalkthroughImportError(
          'Invalid video or duration limit exceeded',
          400,
        );
      return ms;
    };
    const durationMs =
      probe.format?.duration === undefined
        ? await scanDuration(false)
        : Math.round(Number(probe.format.duration) * 1000);
    const durationTag = video?.tags?.DURATION;
    const tagParts =
      typeof durationTag === 'string'
        ? /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(durationTag)
        : null;
    const taggedDurationMs = tagParts
      ? Math.round(
          (Number(tagParts[1]) * 3600 +
            Number(tagParts[2]) * 60 +
            Number(tagParts[3])) *
            1000,
        )
      : NaN;
    const declaredVideoMs =
      video?.duration === undefined
        ? taggedDurationMs
        : Math.round(Number(video.duration) * 1000);
    const streamDurationMs =
      Number.isFinite(declaredVideoMs) && declaredVideoMs > 0
        ? declaredVideoMs
        : video
          ? await scanDuration(true)
          : NaN;
    const videoDurationMs =
      Number.isFinite(streamDurationMs) && streamDurationMs > 0
        ? Math.min(durationMs, streamDurationMs)
        : durationMs;
    if (
      !video ||
      !Number.isFinite(durationMs) ||
      durationMs < 1 ||
      durationMs > WALKTHROUGH_LIMITS.durationMs ||
      ![video.width, video.height].every(
        (n) =>
          Number.isInteger(n) && n > 0 && n <= WALKTHROUGH_LIMITS.dimension,
      )
    )
      throw new WalkthroughImportError(
        'Invalid video or duration/dimension limit exceeded',
        400,
      );
    const rotation = Number(
      video.side_data_list?.find(
        (s: { rotation?: number }) => s.rotation !== undefined,
      )?.rotation ??
        video.tags?.rotate ??
        0,
    );
    if (!Number.isFinite(rotation) || rotation % 90 !== 0)
      throw new WalkthroughImportError('Unsupported video rotation', 400);
    const rotated = Math.abs(rotation) % 180 === 90;
    const displayWidth = rotated ? video.height : video.width;
    const displayHeight = rotated ? video.width : video.height;
    const audio = probe.streams.some(
      (s: { codec_type?: string }) => s.codec_type === 'audio',
    );
    await phase('transcribe');
    let transcript: WalkthroughTranscript[] = [];
    if (audio) {
      const deadline = Math.min(pipelineDeadline, Date.now() + 15 * 60_000);
      const signal = AbortSignal.timeout(15 * 60_000);
      let backoff = 250;
      let result: TranscriptionResult;
      for (;;) {
        await input.authorize();
        result = await this.deps.transcriber.transcribeFile({
          inputPath: source,
          media: 'walkthrough',
          signal,
        });
        if (result.status !== 'failed' || result.reason !== 'busy') break;
        if (Date.now() + backoff >= deadline)
          return {
            status: 'failed',
            reason: 'Transcription queue deadline exceeded',
          };
        await delay(backoff, undefined, { signal });
        backoff = Math.min(5000, backoff * 2);
      }
      if (result.status === 'unavailable') return result;
      if (result.status === 'failed')
        return { status: 'failed', reason: `Transcription ${result.reason}` };
      transcript = result.segments.map((s) => ({
        kind: 'transcript',
        tMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        tokens: s.tokens.map((t) => ({
          tMs: t.startMs,
          endMs: t.endMs,
          text: t.text,
        })),
      }));
    }
    const base: Walkthrough = {
      schema: WALKTHROUGH_SCHEMA,
      id: input.requestId,
      createdAt: new Date().toISOString(),
      source: {
        adapter: 'video-import',
        adapterVersion: '1',
        originalName: input.originalName,
        durationMs,
      },
      capture: {
        platform: 'unknown',
        width: displayWidth,
        height: displayHeight,
      },
      coverage: {
        transcript: audio ? 'present' : 'absent',
        frames: 'present',
        marks: 'absent',
        elements: 'absent',
        route: 'absent',
        console: 'absent',
        network: 'absent',
      },
      events: transcript,
    };
    // Validate transcriber timestamps and all transcript bounds before expensive frame work.
    parseWalkthrough(base);
    await phase('frames');
    const scenes = await run(
      tools.paths.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        ...inputOptions,
        '-skip_frame',
        'nokey',
        '-i',
        source,
        '-vf',
        "fps=5,scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease,select=gt(scene\\,0.3),metadata=print:file=-",
        '-an',
        '-f',
        'null',
        '-',
      ],
      {
        timeoutMs: Math.min(300_000, 30_000 + videoDurationMs * 0.5),
        maxBuffer: 1024 * 1024,
      },
    );
    const sceneTimes = [...scenes.matchAll(/pts_time:([\d.]+)/g)].map(
      (m) => Number(m[1]) * 1000,
    );
    const selection = selectWalkthroughFrames({
      durationMs: videoDurationMs,
      tokens: transcript.flatMap((e) => e.tokens ?? []),
      speech: transcript,
      sceneTimes,
    });
    const artifact = join(temp, 'artifact');
    await mkdir(artifact, { mode: 0o700 });
    const factor = Math.min(
      1,
      WALKTHROUGH_LIMITS.frameEdge / Math.max(displayWidth, displayHeight),
    );
    const width = Math.max(1, Math.floor(displayWidth * factor)),
      height = Math.max(1, Math.floor(displayHeight * factor));
    const frames: WalkthroughFrame[] = [];
    for (const [index, frame] of selection.frames.entries()) {
      const file = `frame-${index.toString().padStart(3, '0')}.jpg`;
      await run(
        tools.paths.ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          ...inputOptions,
          '-ss',
          String(frame.tMs / 1000),
          '-i',
          source,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          `scale=${width}:${height}`,
          '-q:v',
          '4',
          '-threads',
          '1',
          join(artifact, file),
        ],
        {
          timeoutMs: Math.min(90_000, 30_000 + videoDurationMs * 0.02),
          maxBuffer: 4096,
        },
      );
      const bytes = await boundedFile(
        join(artifact, file),
        WALKTHROUGH_LIMITS.frameBytes,
      ).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      });
      if (!bytes) continue;
      if (
        bytes.length < 4 ||
        bytes[0] !== 255 ||
        bytes[1] !== 216 ||
        bytes.at(-2) !== 255 ||
        bytes.at(-1) !== 217
      )
        throw new Error('Invalid JPEG frame');
      const handle = await open(join(artifact, file), 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      frames.push({
        kind: 'frame',
        ...frame,
        frameId: `frame-${index}`,
        file,
        width,
        height,
      });
    }
    if (!frames.length)
      throw new WalkthroughImportError('No video frames could be decoded', 400);
    await phase('write');
    const manifest = parseWalkthrough({
      ...base,
      frameSelection: { ...selection.frameSelection, kept: frames.length },
      events: [...transcript, ...frames].sort((a, b) => a.tMs - b.tMs),
    });
    new JsonFileStore<Walkthrough | null>(
      join(artifact, 'manifest.json'),
      null,
      {
        durableAtomicWrite: true,
      },
    ).write(manifest);
    parseWalkthrough(
      JSON.parse(
        (
          await boundedFile(
            join(artifact, 'manifest.json'),
            WALKTHROUGH_LIMITS.manifestBytes,
          )
        ).toString('utf8'),
      ),
    );
    fsyncDirectorySync(artifact);
    await commit(async () => {
      await rename(artifact, join(this.#root(input.projectSlug), manifest.id));
      fsyncDirectorySync(this.#root(input.projectSlug));
    });
    return { status: 'imported', id: manifest.id };
  }
  async status(
    slug: string,
    id: string,
    actor: ActionOperationActor,
  ): Promise<WalkthroughImportStatus | undefined> {
    const receipt = this.#receipt(slug, id);
    let saved = receipt.read();
    if (!saved) return undefined;
    this.#assertActor(saved, actor);
    if (!saved.outcome && !this.#running.has(this.#key(slug, id))) {
      const manifest = await this.get(slug, id);
      await rm(join(this.#root(slug), `.pending-${id}`), {
        recursive: true,
        force: true,
      });
      const outcome: WalkthroughImportOutcome = manifest
        ? { status: 'imported', id }
        : {
            status: 'failed',
            reason: 'Import interrupted; submit a new request id',
          };
      const current = await this.deps.operations.get(actor, saved.operation.id);
      if (!current)
        throw new WalkthroughImportError('Import operation unavailable', 503);
      const result = await this.deps.operations.update(
        actor,
        saved.operation.id,
        {
          expectedRevision: current.revision,
          status: manifest ? 'succeeded' : 'failed',
          errorSummary: manifest ? undefined : 'Walkthrough import interrupted',
        },
      );
      if (
        (result.kind === 'updated' || result.kind === 'terminal') &&
        result.operation.status === (manifest ? 'succeeded' : 'failed')
      ) {
        saved = { operation: result.operation, outcome };
      } else
        throw new WalkthroughImportError(
          'Import operation changed; read status again',
          503,
        );
      receipt.write(saved);
    }
    return saved;
  }
  async get(slug: string, id: string): Promise<Walkthrough | null> {
    if (!isWalkthroughId(id))
      throw new WalkthroughImportError('Invalid Walkthrough id', 400);
    try {
      return parseWalkthrough(
        JSON.parse(
          (
            await boundedFile(
              join(this.#root(slug), id, 'manifest.json'),
              WALKTHROUGH_LIMITS.manifestBytes,
            )
          ).toString('utf8'),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async frame(
    slug: string,
    id: string,
    frameId: string,
  ): Promise<Buffer | null> {
    const manifest = await this.get(slug, id);
    const frame = manifest?.events.find(
      (e): e is WalkthroughFrame => e.kind === 'frame' && e.frameId === frameId,
    );
    return frame
      ? boundedFile(
          join(this.#root(slug), id, frame.file),
          WALKTHROUGH_LIMITS.frameBytes,
        )
      : null;
  }
  async list(
    slug: string,
    limit = 25,
    cursor?: string,
  ): Promise<WalkthroughPage> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > WALKTHROUGH_LIMITS.listPage ||
      (cursor !== undefined && !isWalkthroughId(cursor))
    )
      throw new WalkthroughImportError('Invalid page bounds', 400);
    let names: string[];
    try {
      names = (await readdir(this.#root(slug), { withFileTypes: true }))
        .filter((e) => e.isDirectory() && isWalkthroughId(e.name))
        .map((e) => e.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { items: [] };
      throw error;
    }
    const page = names.filter((n) => !cursor || n > cursor).slice(0, limit + 1);
    const items = [];
    for (const id of page.slice(0, limit)) {
      const m = await this.get(slug, id);
      if (!m) throw new Error('Walkthrough disappeared');
      items.push({
        id: m.id,
        createdAt: m.createdAt,
        ...(m.title ? { title: m.title } : {}),
        durationMs: m.source.durationMs,
        frames: m.events.filter((e) => e.kind === 'frame').length,
      });
    }
    return {
      items,
      ...(page.length > limit ? { nextCursor: page[limit - 1] } : {}),
    };
  }
}
