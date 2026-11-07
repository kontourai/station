/**
 * PLACEHOLDER (lane-a): minimal stand-in for Lane A's real module so Lane B
 * compiles and tests. The orchestrator drops this commit when merging Lane A.
 * Honours the frozen interface; the wording is not the real text.
 */
import { createHash } from 'node:crypto';
import type {
  EngineId,
  ResolvedAgentToolServer,
} from '@kontourai/station-contracts/provider';
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
  controlTools: ReadonlySet<string>;
  browser: boolean;
  devices: boolean;
  delegated: boolean;
  harness: 'claude' | 'codex' | 'acp' | 'muse' | 'other';
  toolSearch: boolean;
  progressiveFamilies: boolean;
}

export function stationControlAssuranceFor(
  provider: EngineId,
): StationControlPolicyCaller['assurance'] | undefined {
  if (provider === 'claude') return 'bound';
  if (provider === 'acp') return 'delegated-custody';
  if (provider === 'codex') return 'bearer-exposed';
  return undefined;
}

export function effectiveStationControlTools(
  server: Pick<
    ResolvedAgentToolServer,
    'allowedTools' | 'disabledTools' | 'toolNames'
  >,
  catalog: readonly string[],
  assurance: StationControlPolicyCaller['assurance'],
): Set<string> {
  const base = server.allowedTools ?? server.toolNames ?? catalog;
  const disabled = new Set(server.disabledTools ?? []);
  const out = new Set<string>();
  for (const name of base) {
    if (disabled.has(name)) continue;
    const policy = stationControlToolPolicy(name);
    if (policy && !stationControlToolListable(policy, assurance)) continue;
    out.add(name);
  }
  return out;
}

export function composeStationInstructions(
  c: StationInstructionCapabilities,
):
  | {
      sections: { id: StationInstructionSectionId; text: string }[];
      text: string;
      digest: string;
    }
  | undefined {
  const sections: { id: StationInstructionSectionId; text: string }[] = [];
  if (c.delegated) {
    sections.push({
      id: 'delegated-child',
      text: '## Station: you are a delegated task',
    });
  } else if (c.controlTools.has('delegate_task')) {
    sections.push({ id: 'orchestration', text: '## Station orchestration' });
  }
  if (
    c.controlTools.has('send_to_session') ||
    c.controlTools.has('wait_session')
  ) {
    sections.push({
      id: 'sessions',
      text: '## Other Sessions in this Project',
    });
  }
  if (c.browser) sections.push({ id: 'browser', text: '## Station browser' });
  if (c.devices) sections.push({ id: 'devices', text: '## Station devices' });
  if (sections.length === 0) return undefined;
  const text = sections.map((s) => s.text).join('\n\n');
  return {
    sections,
    text,
    digest: createHash('sha256').update(text).digest('hex'),
  };
}

export function wrapFirstTurnStationInstructions(text: string): string {
  return `<station_instructions>\n${text}\n</station_instructions>`;
}
