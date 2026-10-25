/**
 * The interface consumers use to find Station's on-demand media tools
 * (docs/design/walkthroughs.md, "Speech and media tools, on demand").
 *
 * Resolution never touches the network. A tool is `ready` when it is
 * installed on the host or a pinned build was already downloaded into the
 * Station home; otherwise the answer says what a consented download would
 * fetch, or that this platform has no pinned build. Downloading is a
 * separate, consent-gated operation owned by the acquisition module.
 */

export type MediaToolOrigin = 'host' | 'downloaded';

export interface MediaToolDownloadItem {
  /** Stable component id, e.g. `ffmpeg`, `speech-runtime`, `speech-model`. */
  readonly component: string;
  readonly version: string;
  /** Exact archive length in bytes, from the pin. */
  readonly bytes: number;
}

export type MediaToolResolution<Paths> =
  | { readonly status: 'ready'; readonly paths: Paths; readonly origin: MediaToolOrigin }
  | { readonly status: 'needs-consent'; readonly downloads: readonly MediaToolDownloadItem[] }
  | { readonly status: 'unsupported-platform'; readonly platform: string };

export interface FfmpegPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface MediaToolsResolver {
  resolveFfmpeg(): Promise<MediaToolResolution<FfmpegPaths>>;
}
