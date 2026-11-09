/**
 * Loading, checking and replaying the eval's cases. Refusal results come from
 * Station's own refusal builders, so a case never copies product copy.
 */
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import {
  STATION_CONTROL_OUT_OF_SCOPE_REASONS,
  type StationControlOutOfScopeReason,
  stationControlOutOfScopeRefusal,
  stationControlRefusalBody,
} from '../../../src-server/tools/station-control-policy.js';
import {
  type PriorToolTurn,
  STATION_CONTROL_PREFIX,
  type ToolUseCase,
} from './grade.js';
import { type Assurance, HARNESS_TOOLS } from './tools.js';

export const CASES_URL = new URL('./cases.json', import.meta.url);

export function loadCases(url: URL = CASES_URL): ToolUseCase[] {
  return JSON.parse(readFileSync(url, 'utf8')) as ToolUseCase[];
}

const HARNESS_NAMES = new Set(HARNESS_TOOLS.map((t) => t.name));

function isToolTurn(turn: unknown): turn is PriorToolTurn {
  return typeof turn === 'object' && turn !== null && 'toolCall' in turn;
}

/**
 * Problems with the case table: duplicate ids, missing sources, too few
 * controls, unknown refusal reasons, and tool names the case's session is
 * not offered (a case about a tool that no longer exists tests nothing).
 */
export function validateCases(
  cases: readonly ToolUseCase[],
  offered: Record<Assurance, ReadonlySet<string>>,
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    if (!c.source?.trim()) problems.push(`${c.id}: no source`);
    if (!c.experience?.trim()) problems.push(`${c.id}: no experience`);
    const tools = offered[c.assurance];
    if (!tools) {
      problems.push(`${c.id}: unknown assurance ${c.assurance}`);
      continue;
    }
    const known = (name: string) => tools.has(name) || HARNESS_NAMES.has(name);
    const named = [
      ...(c.expect.firstCallAnyOf ?? []),
      ...(c.expect.calls ?? []).map((call) => call.tool),
    ];
    for (const name of named) {
      if (!known(name)) {
        problems.push(`${c.id}: ${name} is not offered at ${c.assurance}`);
      }
    }
    for (const turn of c.priorTurns ?? []) {
      if (!isToolTurn(turn)) continue;
      if (!known(turn.toolCall.name)) {
        problems.push(
          `${c.id}: prior call ${turn.toolCall.name} is not offered at ${c.assurance}`,
        );
      }
      if (
        turn.refusal !== undefined &&
        !(STATION_CONTROL_OUT_OF_SCOPE_REASONS as readonly string[]).includes(
          turn.refusal,
        )
      ) {
        problems.push(`${c.id}: unknown refusal reason ${turn.refusal}`);
      }
      if ((turn.result === undefined) === (turn.refusal === undefined)) {
        problems.push(
          `${c.id}: a prior call needs exactly one of result, refusal`,
        );
      }
    }
    const e = c.expect;
    if (
      !e.firstCallAnyOf &&
      !e.calls?.length &&
      !e.callsMustNot?.length &&
      !e.shellMustNot?.length &&
      !e.noStationTools
    ) {
      problems.push(`${c.id}: expects nothing`);
    }
  }
  for (const kind of ['bad', 'control'] as const) {
    if (cases.filter((c) => c.kind === kind).length < 2) {
      problems.push(`fewer than two ${kind} cases`);
    }
  }
  return problems;
}

function toolResultText(turn: PriorToolTurn): string {
  const value =
    turn.refusal !== undefined
      ? stationControlRefusalBody(
          stationControlOutOfScopeRefusal(
            turn.refusal as StationControlOutOfScopeReason,
          ),
        )
      : turn.result;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The case's conversation as Messages API turns, ending on a user turn. */
export function buildMessages(c: ToolUseCase): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let callIndex = 0;
  for (const turn of c.priorTurns ?? []) {
    if (!isToolTurn(turn)) {
      messages.push({ role: turn.role, content: turn.text });
      continue;
    }
    callIndex += 1;
    const id = `toolu_case_${callIndex}`;
    const name = HARNESS_NAMES.has(turn.toolCall.name)
      ? turn.toolCall.name
      : `${STATION_CONTROL_PREFIX}${turn.toolCall.name}`;
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: turn.toolCall.input }],
    });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: toolResultText(turn),
          ...(turn.isError ? { is_error: true } : {}),
        },
      ],
    });
  }
  if (c.prompt) {
    const last = messages.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content.push({ type: 'text', text: c.prompt });
    } else {
      messages.push({ role: 'user', content: c.prompt });
    }
  }
  if (messages.at(-1)?.role !== 'user') {
    throw new Error(`${c.id}: the conversation must end on a user turn`);
  }
  return messages;
}
