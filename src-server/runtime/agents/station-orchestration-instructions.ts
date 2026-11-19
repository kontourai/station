/**
 * Station-owned orchestration instructions: the short text that tells an
 * Agent which Station tools to reach for, composed only from the tools the
 * session is actually offered.
 *
 * This module is pure. It decides WHAT to say; where the text is delivered
 * (system-prompt append or first turn) and whether the feature is on belong
 * to the resolver and adapters. Every tool name in the text is gated on the
 * `controlTools` set the caller passes (already filtered by the Agent's tool
 * selection and the engine's assurance), so a session is never told about a
 * tool it cannot call.
 */
import { createHash } from 'node:crypto';
import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import { STATION_BROWSER_TOOL_NAMES } from '../../tools/station-browser-policy.js';
import { STATION_CONTROL_DISCOVERY_TOOL_NAMES } from '../../tools/station-control-disclosure.js';
import {
  type StationControlPolicyCaller,
  stationControlToolListable,
  stationControlToolPolicy,
} from '../../tools/station-control-policy.js';

export const STATION_INSTRUCTION_SECTION_MAX_BYTES = 3_500;
export const STATION_INSTRUCTIONS_MAX_BYTES = 12_000;

export type StationInstructionSectionId =
  | 'engine-setup'
  | 'orchestration'
  | 'delegated-child'
  | 'sessions'
  | 'replies'
  | 'browser'
  | 'devices'
  | 'tool-loading';

export interface StationInstructionCapabilities {
  /** Already filtered by selection + assurance. */
  controlTools: ReadonlySet<string>;
  browser: boolean;
  devices: boolean;
  delegated: boolean;
  canDelegateFromChild?: boolean;
  harness: 'claude' | 'codex' | 'acp' | 'muse' | 'other';
  /** Claude, with Station turning its tool search on (`claude-tool-search.ts`). */
  toolSearch: boolean;
  /** HTTP progressive disclosure is on. */
  progressiveFamilies: boolean;
}

/**
 * The assurance Station-control tools are listed at for each engine, from how
 * the engine's token is minted (`station-control-mcp-token.ts`
 * `stationControlTokenAssurance`): Claude's in-process server is `bound`;
 * Codex and ACP both receive a header-only bearer (`http-header-token`), which
 * is `delegated-custody`. A Codex session whose station-control travels on
 * the bound channel (`codexBoundCatalog`, #2376 slice 2) gets no header token
 * and is `bound` too. `bearer-exposed` (a query-string URL token) is a
 * legacy channel no current engine uses. An engine with no Station-control
 * delivery (Muse, command engines) has none.
 */
export function stationControlAssuranceFor(
  provider: EngineId,
  codexBoundCatalog = false,
): StationControlPolicyCaller['assurance'] | undefined {
  switch (provider) {
    case 'claude':
      return 'bound';
    case 'codex':
      return codexBoundCatalog ? 'bound' : 'delegated-custody';
    case 'acp':
      return 'delegated-custody';
    default:
      return undefined;
  }
}

/**
 * The Station-control tools an Agent's selection leaves callable at this
 * assurance: `(allowedTools ?? toolNames ?? catalog) − disabledTools`, kept to
 * names the catalog registers and the policy lists at that assurance.
 */
export function effectiveStationControlTools(
  server: Pick<
    ResolvedAgentToolServer,
    'allowedTools' | 'disabledTools' | 'toolNames'
  >,
  catalog: readonly string[],
  assurance: StationControlPolicyCaller['assurance'],
): Set<string> {
  const registered = new Set(catalog);
  const disabled = new Set(server.disabledTools ?? []);
  const selected = server.allowedTools ?? server.toolNames ?? catalog;
  const out = new Set<string>();
  for (const name of selected) {
    if (!registered.has(name) || disabled.has(name)) continue;
    const policy = stationControlToolPolicy(name);
    if (!policy || !stationControlToolListable(policy, assurance)) continue;
    out.add(name);
  }
  return out;
}

