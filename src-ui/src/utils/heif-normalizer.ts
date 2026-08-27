/**
 * Bounded, local HEIF intake.  This is intentionally an inspector plus a
 * browser-native adapter, not a bundled HEIF codec: Station does not have an
 * affirmative licence policy for the LGPL-3.0 `heic-to` distribution.
 */
export const HEIF_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const HEIF_MAX_AGGREGATE_SOURCE_BYTES = 50 * 1024 * 1024;
export const HEIF_MAX_METADATA_BYTES = 1024 * 1024;
export const HEIF_MAX_BOXES = 1024;
export const HEIF_MAX_DEPTH = 8;
export const HEIF_MAX_EDGE = 8192;
export const HEIF_MAX_PIXELS = 32 * 1024 * 1024;
export const HEIF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const HEIF_DECODE_TIMEOUT_MS = 12_000;

const HEIF_MIME = /^image\/hei(?:c|f)$/iu;
const HEIF_EXTENSION = /\.(?:heic|heif)$/iu;
const HEIF_BRANDS = new Set(['heic', 'heix']);
const DISALLOWED_BRANDS = new Set(['avif', 'avis', 'msf1', 'hevc', 'hevx']);
const TEXT = new TextDecoder('latin1');

export type HeifFailure =
  | 'not-heif'
  | 'source-too-large'
  | 'malformed'
  | 'unsupported'
  | 'decoder-unavailable'
  | 'decoder-failed'
  | 'invalid-output'
  | 'output-too-large'
  | 'timed-out'
  | 'cancelled';

export type HeifInspection = {
  width: number;
  height: number;
  primaryItemId: number;
};

export type TransformationReceipt = {
  kind: 'heif-to-jpeg';
  adapter: 'browser-native';
  source: { mimeType: string; bytes: number; sha256: string };
  output: { name: string; mimeType: string; bytes: number; sha256: string };
};

export type HeifNormalizationResult =
  | {
      ok: true;
      file: File;
      inspection: HeifInspection;
      receipt: TransformationReceipt;
    }
  | { ok: false; reason: HeifFailure };

type Box = { type: string; start: number; payload: number; end: number };

export function isHeifCandidate(file: Pick<File, 'name' | 'type'>): boolean {
  const type = file.type.trim().toLowerCase();
  return (
    HEIF_MIME.test(type) ||
    ((type === '' || type === 'application/octet-stream') &&
      HEIF_EXTENSION.test(file.name))
  );
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('HEIF conversion cancelled.', 'AbortError');
}

async function range(
  file: Blob,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  abortIfNeeded(signal);
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  abortIfNeeded(signal);
  return bytes;
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset);
}

async function header(
  file: File,
  start: number,
  scopeEnd: number,
  signal?: AbortSignal,
): Promise<Box | null> {
  if (start + 8 > scopeEnd) return null;
  const first = await range(
    file,
    start,
    Math.min(scopeEnd, start + 16),
    signal,
  );
  let size = u32(first, 0);
  let head = 8;
  if (size === 1) {
    if (first.byteLength < 16) return null;
    const wide = new DataView(
      first.buffer,
      first.byteOffset,
      first.byteLength,
    ).getBigUint64(8);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(wide);
    head = 16;
  } else if (size === 0) {
    size = scopeEnd - start;
  }
  if (size < head || size > scopeEnd - start) return null;
  return {
    type: TEXT.decode(first.subarray(4, 8)),
    start,
    payload: start + head,
    end: start + size,
  };
}

function localBox(
  bytes: Uint8Array,
  start: number,
  scopeEnd: number,
): Box | null {
  if (start + 8 > scopeEnd) return null;
  let size = u32(bytes, start);
  let head = 8;
  if (size === 1) {
    if (start + 16 > scopeEnd) return null;
    const wide = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigUint64(start + 8);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(wide);
    head = 16;
  } else if (size === 0) {
    size = scopeEnd - start;
  }
  if (size < head || size > scopeEnd - start) return null;
  return {
    type: TEXT.decode(bytes.subarray(start + 4, start + 8)),
    start,
    payload: start + head,
    end: start + size,
  };
}

function childBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
  count: { value: number },
): Box[] | null {
  if (depth > HEIF_MAX_DEPTH) return null;
  const boxes: Box[] = [];
  for (let offset = start; offset < end; ) {
    const box = localBox(bytes, offset, end);
    if (!box || ++count.value > HEIF_MAX_BOXES) return null;
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

function parseMetadata(
  bytes: Uint8Array,
  boxesBeforeMetadata: number,
): HeifInspection | null {
  // `meta` begins with a FullBox version/flags field.
  if (bytes.byteLength < 4) return null;
  // The top-level walk has already charged every box before `meta`; metadata
  // children spend from that same budget rather than gaining a second 1,024.
  const count = { value: boxesBeforeMetadata };
  const children = childBoxes(bytes, 4, bytes.byteLength, 1, count);
  if (!children) return null;
  const pitm = children.find((box) => box.type === 'pitm');
  const iinf = children.find((box) => box.type === 'iinf');
  const iprp = children.find((box) => box.type === 'iprp');
  if (!pitm || !iinf || !iprp || pitm.payload >= pitm.end) return null;
  const pitmVersion = bytes[pitm.payload];
  const primaryOffset = pitm.payload + 4;
  const primaryBytes = pitmVersion === 0 ? 2 : pitmVersion === 1 ? 4 : 0;
  if (!primaryBytes || primaryOffset + primaryBytes > pitm.end) return null;
  const primaryItemId =
    primaryBytes === 2
      ? new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getUint16(primaryOffset)
      : u32(bytes, primaryOffset);
  if (primaryItemId === 0) return null;

  if (iinf.payload + 6 > iinf.end) return null;
  const iinfVersion = bytes[iinf.payload];
  const entryCountOffset = iinf.payload + 4;
  const entryCountBytes = iinfVersion === 0 ? 2 : 4;
  if (entryCountOffset + entryCountBytes > iinf.end) return null;
  const declaredEntries =
    entryCountBytes === 2
      ? new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getUint16(entryCountOffset)
      : u32(bytes, entryCountOffset);
  if (declaredEntries !== 1) return null;
  const infos = childBoxes(
    bytes,
    entryCountOffset + entryCountBytes,
    iinf.end,
    2,
    count,
  );
  const info = infos?.[0];
  if (!info || infos.length !== 1 || info.type !== 'infe') return null;
  if (
    info.payload + 12 > info.end ||
    (bytes[info.payload] !== 2 && bytes[info.payload] !== 3)
  )
    return null;
  const infoVersion = bytes[info.payload];
  const idOffset = info.payload + 4;
  const idBytes = infoVersion === 2 ? 2 : 4;
  if (idOffset + idBytes + 6 > info.end) return null;
  const itemId =
    idBytes === 2
      ? new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getUint16(idOffset)
      : u32(bytes, idOffset);
  const itemType = TEXT.decode(
    bytes.subarray(idOffset + idBytes + 2, idOffset + idBytes + 6),
  );
  if (itemId !== primaryItemId || !['hvc1', 'hev1'].includes(itemType))
    return null;

  const iprpChildren = childBoxes(bytes, iprp.payload, iprp.end, 2, count);
  const ipco = iprpChildren?.find((box) => box.type === 'ipco');
  if (!ipco) return null;
  const properties = childBoxes(bytes, ipco.payload, ipco.end, 3, count);
  const ipma = iprpChildren?.find((box) => box.type === 'ipma');
  if (!properties || !ipma || ipma.payload + 8 > ipma.end) return null;
  const ipmaVersion = bytes[ipma.payload];
  const ipmaFlags =
    (bytes[ipma.payload + 1] << 16) |
    (bytes[ipma.payload + 2] << 8) |
    bytes[ipma.payload + 3];
  const entryCount = u32(bytes, ipma.payload + 4);
  let associationOffset = ipma.payload + 8;
  const primaryPropertyIndices: number[] = [];
  for (let entry = 0; entry < entryCount; entry += 1) {
    const itemIdBytes = ipmaVersion === 0 ? 2 : ipmaVersion === 1 ? 4 : 0;
    if (!itemIdBytes || associationOffset + itemIdBytes + 1 > ipma.end)
      return null;
    const associatedItemId =
      itemIdBytes === 2
        ? new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ).getUint16(associationOffset)
        : u32(bytes, associationOffset);
    associationOffset += itemIdBytes;
    const associations = bytes[associationOffset++];
    for (let index = 0; index < associations; index += 1) {
      const wide = (ipmaFlags & 1) !== 0;
      if (associationOffset + (wide ? 2 : 1) > ipma.end) return null;
      const raw = wide
        ? new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ).getUint16(associationOffset)
        : bytes[associationOffset];
      associationOffset += wide ? 2 : 1;
      const propertyIndex = wide ? raw & 0x7fff : raw & 0x7f;
      if (associatedItemId === primaryItemId)
        primaryPropertyIndices.push(propertyIndex);
    }
  }
  if (
    associationOffset !== ipma.end ||
    primaryPropertyIndices.some(
      (propertyIndex) =>
        propertyIndex === 0 || propertyIndex > properties.length,
    )
  )
    return null;
  const primaryDimensions = primaryPropertyIndices
    .map((propertyIndex) => properties[propertyIndex - 1])
    .filter((property) => property.type === 'ispe');
  if (primaryDimensions.length !== 1) return null;
  const ispe = primaryDimensions[0];
  if (ispe.payload + 12 > ispe.end) return null;
  const width = u32(bytes, ispe.payload + 4);
  const height = u32(bytes, ispe.payload + 8);
  if (
    !width ||
    !height ||
    width > HEIF_MAX_EDGE ||
    height > HEIF_MAX_EDGE ||
    width > Math.floor(HEIF_MAX_PIXELS / height)
  )
    return null;
  return { width, height, primaryItemId };
}

