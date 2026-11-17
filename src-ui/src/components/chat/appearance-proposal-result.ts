import {
  appearanceProposalReferenceView,
  type CustomAppearanceProposalReference,
  parseAppearanceProposalReference,
} from '@kontourai/station-contracts/custom-appearance';
import { stationControlToolName } from '@kontourai/station-contracts/station-control-refusal';

interface AppearanceCall {
  toolName?: string;
  name?: string;
  server?: string;
  originalName?: string;
  state?: string;
  result?: unknown;
  output?: unknown;
  appearanceProposal?: unknown;
  error?: string;
  errorText?: string;
  cancelled?: boolean;
  needsApproval?: boolean;
}

function nameOf(call: AppearanceCall) {
  if (call.server && call.server !== 'station-control') return undefined;
  const name = call.server
    ? (call.originalName ?? call.toolName ?? call.name)
    : (call.toolName ?? call.name ?? call.originalName);
  return call.server === 'station-control' && !stationControlToolName(name)
    ? `station-control/${name}`
    : name;
}

export function isAppearanceProposalCall(call: AppearanceCall): boolean {
  return stationControlToolName(nameOf(call)) === 'propose_appearance';
}

/** Retained projection or a whole successful envelope; never infer an ID from the latest proposal. */
export function appearanceProposalResult(
  call: AppearanceCall,
): CustomAppearanceProposalReference | undefined {
  if (
    !isAppearanceProposalCall(call) ||
    call.error ||
    call.errorText ||
    call.cancelled ||
    call.needsApproval ||
    call.state === 'error' ||
    call.state === 'unresolved'
  )
    return undefined;
  return (
    appearanceProposalReferenceView(call.appearanceProposal) ??
    parseAppearanceProposalReference(nameOf(call), call.output ?? call.result)
  );
}
