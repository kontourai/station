import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  locateExecutable,
  standardFfmpegDirs,
} from '../devices/device-host-tools.js';
import { extractMediaAsset } from './media-archive.js';
import {
  MEDIA_TOOLS_PINS,
  type MediaToolBuild,
  type MediaToolComponent,
  type MediaToolPin,
  type MediaToolPins,
  type MediaToolPlatform,
} from './media-tools-pins.js';
import type {
  FfmpegPaths,
  MediaToolDownloadItem,
  MediaToolResolution,
  MediaToolsResolver,
} from './media-tools-resolver.js';

export interface SpeechPaths {
  executable: string;
  runtimeDir: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}
export interface MediaToolStatus extends MediaToolDownloadItem {
  resolution: MediaToolResolution<Readonly<Record<string, string>>>;
  progress?: { receivedBytes: number; totalBytes: number };
  failure?: string;
}
export interface MediaToolsStatus {
  components: readonly MediaToolStatus[];
}

class MediaToolsConsentRequiredError extends Error {
  constructor() {
    super('Downloading media tools requires explicit consent: true.');
  }
}

interface AcquisitionOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  pins?: MediaToolPins;
  fetch?: typeof fetch;
  /** Host discovery is replaceable for hosts with custom tool installations. */
  locate?: (name: string) => Promise<string | null>;
}
const COMPONENTS: readonly MediaToolComponent[] = [
  'ffmpeg',
  'speech-runtime',
  'speech-model',
];
const MODEL_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
];
const MARKER = 'station-media-tool.json';
type Paths = Readonly<Record<string, string>>;
const active = new Map<
  string,
  {
    progress: { receivedBytes: number; totalBytes: number };
    completion: Promise<void>;
    failure?: string;
  }
>();