const BROWSER_TOOLS: ReadonlySet<string> = new Set(STATION_BROWSER_TOOL_NAMES);
const CONTROL_PREFIX = 'mcp__station-control__';
const BROWSER_PREFIX = 'mcp__station-browser__';

type Section = { id: StationInstructionSectionId; text: string };

function orchestrationSection(
  has: (...n: string[]) => boolean,
): Section | undefined {
  if (!has('delegate_task')) return undefined;
  const lines: string[] = [
    'Use Station tools when asked or when work crosses Agents, engines, models, Projects or Stations.',
    'Use `delegate_task` for tracked child work. Use native subagents only when requested.',
  ];
  if (has('list_delegation_targets')) {
    lines.push(
      `Before the first \`delegate_task\`, call \`list_delegation_targets\` once for ready Agents and models; repeat only on refusal or target change. If it is refused, ${has('list_agents') ? 'use `list_agents` and ' : ''}delegate only to an Agent the user named.`,
    );
  } else if (has('list_agents')) {
    lines.push(
      'Before the first `delegate_task`, call `list_agents` once. Use a listed or user-named Agent; readiness/models are unknown.',
    );
  } else {
    lines.push('Delegate only to an Agent the user named.');
  }
  lines.push(
    'Report unavailable targets with catalog options. Change Agent or model only with user approval. Never delegate through a shell.',
    'Brief the child on one outcome and what to return. Supply excerpts if it cannot read files.',
    'Use a fresh `clientTurnId` except for identical retries. Start a new task for re-review.',
  );
  const follow: string[] = [];
  if (has('continue_task'))
    follow.push('Send follow-ups with `continue_task`.');
  if (has('get_task')) {
    follow.push(
      has('get_task_events')
        ? 'Read `get_task` and `get_task_events`; pass `nextCursor`.'
        : 'Read state with `get_task`.',
    );
  } else if (has('get_task_events')) {
    follow.push(
      'Read state with `get_task_events`, passing back `nextCursor`.',
    );
  }
  if (follow.length > 0) lines.push(follow.join(' '));
  if (has('wait_session')) {
    lines.push(
      'Wait with `wait_session`, its `sessionId` and `until: "turn-settled"`; repeat on timeout. Never poll with sleep/shell loops.',
    );
  }
  if (has('interrupt_task')) {
    lines.push('Use `interrupt_task` for replaced or unneeded tasks.');
  }
  return {
    id: 'orchestration',
    text: bulleted('## Station orchestration', lines),
  };
}

function delegatedChildSection(canDelegate: boolean): Section {
  return {
    id: 'delegated-child',
    text: [
      '## Station: you are a delegated task',
      '',
      'Put the result in your final reply so Station can deliver it to your parent.',
      canDelegate
        ? 'If the task needs another Agent, start a new tracked child in this Project on this Station. Your depth and tool restrictions carry forward.'
        : 'If the work needs another Agent, tell your parent in your reply.',
      'Do not use shell CLIs to dispatch other Agents.',
    ].join('\n'),
  };
}

function sessionsSection(
  has: (...n: string[]) => boolean,
): Section | undefined {
  const lines: string[] = [];
  if (has('send_to_session')) {
    lines.push(
      "`send_to_session` uses the Project Session's Agent settings. Fresh `requestKey` per message; reuse only to retry. `session_busy`: unsent. `indeterminate`: may have arrived; never resend with a new key.",
    );
  }
  if (has('wait_session')) {
    lines.push(
      `${has('send_to_session') ? 'Then call' : 'Call'} \`wait_session\` with \`sessionId\`, \`afterEventCursor\` = \`eventCursor\`, \`until: "turn-settled"\`; on \`superseded\`, wait on \`currentSessionId\`.`,
    );
  }
  if (has('interrupt_session')) {
    lines.push(
      'Use `interrupt_session` only on a Session you started or the user named.',
    );
  }
  const activity: string[] = [];
  if (has('list_project_activity')) {
    activity.push('`list_project_activity` shows which Sessions are active.');
  }
  if (has('claim_work', 'release_claim')) {
    activity.push(
      'Say what you are on with `claim_work` and `release_claim` when done.',
    );
  }
  if (activity.length > 0) lines.push(activity.join(' '));
  if (lines.length === 0) return undefined;
  return {
    id: 'sessions',
    text: bulleted('## Project Sessions', lines),
  };
}

