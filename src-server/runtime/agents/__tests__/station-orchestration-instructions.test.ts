import { describe, expect, test } from 'vitest';
import { STATION_BROWSER_TOOL_NAMES } from '../../../tools/station-browser-policy.js';
import { STATION_CONTROL_DISCOVERY_TOOL_NAMES } from '../../../tools/station-control-disclosure.js';
import { stationControlToolCatalog } from '../../../tools/station-control-mcp-server.js';
import { stationControlToolPolicy } from '../../../tools/station-control-policy.js';
import { stationControlTokenAssurance } from '../../mcp/station-control-mcp-token.js';
import {
  assertStationInstructionBounds,
  composeStationInstructions,
  effectiveStationControlTools,
  STATION_INSTRUCTION_SECTION_MAX_BYTES,
  STATION_INSTRUCTIONS_MAX_BYTES,
  type StationInstructionCapabilities,
  stationControlAssuranceFor,
  wrapFirstTurnStationInstructions,
} from '../station-orchestration-instructions.js';

const CATALOG = stationControlToolCatalog().map((t) => t.name);
const BROWSER: readonly string[] = STATION_BROWSER_TOOL_NAMES;
const DISCOVERY: readonly string[] = Object.values(
  STATION_CONTROL_DISCOVERY_TOOL_NAMES,
);
const ASSURANCES = ['bound', 'delegated-custody', 'bearer-exposed'] as const;

/** Backticked words in the text that are parameters or answers, not tools. */
const NON_TOOL_TOKENS = [
  'afterEventCursor',
  'clientTurnId',
  'currentSessionId',
  'eventCursor',
  'indeterminate',
  'nextCursor',
  'requestKey',
  'session_busy',
  'sessionId',
  'superseded',
  'station',
  'claude',
  'codex',
  'adb',
];

function caps(
  over: Partial<StationInstructionCapabilities> & {
    assurance?: (typeof ASSURANCES)[number];
  } = {},
): StationInstructionCapabilities {
  const { assurance = 'bound', ...rest } = over;
  return {
    controlTools: effectiveStationControlTools({}, CATALOG, assurance),
    browser: true,
    devices: true,
    delegated: false,
    harness: 'claude',
    toolSearch: true,
    progressiveFamilies: true,
    ...rest,
  };
}

