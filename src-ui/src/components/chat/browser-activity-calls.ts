import { parseMcpToolRef } from '@kontourai/station-contracts/layout';
import type { ToolCallLike } from './tool-call-runs';
import { toolDisplayView } from './tool-display-view';

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Provider-reported MCP identity only; bare tool names carry no server authority. */
export function stationBrowserTool(part: ToolCallLike): string | undefined {
  if (typeof part.server === 'string' && part.server !== 'station-browser')
    return undefined;
  const name = String(part.toolName ?? part.name ?? '');
  const match = /^mcp__station-browser__(browser_[a-z0-9_]+)$/.exec(name);
  const ref =
    typeof part.server === 'string' && typeof part.originalName === 'string'
      ? `${part.server}/${part.originalName}`
      : match
        ? `station-browser/${match[1]}`
        : name;
  const parsed = parseMcpToolRef(ref);
  return parsed?.serverId === 'station-browser' &&
    parsed.toolName.startsWith('browser_')
    ? parsed.toolName
    : undefined;
}

function envelope(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = envelope(item);
      if (found) return found;
    }
    return undefined;
  }
  const row = object(value);
  if (!row) return undefined;
  if (typeof row.ok === 'boolean' || typeof row.success === 'boolean')
    return row;
  return envelope(row.content ?? row.text ?? row.output);
}

/** Use only an explicit selector or a successful open response, never a recent session. */
export function browserCallSessionId(part: ToolCallLike): string | undefined {
  const tool = stationBrowserTool(part);
  if (!tool) return undefined;
  const display = toolDisplayView(part);
  const args = object(display.args);
  if (typeof args?.browserSessionId === 'string' && args.browserSessionId)
    return args.browserSessionId;
  if (
    tool !== 'browser_open' ||
    display.error ||
    part.isError ||
    object(display.result)?.isError === true ||
    part.cancelled ||
    part.outputTruncated
  )
    return undefined;
  const result = envelope(display.result);
  const session = object(result?.session);
  return result?.ok === true &&
    typeof session?.browserSessionId === 'string' &&
    session.browserSessionId
    ? session.browserSessionId
    : undefined;
}

/** Split mixed tool runs without moving unrelated calls or reasoning into a browser card. */
export function splitBrowserActivityRuns<P extends ToolCallLike>(
  blocks: import('./tool-call-runs').RunBlock<P>[],
): import('./tool-call-runs').RunBlock<P>[] {
  return blocks.flatMap((block) => {
    if (block.type !== 'tool-call-run') return [block];
    const output: import('./tool-call-runs').RunBlock<P>[] = [];
    let pending: { part: P; index: number }[] = [];
    let key: string | undefined;
    const flush = () => {
      if (pending.length)
        output.push({
          type: 'tool-call-run',
          key: `tool-call-run:${pending[0].part.toolCallId ?? pending[0].index}`,
          calls: pending,
        });
      pending = [];
    };
    const entries = [...block.calls, ...(block.interludes ?? [])].sort(
      (a, b) => a.index - b.index,
    );
    for (const entry of entries) {
      if (entry.part.type === 'reasoning' || entry.part.type === 'text') {
        flush();
        output.push({ type: 'content-part', ...entry });
        key = undefined;
        continue;
      }
      const browser = stationBrowserTool(entry.part);
      const id = browser && browserCallSessionId(entry.part);
      const nextKey = browser
        ? `browser:${id ?? `unknown:${entry.index}`}`
        : 'other';
      if (pending.length && key !== nextKey) flush();
      key = nextKey;
      pending.push(entry);
    }
    flush();
    return output;
  });
}
