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
  harness: 'claude' | 'codex' | 'acp' | 'muse' | 'other';
  /** Claude and `toolServerLoading !== 'always'`. */
  toolSearch: boolean;
  /** HTTP progressive disclosure is on. */
  progressiveFamilies: boolean;
}

/**
 * The assurance Station-control tools are listed at for each engine, from how
 * the engine's token is minted (`station-control-mcp-token.ts`
 * `stationControlTokenAssurance`): Claude's in-process server is `bound`;
 * Codex and ACP both receive a header-only bearer (`http-header-token`), which
 * is `delegated-custody`. `bearer-exposed` (a query-string URL token) is a
 * legacy channel no current engine uses. An engine with no Station-control
 * delivery (Muse, command engines) has none.
 */
export function stationControlAssuranceFor(
  provider: EngineId,
): StationControlPolicyCaller['assurance'] | undefined {
  switch (provider) {
    case 'claude':
      return 'bound';
    case 'codex':
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
/** The two tools a delegated Task may not use (Station refuses them). */
const DELEGATED_BLOCKED_TOOLS = ['delegate_task', 'send_message'] as const;

type Section = { id: StationInstructionSectionId; text: string };

function orchestrationSection(
  has: (...n: string[]) => boolean,
): Section | undefined {
  if (!has('delegate_task')) return undefined;
  const lines: string[] = [
    'Ordinary coding needs no Station tools. Use them when the work needs another Agent, engine, model, Project or Station, or when the user asks.',
    'For a quick helper on your own engine in this checkout, use your own subagent tool. Use `delegate_task` when the work needs another Agent or engine, a model you do not have, another Project or saved environment, or a resumable Task the user can open in Station.',
  ];
  if (has('list_delegation_targets')) {
    lines.push(
      `Before your first \`delegate_task\` in this conversation, call \`list_delegation_targets\` once: it lists Agents, readiness, engines and models. Call it again only after a refusal or when the user names another target. If it is refused, ${has('list_agents') ? 'use `list_agents` and ' : ''}delegate only to an Agent the user named.`,
    );
  } else if (has('list_agents')) {
    lines.push(
      'Before your first `delegate_task`, call `list_agents` once and delegate only to an Agent it lists or the user names; readiness and models cannot be checked from here.',
    );
  } else {
    lines.push('Delegate only to an Agent the user named.');
  }
  lines.push(
    'If the target is missing or not ready, say so. Never switch Agent or model unasked, and never fall back to running `station`, `claude` or `codex` in a shell.',
    'Give each new `delegate_task` a fresh `clientTurnId`; reuse it only to retry the identical call. A new review or re-check is a new `delegate_task` with its own brief.',
  );
  const follow: string[] = [];
  if (has('continue_task'))
    follow.push('Send follow-ups with `continue_task`.');
  if (has('get_task')) {
    follow.push(
      has('get_task_events')
        ? 'Read state with `get_task` and `get_task_events`, passing back `nextCursor`.'
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
      'To wait for a task on this Station, call `wait_session` with its `sessionId` and `until: "turn-settled"`; when it times out, call it again. Never poll with sleep or shell loops.',
    );
  }
  if (has('interrupt_task')) {
    lines.push(
      'Stop a task you replaced or no longer need with `interrupt_task`.',
    );
  }
  return {
    id: 'orchestration',
    text: bulleted('## Station orchestration', lines),
  };
}

function delegatedChildSection(): Section {
  return {
    id: 'delegated-child',
    text: [
      '## Station: you are a delegated task',
      '',
      'Do the work yourself and put the result in your final reply; your parent reads it. Delegated sessions may not use `delegate_task` or `send_message`, and Station refuses them. Do not work around that with shell CLIs. If the work needs another Agent, say so in your reply.',
    ].join('\n'),
  };
}

function sessionsSection(
  has: (...n: string[]) => boolean,
): Section | undefined {
  const lines: string[] = [];
  if (has('send_to_session')) {
    lines.push(
      "`send_to_session` messages a Session in your Project; it runs under that Session's own Agent settings. Give each new message a fresh `requestKey` and reuse it only to retry. `session_busy` means nothing was sent; `indeterminate` means it may have arrived, so do not resend under a new key.",
    );
  }
  if (has('wait_session')) {
    lines.push(
      `${has('send_to_session') ? 'Then call' : 'Call'} \`wait_session\` with the returned \`sessionId\`, \`afterEventCursor\` set to its \`eventCursor\`, and \`until: "turn-settled"\`. If the answer is \`superseded\`, wait on \`currentSessionId\`.`,
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
    text: bulleted('## Other Sessions in this Project', lines),
  };
}

function repliesSection(has: (...n: string[]) => boolean): Section | undefined {
  const lines: string[] = [];
  if (has('html_preview', 'html_render')) {
    lines.push(
      'For a chart or visual the user should see here, check it with `html_preview`, then publish it with `html_render`. Do not start a server for it.',
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
    text: bulleted('## Replying through Station', lines),
  };
}

function browserSection(): Section {
  return {
    id: 'browser',
    text: [
      '## Station browser',
      '',
      'When the task asks for browser work, the `browser_*` tools drive the Browser pane the user can watch. Call `browser_status` first and `browser_open` if you have no session. Read the page with `browser_snapshot` and act by its element refs, not coordinates. Do not open the browser just to check your own edit unless asked. Close sessions you opened with `browser_close` before you finish, unless the user is using them.',
    ].join('\n'),
  };
}

function devicesSection(has: (...n: string[]) => boolean): Section | undefined {
  if (!has('device_open')) return undefined;
  const look = ['device_screenshot', 'device_snapshot'].filter((n) => has(n));
  const sentences: string[] = [
    `For an iOS Simulator or Android Emulator, use the device tools so the user can watch in the Device pane: ${has('device_list') ? '`device_list`, then ' : ''}\`device_open\` with its id (call again while it reports starting).`,
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
    'Do not drive the UI with `xcrun simctl`, `adb` or ssh scripts; they stay fine for builds and logs. If a device tool is refused, quote the refusal and stop.',
  );
  if (has('delegate_task')) {
    sentences.push(
      'When you delegate device work, pass the device id and tell the child to use `device_open`.',
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
  // A delegated Task cannot use these two, so they are never offered to it.
  const offered = new Set(c.controlTools);
  if (c.delegated) for (const n of DELEGATED_BLOCKED_TOOLS) offered.delete(n);
  const has = (...names: string[]) => names.every((n) => offered.has(n));

  const sections: Section[] = [];
  const push = (s: Section | undefined) => {
    if (s) sections.push(s);
  };
  if (c.delegated) {
    if (DELEGATED_BLOCKED_TOOLS.some((n) => c.controlTools.has(n))) {
      sections.push(delegatedChildSection());
    }
  } else {
    push(orchestrationSection(has));
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