/** Checks BMFF structure without decoding or retaining the original bytes. */
export async function inspectHeifFile(
  file: File,
  signal?: AbortSignal,
  options?: { acceptMagic?: boolean },
): Promise<HeifInspection | null> {
  if (
    (!options?.acceptMagic && !isHeifCandidate(file)) ||
    file.size < 1 ||
    file.size > HEIF_MAX_SOURCE_BYTES
  )
    return null;
  let boxes = 0;
  let offset = 0;
  let ftyp: Box | undefined;
  let meta: Box | undefined;
  while (offset < file.size) {
    const box = await header(file, offset, file.size, signal);
    if (!box || ++boxes > HEIF_MAX_BOXES) return null;
    if (offset === 0 && box.type !== 'ftyp') return null;
    if (box.type === 'ftyp') {
      if (ftyp || box.end - box.payload > HEIF_MAX_METADATA_BYTES) return null;
      ftyp = box;
    }
    if (box.type === 'meta') {
      if (meta || box.end - box.payload > HEIF_MAX_METADATA_BYTES) return null;
      meta = box;
    }
    offset = box.end;
  }
  if (!ftyp || !meta) return null;
  const brandBytes = await range(file, ftyp.payload, ftyp.end, signal);
  if (brandBytes.byteLength < 8) return null;
  const brands = new Set<string>();
  for (let at = 0; at + 4 <= brandBytes.byteLength; at += 4)
    brands.add(TEXT.decode(brandBytes.subarray(at, at + 4)));
  if (
    ![...brands].some((brand) => HEIF_BRANDS.has(brand)) ||
    [...brands].some((brand) => DISALLOWED_BRANDS.has(brand))
  )
    return null;
  return parseMetadata(
    await range(file, meta.payload, meta.end, signal),
    boxes,
  );
}

function jpegMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function jpegName(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name || 'image';
  return `${stem.slice(0, 240)}.jpg`;
}

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

type DecodeResponse =
  | { id: string; ok: true; bytes: ArrayBuffer }
  | { id: string; ok: false; code: HeifFailure };
let decodeTail: Promise<void> = Promise.resolve();