async function isFile(path: string, executable = false): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(
      path,
      executable && process.platform !== 'win32'
        ? constants.X_OK
        : constants.R_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/** Resolution is local-only. Only startDownload may use fetch or create files. */
export class MediaToolsAcquisition implements MediaToolsResolver {
  private readonly platform: string;
  private readonly pins: MediaToolPins;
  private readonly env: NodeJS.ProcessEnv;
  private readonly locate: (name: string) => Promise<string | null>;
  private readonly fetch: typeof fetch;
  constructor(
    readonly stationHome: string,
    options: AcquisitionOptions = {},
  ) {
    this.platform = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
    this.pins = options.pins ?? MEDIA_TOOLS_PINS;
    this.env = options.env ?? process.env;
    this.locate =
      options.locate ??
      ((name) => locateExecutable(name, standardFfmpegDirs(), this.env));
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private build(component: MediaToolComponent): MediaToolBuild | undefined {
    return this.pins[component].builds[this.platform as MediaToolPlatform];
  }
  private installDir(component: MediaToolComponent): string {
    return join(
      this.stationHome,
      'media-tools',
      component,
      this.pins[component].version,
    );
  }
  private key(component: MediaToolComponent): string {
    return `${resolve(this.stationHome)}:${component}`;
  }
  private item(component: MediaToolComponent): MediaToolDownloadItem {
    return {
      component,
      version: this.pins[component].version,
      bytes:
        this.build(component)?.assets.reduce((sum, a) => sum + a.bytes, 0) ?? 0,
    };
  }
  private paths(
    component: MediaToolComponent,
    root: string,
    required: readonly string[],
  ): Paths {
    if (component === 'ffmpeg')
      return {
        ffmpeg: join(root, required[0]!),
        ffprobe: join(root, required[1]!),
      };
    if (component === 'speech-runtime')
      return { executable: join(root, required[0]!) };
    return Object.fromEntries(
      ['encoder', 'decoder', 'joiner', 'tokens'].map((key, i) => [
        key,
        join(root, required[i]!),
      ]),
    );
  }
  private async host(
    component: MediaToolComponent,
  ): Promise<Paths | undefined> {
    if (component === 'ffmpeg') {
      const ffmpeg = await this.locate('ffmpeg');
      const ffprobe = await this.locate('ffprobe');
      return ffmpeg && ffprobe ? { ffmpeg, ffprobe } : undefined;
    }
    if (component === 'speech-runtime') {
      const executable = await this.locate('sherpa-onnx-offline');
      return executable ? { executable } : undefined;
    }
    const root = this.env.STATION_SPEECH_MODEL_DIR;
    if (
      root &&
      (
        await Promise.all(MODEL_FILES.map((file) => isFile(join(root, file))))
      ).every(Boolean)
    ) {
      return this.paths(component, root, MODEL_FILES);
    }
    return undefined;
  }
  private async resolveComponent(
    component: MediaToolComponent,
  ): Promise<MediaToolResolution<Paths>> {
    const host = await this.host(component);
    if (host) return { status: 'ready', paths: host, origin: 'host' };
    const build = this.build(component);
    if (!build)
      return { status: 'unsupported-platform', platform: this.platform };
    const root = this.installDir(component);
    try {
      const marker = await readFile(join(root, MARKER), 'utf8');
      if (
        marker === this.marker(this.pins[component], build) &&
        (
          await Promise.all(
            build.required.map((path, i) =>
              isFile(join(root, path), component !== 'speech-model' && i === 0),
            ),
          )
        ).every(Boolean)
      ) {
        return {
          status: 'ready',
          paths: this.paths(component, root, build.required),
          origin: 'downloaded',
        };
      }
    } catch {
      /* A missing or incomplete installation needs explicit consent. */
    }
    return { status: 'needs-consent', downloads: [this.item(component)] };
  }
  private marker(pin: MediaToolPin, build: MediaToolBuild): string {
    return `${JSON.stringify({ version: pin.version, platform: this.platform, assets: build.assets })}\n`;
  }
  /** The device decoder needs ffmpeg alone; ffprobe remains required by import/transcription. */
  async resolveFfmpegExecutable(): Promise<MediaToolResolution<string>> {
    const host = await this.locate('ffmpeg');
    if (host) return { status: 'ready', paths: host, origin: 'host' };
    const result = await this.resolveFfmpeg();
    return result.status === 'ready'
      ? { ...result, paths: result.paths.ffmpeg }
      : result;
  }
  async resolveFfmpeg(): Promise<MediaToolResolution<FfmpegPaths>> {
    const resolution = await this.resolveComponent('ffmpeg');
    return resolution.status === 'ready'
      ? {
          ...resolution,
          paths: {
            ffmpeg: resolution.paths.ffmpeg!,
            ffprobe: resolution.paths.ffprobe!,
          },
        }
      : resolution;
  }
  async resolveSpeech(): Promise<MediaToolResolution<SpeechPaths>> {
    const resolutions = await Promise.all([
      this.resolveComponent('speech-runtime'),
      this.resolveComponent('speech-model'),
    ]);
    for (const r of resolutions)
      if (r.status === 'unsupported-platform') return r;
    const downloads = resolutions.flatMap((r) =>
      r.status === 'needs-consent' ? r.downloads : [],
    );
    if (downloads.length) return { status: 'needs-consent', downloads };
    const [runtime, model] = resolutions;
    if (runtime?.status !== 'ready' || model?.status !== 'ready')
      throw new Error('Speech resolution invariant violated.');
    return {
      status: 'ready',
      origin:
        runtime.origin === 'host' && model.origin === 'host'
          ? 'host'
          : 'downloaded',
      paths: {
        executable: runtime.paths.executable!,
        runtimeDir: dirname(runtime.paths.executable!),
        encoder: model.paths.encoder!,
        decoder: model.paths.decoder!,
        joiner: model.paths.joiner!,
        tokens: model.paths.tokens!,
      },
    };
  }
  async status(): Promise<MediaToolsStatus> {
    return {
      components: await Promise.all(
        COMPONENTS.map(async (component) => {
          const job = active.get(this.key(component));
          return {
            ...this.item(component),
            resolution: await this.resolveComponent(component),
            ...(job
              ? {
                  progress: { ...job.progress },
                  ...(job.failure ? { failure: job.failure } : {}),
                }
              : {}),
          };
        }),
      ),
    };
  }
  async startDownload(request: {
    consent: true;
    components?: readonly MediaToolComponent[];
  }): Promise<{ status: MediaToolsStatus; completion: Promise<void> }> {
    if (request?.consent !== true) throw new MediaToolsConsentRequiredError();
    const selected = request.components ?? COMPONENTS;
    if (!selected.length || selected.some((c) => !COMPONENTS.includes(c)))
      throw new Error('Unknown media tool component.');
    const jobs: Promise<void>[] = [];
    for (const component of new Set(selected)) {
      const key = this.key(component);
      const current = active.get(key);
      if (current && !current.failure) {
        jobs.push(current.completion);
        continue;
      }
      const progress = {
        receivedBytes: 0,
        totalBytes: this.item(component).bytes,
      };
      const job = {
        progress,
        completion: Promise.resolve(),
        failure: undefined as string | undefined,
      };
      active.set(key, job);
      job.completion = (async () => {
        if ((await this.resolveComponent(component)).status === 'needs-consent')
          await this.download(component, progress);
      })()
        .then(() => {
          active.delete(key);
        })
        .catch((error: unknown) => {
          job.failure = error instanceof Error ? error.message : String(error);
        });
      jobs.push(job.completion);
    }
    return {
      status: await this.status(),
      completion: Promise.all(jobs).then(() => {}),
    };
  }
  private async download(
    component: MediaToolComponent,
    progress: { receivedBytes: number; totalBytes: number },
  ): Promise<void> {
    const build = this.build(component)!;
    const parent = join(this.stationHome, 'media-tools', component);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(parent, '.download-'));
    const extracted = join(staging, 'extracted');
    await mkdir(extracted, { mode: 0o700 });
    try {
      for (const [index, asset] of build.assets.entries()) {
        const archive = join(staging, `archive-${index}`);
        const response = await this.fetch(asset.url, {
          signal: AbortSignal.timeout(5 * 60_000),
          redirect: 'follow',
        });
        if (!response.ok || !response.body)
          throw new Error(`Download failed (${response.status}).`);
        const length = response.headers.get('content-length');
        if (length !== null && Number(length) !== asset.bytes) {
          await response.body.cancel();
          throw new Error('Media archive byte length mismatch.');
        }
        const hash = createHash('sha256');
        let bytes = 0;
        const verify = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.byteLength;
            progress.receivedBytes += chunk.byteLength;
            hash.update(chunk);
            callback(
              bytes > asset.bytes
                ? new Error('Media archive byte length mismatch.')
                : null,
              chunk,
            );
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          verify,
          createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
        );
        if (bytes !== asset.bytes)
          throw new Error('Media archive byte length mismatch.');
        if (hash.digest('hex') !== asset.sha256)
          throw new Error('Media archive SHA-256 mismatch.');
        await extractMediaAsset(asset, archive, extracted);
      }
      if (
        !(
          await Promise.all(
            build.required.map((path) => isFile(join(extracted, path))),
          )
        ).every(Boolean)
      )
        throw new Error('Media archive lacks required files.');
      if (component !== 'speech-model')
        for (const path of Object.values(
          this.paths(component, extracted, build.required),
        ))
          await chmod(path, 0o700);
      await writeFile(
        join(extracted, MARKER),
        this.marker(this.pins[component], build),
      );
      const dest = this.installDir(component);
      await rm(dest, { recursive: true, force: true });
      await rename(extracted, dest);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