function repliesSection(has: (...n: string[]) => boolean): Section | undefined {
  const lines: string[] = [];
  if (has('html_preview', 'html_render')) {
    lines.push(
      'For visuals, reach for `html_preview` then `html_render` by default. On Artifact auth-token refusal, use `html_render` for the same page; no local-file-only result or server.',
    );
  }
  if (has('schedule_wake_up')) {
    lines.push(
      'To continue later, use `schedule_wake_up`, never a sleep loop.',
    );
  }
  if (has('declare_pull_request')) {
    lines.push(
      'After you open a pull request, record it with `declare_pull_request`.',
    );
  }
  if (has('notify_user')) {
    lines.push(
      'Use `notify_user` only when the user must act or asked to be told.',
    );
  }
  if (lines.length === 0) return undefined;
  return {
    id: 'replies',
    text: bulleted('## Station replies', lines),
  };
}

function browserSection(): Section {
  return {
    id: 'browser',
    text: [
      '## Station browser',
      '',
      'For requested browser work, use the visible Browser pane: `browser_status`, then `browser_open` if needed. Read with `browser_snapshot`; act by element refs, not coordinates. Never open it to check your edit unasked. Finish with `browser_close` for sessions you opened, unless the user uses them.',
    ].join('\n'),
  };
}

function devicesSection(has: (...n: string[]) => boolean): Section | undefined {
  if (!has('device_open')) return undefined;
  const look = ['device_screenshot', 'device_snapshot'].filter((n) => has(n));
  const sentences: string[] = [
    `For a visible iOS Simulator/Android Emulator, use ${has('device_list') ? '`device_list`, then ' : ''}\`device_open\` with its id (call again while it reports starting).`,
  ];
  const lookAct: string[] = [];
  if (look.length > 0) {
    lookAct.push(`Look with ${look.map((n) => `\`${n}\``).join(' or ')}`);
  }
  if (has('device_input')) {
    lookAct.push(`${look.length > 0 ? 'act' : 'Act'} with \`device_input\``);
  }
  if (lookAct.length > 0) sentences.push(`${lookAct.join('; ')}.`);
  sentences.push(
    'No UI driving via `xcrun simctl`, `adb` or ssh; builds/logs are fine. On device-tool refusal, quote it and stop.',
  );
  if (has('delegate_task')) {
    sentences.push(
      'When you delegate device work, pass its id; the child uses `device_open`.',
    );
  }
  return {
    id: 'devices',
    text: ['## Station devices', '', sentences.join(' ')].join('\n'),
  };
}

function bulleted(heading: string, lines: readonly string[]): string {
  return [heading, '', ...lines.map((l) => `- ${l}`)].join('\n');
}

/** Backticked identifiers, in first-seen order. */
function backtickedNames(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) seen.add(m[1]);
  return [...seen];
}

/** Enforces the per-section and total byte ceilings; throws on overflow. */
export function assertStationInstructionBounds(
  sections: readonly { id: string; text: string }[],
  joined: string,
): void {
  for (const s of sections) {
    const bytes = Buffer.byteLength(s.text, 'utf8');
    if (bytes > STATION_INSTRUCTION_SECTION_MAX_BYTES) {
      throw new Error(
        `Station instruction section "${s.id}" is ${bytes} bytes, over the ${STATION_INSTRUCTION_SECTION_MAX_BYTES} byte limit`,
      );
    }
  }
  const total = Buffer.byteLength(joined, 'utf8');
  if (total > STATION_INSTRUCTIONS_MAX_BYTES) {
    throw new Error(
      `Station instructions are ${total} bytes, over the ${STATION_INSTRUCTIONS_MAX_BYTES} byte limit`,
    );
  }
}

