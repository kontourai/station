/**
 * Browser page for the H.264 decode fixture (#4418): the real
 * `LiveSurfaceH264Decoder` over the browser's own WebCodecs. Bundled by the
 * fixture test, never by the app.
 */
import type { LiveSurfaceFrameHeader } from '@kontourai/station-contracts/live-surface';
import {
  LiveSurfaceH264Decoder,
  liveSurfaceH264Capable,
} from '../../liveSurfaceVideoDecoder';

declare global {
  interface Window {
    decodeUnits(units: { keyframe: boolean; base64: string }[]): Promise<{
      capable: boolean;
      outcomes: string[];
      pictures: { width: number; height: number; seq: number }[];
      errors: string[];
    }>;
  }
}

window.decodeUnits = async (units) => {
  const pictures: { width: number; height: number; seq: number }[] = [];
  const errors: string[] = [];
  const capable = liveSurfaceH264Capable();
  if (!capable) return { capable, outcomes: [], pictures, errors };
  const decoder = new LiveSurfaceH264Decoder({
    onPicture: (picture, header) => {
      pictures.push({
        width: picture.displayWidth,
        height: picture.displayHeight,
        seq: header.seq,
      });
      picture.close();
    },
    onError: (error) => errors.push(String(error)),
  });
  const outcomes: string[] = [];
  let seq = 0;
  for (const unit of units) {
    seq += 1;
    const header: LiveSurfaceFrameHeader = {
      surfaceId: 'device:android:fixture',
      seq,
      epoch: 0,
      codec: 'h264',
      keyframe: unit.keyframe,
      width: 576,
      height: 1280,
      deviceScaleFactor: 1,
      capturedAt: 0,
    };
    const body = Uint8Array.from(atob(unit.base64), (c) => c.charCodeAt(0));
    outcomes.push(await decoder.decode(header, body));
  }
  // Let the decoder emit what it holds.
  const deadline = Date.now() + 5_000;
  while (
    pictures.length < outcomes.filter((o) => o === 'decoding').length &&
    errors.length === 0 &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  decoder.close();
  return { capable, outcomes, pictures, errors };
};
