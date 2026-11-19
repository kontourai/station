/**
 * The tool-choice case set: a deterministic table of scenarios, each pinning
 * which Station tools the composed instructions name (and must not name) for a
 * session of a given shape. It checks what the TEXT offers for each situation.
 * It does not measure model behaviour; it is not a model eval.
 */
import { describe, expect, test } from 'vitest';
import { STATION_BROWSER_TOOL_NAMES } from '../../../tools/station-browser-policy.js';
import { STATION_CONTROL_DISCOVERY_TOOL_NAMES } from '../../../tools/station-control-disclosure.js';
import { stationControlToolCatalog } from '../../../tools/station-control-mcp-server.js';
import {
  composeStationInstructions,
  effectiveStationControlTools,
  type StationInstructionCapabilities,
} from '../station-orchestration-instructions.js';
import cases from './fixtures/station-orchestration-tool-choice.json' with {
  type: 'json',
};

interface Case {
  id: string;
  kind: 'bad' | 'guard' | 'control';
  shape: string;
  scenario: string;
  expectNamed: string[];
  mustNotName: string[];
}

const CATALOG = stationControlToolCatalog().map((t) => t.name);
const ALL_TOOLS = [
  ...CATALOG,
  ...STATION_BROWSER_TOOL_NAMES,
  ...Object.values(STATION_CONTROL_DISCOVERY_TOOL_NAMES),
];

const claudeFull: StationInstructionCapabilities = {
  controlTools: effectiveStationControlTools({}, CATALOG, 'bound'),
  browser: true,
  devices: true,
  delegated: false,
  harness: 'claude',
  toolSearch: true,
  progressiveFamilies: false,
};
const custody = (harness: 'codex' | 'acp'): StationInstructionCapabilities => ({
  controlTools: effectiveStationControlTools({}, CATALOG, 'delegated-custody'),
  browser: false,
  devices: false,
  delegated: false,
  harness,
  toolSearch: false,
  progressiveFamilies: false,
});

const SHAPES: Record<string, StationInstructionCapabilities> = {
  'claude-full': claudeFull,
  'codex-custody': custody('codex'),
  'acp-custody': custody('acp'),
  'delegated-child': { ...claudeFull, delegated: true },
  'no-delegate': {
    ...claudeFull,
    controlTools: effectiveStationControlTools(
      { disabledTools: ['delegate_task'] },
      CATALOG,
      'bound',
    ),
  },
  'narrow-selection': {
    ...claudeFull,
    browser: false,
    devices: false,
    controlTools: effectiveStationControlTools(
      {
        allowedTools: [
          'notify_user',
          'wait_session',
          'list_agents',
          'get_task',
        ],
      },
      CATALOG,
      'bound',
    ),
  },
  'no-station-tools': {
    ...claudeFull,
    controlTools: new Set(),
    browser: false,
    devices: false,
  },
};

function named(text: string): Set<string> {
  const out = new Set<string>();
  for (const name of ALL_TOOLS) {
    if (new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(text)) {
      out.add(name);
    }
  }
  return out;
}

describe('tool-choice case set', () => {
  const table = cases as Case[];

  test('the table is well formed and covers every kind', () => {
    expect(new Set(table.map((c) => c.id)).size).toBe(table.length);
    for (const kind of ['bad', 'guard', 'control'] as const) {
      expect(
        table.filter((c) => c.kind === kind).length,
      ).toBeGreaterThanOrEqual(2);
    }
    for (const c of table) {
      expect(SHAPES[c.shape], `${c.id}: shape ${c.shape}`).toBeDefined();
      expect(c.scenario.length).toBeGreaterThan(20);
      for (const n of [...c.expectNamed, ...c.mustNotName]) {
        expect(ALL_TOOLS, `${c.id}: ${n} is not a registered tool`).toContain(
          n,
        );
      }
    }
  });

  test.each(table.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const result = composeStationInstructions(SHAPES[c.shape]);
    // The delegated-child section names the two refused tools to forbid them;
    // everything else in the text is what the session is offered.
    const offeredText = (result?.sections ?? [])
      .filter((s) => s.id !== 'delegated-child')
      .map((s) => s.text)
      .join('\n');
    const present = named(offeredText);
    for (const n of c.expectNamed) {
      expect(present, `${c.id}: should name ${n}`).toContain(n);
    }
    for (const n of c.mustNotName) {
      expect(present, `${c.id}: must not name ${n}`).not.toContain(n);
    }
    if (c.shape === 'no-station-tools') expect(result).toBeUndefined();
    if (c.shape === 'delegated-child') {
      expect(result?.text).toContain('you are a delegated task');
    }
  });
});
