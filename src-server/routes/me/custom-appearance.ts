/**
 * `/api/me/appearance`: the calling person's own custom appearance
 * (docs/decisions/custom-appearance.md).
 *
 * Like every `/api/me` family, the owner is the request's own principal; no
 * path or body names one, so nobody can read or write another person's
 * appearance. Agents may read and PROPOSE. Keeping, saving, turning off,
 * dismissing and reporting a preview are the person's own steps and refuse
 * any request that may be an agent's, as the Personal Board routes do.
 */
import { CUSTOM_APPEARANCE_THEME_PACK_MAX_BYTES } from '@kontourai/station-contracts/custom-appearance';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { connectedAccountOwnerId } from '../../services/identity/connected-account-owner.js';
import {
  CustomAppearanceConflictError,
  CustomAppearanceGrantExpiredError,
  CustomAppearanceLibraryFullError,
  type CustomAppearanceStore,
  CustomAppearanceStudioDisabledError,
  CustomAppearanceThemeNotFoundError,
  CustomAppearanceTooLargeError,
  InvalidCustomAppearanceError,
  StaleRenderReportError,
} from '../../services/identity/custom-appearance.js';
import { errorMessage } from '../schemas/schemas.js';
import type { PersonalLayoutPrincipalContext } from './personal-layouts.js';

/** Two 50,000-character sheets fit; anything larger is refused before parsing. */
const MAX_BODY_BYTES = 160 * 1024;

const revision = z.string().min(1).max(128);
const proposalBody = z.object({ revision, appearance: z.unknown() }).strict();
const saveBody = z.object({ revision, appearance: z.unknown() }).strict();
const keepBody = z
  .object({ revision, proposalId: z.string().min(1).max(128) })
  .strict();
const dismissBody = z.object({ revision }).strict();
const librarySaveBody = z
  .object({
    revision,
    id: z.string().min(1).max(128).optional(),
    appearance: z.unknown(),
    name: z.string().max(80).optional(),
    favorite: z.boolean().optional(),
  })
  .strict();
const libraryUpdateBody = z
  .object({
    revision,
    id: z.string().min(1).max(128),
    name: z.string().max(80).optional(),
    favorite: z.boolean().optional(),
  })
  .strict();
const libraryRemoveBody = z
  .object({ revision, id: z.string().min(1).max(128) })
  .strict();
