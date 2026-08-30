import {
  ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS,
  ATTACHMENT_STAGING_PROTOCOL_VERSION,
  type AttachmentStagingCapability,
} from '@kontourai/station-contracts/attachment-staging';
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH,
} from '@kontourai/station-contracts/chat-attachment';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  type AttachmentStageDescriptor,
  AttachmentStageError,
  type AttachmentStageOwner,
  type AttachmentStagingService,
} from '../../services/orchestration/attachment-staging-service.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const descriptorSchema = z.object({
  clientAttachmentId: z.string().min(1).max(128),
  kind: z.enum(['image', 'file']),
  name: z.string().max(160),
  mimeType: z.enum([
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/json',
    'application/pdf',
    'text/csv',
    'text/markdown',
    'text/plain',
  ]),
  size: z.number().int(),
});

const reconcileSchema = z.object({
  stageIds: z.array(z.string().min(1).max(128)).max(CHAT_ATTACHMENT_MAX_COUNT),
});

export interface AttachmentStagingRouteDeps {
  service: AttachmentStagingService;
  /** Auth identity only; no tenant path or grant reaches the route Interface. */
  currentOwner: (context: {
    env: unknown;
    req: { raw: Request; header(name: string): string | undefined };
  }) => AttachmentStageOwner;
}

/**
 * Current-host attachment staging routes. The capability leaf is intentionally
 * separate from prepare/upload: an absent old host is a known legacy handshake;
 * a malformed capability response is unknown and the client must block.
 */
export function createAttachmentStagingRoutes(
  deps: AttachmentStagingRouteDeps,
) {
  const app = new Hono();
  const capability: AttachmentStagingCapability = {
    state: 'supported',
    version: ATTACHMENT_STAGING_PROTOCOL_VERSION,
    maxConcurrentUploads: ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS,
  };

  app.get('/capability', (c) => c.json(capability));
  app.post('/prepare', validate(descriptorSchema), (c) => {
    try {
      return c.json(
        deps.service.prepare(
          deps.currentOwner(c),
          getBody(c) as AttachmentStageDescriptor,
        ),
      );
    } catch (error) {
      return stageError(c, error);
    }
  });
  app.put('/:stageId', async (c) => {
    try {
      if (new URL(c.req.raw.url).search) {
        return c.json(
          { error: 'Attachment upload authority is invalid.' },
          403,
        );
      }
      const grant = bearerGrant(c.req.raw.headers.get('authorization'));
      if (!grant || !isUtf8PlainText(c.req.raw.headers.get('content-type'))) {
        return c.json(
          { error: 'Attachment upload authority is invalid.' },
          403,
        );
      }
      const dataUrl = await readBoundedRawText(
        c.req.raw,
        CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH,
      );
      if (dataUrl === undefined) {
        return c.json(
          { error: 'Attachment staging rejected this upload.' },
          400,
        );
      }
      return c.json(deps.service.upload(param(c, 'stageId'), grant, dataUrl));
    } catch (error) {
      return stageError(c, error);
    }
  });
  app.post('/reconcile', validate(reconcileSchema), (c) => {
    const body = getBody(c);
    return c.json(deps.service.reconcile(deps.currentOwner(c), body.stageIds));
  });
  app.delete('/:stageId', (c) => {
    try {
      deps.service.cancel(deps.currentOwner(c), param(c, 'stageId'));
      return c.body(null, 204);
    } catch (error) {
      return stageError(c, error);
    }
  });
  return app;
}

function isUtf8PlainText(value: string | null): boolean {
  return /^text\/plain\s*;\s*charset\s*=\s*utf-8$/iu.test(value ?? '');
}

function bearerGrant(value: string | null): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(value ?? '');
  return match?.[1];
}

async function readBoundedRawText(
  request: Request,
  maxBytes: number,
): Promise<string | undefined> {
  const declaredLength = request.headers.get('content-length');
  if (!declaredLength || !/^\d+$/u.test(declaredLength)) return undefined;
  const expectedLength = Number(declaredLength);
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 1 ||
    expectedLength > maxBytes
  ) {
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  if (total === 0 || total !== expectedLength) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function stageError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response },
  error: unknown,
): Response {
  if (!(error instanceof AttachmentStageError)) {
    return c.json({ error: 'Attachment staging is unavailable.' }, 400);
  }
  const status =
    error.code === 'stage_forbidden' || error.code === 'stage_grant_invalid'
      ? 403
      : error.code === 'stage_not_found'
        ? 404
        : error.code === 'stage_expired' ||
            error.code === 'stage_cancelled' ||
            error.code === 'stage_incomplete' ||
            error.code === 'stage_capacity'
          ? 409
          : 400;
  return c.json(
    { error: stageErrorMessage(error.code), code: error.code },
    status,
  );
}

function stageErrorMessage(code: AttachmentStageError['code']): string {
  switch (code) {
    case 'stage_grant_invalid':
    case 'stage_forbidden':
      return 'Attachment staging is unavailable.';
    case 'stage_expired':
      return 'Attachment staging expired. Select the file again to retry.';
    case 'stage_cancelled':
      return 'Attachment staging was cancelled.';
    case 'stage_incomplete':
      return 'Attachment staging is not complete.';
    case 'stage_invalid_upload':
      return 'Attachment staging rejected this upload.';
    case 'stage_capacity':
      return 'Attachment staging capacity is full. Remove or send another attachment first.';
    case 'stage_not_found':
      return 'Attachment staging is unavailable.';
  }
}
