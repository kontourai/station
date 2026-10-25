import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { runMediaProcess } from '../../media-tools/media-process.js';
import { SherpaTranscriber } from '../sherpa-transcriber.js';

const temp = trackTempDirs();
const dir = process.env.STATION_WALKTHROUGH_TEST_FFMPEG_DIR;
test.skipIf(!dir)(
  'real dictation accepts browser audio and refuses foreign containers, codecs and playlists',
  async () => {
    const home = temp('station-dictation-formats-');
    const recognizer = join(home, 'recognizer');
    await writeFile(
      recognizer,
      `#!${process.execPath}\nconsole.log(JSON.stringify({text:'',tokens:[],timestamps:[],durations:[]}));\n`,
      { mode: 0o700 },
    );
    const ffmpeg = join(dir!, 'ffmpeg'),
      ffprobe = join(dir!, 'ffprobe');
    const transcriber = new SherpaTranscriber({
      resolveFfmpeg: async () => ({
        status: 'ready',
        origin: 'host',
        paths: { ffmpeg, ffprobe },
      }),
      resolveSpeech: async () => ({
        status: 'ready',
        origin: 'host',
        paths: {
          executable: recognizer,
          runtimeDir: home,
          encoder: 'unused',
          decoder: 'unused',
          joiner: 'unused',
          tokens: 'unused',
        },
      }),
    });
    for (const [name, codec, accepted] of [
      ['pcm.wav', 'pcm_s16le', true],
      ['opus.webm', 'libopus', true],
      ['vorbis.ogg', 'libvorbis', true],
      ['safari.m4a', 'aac', true],
      ['safari.mov', 'alac', true],
      ['foreign.flac', 'flac', false],
      ['foreign.wav', 'adpcm_ima_wav', false],
    ] as const) {
      const inputPath = join(home, name);
      await runMediaProcess(
        ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=duration=0.5',
          '-c:a',
          codec,
          inputPath,
        ],
        { timeoutMs: 15_000 },
      );
      const result = await transcriber.transcribeFile({ inputPath });
      expect(result, name).toMatchObject(
        accepted
          ? { status: 'transcribed' }
          : { status: 'failed', reason: 'invalid-input' },
      );
    }
    for (const [name, contents] of [
      ['playlist.ffconcat', 'ffconcat version 1.0\nfile pcm.wav\n'],
      ['playlist.m3u8', '#EXTM3U\n#EXTINF:1,\npcm.wav\n'],
      ['playlist.mpd', '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>'],
      ['playlist.sdp', 'v=0\nc=IN IP4 127.0.0.1\nm=audio 1234 RTP/AVP 0\n'],
    ] as const) {
      const inputPath = join(home, name);
      await writeFile(inputPath, contents);
      expect(
        await transcriber.transcribeFile({ inputPath }),
        name,
      ).toMatchObject({ status: 'failed', reason: 'invalid-input' });
    }
  },
  60_000,
);
