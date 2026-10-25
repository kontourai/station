/**
 * Trust roots recorded 2026-10-24: downloaded each distinct URL ONCE into
 * /tmp/station-speech-pins-20261024 (outside repo and Station home), counted
 * bytes and hashed SHA-256, cross-checked GitHub release asset sizes.
 * macOS shares the universal2 no-TTS CLI. Linux arm64 has no no-TTS asset
 * in v2.0.0: use its CPU shared CLI (includes unused TTS programs). Windows
 * uses the release MD CLI, with its bundled DLLs. No GPU/runtime-lib bundles.
 * None of these tar archives contains a link; extraction refuses all links.
 */
export type MediaToolComponent = 'ffmpeg' | 'speech-runtime' | 'speech-model';
export type MediaToolPlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64';
export interface MediaToolAsset {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly format: 'gzip' | 'tar.bz2' | 'file';
  readonly output?: string;
}
export interface MediaToolBuild {
  readonly assets: readonly MediaToolAsset[];
  readonly required: readonly string[];
}
export interface MediaToolPin {
  readonly version: string;
  readonly builds: Readonly<Partial<Record<MediaToolPlatform, MediaToolBuild>>>;
}
export type MediaToolPins = Readonly<Record<MediaToolComponent, MediaToolPin>>;
export const MEDIA_TOOLS_PINS: MediaToolPins = {
  ffmpeg: {
    version: 'b6.1.1',
    builds: {
      'darwin-arm64': {
        assets: [
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz',
            bytes: 19246198,
            sha256:
              '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
            format: 'gzip',
            output: 'ffmpeg',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-arm64.gz',
            bytes: 19207077,
            sha256:
              'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
            format: 'gzip',
            output: 'ffprobe',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/darwin-arm64.LICENSE',
            bytes: 4376,
            sha256:
              'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2',
            format: 'file',
            output: 'darwin-arm64.LICENSE',
          },
        ],
        required: ['ffmpeg', 'ffprobe', 'darwin-arm64.LICENSE'],
      },
      'darwin-x64': {
        assets: [
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-x64.gz',
            bytes: 25296431,
            sha256:
              '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
            format: 'gzip',
            output: 'ffmpeg',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-x64.gz',
            bytes: 25239438,
            sha256:
              'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
            format: 'gzip',
            output: 'ffprobe',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/darwin-x64.LICENSE',
            bytes: 4346,
            sha256:
              '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af',
            format: 'file',
            output: 'darwin-x64.LICENSE',
          },
        ],
        required: ['ffmpeg', 'ffprobe', 'darwin-x64.LICENSE'],
      },
      'linux-x64': {
        assets: [
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz',
            bytes: 29354986,
            sha256:
              'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
            format: 'gzip',
            output: 'ffmpeg',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-x64.gz',
            bytes: 29276839,
            sha256:
              '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
            format: 'gzip',
            output: 'ffprobe',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/linux-x64.LICENSE',
            bytes: 35147,
            sha256:
              '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
            format: 'file',
            output: 'linux-x64.LICENSE',
          },
        ],
        required: ['ffmpeg', 'ffprobe', 'linux-x64.LICENSE'],
      },
      'linux-arm64': {
        assets: [
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-arm64.gz',
            bytes: 25568691,
            sha256:
              '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
            format: 'gzip',
            output: 'ffmpeg',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-arm64.gz',
            bytes: 25493573,
            sha256:
              '2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8',
            format: 'gzip',
            output: 'ffprobe',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/linux-arm64.LICENSE',
            bytes: 35147,
            sha256:
              '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
            format: 'file',
            output: 'linux-arm64.LICENSE',
          },
        ],
        required: ['ffmpeg', 'ffprobe', 'linux-arm64.LICENSE'],
      },
      'win32-x64': {
        assets: [
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz',
            bytes: 29581307,
            sha256:
              '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
            format: 'gzip',
            output: 'ffmpeg.exe',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-win32-x64.gz',
            bytes: 29521644,
            sha256:
              'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d',
            format: 'gzip',
            output: 'ffprobe.exe',
          },
          {
            url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/win32-x64.LICENSE',
            bytes: 35147,
            sha256:
              '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
            format: 'file',
            output: 'win32-x64.LICENSE',
          },
        ],
        required: ['ffmpeg.exe', 'ffprobe.exe', 'win32-x64.LICENSE'],
      },
    },
  },
  'speech-runtime': {
    version: '2.0.0',
    builds: {
      'darwin-arm64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-osx-universal2-shared-no-tts.tar.bz2',
            bytes: 39999006,
            sha256:
              '1b1626b7e2f0873bac0e7d9f81e136547eee506d25f6d36548c9d2e93424d985',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-v2.0.0-osx-universal2-shared-no-tts/bin/sherpa-onnx-offline',
        ],
      },
      'darwin-x64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-osx-universal2-shared-no-tts.tar.bz2',
            bytes: 39999006,
            sha256:
              '1b1626b7e2f0873bac0e7d9f81e136547eee506d25f6d36548c9d2e93424d985',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-v2.0.0-osx-universal2-shared-no-tts/bin/sherpa-onnx-offline',
        ],
      },
      'linux-x64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-linux-x64-shared-no-tts.tar.bz2',
            bytes: 25246331,
            sha256:
              '10378908bc8976d324d6cc1e882bccf982ab9e6e6e0cfb433bae9e3871646c34',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-v2.0.0-linux-x64-shared-no-tts/bin/sherpa-onnx-offline',
        ],
      },
      'linux-arm64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-linux-aarch64-shared-cpu.tar.bz2',
            bytes: 27802045,
            sha256:
              '0ee6e6a6de388f9db6f24c241ee6631c7509d47f3c8e5cd7b05259ff92f722b6',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-v2.0.0-linux-aarch64-shared-cpu/bin/sherpa-onnx-offline',
        ],
      },
      'win32-x64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-win-x64-shared-MD-Release-no-tts.tar.bz2',
            bytes: 20864508,
            sha256:
              '98d8cf1c0e0bfb5768042e90ffe9591203855b8f4aabdcd5c154eb39b87a0707',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-v2.0.0-win-x64-shared-MD-Release-no-tts/bin/sherpa-onnx-offline.exe',
        ],
      },
    },
  },
  'speech-model': {
    version: 'parakeet-tdt-110m-int8',
    builds: {
      'darwin-arm64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2',
            bytes: 108035095,
            sha256:
              'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/encoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/decoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/joiner.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/tokens.txt',
        ],
      },
      'darwin-x64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2',
            bytes: 108035095,
            sha256:
              'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/encoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/decoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/joiner.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/tokens.txt',
        ],
      },
      'linux-x64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2',
            bytes: 108035095,
            sha256:
              'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/encoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/decoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/joiner.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/tokens.txt',
        ],
      },
      'linux-arm64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2',
            bytes: 108035095,
            sha256:
              'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/encoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/decoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/joiner.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/tokens.txt',
        ],
      },
      'win32-x64': {
        assets: [
          {
            url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2',
            bytes: 108035095,
            sha256:
              'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
            format: 'tar.bz2',
          },
        ],
        required: [
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/encoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/decoder.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/joiner.int8.onnx',
          'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/tokens.txt',
        ],
      },
    },
  },
};
