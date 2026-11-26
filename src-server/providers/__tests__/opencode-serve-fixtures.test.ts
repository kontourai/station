import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  credentialScrubRows,
  scrubText,
} from './fixtures/capture-opencode-serve-scrub.mjs';

const OPENCODE_BASIC_PREFIX = Buffer.from('opencode:').toString('base64');

/**
 * The OpenCode 2.3.0 `serve` captures (`capture-opencode-serve-fixtures.mjs`):
 * that they hold nothing of the machine they were recorded on, and what they
 * settled about the wire before the native transport relies on it.
 */

const DIR = new URL('./fixtures/', import.meta.url);
const PREFIX = 'opencode-serve-2.3.0-';

const files = readdirSync(DIR).filter((name) => name.startsWith(PREFIX));
const read = (name: string) => readFileSync(new URL(name, DIR), 'utf8');

type Line = {
  t: number;
  kind: string;
  method?: string;
  path?: string;
  status?: number;
  response?: any;
  event?: any;
  dir?: string;
  msg?: any;
  text?: string;
};

function lines(scenario: string): Line[] {
  return read(`${PREFIX}${scenario}.jsonl`)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

describe('OpenCode serve captures', () => {
  test('every scenario the native transport replays was captured', () => {
    expect(files.sort()).toEqual(
      [
        'attachment',
        'basic',
        'boot',
        'catalog',
        'compact',
        'crossload',
        'debug-agents',
        'governed',
        'history',
        'interrupt',
        'interrupt-pending',
        'mcp',
        'mcp-add',
        'mode-switch',
        'move',
        'move-denied',
        'move-gap',
        'permission-allow',
        'permission-reject',
        'permission-saved',
        'plan-deny',
        'question',
        'reasoning',
        'reasoning-reconnect',
        'reconnect',
        'revert',
        'steer',
        'stop-pending',
        'subagent',
        'subagent-gap',
        'tools',
      ]
        .map((name) => `${PREFIX}${name}.jsonl`)
        .concat(`${PREFIX}openapi.json`)
        .sort(),
    );
  });

  test('the capture scrubber removes every credential form', () => {
    const password = 'p'.repeat(43);
    const basic = Buffer.from(`opencode:${password}`).toString('base64');
    expect(basic.startsWith(OPENCODE_BASIC_PREFIX)).toBe(true);
    const recorded = JSON.stringify({
      headers: { authorization: `Basic ${basic}` },
      echoed: basic,
      env: { OPENCODE_PASSWORD: password },
    });
    const out = scrubText(recorded, credentialScrubRows('opencode', password));
    expect(out).not.toContain(password);
    expect(out).not.toContain(OPENCODE_BASIC_PREFIX);
    expect(out).toContain('"authorization":"Basic {AUTH}"');
    expect(out).toContain('"echoed":"{AUTH}"');
  });

  test('the captures hold no machine path, credential or private name', () => {
    const allowed = new Set([
      '{PROJ}',
      '{HOME}',
      '{WORK}',
      '{BIN}',
      '{USERHOME}',
      '{HOSTNAME}',
      '{USER}',
      '{AUTH}',
    ]);
    for (const name of files) {
      const text = read(name);
      // A path under a placeholder (`{WORK}/tmp/opencode`) was scrubbed.
      const unscrubbed = text.replace(/\{[A-Z]+\}[\w./-]*/g, '');
      for (const token of [
        '/Users/',
        '/home/',
        '/private/',
        '/tmp/',
        '/var/folders',
        'oc-research',
        'C:\\\\',
        'brian',
        'kontour',
        // A request header, never the API's own prose about authorization.
        '"authorization"',
        'OPENCODE_PASSWORD',
        '{PASSWORD}',
      ]) {
        expect(unscrubbed.toLowerCase(), `${name}: ${token}`).not.toContain(
          token.toLowerCase(),
        );
      }
      expect(text, name).not.toMatch(/Basic [A-Za-z0-9+/=]{16,}/);
      // `base64("opencode:")`: the start of any Basic credential for the
      // server's user, prefixed or bare.
      expect(text, name).not.toContain(OPENCODE_BASIC_PREFIX);
      const placeholders = text.match(/\{[A-Z]+\}/g) ?? [];
      expect(
        placeholders.filter((token) => !allowed.has(token)),
        name,
      ).toEqual([]);
    }
  });

  test('(a) an ACP session id is the native session id, both ways', () => {
    const crossload = lines('crossload');
    const created = crossload.find(
      (line) =>
        line.kind === 'http' &&
        line.method === 'POST' &&
        line.path === '/api/session',
    );
    const nativeId = created?.response.data.id as string;
    const load = crossload.find(
      (line) =>
        line.kind === 'acp' &&
        line.dir === '->' &&
        line.msg.method === 'session/load',
    );
    expect(load?.msg.params.sessionId).toBe(nativeId);
    const loaded = crossload.find(
      (line) =>
        line.kind === 'acp' &&
        line.dir === '<-' &&
        line.msg.id === load?.msg.id,
    );
    expect(loaded?.msg.error).toBeUndefined();

    const sessionNew = crossload.find(
      (line) =>
        line.kind === 'acp' &&
        line.dir === '->' &&
        line.msg.method === 'session/new',
    );
    const acpId = crossload.find(
      (line) =>
        line.kind === 'acp' &&
        line.dir === '<-' &&
        line.msg.id === sessionNew?.msg.id,
    )?.msg.result.sessionId as string;
    expect(acpId).toMatch(/^ses_/);
    const viaNative = crossload.find(
      (line) => line.kind === 'http' && line.path === `/api/session/${acpId}`,
    );
    expect(viaNative?.status).toBe(200);
    expect(viaNative?.response.data.id).toBe(acpId);
  });

  test('(b) a user turn message id is the prompt answer id, and its inbox id', () => {
    const steer = lines('steer');
    const prompts = steer.filter(
      (line) => line.kind === 'http' && line.path?.endsWith('/prompt'),
    );
    expect(prompts).toHaveLength(3);
    const history = steer
      .filter((line) => line.kind === 'http' && line.path?.includes('/message'))
      .at(-1)
      ?.response.data.filter((message: any) => message.type === 'user')
      .map((message: any) => message.id);
    const enqueued = steer
      .filter((line) => line.event?.type === 'session.inbox.enqueued')
      .map((line) => line.event.data.inboxID);
    const delivered = steer
      .filter((line) => line.event?.type === 'session.inbox.delivered')
      .map((line) => line.event.data.inboxID);
    const cancelled = steer
      .filter((line) => line.event?.type === 'session.inbox.cancelled')
      .map((line) => line.event.data.inboxID);
    const [first, withdrawn, steered] = prompts.map(
      (line) => line.response.data.id as string,
    );
    expect(enqueued).toEqual([first, withdrawn, steered]);
    expect(delivered).toEqual([first, steered]);
    expect(cancelled).toEqual([withdrawn]);
    expect(history).toEqual(expect.arrayContaining([first, steered]));
    expect(history).not.toContain(withdrawn);
  });

  test('(c) 2.x has no `debug agent <name>`; `debug agents` lists configured rules only', () => {
    const runs = lines('debug-agents').filter((line) => line.kind === 'cli');
    const [agents, single] = runs as Array<Line & Record<string, any>>;
    expect(agents?.args).toEqual(['debug', 'agents', '--standalone']);
    expect(agents?.status).toBe(0);
    const build = agents?.stdout.find((agent: any) => agent.id === 'build');
    expect(build.permissions[0]).toEqual(
      expect.objectContaining({ action: '*', resource: '*' }),
    );
    expect(single?.args).toEqual(['debug', 'agent', 'build']);
    expect(single?.status).toBe(1);
    expect(single?.stderr).toContain('Unknown subcommand "agent"');
  });

  test('(d) just after /api/info is ready, GET /api/agent/{id} is briefly 404', () => {
    const boot = lines('boot').filter((line) => line.kind === 'http');
    const ready = boot.findIndex(
      (line) => line.path === '/api/info' && line.status === 200,
    );
    const agent = boot.slice(ready + 1);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(agent[0]).toMatchObject({
      path: '/api/agent/build',
      status: 404,
      response: { _tag: 'AgentNotFoundError', agentID: 'build' },
    });
    expect(agent.at(-1)).toMatchObject({ status: 200 });
  });

  test('(e) PATCH permissions:null keeps the session rules; [] clears them', () => {
    const http = lines('mode-switch').filter((line) => line.kind === 'http');
    const at = (body: unknown) =>
      http.findIndex(
        (line) =>
          line.method === 'PATCH' &&
          JSON.stringify((line as { body?: unknown }).body) ===
            JSON.stringify(body),
      );
    const afterNull = http[at({ permissions: null }) + 1];
    const afterEmpty = http[at({ permissions: [] }) + 1];
    expect(afterNull?.method).toBe('GET');
    expect(afterNull?.response.data.permissions.length).toBeGreaterThan(0);
    expect(afterEmpty?.response.data.permissions).toEqual([]);
  });

  test('(f) an interrupt drops a pending ask without permission.replied; a late answer is 404', () => {
    const scenario = lines('interrupt-pending');
    expect(
      scenario.some((line) => line.event?.type === 'permission.asked'),
    ).toBe(true);
    expect(
      scenario.some(
        (line) => line.event?.type === 'session.execution.interrupted',
      ),
    ).toBe(true);
    expect(
      scenario.some((line) => line.event?.type === 'permission.replied'),
    ).toBe(false);
    expect(
      scenario.find(
        (line) => line.kind === 'http' && line.path?.endsWith('/reply'),
      )?.status,
    ).toBe(404);
  });

  test("(g) Station's asks after the plan agent's deny make OpenCode ask; a reject fails the edit", () => {
    const scenario = lines('plan-deny');
    const asked = scenario.find(
      (line) => line.event?.type === 'permission.asked',
    );
    expect(asked?.event?.data).toMatchObject({
      action: 'edit',
      resources: ['edit-me.txt'],
    });
    expect(
      scenario.find((line) => line.event?.type === 'session.tool.failed')?.event
        ?.data,
    ).toMatchObject({ error: { message: 'The user declined this tool call' } });
  });

  test("(i) Code Mode's session move asks nothing and loads the destination first; denied, the tool is not offered", () => {
    const move = lines('move');
    expect(move.some((line) => line.event?.type === 'permission.asked')).toBe(
      false,
    );
    expect(
      move.find((line) => line.event?.type === 'session.moved')?.event?.data,
    ).toMatchObject({ location: { directory: '{PROJ}/sub' }, subpath: 'sub' });
    expect(move.find((line) => line.kind === 'finding')?.text).toContain(
      'the nested plugin ran before the event was published',
    );
    const denied = lines('move-denied');
    expect(denied.some((line) => line.event?.type === 'session.moved')).toBe(
      false,
    );
    expect(
      JSON.stringify(
        denied.find((line) => line.event?.type === 'session.tool.success')
          ?.event?.data,
      ),
    ).toContain("Unknown tool 'opencode.session_move'");
    expect(denied.find((line) => line.kind === 'finding')?.text).toContain(
      'the plugin never ran',
    );
  });

  test('(j) a grandchild ask raised with no feed open is listed by the location, and found by parentID', () => {
    const gap = lines('subagent-gap');
    const lists = gap.filter(
      (line) =>
        line.kind === 'http' && line.path?.startsWith('/api/session?parentID='),
    ) as Array<{ response: { data: Array<{ id: string; parentID: string }> } }>;
    const child = lists[0]?.response.data[0];
    const grandchild = lists[1]?.response.data[0];
    expect(grandchild?.parentID).toBe(child?.id);
    const pending = gap.find(
      (line) => line.kind === 'http' && line.path === '/api/permission/request',
    )?.response as { data: Array<{ sessionID: string }> };
    expect(pending.data.map((ask) => ask.sessionID)).toEqual([grandchild?.id]);
  });

  test('(h) history is paged: 50 messages by default, newest first with a cursor that carries its order', () => {
    const reads = lines('history').filter(
      (line) => line.kind === 'http' && line.path?.includes('/message?'),
    );
    const first = reads[0]?.response as { data: unknown[] };
    expect(first.data).toHaveLength(50);
    const pages = reads.slice(1, -1) as Array<{
      response: { data: Array<{ id: string }>; cursor: { next?: string } };
    }>;
    const total = pages.reduce(
      (sum, page) => sum + page.response.data.length,
      0,
    );
    expect(total).toBeGreaterThan(50);
    const cursor = JSON.parse(
      Buffer.from(pages[0]?.response.cursor.next ?? '', 'base64url').toString(
        'utf8',
      ),
    );
    expect(cursor).toEqual({
      id: pages[0]?.response.data.at(-1)?.id,
      order: 'desc',
      direction: 'next',
    });
    // A cursor cannot be combined with an order.
    expect(reads.at(-1)?.status).toBe(400);
  });
});
