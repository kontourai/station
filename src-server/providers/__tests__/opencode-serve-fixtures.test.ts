import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

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
        'basic',
        'catalog',
        'compact',
        'crossload',
        'debug-agents',
        'interrupt',
        'mcp',
        'permission-allow',
        'permission-reject',
        'permission-saved',
        'question',
        'reconnect',
        'revert',
        'steer',
        'subagent',
        'tools',
      ]
        .map((name) => `${PREFIX}${name}.jsonl`)
        .concat(`${PREFIX}openapi.json`)
        .sort(),
    );
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
});
