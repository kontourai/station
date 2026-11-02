import { DEVICE_ARTIFACT_UPLOAD_MAX_BYTES } from '@kontourai/station-contracts/device-tools';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import {
  DeviceArtifactError,
  type DeviceArtifactStaging,
} from '../services/devices/device-app-artifacts.js';

const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
type Project = { id: string; root: string | null };

/** Project-bound intake. A receipt is staging, not proof of installability. */
export function createDeviceArtifactRoutes(deps: {
  staging: DeviceArtifactStaging;
  enabled(): boolean;
  current(request: Request): boolean;
  human(c: Context): boolean;
  project(slug: string): Project | undefined;
  authorize(request: Request, projectId: string): Promise<boolean>;
}) {
  const app = new Hono();
  const shutdown = new AbortController();
  const receiving = new Map<string, Promise<void>>();
  app.post('/projects/:slug/device-artifacts/:source', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.enabled() || shutdown.signal.aborted)
      return c.json({ success: false, code: 'feature_preview_disabled' }, 404);
    const slug = c.req.param('slug');
    const source = c.req.param('source');
    if (
      !PROJECT_SLUG.test(slug) ||
      (source !== 'workspace' && source !== 'upload')
    )
      return c.json({ success: false, code: 'invalid-source' }, 400);
    const project = deps.project(slug);
    if (!project || !deps.current(c.req.raw) || !deps.human(c))
      return c.json({ success: false, code: 'not-authorized' }, 403);
    const authorize = async () => {
      const now = deps.project(slug);
      if (
        !deps.enabled() ||
        shutdown.signal.aborted ||
        !deps.current(c.req.raw) ||
        !deps.human(c) ||
        now?.id !== project.id ||
        (source === 'workspace' && now.root !== project.root)
      )
        return false;
      const allowed = await deps.authorize(c.req.raw, project.id);
      const after = deps.project(slug);
      return (
        allowed &&
        deps.enabled() &&
        !shutdown.signal.aborted &&
        deps.current(c.req.raw) &&
        deps.human(c) &&
        after?.id === project.id &&
        (source !== 'workspace' || after.root === project.root)
      );
    };
    if (!(await authorize()))
      return c.json({ success: false, code: 'not-authorized' }, 403);
    try {
      if (source === 'workspace') {
        if (Object.keys(c.req.queries()).length !== 0)
          return c.json({ success: false, code: 'invalid-source' }, 400);
        if (!project.root)
          return c.json({ success: false, code: 'invalid-source' }, 400);
        const body = await readBoundedRequestBody(c.req.raw, 4096);
        let value: unknown;
        try {
          value = body.status === 'ok' ? JSON.parse(body.body) : null;
        } catch {
          value = null;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return c.json({ success: false, code: 'invalid-source' }, 400);
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).length !== 2 ||
          typeof record.relativePath !== 'string' ||
          (record.platform !== 'ios' && record.platform !== 'android')
        )
          return c.json({ success: false, code: 'invalid-source' }, 400);
        const receipt = await deps.staging.stageWorkspace(
          project.id,
          project.root,
          record.relativePath,
          record.platform,
          authorize,
          AbortSignal.any([c.req.raw.signal, shutdown.signal]),
        );
        return c.json({ success: true, data: receipt }, 201);
      }
      const query = c.req.queries();
      const platform = c.req.query('platform');
      if (
        Object.keys(query).length !== 1 ||
        query.platform?.length !== 1 ||
        (platform !== 'ios' && platform !== 'android')
      )
        return c.json({ success: false, code: 'invalid-source' }, 400);
      if (receiving.has(project.id))
        return c.json({ success: false, code: 'artifact-capacity' }, 503);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      receiving.set(project.id, done);
      let bytes: Buffer | undefined;
      try {
        bytes = await readUpload(
          c.req.raw,
          AbortSignal.any([
            c.req.raw.signal,
            shutdown.signal,
            AbortSignal.timeout(10 * 60_000),
          ]),
        );
        const receipt = await deps.staging.stageUpload(
          project.id,
          bytes,
          platform,
          authorize,
          AbortSignal.any([c.req.raw.signal, shutdown.signal]),
        );
        return c.json({ success: true, data: receipt }, 201);
      } finally {
        receiving.delete(project.id);
        finish();
      }
    } catch (error) {
      if (error instanceof DeviceArtifactError) {
        const status =
          error.code === 'not-authorized'
            ? 403
            : error.code === 'artifact-capacity' ||
                error.code === 'workspace-snapshot-unavailable'
              ? 503
              : 400;
        return c.json({ success: false, code: error.code }, status);
      }
      return c.json({ success: false, code: 'invalid-source' }, 400);
    }
  });
  return Object.assign(app, {
    async dispose() {
      shutdown.abort();
      await Promise.all(receiving.values());
      await deps.staging.dispose();
    },
  });
}

async function readUpload(
  request: Request,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) ||
      Number(declared) > DEVICE_ARTIFACT_UPLOAD_MAX_BYTES)
  )
    throw new DeviceArtifactError('invalid-artifact');
  if (!request.body || signal.aborted)
    throw new DeviceArtifactError('cancelled');
  const capacity =
    declared === null ? DEVICE_ARTIFACT_UPLOAD_MAX_BYTES : Number(declared);
  let buffer = Buffer.allocUnsafe(Math.min(capacity, 64 * 1024));
  const reader = request.body.getReader();
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw new DeviceArtifactError('cancelled');
      if (part.done) break;
      if (part.value.byteLength > capacity - total)
        throw new DeviceArtifactError('invalid-artifact');
      const needed = total + part.value.byteLength;
      if (needed > buffer.length) {
        const next = Buffer.allocUnsafe(
          Math.min(capacity, Math.max(needed, buffer.length * 2)),
        );
        buffer.copy(next, 0, 0, total);
        buffer.fill(0, 0, total);
        buffer = next;
      }
      buffer.set(part.value, total);
      total = needed;
    }
    if (!total || (declared !== null && total !== capacity))
      throw new DeviceArtifactError('invalid-artifact');
    return buffer.subarray(0, total);
  } catch (error) {
    buffer.fill(0, 0, total);
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
