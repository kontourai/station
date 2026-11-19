import type { FlowGateDiagnosticDetails } from '@kontourai/station-contracts/runtime-events';

const MAX_CLAIMS = 32;
const MAX_GAPS = 32;
const MAX_TEXT = 512;

export function boundFlowDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .slice(0, MAX_TEXT)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .trim();
  return text ? `${text}${value.length > MAX_TEXT ? '…' : ''}` : undefined;
}

/** Allowlist the display facts from Flow's public diagnostics container. */
export function projectFlowGateDiagnostics(
  value: unknown,
): FlowGateDiagnosticDetails | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('claim_evaluation' in value) ||
    !Array.isArray(value.claim_evaluation)
  )
    return undefined;

  let remaining = MAX_GAPS;
  let truncated =
    value.claim_evaluation.length > MAX_CLAIMS ||
    ('surface_gaps_truncated' in value &&
      value.surface_gaps_truncated === true);
  const claims: FlowGateDiagnosticDetails['claims'] = [];
  for (const item of value.claim_evaluation.slice(0, MAX_CLAIMS)) {
    if (!item || typeof item !== 'object') continue;
    const expectationId = boundFlowDiagnosticText(item.expectation_id);
    const reason = boundFlowDiagnosticText(item.reason);
    const specificReason = boundFlowDiagnosticText(item.specific_reason);
    const surfaceGaps: NonNullable<
      FlowGateDiagnosticDetails['claims'][number]['surfaceGaps']
    > = [];
    if (Array.isArray(item.surface_gaps)) {
      truncated ||=
        item.surface_gaps.length > remaining ||
        item.surface_gaps_truncated === true;
      for (const gap of item.surface_gaps.slice(0, remaining)) {
        if (!gap || typeof gap !== 'object') continue;
        const type = boundFlowDiagnosticText(gap.type);
        const message = boundFlowDiagnosticText(gap.message);
        if (type || message) surfaceGaps.push({ type, message });
      }
      remaining -= surfaceGaps.length;
    }
    if (reason || specificReason || surfaceGaps.length)
      claims.push({
        expectationId,
        reason,
        specificReason,
        ...(surfaceGaps.length ? { surfaceGaps } : {}),
      });
  }
  if (!claims.length && !truncated) return undefined;
  return { claims, ...(truncated ? { truncated: true } : {}) };
}
