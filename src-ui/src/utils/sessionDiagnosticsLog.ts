import { flowRunDisplayIdentity } from '@kontourai/station-contracts';
import type { OrchestrationEvent } from '../hooks/orchestration/types';

/**
 * archive#1170: every case here must return something OTHER than the bare method
 * name — the raw log's "every event renders its name twice" bug was this
 * function's default case echoing `event.method` back as the body, right
 * next to the label that already shows it. Genuinely bodiless events (e.g.
 * a bare session.started with no metadata worth restating) return '' and
 * the caller omits the body span rather than repeat the label.
 */
function describeEvent(event: OrchestrationEvent): string {
  switch (event.method) {
    case 'content.text-delta':
    case 'content.reasoning-delta':
      return event.delta;
    case 'tool.started':
      return `→ ${event.toolName}`;
    case 'tool.progress':
      return event.message;
    case 'tool.completed':
      return `${event.toolName} (${event.status})`;
    case 'request.opened':
      return event.title;
    case 'request.resolved':
      return `Request ${event.status}`;
    case 'turn.started':
      return event.prompt?.trim() ?? '';
    case 'turn.completed':
      return (
        event.outputText?.trim() || `Finished (${event.finishReason ?? 'stop'})`
      );
    case 'turn.aborted':
      return event.reason;
    case 'session.configured':
      return event.model ?? '';
    case 'session.state-changed':
      return event.reason
        ? `${event.from} → ${event.to}: ${event.reason}`
        : `${event.from} → ${event.to}`;
    case 'session.exited':
      return typeof event.exitCode === 'number'
        ? `Exit code ${event.exitCode}`
        : (event.reason ?? '');
    case 'runtime.error':
    case 'runtime.warning':
      return event.message;
    case 'token-usage.updated':
      return typeof event.totalTokens === 'number'
        ? `${event.totalTokens} tokens`
        : '';
    case 'flow.run-attached':
      return `${flowRunDisplayIdentity(event.definitionId, event.runId)}${event.resumed ? ' (resumed)' : ''}`;
    case 'flow.gate-verdict':
      return event.gateId
        ? `${event.verdict} · ${event.gateId}`
        : event.verdict;
    default:
      return '';
  }
}

export interface DiagnosticsEntry {
/** Merge identity only (`${method}:${itemId}` for delta groups) — deliberately
* NOT unique across the whole log, since two different turns can both open
* with `itemId: "0"` in streaming protocols that reset ids per turn. Never
* use this as a React list key (see `renderKey`). */
  key: string;
 /** (archive#1170): React list keys must be unique across the
* WHOLE list, not just adjacent entries — `key` above collides whenever a
* non-adjacent group reuses the same `(method, itemId)` pair (a common
* streaming-protocol shape), which produced a real
* "Encountered two children with the same key" warning and undefined
* render behavior. `renderKey` suffixes `key` with this entry's final
* position in the entries array (unique and stable — the array is only
* ever rebuilt from the full `events` list, never reordered), so it stays
* unique even when `key` repeats. */
  renderKey: string;
  method: string;
  body: string;
  count: number;
}

/** Groups consecutive text/reasoning deltas from the same item into one
 * merged entry (the reported "'I' / '\'m Claude Opus 4.5…'" split), and
 * collapses consecutive fully-identical entries — e.g. a duplicated
 * `session.configured` — into one with a "×N" count, instead of two
 * identical-looking rows back to back.
 *
 * (archive#1170): the collapse must never fire on an EMPTY
 * body. `describeEvent`'s default case returns '' for every method it
 * doesn't special-case — including `platform.mutation` (station's
 * structured self-mutation audit record), `policy.stop-verdict`,
 * `workflow.state-changed`, `plan.updated`, `extension.notification` — so
 * two consecutive events of one of those types always rendered as an
 * indistinguishable empty body, and the old `last.body === body` check
 * ('' === '') collapsed them into a false "×N" as if they were proven
 * identical. They were never inspected; a governed-mutation receipt with a
 * different tool/outcome/decision would have silently disappeared into the
 * count. Requiring a non-empty body means a collapse only ever happens
 * after `describeEvent` genuinely differentiated the two events' content
 * (e.g. matching `session.configured` model names) — an empty-bodied event
 * now always gets its own row instead of an unverified merge. */
export function buildDiagnosticsLog(
  events: OrchestrationEvent[],
): DiagnosticsEntry[] {
  const entries: DiagnosticsEntry[] = [];
  events.forEach((event, index) => {
    const isDelta =
      event.method === 'content.text-delta' ||
      event.method === 'content.reasoning-delta';
    const groupKey = isDelta ? `${event.method}:${event.itemId}` : undefined;
    const last = entries.at(-1);
    if (groupKey && last?.key === groupKey) {
      last.body += describeEvent(event);
      last.count += 1;
      return;
    }
    const body = describeEvent(event);
    if (
      !groupKey &&
      last &&
      last.method === event.method &&
      body !== '' &&
      last.body === body
    ) {
      last.count += 1;
      return;
    }
    const key = groupKey ?? `${event.method}-${index}`;
    entries.push({
      key,
      renderKey: `${key}::${entries.length}`,
      method: event.method,
      body,
      count: 1,
    });
  });
  return entries;
}