/** Catalog, browser and discovery names appearing as whole words in `text`. */
function namedTools(text: string): Set<string> {
  const out = new Set<string>();
  for (const name of [...CATALOG, ...BROWSER, ...DISCOVERY]) {
    if (new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(text)) {
      out.add(name);
    }
  }
  return out;
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([a-z][A-Za-z0-9_]*)`/g)].map((m) => m[1]);
}

function compose(c: StationInstructionCapabilities) {
  const r = composeStationInstructions(c);
  if (!r) throw new Error('expected instructions');
  return r;
}

describe('registry', () => {
  test('every tool-shaped name in the full text is a registered tool or pinned vocabulary', () => {
    const { text } = compose(caps());
    const registered = new Set([...CATALOG, ...BROWSER, ...DISCOVERY]);
    const unknown = backticked(text).filter(
      (n) => !registered.has(n) && !NON_TOOL_TOKENS.includes(n),
    );
    expect(unknown).toEqual([]);
  });

  test('the full text names exactly the intended tools (the draft, minus respond_to_task_request)', () => {
    const { text } = compose(caps());
    expect([...namedTools(text)].sort()).toEqual(
      [
        'delegate_task',
        'list_delegation_targets',
        'list_agents',
        'continue_task',
        'get_task',
        'get_task_events',
        'wait_session',
        'interrupt_task',
        'send_to_session',
        'interrupt_session',
        'list_project_activity',
        'claim_work',
        'release_claim',
        'html_preview',
        'html_render',
        'schedule_wake_up',
        'declare_pull_request',
        'notify_user',
        'browser_status',
        'browser_open',
        'browser_snapshot',
        'browser_close',
        'device_list',
        'device_open',
        'device_screenshot',
        'device_snapshot',
        'device_input',
        'list_tool_families',
        'load_tool_family',
      ].sort(),
    );
    expect(text).not.toContain('respond_to_task_request');
  });

  test('the registry holds what the text relies on being absent from it', () => {
    // Pins the real registry facts the fallback text depends on.
    expect(CATALOG).toContain('list_delegation_targets');
    expect(stationControlToolPolicy('list_delegation_targets')?.assurance).toBe(
      'bound',
    );
    expect(stationControlToolPolicy('device_open')?.assurance).toBe('bound');
    expect(CATALOG).toContain('list_agents');
  });
});

describe('assurance', () => {
  test('maps each engine to the assurance its station-control token channel yields', () => {
    const channelFor = {
      claude: 'sdk-in-process',
      codex: 'http-header-token',
      acp: 'http-header-token',
    } as const;
    for (const [engine, channel] of Object.entries(channelFor)) {
      expect(stationControlAssuranceFor(engine)).toBe(
        stationControlTokenAssurance(channel),
      );
    }
    expect(stationControlAssuranceFor('claude')).toBe('bound');
    expect(stationControlAssuranceFor('codex')).toBe('delegated-custody');
    expect(stationControlAssuranceFor('acp')).toBe('delegated-custody');
    expect(stationControlAssuranceFor('muse')).toBeUndefined();
    expect(stationControlAssuranceFor('station')).toBeUndefined();
  });
});

describe('effectiveStationControlTools', () => {
  test('defaults to the whole catalog filtered by listability', () => {
    const bound = effectiveStationControlTools({}, CATALOG, 'bound');
    const custody = effectiveStationControlTools(
      {},
      CATALOG,
      'delegated-custody',
    );
    expect(bound.has('device_open')).toBe(true);
    expect(custody.has('device_open')).toBe(false);
    expect(custody.has('list_delegation_targets')).toBe(false);
    expect(custody.has('delegate_task')).toBe(true);
    expect(custody.size).toBeLessThan(bound.size);
  });

  test('allowedTools wins over toolNames, disabledTools subtracts, unknown names are dropped', () => {
    const s = effectiveStationControlTools(
      {
        allowedTools: [
          'delegate_task',
          'list_agents',
          'not_a_tool',
          'get_task',
        ],
        toolNames: ['notify_user'],
        disabledTools: ['get_task'],
      },
      CATALOG,
      'bound',
    );
    expect([...s].sort()).toEqual(['delegate_task', 'list_agents']);
  });

  test('toolNames is used when there is no allowedTools', () => {
    const s = effectiveStationControlTools(
      { toolNames: ['notify_user', 'device_open'] },
      CATALOG,
      'delegated-custody',
    );
    expect([...s]).toEqual(['notify_user']);
  });
});

describe('composition', () => {
  test('returns undefined when nothing is offered', () => {
    expect(
      composeStationInstructions(
        caps({
          controlTools: new Set(),
          browser: false,
          devices: false,
          progressiveFamilies: false,
        }),
      ),
    ).toBeUndefined();
  });

  test('every capability combination stays inside the section and total byte bounds', () => {
    let composed = 0;
    for (const assurance of ASSURANCES) {
      for (const delegated of [false, true]) {
        for (const browser of [false, true]) {
          for (const devices of [false, true]) {
            for (const harness of ['claude', 'codex', 'acp', 'muse'] as const) {
              for (const progressiveFamilies of [false, true]) {
                const c = caps({
                  assurance,
                  delegated,
                  browser,
                  devices,
                  harness,
                  toolSearch: harness === 'claude',
                  progressiveFamilies,
                });
                const r = composeStationInstructions(c);
                if (!r) continue;
                composed++;
                expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(
                  STATION_INSTRUCTIONS_MAX_BYTES,
                );
                for (const s of r.sections) {
                  expect(Buffer.byteLength(s.text)).toBeLessThanOrEqual(
                    STATION_INSTRUCTION_SECTION_MAX_BYTES,
                  );
                  expect(s.text.trim().length).toBeGreaterThan(0);
                }
              }
            }
          }
        }
      }
    }
    expect(composed).toBeGreaterThan(50);
  });

  test('the full text is a real fraction of the limits, not trivially empty', () => {
    const r = compose(caps());
    expect(r.sections.map((s) => s.id)).toEqual([
      'orchestration',
      'sessions',
      'replies',
      'browser',
      'devices',
      'tool-loading',
    ]);
    expect(Buffer.byteLength(r.text)).toBeGreaterThan(2_000);
  });

  test('bound checker rejects an oversized section and an oversized total', () => {
    const big = 'x'.repeat(STATION_INSTRUCTION_SECTION_MAX_BYTES + 1);
    expect(() =>
      assertStationInstructionBounds([{ id: 'a', text: big }], big),
    ).toThrow(/section "a"/);
    const ok = 'y'.repeat(STATION_INSTRUCTION_SECTION_MAX_BYTES);
    expect(() =>
      assertStationInstructionBounds(
        [{ id: 'a', text: ok }],
        'z'.repeat(STATION_INSTRUCTIONS_MAX_BYTES + 1),
      ),
    ).toThrow(/Station instructions are/);
    expect(() =>
      assertStationInstructionBounds([{ id: 'a', text: ok }], ok),
    ).not.toThrow();
  });

  test('removing any single tool removes every mention of it', () => {
    const full = caps();
    const baseline = namedTools(compose(full).text);
    for (const tool of full.controlTools) {
      if (!baseline.has(tool)) continue;
      const without = new Set(full.controlTools);
      without.delete(tool);
      const r = composeStationInstructions({ ...full, controlTools: without });
      expect(namedTools(r?.text ?? ''), `after removing ${tool}`).not.toContain(
        tool,
      );
    }
  });

  test('omits whole sections when their tools are not offered', () => {
    const only = (...names: string[]) =>
      composeStationInstructions(
        caps({
          controlTools: new Set(names),
          browser: false,
          devices: false,
          progressiveFamilies: false,
          toolSearch: false,
        }),
      );
    expect(only('notify_user')?.sections.map((s) => s.id)).toEqual(['replies']);
    expect(only('wait_session')?.sections.map((s) => s.id)).toEqual([
      'sessions',
    ]);
    expect(only('list_agents', 'get_task')).toBeUndefined();
    expect(only('delegate_task')?.sections.map((s) => s.id)).toEqual([
      'orchestration',
    ]);
    // device tools offered but devices disabled, or the reverse
    expect(
      composeStationInstructions(
        caps({ devices: false, browser: false, progressiveFamilies: false }),
      )?.sections.map((s) => s.id),
    ).not.toContain('devices');
    expect(
      composeStationInstructions(
        caps({
          controlTools: new Set(['notify_user']),
          devices: true,
          browser: false,
          progressiveFamilies: false,
          toolSearch: false,
        }),
      )?.sections.map((s) => s.id),
    ).toEqual(['replies']);
  });

  test('orchestration discovery follows what is offered', () => {
    const base = ['delegate_task', 'wait_session'];
    const withTargets = compose(
      caps({
        controlTools: new Set([
          ...base,
          'list_delegation_targets',
          'list_agents',
        ]),
      }),
    ).text;
    expect(withTargets).toContain('call `list_delegation_targets` once');
    expect(withTargets).toContain('use `list_agents` and delegate only');

    const targetsOnly = compose(
      caps({ controlTools: new Set([...base, 'list_delegation_targets']) }),
    ).text;
    expect(targetsOnly).toContain('If it is refused, delegate only');
    expect(namedTools(targetsOnly)).not.toContain('list_agents');

    const agentsOnly = compose(
      caps({ controlTools: new Set([...base, 'list_agents']) }),
    ).text;
    expect(agentsOnly).toContain('call `list_agents` once');
    expect(namedTools(agentsOnly)).not.toContain('list_delegation_targets');

    const neither = compose(caps({ controlTools: new Set(base) })).text;
    expect(neither).toContain('Delegate only to an Agent the user named.');
  });
});

describe('assurance filtering', () => {
  test('a non-bound caller is never told about bound-only tools', () => {
    const boundOnly = CATALOG.filter(
      (n) => stationControlToolPolicy(n)?.assurance === 'bound',
    );
    expect(boundOnly.length).toBeGreaterThan(10);
    for (const assurance of ['delegated-custody', 'bearer-exposed'] as const) {
      const r = compose(
        caps({ assurance, harness: 'codex', toolSearch: false }),
      );
      const named = namedTools(r.text);
      for (const n of boundOnly)
        expect(named, `${assurance}: ${n}`).not.toContain(n);
      expect(r.sections.map((s) => s.id)).not.toContain('devices');
      // the fallback is named instead
      expect(named).toContain('list_agents');
      expect(named).not.toContain('list_delegation_targets');
    }
  });

  test('every assurance names only tools its effective set offers', () => {
    for (const assurance of ASSURANCES) {
      const c = caps({ assurance });
      const r = compose(c);
      const allowed = new Set([...c.controlTools, ...BROWSER, ...DISCOVERY]);
      for (const n of namedTools(r.text)) {
        expect(allowed.has(n), `${assurance}: ${n}`).toBe(true);
      }
    }
  });
});

describe('delegated child', () => {
  test('replaces orchestration and offers neither delegate_task nor send_message', () => {
    const c = caps({ delegated: true });
    expect(c.controlTools.has('delegate_task')).toBe(true);
    const r = compose(c);
    const ids = r.sections.map((s) => s.id);
    expect(ids).toContain('delegated-child');
    expect(ids).not.toContain('orchestration');
    for (const s of r.sections) {
      if (s.id === 'delegated-child') continue;
      const named = namedTools(s.text);
      expect(named, s.id).not.toContain('delegate_task');
      expect(named, s.id).not.toContain('send_message');
    }
    // the tool-loading line never asks to load the refused tools
    const loading = r.sections.find((s) => s.id === 'tool-loading')?.text ?? '';
    expect(loading).toContain('select:');
    expect(loading).not.toContain('delegate_task');
    expect(loading).not.toContain('send_message');
    // the child section states the prohibition rather than offering
    const child =
      r.sections.find((s) => s.id === 'delegated-child')?.text ?? '';
    expect(child).toContain('may not use `delegate_task` or `send_message`');
  });

  test('says nothing about delegation when neither tool is offered', () => {
    const tools = new Set(['wait_session', 'notify_user']);
    const r = compose(caps({ delegated: true, controlTools: tools }));
    expect(r.sections.map((s) => s.id)).not.toContain('delegated-child');
    expect(r.text).not.toContain('delegate_task');
  });
});

describe('tool loading', () => {
  const loadingOf = (c: StationInstructionCapabilities) =>
    composeStationInstructions(c)?.sections.find((s) => s.id === 'tool-loading')
      ?.text ?? '';

  test('Claude ToolSearch line selects exactly the tools named above, with the right server prefixes', () => {
    const r = compose(caps({ progressiveFamilies: false }));
    const loading = r.sections.find((s) => s.id === 'tool-loading')?.text ?? '';
    const m = loading.match(/select:([^`]+)`/);
    expect(m).not.toBeNull();
    const selected = (m?.[1] ?? '').split(',');
    const aboveText = r.sections
      .filter((s) => s.id !== 'tool-loading')
      .map((s) => s.text)
      .join('\n');
    const above = namedTools(aboveText);
    const expected = [...above].map((n) =>
      BROWSER.includes(n)
        ? `mcp__station-browser__${n}`
        : `mcp__station-control__${n}`,
    );
    expect(selected.sort()).toEqual(expected.sort());
    expect(
      selected.some((s) => s === 'mcp__station-browser__browser_open'),
    ).toBe(true);
    expect(
      selected.some((s) => s === 'mcp__station-control__delegate_task'),
    ).toBe(true);
    expect(
      selected.every((s) =>
        /^mcp__station-(control|browser)__[a-z_]+$/.test(s),
      ),
    ).toBe(true);
  });

  test('is absent for non-Claude harnesses and when ToolSearch is off', () => {
    expect(
      loadingOf(caps({ harness: 'codex', progressiveFamilies: false })),
    ).toBe('');
    expect(
      loadingOf(caps({ toolSearch: false, progressiveFamilies: false })),
    ).toBe('');
    expect(
      loadingOf(
        caps({
          toolSearch: true,
          harness: 'claude',
          progressiveFamilies: false,
        }),
      ),
    ).toContain('ToolSearch');
  });

  test('progressive families line appears only when enabled and names the discovery tools', () => {
    expect(loadingOf(caps({ harness: 'codex', toolSearch: false }))).toContain(
      '`list_tool_families`, then `load_tool_family`',
    );
    expect(
      loadingOf(
        caps({
          harness: 'codex',
          toolSearch: false,
          progressiveFamilies: false,
        }),
      ),
    ).toBe('');
  });

  test('browser tools are only loaded when the browser is delivered', () => {
    const loading = loadingOf(
      caps({ browser: false, progressiveFamilies: false }),
    );
    expect(loading).toContain('mcp__station-control__');
    expect(loading).not.toContain('mcp__station-browser__');
  });
});

describe('digest and wrapper', () => {
  test('digest is a stable hash of the composed text', () => {
    const a = compose(caps());
    const b = compose(caps());
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{16}$/);
    const c = compose(caps({ browser: false }));
    expect(c.digest).not.toBe(a.digest);
  });

  test('wraps first-turn text in a station_instructions tag', () => {
    expect(wrapFirstTurnStationInstructions('hello')).toBe(
      '<station_instructions>\nhello\n</station_instructions>',
    );
  });
});
