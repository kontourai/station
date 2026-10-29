import { workClaimSubjectDetail } from '@kontourai/station-contracts/work-claims';
import {
  listWorkClaims,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { getResolvedApiBase, type ParsedCoreArgs } from './core-api.js';
import { explainRequestFailure } from './errors.js';
import { terminalSafeText } from './terminal-safe.js';

/**
 * #3427: `station claims list` — the work claims of the Sessions you may
 * read, over the person's read the Station UI's chips use
 * (`GET /api/orchestration/work-claims`, SDK `listWorkClaims`). Agents read
 * the same claims through Station Control's `list_project_activity`.
 *
 * Only `list` exists. A claim's claimant is a Session today (the verified
 * Station Control caller), so a person has no claim of their own to make,
 * release or supersede until the claim store records a person claimant.
 *
 * Exit codes follow `station delegate`: 0 success, 1 usage error, 2 Station
 * unreachable, 3 the Station refused or cannot answer the read.
 */
export async function runClaimsCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const verb = parsed.positionals[0];
  if (verb !== 'list')
    throw new Error(
      `Unknown claims subcommand "${verb ?? ''}" (expected: list)`,
    );
  const jsonMode = parsed.flags.json === true;
  let claims: Awaited<ReturnType<typeof listWorkClaims>>;
  try {
    claims = await listWorkClaims(apiBase);
  } catch (error) {
    const transport = explainRequestFailure(error, getResolvedApiBase());
    const message =
      transport ??
      (error instanceof StationHttpError && error.status === 404
        ? 'This Station does not answer work claims. Update it to a version that does.'
        : error instanceof Error
          ? error.message
          : String(error));
    console.error('Error:', terminalSafeText(message));
    process.exit(transport ? 2 : 3);
    return;
  }
  if (jsonMode) {
    console.log(
      JSON.stringify({ ok: true, kind: 'claims.list', data: { claims } }),
    );
    return;
  }
  if (claims.length === 0) {
    console.log('No active claims in the Sessions you can read.');
    return;
  }
  const lines: string[] = [];
  for (const claim of claims) {
    // Every field is text the Station returned, so all of it is made safe.
    const scope =
      claim.scope.kind === 'project'
        ? `Project ${claim.scope.id}`
        : 'the global space';
    const where = `Session ${claim.sessionId} in ${scope}${
      claim.taskId ? `, Task ${claim.taskId}` : ''
    }; expires ${claim.expiresAt}`;
    lines.push(
      terminalSafeText(`${claim.claimId}: ${workClaimSubjectDetail(claim)}`),
      `  ${terminalSafeText(where)}`,
      ...(claim.note ? [`  ${terminalSafeText(claim.note)}`] : []),
    );
  }
  console.log(lines.join('\n'));
}
