import type {
  AttachmentStagingCapability,
  AttachmentStagingPreparation,
  AttachmentStagingStatus,
  StagedAttachmentReference,
} from '@kontourai/station-contracts/attachment-staging';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import {
  PUBLIC_STATION_HANDSHAKE_PATH,
  parsePublicStationHandshake,
} from '@kontourai/station-contracts/environment-security';
import { ChatHttpError } from './chatHttpError';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

const ROOT = '/api/orchestration/attachment-staging';

export interface AttachmentStageUploadProgress {
  loaded: number;
  total: number;
}

export interface AttachmentStageUploadRequest {
  url: string;
  grant: string;
  dataUrl: string;
  signal?: AbortSignal;
  onProgress?: (progress: AttachmentStageUploadProgress) => void;
}

/** Browser hosts inject this transport to expose real XMLHttpRequest progress. */
export type AttachmentStageUploadTransport = (
  request: AttachmentStageUploadRequest,
) => Promise<Response>;

export interface AttachmentStageUploadOptions extends ClientRequestOptions {
  onProgress?: (progress: AttachmentStageUploadProgress) => void;
  transport?: AttachmentStageUploadTransport;
}

/**
 * The client entry point is also typechecked from Station's Node server
 * project, which intentionally does not load the DOM lib. Keep the browser
 * adapter structurally typed here instead of leaking a DOM-only global into
 * that portable surface.
 */
interface BrowserXhr {
  abort(): void;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getAllResponseHeaders(): string;
  send(body: string): void;
  status: number;
  responseText: string;
  upload: { onprogress: ((event: BrowserXhrProgressEvent) => void) | null };
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  onload: (() => void) | null;
}

interface BrowserXhrProgressEvent {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

const browserXhr = globalThis as unknown as {
  XMLHttpRequest: new () => BrowserXhr;
};

/**
 * A small XHR adapter rather than a fake timer: upload progress is the native
 * browser signal and the caller still owns cancellation through AbortSignal.
 */
export const xhrAttachmentStageUpload: AttachmentStageUploadTransport = ({
  url,
  grant,
  dataUrl,
  signal,
  onProgress,
}) =>
  new Promise((resolve, reject) => {
    const xhr = new browserXhr.XMLHttpRequest();
    const abort = () => xhr.abort();
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', `Bearer ${grant}`);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.({ loaded: event.loaded, total: event.total });
      }
    };
    xhr.onerror = () => reject(new TypeError('Attachment upload failed.'));
    xhr.onabort = () =>
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    xhr.onload = () => {
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator > 0)
          headers.append(
            line.slice(0, separator),
            line.slice(separator + 1).trim(),
          );
      }
      resolve(new Response(xhr.responseText, { status: xhr.status, headers }));
    };
    xhr.send(dataUrl);
  });

function descriptor(
  attachment: ChatAttachmentInput & { clientAttachmentId: string },
) {
  const { dataUrl: _dataUrl, ...value } = attachment;
  return value;
}

async function read<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new ChatHttpError(
      response.status,
      typeof body.error === 'string' ? body.error : fallback,
      typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : undefined,
    );
  }
  return body as T;
}

/**
 * Only a validating public Station handshake permits old inline delivery. A
 * response header from a misrouted 404 is not an identity or capability.
 */
export async function getAttachmentStagingCapability(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<AttachmentStagingCapability> {
  const response = await getJson(`${apiBase}${ROOT}/capability`, opts);
  if (response.status === 404) {
    try {
      const handshake = await getJson(
        `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
        { authentication: 'omit', signal: opts?.signal, timeoutMs: 5000 },
      );
      if (!handshake.ok) return { state: 'unknown' };
      return parsePublicStationHandshake(await handshake.json())
        ? { state: 'legacy' }
        : { state: 'unknown' };
    } catch {
      return { state: 'unknown' };
    }
  }
  const value = await read<unknown>(
    response,
    'Attachment staging capability is unavailable.',
  );
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { state?: unknown }).state === 'supported' &&
    (value as { version?: unknown }).version === 1 &&
    (value as { maxConcurrentUploads?: unknown }).maxConcurrentUploads === 3
  ) {
    return value as AttachmentStagingCapability;
  }
  return { state: 'unknown' };
}

export async function prepareAttachmentStage(
  apiBase: string,
  attachment: ChatAttachmentInput & { clientAttachmentId: string },
  opts?: ClientRequestOptions,
): Promise<AttachmentStagingPreparation> {
  return await read<AttachmentStagingPreparation>(
    await mutateJson(
      `${apiBase}${ROOT}/prepare`,
      'POST',
      opts,
      descriptor(attachment),
    ),
    'Attachment staging could not be prepared.',
  );
}

export async function uploadAttachmentStage(
  apiBase: string,
  preparation: AttachmentStagingPreparation,
  dataUrl: string,
  opts?: AttachmentStageUploadOptions,
): Promise<StagedAttachmentReference> {
  const url = `${apiBase}${ROOT}/${encodeURIComponent(preparation.stageId)}`;
  const response = opts?.transport
    ? await opts.transport({
        url,
        grant: preparation.uploadGrant,
        dataUrl,
        signal: opts.signal,
        onProgress: opts.onProgress,
      })
    : await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${preparation.uploadGrant}`,
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: dataUrl,
        signal: opts?.signal,
      });
  return await read<StagedAttachmentReference>(
    response,
    'Attachment staging could not be uploaded.',
  );
}

export async function reconcileAttachmentStages(
  apiBase: string,
  stageIds: readonly string[],
  opts?: ClientRequestOptions,
): Promise<AttachmentStagingStatus[]> {
  return await read<AttachmentStagingStatus[]>(
    await mutateJson(`${apiBase}${ROOT}/reconcile`, 'POST', opts, { stageIds }),
    'Attachment staging could not be reconciled.',
  );
}

export async function cancelAttachmentStage(
  apiBase: string,
  stageId: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  const response = await mutateJson(
    `${apiBase}${ROOT}/${encodeURIComponent(stageId)}`,
    'DELETE',
    opts,
  );
  if (!response.ok && response.status !== 404) {
    await read(response, 'Attachment staging could not be cancelled.');
  }
}
