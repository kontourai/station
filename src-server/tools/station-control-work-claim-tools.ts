/**
 * station#3413 part B: `claim_work`, `renew_claim` and `release_claim`, by
 * which an agent says what it has taken in its Project so peers don't
 * duplicate it. A claim is information, not a lock.
 *
 * Thin over their routes (`routes/orchestration/session-work-claims.ts`),
 * which take the claimant from the verified caller. The schemas are STRICT and
 * name no Session, owner or Project, and a bound is a refusal here as at the
 * route, never a truncation.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import { z } from 'zod';

import {
  WORK_CLAIM_DEFAULT_TTL_SECONDS,
  WORK_CLAIM_MAX_PATHS,
  WORK_CLAIM_MAX_TTL_SECONDS,
  WORK_CLAIM_MIN_TTL_SECONDS,
  WORK_CLAIM_NOTE_MAX_CHARS,
  WORK_CLAIM_PATH_MAX_CHARS,
  WORK_CLAIM_WORK_ITEM_REF_MAX_CHARS,
} from '../routes/orchestration/work-claim-limits.js';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const CLAIMS_API = '/api/orchestration/work-claims';

const ttlSeconds = z
  .number()
  .int()
  .min(WORK_CLAIM_MIN_TTL_SECONDS)
  .max(WORK_CLAIM_MAX_TTL_SECONDS)
  .optional()
  .describe(
    `How long the claim lasts from now, in seconds: ${WORK_CLAIM_MIN_TTL_SECONDS} to ${WORK_CLAIM_MAX_TTL_SECONDS} (default ${WORK_CLAIM_DEFAULT_TTL_SECONDS})`,
  );

const note = z.string().min(1).max(WORK_CLAIM_NOTE_MAX_CHARS).optional();

const claimId = z
  .string()
  .min(1)
  .max(200)
  .describe('The claimId claim_work returned');

const claimWorkInputSchema = z
  .object({
    workItemRef: z
      .string()
      .min(1)
      .max(WORK_CLAIM_WORK_ITEM_REF_MAX_CHARS)
      .optional()
      .describe(
        'The work item you are on: an issue reference such as owner/repo#123 or #123, or a Task id',
      ),
    paths: z
      .array(z.string().min(1).max(WORK_CLAIM_PATH_MAX_CHARS))
      .max(WORK_CLAIM_MAX_PATHS)
      .optional()
      .describe(
        `Files or folders you are changing, as hints for peers (at most ${WORK_CLAIM_MAX_PATHS})`,
      ),
    note: note.describe('One line on what you are doing'),
    ttlSeconds,
  })
  .strict();

const renewClaimInputSchema = z.object({ claimId, ttlSeconds }).strict();

const releaseClaimInputSchema = z
  .object({
    claimId,
    note: note.describe('One line for whoever picks this up next'),
  })
  .strict();

const CLAIM_WORK_DESCRIPTION = [
  'Say what you are working on in your Project (or the global space, if your Session has no Project), so other Sessions see it in list_project_activity and in the Station UI and do not duplicate it.',
  'Name a work item (workItemRef), paths, or both, with an optional one-line note. The claim is yours: your own Session is the claimant, and you cannot claim for another.',
  `It is information, not a lock: anyone may still work on it, and others may claim the same item. It expires after ttlSeconds (default ${WORK_CLAIM_DEFAULT_TTL_SECONDS}) unless you renew it, and it stops showing once your Session ends.`,
  'Claiming a work item you already hold renews that claim and replaces its note and paths.',
  'Returns the claim with its claimId, for renew_claim and release_claim.',
].join(' ');

const RENEW_CLAIM_DESCRIPTION = [
  'Extend one of your own claims: it now expires ttlSeconds from now.',
  'A claim that was released or has already expired is refused; claim the work again instead. Another Session’s claim reads as not found.',
].join(' ');

const RELEASE_CLAIM_DESCRIPTION = [
  'Release one of your own claims when you finish or stop, with an optional note for whoever picks the work up.',
  'Another Session’s claim reads as not found.',
].join(' ');

export function registerWorkClaimTools(registry: StationControlToolRegistry) {
  registry.toolWithSchema(
    'claim_work',
    CLAIM_WORK_DESCRIPTION,
    claimWorkInputSchema,
    async (input) =>
      jsonToolResult(
        await api(CLAIMS_API, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      ),
  );

  registry.toolWithSchema(
    'renew_claim',
    RENEW_CLAIM_DESCRIPTION,
    renewClaimInputSchema,
    async ({ claimId, ...body }) =>
      jsonToolResult(
        await api(`${CLAIMS_API}/${encodeURIComponent(claimId)}/renew`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
  );

  registry.toolWithSchema(
    'release_claim',
    RELEASE_CLAIM_DESCRIPTION,
    releaseClaimInputSchema,
    async ({ claimId, ...body }) =>
      jsonToolResult(
        await api(`${CLAIMS_API}/${encodeURIComponent(claimId)}/release`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
  );
}
