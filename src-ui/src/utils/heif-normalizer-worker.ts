/*
* A local, dependency-free best-effort adapter.  It deliberately relies only
 * on the browser/host's own decoder: importing a codec here would change the
* distribution and CSP review boundary.  A host that cannot decode HEIF says
 * so; it never sends the source to Station for conversion.
 */
type DecodeRequest = {
  id: string;
  file: File;
  width: number;
  height: number;
};

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function jpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

type WorkerScope = {
  onmessage:
    | ((event: MessageEvent<DecodeRequest>) => void | Promise<void>)
    | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, file, width, height } = event.data;
  if (
    typeof createImageBitmap !== 'function' ||
    typeof OffscreenCanvas !== 'function'
  ) {
    workerScope.postMessage({ id, ok: false, code: 'decoder-unavailable' });
    return;
  }
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width !== width || bitmap.height !== height) {
      workerScope.postMessage({ id, ok: false, code: 'decoder-failed' });
      return;
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      workerScope.postMessage({ id, ok: false, code: 'decoder-unavailable' });
      return;
    }
// JPEG has no alpha. A deterministic white matte is safer than silently
// accepting the browser's implementation-specific transparent result.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const output = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: 0.85,
    });
    if (output.size > MAX_OUTPUT_BYTES) {
      workerScope.postMessage({ id, ok: false, code: 'output-too-large' });
      return;
    }
    const bytes = new Uint8Array(await output.arrayBuffer());
    if (output.type !== 'image/jpeg' || !jpeg(bytes)) {
      workerScope.postMessage({ id, ok: false, code: 'invalid-output' });
      return;
    }
    workerScope.postMessage({ id, ok: true, bytes: bytes.buffer }, [
      bytes.buffer,
    ]);
  } catch {
    workerScope.postMessage({ id, ok: false, code: 'decoder-unavailable' });
  } finally {
    bitmap?.close();
  }
};
