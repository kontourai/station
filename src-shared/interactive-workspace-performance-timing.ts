export const INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER =
  'x-station-performance-reference' as const;
export const INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER =
  'x-station-performance-timing' as const;
export const INTERACTIVE_WORKSPACE_TIMING_MODE =
  'interactive-workspace-v3' as const;
const RECEIPT = 'station-batch-timing-v1';

export interface InteractiveWorkspaceBatchTimingReceipt {
  readonly taskId: string;
  readonly ingressEpochMs: number;
  readonly acceptedEpochMs: number;
}

export function formatInteractiveWorkspaceBatchTiming(
  receipt: InteractiveWorkspaceBatchTimingReceipt,
): string | undefined {
  if (!valid(receipt)) return undefined;
  return `${RECEIPT};task=${encodeURIComponent(receipt.taskId)};ingress=${receipt.ingressEpochMs};accepted=${receipt.acceptedEpochMs}`;
}

export function parseInteractiveWorkspaceBatchTiming(
  value: string | null | undefined,
): InteractiveWorkspaceBatchTimingReceipt | undefined {
  if (!value || value.length > 512) return undefined;
  const parts = value.split(';');
  if (
    parts.length !== 4 ||
    parts[0] !== RECEIPT ||
    !parts[1]?.startsWith('task=') ||
    !parts[2]?.startsWith('ingress=') ||
    !parts[3]?.startsWith('accepted=')
  )
    return undefined;
  try {
    const receipt = {
      taskId: decodeURIComponent(parts[1].slice(5)),
      ingressEpochMs: Number(parts[2].slice(8)),
      acceptedEpochMs: Number(parts[3].slice(9)),
    };
    return valid(receipt) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

function valid(
  value: InteractiveWorkspaceBatchTimingReceipt,
): value is InteractiveWorkspaceBatchTimingReceipt {
  return (
    typeof value.taskId === 'string' &&
    value.taskId.length > 0 &&
    value.taskId.length <= 256 &&
    value.taskId === value.taskId.trim() &&
    Number.isFinite(value.ingressEpochMs) &&
    Number.isFinite(value.acceptedEpochMs) &&
    value.ingressEpochMs > 0 &&
    value.acceptedEpochMs >= value.ingressEpochMs
  );
}