const text = (max: number) => z.string().max(max);
const reportBody = z
  .object({
    proposalId: z.string().min(1).max(128),
    mode: z.enum(['dark', 'light']),
    hooks: z
      .array(
        z
          .object({
            id: text(64),
            selector: text(200),
            matched: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .max(64),
    contrast: z
      .array(
        z
          .object({
            mode: z.enum(['dark', 'light']),
            foreground: text(64),
            surface: text(64),
            ratio: z.number().min(0).max(21),
            minimum: z.number().min(0).max(21),
            pass: z.boolean(),
          })
          .strict(),
      )
      .max(128),
    stripped: z
      .array(
        z
          .object({
            where: text(120),
            what: text(120),
            reason: z.enum([
              'too-long',
              'escape',
              'import',
              'remote-url',
              'image-function',
              'font-face',
              'at-rule',
            ]),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

const PERSON_ONLY: Record<string, string> = {
  save: 'Save your appearance in Station.',
  keep: 'Keep this proposal in Station after previewing it.',
  dismiss: 'Dismiss this proposal in Station.',
  library: 'Manage your saved themes in Station.',
  report: 'Only the person previewing a proposal reports how it rendered.',
};

export function createCustomAppearanceRoutes(deps: {
  store: CustomAppearanceStore;
  resolvePrincipal(c: PersonalLayoutPrincipalContext): PrincipalRef;
  resolveDelegatedAppearanceOwner?(request: Request): string | undefined;
  tenantId(request: Request): string | undefined;
  studioEnabled?: () => boolean;
  resolveProposalSourceSessionId?: (
    c: PersonalLayoutPrincipalContext,
  ) => string | undefined;
}) {
  const app = new Hono();
  const studioEnabled = () => deps.studioEnabled?.() === true;
  const disabled = () => ({
    success: false,
    code: 'feature_preview_disabled',
    previewId: 'appearance-studio',
    settingsPath: '/settings/advanced',
    error: 'Enable Appearance Studio in Feature Previews to use this feature.',
  });
  const handle =
    <T>(
      schema: z.ZodType<T> | null,
      run: (
        owner: { principalId: string; tenantId?: string },
        body: T,
        c: Context,
        delegatedGrantCurrent?: () => boolean,
      ) => unknown,
      personOnly?: keyof typeof PERSON_ONLY,
      studioOnly = false,
      allowDelegatedAppearance = false,
    ) =>
    async (c: Context): Promise<Response> => {
      c.header('Cache-Control', 'no-store');
      if (studioOnly && !studioEnabled()) return c.json(disabled(), 404);
      const delegatedOwner = allowDelegatedAppearance
        ? deps.resolveDelegatedAppearanceOwner?.(c.req.raw)
        : undefined;
      let principalId: string | undefined;
      try {
        principalId =
          delegatedOwner ?? connectedAccountOwnerId(deps.resolvePrincipal(c));
      } catch {
        principalId = undefined;
      }
      if (!principalId)
        return c.json(
          {
            success: false,
            error: 'Custom appearance belongs to a signed-in person.',
            code: 'custom_appearance_identity_required',
          },
          403,
        );
      if (personOnly && requestMayBeAnAgent(c.req.raw))
        return c.json(
          {
            success: false,
            error: PERSON_ONLY[personOnly],
            code: 'custom_appearance_person_only',
          },
          403,
        );
      let body: T = undefined as T;
      if (schema) {
        const read = await readBoundedRequestBody(
          c.req.raw,
          studioEnabled()
            ? CUSTOM_APPEARANCE_THEME_PACK_MAX_BYTES
            : MAX_BODY_BYTES,
        );
        if (read.status === 'too-large')
          return c.json(
            {
              success: false,
              error: 'This appearance is too large.',
              code: 'custom_appearance_too_large',
            },
            413,
          );
        let json: unknown;
        try {
          json = read.status === 'ok' ? JSON.parse(read.body) : undefined;
        } catch {
          json = undefined;
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success)
          return c.json(
            {
              success: false,
              error: 'This request is not a valid appearance request.',
              code: 'invalid_custom_appearance',
            },
            400,
          );
        body = parsed.data;
      }
      const owner = { principalId, tenantId: deps.tenantId(c.req.raw) };
      try {
        const grantCurrent = delegatedOwner
          ? () =>
              deps.resolveDelegatedAppearanceOwner?.(c.req.raw) ===
              delegatedOwner
          : undefined;
        if (grantCurrent && !grantCurrent())
          throw new CustomAppearanceGrantExpiredError();
        return c.json({
          success: true,
          data: await run(owner, body, c, grantCurrent),
        });
      } catch (error) {
        if (error instanceof CustomAppearanceGrantExpiredError)
          return c.json(
            {
              success: false,
              code: 'custom_appearance_identity_required',
              error: 'The delegated appearance proposal grant expired.',
            },
            403,
          );
        if (error instanceof CustomAppearanceStudioDisabledError)
          return c.json(disabled(), 404);
        if (error instanceof CustomAppearanceLibraryFullError)
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              code: 'custom_appearance_library_full',
            },
            413,
          );
        if (error instanceof CustomAppearanceThemeNotFoundError)
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              code: 'custom_appearance_theme_not_found',
            },
            404,
          );
        if (error instanceof InvalidCustomAppearanceError)
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              code: 'invalid_custom_appearance',
              violations: error.violations,
            },
            400,
          );
        if (error instanceof CustomAppearanceConflictError)
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              code: 'custom_appearance_changed',
            },
            409,
          );
        if (error instanceof CustomAppearanceTooLargeError)
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              code: 'custom_appearance_store_full',
            },
            413,
          );
        if (error instanceof StaleRenderReportError)
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              code: 'custom_appearance_changed',
            },
            409,
          );
        throw error;
      }
    };

  app.get(
    '/appearance',
    handle(null, (owner) => deps.store.read(owner), undefined, false, true),
  );
  app.put(
    '/appearance',
    handle(
      saveBody,
      (owner, body) =>
        deps.store.save(owner, body.revision, body.appearance, studioEnabled),
      'save',
    ),
  );
  app.post(
    '/appearance/proposal',
    handle(
      proposalBody,
      (owner, body, c, grantCurrent) =>
        deps.store.propose(
          owner,
          body.revision,
          body.appearance,
          deps.resolveProposalSourceSessionId?.(c),
          studioEnabled,
          grantCurrent,
        ),
      undefined,
      false,
      true,
    ),
  );
  app.post(
    '/appearance/proposal/keep',
    handle(
      keepBody,
      (owner, body) =>
        deps.store.keep(owner, body.revision, body.proposalId, studioEnabled),
      'keep',
    ),
  );
  app.delete(
    '/appearance/proposal',
    handle(
      dismissBody,
      (owner, body) => deps.store.dismiss(owner, body.revision),
      'dismiss',
    ),
  );
  app.post(
    '/appearance/proposal/report',
    handle(
      reportBody,
      (owner, body) => deps.store.report(owner, { ...body, reportedAt: '' }),
      'report',
    ),
  );
  app.get(
    '/appearance/library',
    handle(null, (owner) => deps.store.readLibrary(owner), 'library', true),
  );
  app.post(
    '/appearance/library',
    handle(
      librarySaveBody,
      (owner, body) => deps.store.saveLibraryTheme(owner, body, studioEnabled),
      'library',
      true,
    ),
  );
  app.patch(
    '/appearance/library',
    handle(
      libraryUpdateBody,
      (owner, body) =>
        deps.store.updateLibraryTheme(owner, body, studioEnabled),
      'library',
      true,
    ),
  );
  app.delete(
    '/appearance/library',
    handle(
      libraryRemoveBody,
      (owner, body) =>
        deps.store.removeLibraryTheme(
          owner,
          body.revision,
          body.id,
          studioEnabled,
        ),
      'library',
      true,
    ),
  );
  return app;
}
