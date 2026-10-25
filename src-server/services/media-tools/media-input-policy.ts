// FFmpeg -codec_whitelist accepts decoder names, not codec ids.
// Browser capture formats; see the compatibility sources in the local-speech guide.
const AUDIO_CODECS =
  'aac,opus,vorbis,alac,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s24be,pcm_s32be';
const WALKTHROUGH_CODECS = `h264,hevc,vp8,vp9,av1,libaom-av1,${AUDIO_CODECS}`;
export function mediaInputPolicy(walkthrough = false): string[] {
  return [
    '-protocol_whitelist',
    'file',
    '-format_whitelist',
    walkthrough ? 'mov,matroska,webm' : 'mov,matroska,webm,ogg,wav',
    '-codec_whitelist',
    walkthrough ? WALKTHROUGH_CODECS : AUDIO_CODECS,
  ];
}
