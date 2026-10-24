import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type {
  UsageExportPage,
  UsageExportRequest,
  UsageExportScope,
} from '@kontourai/station-contracts/usage-export';
import { Hono } from 'hono';
import { UsageExportRejected } from '../../analytics/usage-export-reader.js';
import {
  AuthorityObservationRejected,
  guardAuthorityObservationResponse,
} from '../../services/identity/authority-observation.js';

/** Alternate credential owner for ONE exact read leaf; it grants no general API identity. */
export function createSourceGrantExportRoutes(deps: {
  authorize(
    request: Request,
    approvalId: string,
    credential: string,
    proof: unknown,
  ): Promise<{
    authority: SessionReadAuthority;
    scope: UsageExportScope;
    revision: number;
    authorizationContext: string;
    assertCurrent(): Promise<void>;
  }>;
  read(
    authority: SessionReadAuthority,
    request: UsageExportRequest,
    authorizationContext: string,
  ): { page: UsageExportPage; assertCurrent(): void };
}) {
  const app = new Hono();
  app.get('/:approvalId', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const credential = c.req
        .header('authorization')
        ?.match(/^Bearer (stax_[A-Za-z0-9_-]{43})$/)?.[1];
      const encoded = c.req.header('x-station-analytics-proof');
      if (
        !credential ||
        !encoded ||
        encoded.length > 4096 ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)
      )
        throw new AuthorityObservationRejected(403, 'authentication_required');
      let proof: unknown;
      try {
        proof = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      } catch {
        throw new AuthorityObservationRejected(403, 'authentication_required');
      }
      const query = new URL(c.req.url).searchParams;
      if (
        [...query.keys()].some(
          (key) =>
            !['from', 'to', 'pageSize', 'cursor'].includes(key) ||
            query.getAll(key).length !== 1,
        )
      )
        throw new UsageExportRejected('invalid_usage_export', 400);
      const grant = await deps.authorize(
        c.req.raw,
        c.req.param('approvalId'),
        credential,
        proof,
      );
      if (c.req.method === 'HEAD') {
        if (query.size !== 0)
          throw new UsageExportRejected('invalid_usage_export', 400);
        return guardAuthorityObservationResponse(
          c.body(null, 204),
          grant.assertCurrent,
        );
      }
      const selected = deps.read(
        grant.authority,
        {
          from: query.get('from') ?? '',
          to: query.get('to') ?? '',
          scope: grant.scope,
          ...(query.has('pageSize')
            ? { pageSize: Number(query.get('pageSize')) }
            : {}),
          ...(query.has('cursor') ? { cursor: query.get('cursor') ?? '' } : {}),
        },
        grant.authorizationContext,
      );
      const assertCurrent = async () => {
        await grant.assertCurrent();
        selected.assertCurrent();
      };
      return guardAuthorityObservationResponse(
        c.json({
          success: true,
          data: selected.page,
          grant: {
            sourceApprovalId: c.req.param('approvalId'),
            revision: grant.revision,
            scope: grant.scope,
          },
        }),
        assertCurrent,
      );
    } catch (error) {
      if (
        error instanceof AuthorityObservationRejected ||
        error instanceof UsageExportRejected
      )
        return c.json({ error: { code: error.code } }, error.status);
      return c.json(
        { error: { code: 'source_grant_export_unavailable' } },
        503,
      );
    }
  });
  return app;
}
