import { redactDeep } from '@kontourai/station-shared/redaction';
import type { MonitoringEvent } from './schema.js';
import { K } from './schema.js';

const CONTENT_BEARING_FIELDS = [
  K.TOOL_CALL_ARGS,
  K.TOOL_CALL_RESULT,
  K.ARTIFACTS,
  K.REASONING_TEXT,
] as const;

/**
 * Redacts the monitoring fields that can carry arbitrary tool/model content.
 *
 * This deliberately leaves correlation and operational attributes intact while
 * retaining the content field and its shape, so monitoring remains useful
 * without making persisted telemetry a secret egress path.
 */
export function redactMonitoringContent(
  event: MonitoringEvent,
): MonitoringEvent {
  const redacted = { ...event };
  for (const field of CONTENT_BEARING_FIELDS) {
    if (field in event) {
      (redacted as Record<string, unknown>)[field] = redactDeep(event[field]);
    }
  }
  return redacted;
}
