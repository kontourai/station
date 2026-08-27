type ToolContentPart = {
  type: string;
  activityAt?: string;
  name?: string;
  toolName?: string;
  state?: string;
  progressMessage?: string;
};

export interface ToolProgressSummary {
  label: string;
  toolName: string;
}

function normalizeProgressMessage(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Human-readable tool-name normalization shared by the streaming progress
 * indicator and the collapsed tool-call batch summary (`tool-call-groups.ts`)
 * — one label vocabulary, not two parallel ones.
 */
export function formatToolName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'tool';
  }
  return value.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

function activityTimestamp(part: ToolContentPart): number {
  if (!part?.activityAt) {
    return Number.NEGATIVE_INFINITY;
  }
  const timestamp = Date.parse(part.activityAt);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function deriveToolProgressSummary(
  contentParts: ToolContentPart[] | undefined,
): ToolProgressSummary | null {
  if (!contentParts || contentParts.length === 0) {
    return null;
  }

  const runningToolParts = contentParts.filter(
    (part) => part.type === 'tool-invocation' && part.state === 'running',
  );

  if (runningToolParts.length === 0) {
    return null;
  }

  const runningToolPart = runningToolParts.reduce((latest, candidate) =>
    activityTimestamp(candidate) >= activityTimestamp(latest)
      ? candidate
      : latest,
  );

  if (!runningToolPart) {
    return null;
  }

  const toolName = formatToolName(
    runningToolPart.toolName ?? runningToolPart.name,
  );
  const progressMessage = normalizeProgressMessage(
    runningToolPart.progressMessage,
  );

  return {
    label: progressMessage ?? `Running ${toolName}`,
    toolName,
  };
}
