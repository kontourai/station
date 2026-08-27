import type { TransformationReceipt } from './heif-normalizer';
import {
  HEIF_MAX_AGGREGATE_SOURCE_BYTES,
  HEIF_MAX_SOURCE_BYTES,
  type HeifFailure,
  normalizeHeifFile,
} from './heif-normalizer';

export type HeifPreparation =
  | { kind: 'not-heif' }
  | {
      kind: 'ready';
      file: File;
      receipt: TransformationReceipt;
      sourceBytes: number;
    }
  | { kind: 'rejected'; error: string };

const HEIF_MIME = /^image\/hei(?:c|f)$/iu;
const HEIF_EXTENSION = /\.(?:heic|heif)$/iu;

function isHeifCandidate(file: Pick<File, 'name' | 'type'>): boolean {
  const type = file.type.trim().toLowerCase();
  return (
    HEIF_MIME.test(type) ||
    ((type === '' || type === 'application/octet-stream') &&
      HEIF_EXTENSION.test(file.name))
  );
}

function refusal(name: string, reason: HeifFailure): string {
  switch (reason) {
    case 'source-too-large':
      return `${name} is larger than 25 MB. Convert it to JPEG and choose it again.`;
    case 'decoder-unavailable':
      return `${name} was inspected locally, but this browser cannot safely convert HEIF. Convert it to JPEG and choose it again.`;
    case 'timed-out':
      return `${name} took too long to convert locally. Try a smaller JPEG instead.`;
    case 'cancelled':
      return `${name} conversion was cancelled. Choose it again to retry.`;
    case 'output-too-large':
      return `${name} converted output exceeded Station's local safety limit. Convert it to JPEG and choose it again.`;
    case 'invalid-output':
      return `${name} did not produce a valid JPEG. Convert it to JPEG and choose it again.`;
    default:
      return `${name} is not a supported single-image HEIF photo. Convert it to JPEG and choose it again.`;
  }
}

/** The only dynamic boundary from normal attachment intake into HEIF work. */
export async function prepareHeifAttachment(
  file: File,
  name: string,
  aggregateSourceBytes: number,
  options?: { magicSaysBmff?: boolean },
): Promise<HeifPreparation> {
  if (!options?.magicSaysBmff && !isHeifCandidate(file))
    return { kind: 'not-heif' };
  if (file.size > HEIF_MAX_SOURCE_BYTES)
    return { kind: 'rejected', error: refusal(name, 'source-too-large') };
  if (aggregateSourceBytes + file.size > HEIF_MAX_AGGREGATE_SOURCE_BYTES) {
    return {
      kind: 'rejected',
      error:
        'HEIF photos selected together must be 50 MB or smaller before local conversion.',
    };
  }
  const normalized = await normalizeHeifFile(file, undefined, {
    acceptMagic: options?.magicSaysBmff,
  });
  if (!normalized.ok)
    return { kind: 'rejected', error: refusal(name, normalized.reason) };
  return {
    kind: 'ready',
    file: normalized.file,
    receipt: normalized.receipt,
    sourceBytes: file.size,
  };
}
