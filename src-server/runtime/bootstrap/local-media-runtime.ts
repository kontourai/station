import type { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import { MediaToolsAcquisition } from '../../services/media-tools/media-tools-acquisition.js';
import { SherpaTranscriber } from '../../services/transcription/sherpa-transcriber.js';

/** Runtime composition owns one downloader and one bounded recognizer for every consumer. */
export function composeLocalMedia(home: string) {
  const mediaTools = new MediaToolsAcquisition(home);
  const transcriber = new SherpaTranscriber(mediaTools);
  return { mediaTools, transcriber };
}

export function bindLocalMediaPreviews(
  featurePreviews: FeaturePreviewRegistry,
) {
  const walkthroughsPreview = featurePreviews.bind({
    id: 'walkthroughs',
    label: 'Walkthroughs',
    description:
      'Import narrated screen recordings into Walkthroughs that agents can read. Processing stays on this Station; missing media and speech tools need a one-time consented download.',
  });
  const localSpeechPreview = featurePreviews.bind({
    id: 'local-speech',
    label: 'Local speech',
    description:
      'Try on-device speech-to-text for voice input. Processing stays on this Station; missing tools and the English speech model need a one-time consented download. The voice input provider is coming next.',
  });
  const mediaToolsPreview = {
    select: <T>(branches: { enabled: () => T; disabled: () => T }): T =>
      walkthroughsPreview.select({
        enabled: branches.enabled,
        disabled: () => localSpeechPreview.select(branches),
      }),
  };
  return {
    walkthroughsPreview,
    localSpeechPreview,
    mediaToolsPreview,
  };
}