export type HeifWorker = {
  onmessage: ((event: MessageEvent<DecodeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
  postMessage(message: unknown): void;
};

export type HeifNormalizerOptions = {
  acceptMagic?: boolean;
  createWorker?: () => HeifWorker;
  timeoutMs?: number;
};

function createBrowserWorker(): HeifWorker {
  if (typeof Worker !== 'function') throw new Error('decoder-unavailable');
  return new Worker(new URL('./heif-normalizer-worker.ts', import.meta.url), {
    type: 'module',
    name: 'station-heif-normalizer',
  });
}

function decodeOnce(
  file: File,
  inspection: HeifInspection,
  signal?: AbortSignal,
  options?: HeifNormalizerOptions,
): Promise<Uint8Array> {
  const previous = decodeTail;
  let release!: () => void;
  decodeTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous
    .catch(() => undefined)
    .then(async () => {
      try {
        abortIfNeeded(signal);
        const id = crypto.randomUUID();
        const worker = (options?.createWorker ?? createBrowserWorker)();
        return await new Promise<Uint8Array>((resolve, reject) => {
          let settled = false;
          const finish = (result?: Uint8Array, failure?: HeifFailure) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
            if (result) resolve(result);
            else reject(new Error(failure ?? 'decoder-failed'));
          };
          const abort = () => finish(undefined, 'cancelled');
          const timeout = setTimeout(
            () => finish(undefined, 'timed-out'),
            options?.timeoutMs ?? HEIF_DECODE_TIMEOUT_MS,
          );
          signal?.addEventListener('abort', abort, { once: true });
          worker.onerror = () => finish(undefined, 'decoder-unavailable');
          worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
            const response = event.data;
            if (!response || response.id !== id) return;
            if (!response.ok) return finish(undefined, response.code);
            const bytes = new Uint8Array(response.bytes);
            if (bytes.byteLength > HEIF_MAX_OUTPUT_BYTES || !jpegMagic(bytes))
              return finish(
                undefined,
                bytes.byteLength > HEIF_MAX_OUTPUT_BYTES
                  ? 'output-too-large'
                  : 'invalid-output',
              );
            finish(bytes);
          };
          try {
            worker.postMessage({
              id,
              file,
              width: inspection.width,
              height: inspection.height,
            });
          } catch {
            finish(undefined, 'decoder-unavailable');
          }
        });
      } finally {
        release();
      }
    });
}

/**
 * Normalizes a verified single-image HEIF file only when the local browser
 * already supplies a decoder. Nothing is uploaded unless this returns JPEG.
 */
export async function normalizeHeifFile(
  file: File,
  signal?: AbortSignal,
  options?: HeifNormalizerOptions,
): Promise<HeifNormalizationResult> {
  if (!options?.acceptMagic && !isHeifCandidate(file))
    return { ok: false, reason: 'not-heif' };
  if (file.size > HEIF_MAX_SOURCE_BYTES)
    return { ok: false, reason: 'source-too-large' };
  try {
    const inspection = await inspectHeifFile(file, signal, options);
    if (!inspection) return { ok: false, reason: 'malformed' };
    const bytes = await decodeOnce(file, inspection, signal, options);
    const ownedBytes = new Uint8Array(bytes);
    const output = new File([ownedBytes.buffer], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
    const [sourceSha256, outputSha256] = await Promise.all([
      sha256(file),
      sha256(output),
    ]);
    return {
      ok: true,
      file: output,
      inspection,
      receipt: {
        kind: 'heif-to-jpeg',
        adapter: 'browser-native',
        source: {
          mimeType: file.type || 'application/octet-stream',
          bytes: file.size,
          sha256: sourceSha256,
        },
        output: {
          name: output.name,
          mimeType: 'image/jpeg',
          bytes: output.size,
          sha256: outputSha256,
        },
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      return { ok: false, reason: 'cancelled' };
    const code = error instanceof Error ? error.message : '';
    return {
      ok: false,
      reason: new Set<HeifFailure>([
        'decoder-unavailable',
        'decoder-failed',
        'invalid-output',
        'output-too-large',
        'timed-out',
        'cancelled',
      ]).has(code as HeifFailure)
        ? (code as HeifFailure)
        : 'decoder-failed',
    };
  }
}