export function composeStationInstructions(
  c: StationInstructionCapabilities,
): { sections: Section[]; text: string; digest: string } | undefined {
  const offered = new Set(c.controlTools);
  if (c.delegated) {
    offered.delete('send_message');
    if (!c.canDelegateFromChild) offered.delete('delegate_task');
    offered.delete('list_delegation_environments');
  }
  const has = (...names: string[]) => names.every((n) => offered.has(n));

  const sections: Section[] = [];
  const push = (s: Section | undefined) => {
    if (s) sections.push(s);
  };
  if (c.delegated && c.controlTools.has('delegate_task'))
    push(delegatedChildSection(has('delegate_task')));
  push(orchestrationSection(has));
  if (has('list_engine_setup')) {
    const lines = [
      'For engine setup, call `list_engine_setup`; reuse its id/setupPath and saved connection. Preview off: give the Settings path; never enable it.',
      has('open_engine_setup')
        ? 'Use `open_engine_setup` for that id; check navigation or give setupPath.'
        : 'Give setupPath to the person.',
      'The person installs/signs in on the Station host (may differ from the client), reviews launch arguments in place, and chooses Add Station tools if needed. Never request OAuth codes/tokens in chat, edit Station home config, or bypass with shell login.',
      'Ask the person to return here; re-read `list_engine_setup`. Handshake, sign-in, chat and Station-tool delivery are separate facts; report only observed facts.',
    ];
    if (has('list_agents'))
      lines.push('Read `list_agents` after setup; use its actual Agent id.');
    push({ id: 'engine-setup', text: bulleted('## Engine setup', lines) });
  }
  push(sessionsSection(has));
  push(repliesSection(has));
  if (c.browser) sections.push(browserSection());
  if (c.devices) push(devicesSection(has));

  // Tool-loading names only what the sections above name, kept to offered tools.
  const named = [
    ...new Set(
      sections
        .filter((s) => s.id !== 'delegated-child')
        .flatMap((s) => backtickedNames(s.text)),
    ),
  ];
  const loadingLines: string[] = [];
  if (c.harness === 'claude' && c.toolSearch) {
    const control = named.filter((n) => offered.has(n));
    const browser = c.browser ? named.filter((n) => BROWSER_TOOLS.has(n)) : [];
    const selects = [
      ...control.map((n) => `${CONTROL_PREFIX}${n}`),
      ...browser.map((n) => `${BROWSER_PREFIX}${n}`),
    ];
    if (selects.length > 0) {
      loadingLines.push(
        `Station tools load on demand. Load the ones named above with ToolSearch \`select:${selects.join(',')}\`.`,
      );
    }
  }
  if (c.progressiveFamilies && sections.length > 0) {
    loadingLines.push(
      `Station tools come in families. If a tool named here is missing, call \`${STATION_CONTROL_DISCOVERY_TOOL_NAMES.listFamilies}\`, then \`${STATION_CONTROL_DISCOVERY_TOOL_NAMES.loadFamily}\` with its family.`,
    );
  }
  if (loadingLines.length > 0) {
    sections.push({
      id: 'tool-loading',
      text: bulleted('## Loading Station tools', loadingLines),
    });
  }

  if (sections.length === 0) return undefined;
  const text = sections.map((s) => s.text).join('\n\n');
  assertStationInstructionBounds(sections, text);
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  return { sections, text, digest };
}

export function wrapFirstTurnStationInstructions(text: string): string {
  return `<station_instructions>\n${text}\n</station_instructions>`;
}
