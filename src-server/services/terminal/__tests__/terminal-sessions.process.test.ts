import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileTerminalHistoryStore } from '../../../adapters/file-terminal-history-store.js';
import { NodePtyAdapter } from '../../../adapters/node-pty-adapter.js';
import { createTerminalSessionRoutes } from '../../../routes/projects/terminal-session-routes.js';
import { InProcessShellHost } from '../shell-host.js';
import {
  TerminalJournal,
  type TerminalJournalOptions,
} from '../terminal-journal.js';
import { TerminalService } from '../terminal-service.js';
import { TerminalSessions } from '../terminal-sessions.js';

const makeTempDir = trackTempDirs();
const scope = { projectId: 'project-a', bindingKey: 'project' };
const dimensions = { cols: 80, rows: 24 };

// POSIX shell fixture. ConPTY/Windows is explicitly unqualified by this lane.
describe.skipIf(process.platform === 'win32')(
  'durable terminal sessions with real node-pty',
  () => {
    let home: string;
    let root: string;
    let sessions: TerminalSessions<Request>;
    let routes: ReturnType<typeof createTerminalSessionRoutes>;
    const grants = new Map<string, 'operate' | 'observe'>();
    const request = (principal = 'operator') =>
      new Request('http://localhost:43994', {
        headers: { 'x-test-principal': principal },
      });
    const principalOf = (req: Request) =>
      req.headers.get('x-test-principal') ?? '';

    function create(options: Partial<TerminalJournalOptions> = {}) {
      sessions = new TerminalSessions(
        home,
        new InProcessShellHost(new NodePtyAdapter(), () => '/bin/sh'),
        {
          authorize: (principal, target, operation) => {
            const grant = grants.get(principalOf(principal));
            return (
              ['project-a', 'project-b'].includes(target.projectId) &&
              ['project', 'thread:one'].includes(target.bindingKey) &&
              (grant === 'operate' ||
                (grant === 'observe' && operation === 'observe'))
            );
          },
          resolveRoot: async (_principal, target) =>
            target.projectId === 'project-a' ? root : join(home, 'b'),
        },
        options,
      );
      routes = createTerminalSessionRoutes(
        sessions,
        (slug) => (slug === 'alpha' ? 'project-a' : 'project-b'),
        (req) => grants.has(principalOf(req)),
      );
    }

    async function call(
      path: string,
      method = 'GET',
      body?: unknown,
      principal = 'operator',
    ) {
      return routes.request(
        `http://localhost:43994/alpha/terminal-sessions${path}`,
        {
          method,
          headers: {
            'content-type': 'application/json',
            'x-test-principal': principal,
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        },
      );
    }

    async function output(id: string, marker: string) {
      await expect
        .poll(
          async () => {
            const snapshot = await sessions.read(request(), scope, id);
            return snapshot.journal.records
              .map((record) => record.data)
              .join('');
          },
          { timeout: 10_000 },
        )
        .toContain(marker);
      return sessions.read(request(), scope, id);
    }

    beforeEach(async () => {
      home = makeTempDir('station-terminal-3994-');
      root = join(home, 'a');
      await mkdir(root);
      await mkdir(join(home, 'b'));
      grants.clear();
      grants.set('operator', 'operate');
      grants.set('observer', 'observe');
      create();
    });

    afterEach(async () => {
      await sessions.dispose();
    });

    test('reconnect resumes a live PTY and a new service reads its durable identity and output without re-running it', async () => {
      const first = await sessions.open(request(), scope, dimensions);
      expect(first.terminalId).toMatch(/^[0-9a-f-]{36}$/);
      await sessions.write(
        request(),
        scope,
        first.terminalId,
        "printf '%s%s\\n' 'proof:' 'first'\r",
      );
      const before = await output(first.terminalId, 'proof:first');
      const reconnect = await call(
        `/${first.terminalId}?fromSeq=${before.journal.lastSeq}`,
      );
      expect(reconnect.status).toBe(200);
      await sessions.write(
        request(),
        scope,
        first.terminalId,
        "printf '%s%s\\n' 'proof:' 'second'\r",
      );
      await output(first.terminalId, 'proof:second');
      const resumed = await sessions.read(
        request(),
        scope,
        first.terminalId,
        before.journal.lastSeq,
      );
      expect(resumed.pid).toBe(first.pid);
      expect(
        resumed.journal.records.every(
          (record) => record.seq > before.journal.lastSeq,
        ),
      ).toBe(true);
      expect(
        resumed.journal.records.map((record) => record.data).join(''),
      ).not.toContain('proof:first');
      await sessions.dispose();
      create();
      const restored = await sessions.read(request(), scope, first.terminalId);
      expect(restored.status).toBe('exited');
      expect(restored.pid).toBeNull();
      expect(
        restored.journal.records.map((record) => record.data).join(''),
      ).toContain('proof:second');
      await expect(
        sessions.write(
          request(),
          scope,
          first.terminalId,
          'echo should-not-run\r',
        ),
      ).rejects.toThrow('ended');
    });

    test('cwd traversal and symlink escapes are refused before a real shell starts', async () => {
      await symlink(join(home, 'b'), join(root, 'escape'), 'dir');
      for (const subdirectory of ['../b', 'escape', join(home, 'b')]) {
        const response = await call('', 'POST', {
          ...dimensions,
          subdirectory,
        });
        expect(response.status).toBe(403);
      }
      expect(await sessions.list(request(), scope)).toEqual([]);
      await mkdir(join(root, 'inside'));
      const allowed = await sessions.open(request(), scope, {
        ...dimensions,
        subdirectory: 'inside',
      });
      await sessions.write(
        request(),
        scope,
        allowed.terminalId,
        'printf \'cwd:%s\\n\' "$PWD"\r',
      );
      const canonical = await realpath(join(root, 'inside'));
      const snapshot = await output(allowed.terminalId, `cwd:${canonical}`);
      expect(snapshot.cwd).toBe(canonical);
    });

    test('a principal granted both Projects and bindings cannot name a terminal through another scope', async () => {
      const opened = await sessions.open(request(), scope, dimensions);
      const otherProject = await routes.request(
        `http://localhost:43994/beta/terminal-sessions/${opened.terminalId}`,
        { headers: { 'x-test-principal': 'operator' } },
      );
      expect(otherProject.status).toBe(403);
      const otherBinding = await call(
        `/${opened.terminalId}?bindingKey=thread:one`,
      );
      expect(otherBinding.status).toBe(403);
      for (const target of [
        { projectId: 'project-b', bindingKey: 'project' },
        { projectId: 'project-a', bindingKey: 'thread:one' },
      ]) {
        await expect(
          sessions.write(
            request(),
            target,
            opened.terminalId,
            'echo escaped\r',
          ),
        ).rejects.toThrow('not found');
        await expect(
          sessions.resize(request(), target, opened.terminalId, 90, 30),
        ).rejects.toThrow('not found');
        await expect(
          sessions.close(request(), target, opened.terminalId),
        ).rejects.toThrow('not found');
      }
      await sessions.write(
        request(),
        scope,
        opened.terminalId,
        "printf '%s%s\\n' 'scope:' 'alive'\r",
      );
      await output(opened.terminalId, 'scope:alive');
    });

    test('observers can read but cannot create, type, resize or close; revoked principals cannot read', async () => {
      const opened = await sessions.open(request(), scope, dimensions);
      expect(
        (await call(`/${opened.terminalId}`, 'GET', undefined, 'observer'))
          .status,
      ).toBe(200);
      expect((await call('', 'POST', dimensions, 'observer')).status).toBe(403);
      expect(
        (
          await call(
            `/${opened.terminalId}/input`,
            'POST',
            { data: "printf '%s%s\\n' 'observer:' 'wrote'\r" },
            'observer',
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            `/${opened.terminalId}/resize`,
            'POST',
            dimensions,
            'observer',
          )
        ).status,
      ).toBe(403);
      expect(
        (await call(`/${opened.terminalId}`, 'DELETE', undefined, 'observer'))
          .status,
      ).toBe(403);
      grants.delete('operator');
      await expect(
        sessions.read(request(), scope, opened.terminalId),
      ).rejects.toThrow('refused');
      grants.set('operator', 'operate');
      await sessions.write(
        request(),
        scope,
        opened.terminalId,
        "printf '%s%s\\n' 'operator:' 'wrote'\r",
      );
      const snapshot = await output(opened.terminalId, 'operator:wrote');
      expect(
        snapshot.journal.records.map((record) => record.data).join(''),
      ).not.toContain('observer:wrote');
    });

    test('disk and memory journals bound lines and UTF-8 bytes and signal a lost resume window', async () => {
      await sessions.dispose();
      create({
        maxBytes: 4096,
        maxLines: 12,
        tailBytes: 1024,
        tailLines: 4,
        segmentBytes: 1024,
      });
      const opened = await sessions.open(request(), scope, dimensions);
      await sessions.write(
        request(),
        scope,
        opened.terminalId,
        "i=0; while [ $i -lt 160 ]; do printf '界🙂0123456789\\n'; i=$((i+1)); done; printf '%s%s\\n' 'bounds:' 'done'\r",
      );
      const snapshot = await output(opened.terminalId, 'bounds:done');
      const text = snapshot.journal.records
        .map((record) => record.data)
        .join('');
      expect(snapshot.journal.reset).toBe(true);
      expect(text.split('\n').length).toBeLessThanOrEqual(13);
      expect(text).not.toContain('\ufffd');
      const directory = join(home, 'terminal-journals', opened.terminalId);
      const files = (await readdir(directory)).filter((name) =>
        name.endsWith('.jsonl'),
      );
      const sizes = await Promise.all(
        files.map(async (name) => (await stat(join(directory, name))).size),
      );
      expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4096);
      const last = snapshot.journal.records.at(-1)!;
      expect(
        (await sessions.read(request(), scope, opened.terminalId, last.seq))
          .journal.records,
      ).toEqual([]);
      await sessions.dispose();
      create({ persist: false, tailBytes: 1024, tailLines: 4 });
      const memory = await sessions.open(request(), scope, dimensions);
      await sessions.write(
        request(),
        scope,
        memory.terminalId,
        "i=0; while [ $i -lt 160 ]; do printf '界🙂0123456789\\n'; i=$((i+1)); done; printf '%s%s' 'memory:' 'done'\r",
      );
      const memoryText = (
        await output(memory.terminalId, 'memory:done')
      ).journal.records
        .map((record) => record.data)
        .join('');
      expect(Buffer.byteLength(memoryText)).toBeLessThanOrEqual(1024);
      expect(memoryText.split('\n').length).toBeLessThanOrEqual(5);
      expect(memoryText).not.toContain('\ufffd');
      expect(await readdir(join(home, 'terminal-journals'))).not.toContain(
        memory.terminalId,
      );
    });

    test('newline-free Unicode output hits the byte cap independently of the line cap', async () => {
      await sessions.dispose();
      create({
        maxBytes: 4096,
        maxLines: 100000,
        tailBytes: 1024,
        tailLines: 100000,
        segmentBytes: 1024,
      });
      const opened = await sessions.open(request(), scope, dimensions);
      await sessions.write(
        request(),
        scope,
        opened.terminalId,
        "i=0; while [ $i -lt 4096 ]; do printf '界🙂'; i=$((i+1)); done; printf '%s%s' 'bytes:' 'done'\r",
      );
      const snapshot = await output(opened.terminalId, 'bytes:done');
      const text = snapshot.journal.records
        .map((record) => record.data)
        .join('');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
      for (const record of snapshot.journal.records)
        expect(Buffer.from(record.data).toString('utf8')).toBe(record.data);
      expect(text).not.toContain('\ufffd');
      expect(snapshot.journal.reset).toBe(true);
      const directory = join(home, 'terminal-journals', opened.terminalId);
      const sizes = await Promise.all(
        (await readdir(directory)).map(
          async (name) => (await stat(join(directory, name))).size,
        ),
      );
      expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4096);
    });

    test('queries split across callbacks and surrogate pairs are sanitized before numbering and persistence', async () => {
      const journal = new TerminalJournal(join(home, 'filter'));
      await journal.load();
      await journal.append('visible\x1b[');
      await journal.append('\x006n\x1b]0');
      await journal.append(
        '10;?\x07\x1b]0011;?\x1b\\\x1b]00012;?\x07\x1bP0$qm\x1b\\\x1bP01+q544e\x1b\\\x1b[',
      );
      await journal.append('6n\x1b[?1u\x1b[>0q\x1b[?1$p\x1b]10;');
      await journal.append('?\x07\x1b[\x006n\x1b\x1b[');
      await journal.append(
        '6n\x1b\x00[6n\x1bP$\x00qm\x1b\\\x1b]0;unfinished\x1b]10;?\x07\x1b]10;',
      );
      await journal.append('?\x07\x1b]11;rgb:ff/ff/ff\x1b');
      await journal.append('\\\x1bP>|version\x1b\\\x1b[31mred\x1b[0m\ud83d');
      await journal.append('\ude42done');
      const replay = await journal.read();
      expect(replay.records.map((record) => record.data).join('')).toBe(
        'visible\x1b[31mred\x1b[0m🙂done',
      );
      expect(replay.records.map((record) => record.seq)).toEqual([1, 2, 3]);
      const restored = new TerminalJournal(join(home, 'filter'));
      await restored.load();
      expect((await restored.read()).records).toEqual(replay.records);
    });

    test.each([
      ['nested C1 CSI', '\x1b[\x9b6n'],
      ['OSC interrupted by C1 CSI', '\x1b]0;discard\x9b6n'],
      ['DCS interrupted by C1 CSI', '\x1bPdiscard\x9b6n'],
      ['CSI interrupted by C1 OSC', '\x1b[\x9d010;?\x07'],
      ['palette query', '\x1b]4;1;?\x07'],
      ['clipboard query', '\x1b]52;c;?\x07'],
      ['modifier-key query', '\x1b[?4m'],
      ['graphics query', '\x1b[?1;1;0S'],
      ['window-size query', '\x1b[18t'],
      ['legacy device attributes', '\x1bZ'],
      ['answerback', '\x05'],
      ['parameterized status string', '\x1bP0$qm\x1b\\'],
      ['nested C1 DCS', '\x1b[\x90$qm\x9c'],
      ['mode query with subparameters', '\x1b[?1:2$p'],
      ['DCS interrupted by C1 OSC', '\x1bPdiscard\x9d0012;?\x9c'],
      ['application string interrupted by C1 CSI', '\x1b_\x9b6n'],
    ])(
      'reply-producing %s is omitted whole and split across persisted callbacks',
      async (_name, query) => {
        for (const [index, chunks] of [[query], [...query]].entries()) {
          const directory = join(home, `query-${index}`);
          const journal = new TerminalJournal(directory);
          await journal.load();
          await journal.append('left');
          for (const chunk of chunks) await journal.append(chunk);
          await journal.append('right');
          expect(
            (await journal.read()).records
              .map((record) => record.data)
              .join(''),
          ).toBe('leftright');
          const restored = new TerminalJournal(directory);
          await restored.load();
          expect(
            (await restored.read()).records
              .map((record) => record.data)
              .join(''),
          ).toBe('leftright');
        }
      },
    );

    test('replay retains supported rendering controls, titles and hyperlinks while omitting unsupported controls', async () => {
      const directory = join(home, 'rendering');
      const journal = new TerminalJournal(directory);
      await journal.load();
      const rendering =
        '\x1b7\x1b[2J\x1b[31mred\x1b[0m\x1b[?2004h\x1b[3 q\x1b]0;title\x07\x1b]8;;https://example.com\x1b\\label\x1b]8;;\x1b\\\x1b(B\x1b8';
      await journal.append(rendering);
      await journal.append('\x1b%@\x1bP1;2qgraphics\x1b\\');
      const restored = new TerminalJournal(directory);
      await restored.load();
      expect(
        (await restored.read()).records.map((record) => record.data).join(''),
      ).toBe(rendering);
    });

    test('tail line accounting treats partial callback records as one continuous line', async () => {
      const journal = new TerminalJournal(join(home, 'tail'), {
        persist: false,
        tailBytes: 1024,
        tailLines: 2,
      });
      await journal.load();
      for (const part of ['kept', ' as', ' one', ' line'])
        await journal.append(part);
      expect(
        (await journal.read()).records.map((record) => record.data).join(''),
      ).toBe('kept as one line');
      await journal.append('\nnew');
      expect(
        (await journal.read()).records.map((record) => record.data).join(''),
      ).toBe('kept as one line\nnew');
    });

    test('migrates the current history filename once into the first sanitized journal segment', async () => {
      const history = new FileTerminalHistoryStore(
        join(home, 'terminal-history'),
      );
      await history.save(
        'alpha:old_terminal',
        'legacy🙂\n\x1b[6n\x1b]10;?\x07safe\n',
        'project-a',
      );
      const opened = await sessions.open(request(), scope, {
        ...dimensions,
        legacy: { projectSlug: 'alpha', terminalId: 'old_terminal' },
      });
      expect(opened.journal.records[0]?.data).toBe('legacy🙂\nsafe\n');
      await sessions.dispose();
      await history.save('alpha:old_terminal', 'must not import twice\n');
      create();
      const mapped = await sessions.open(request(), scope, {
        ...dimensions,
        legacy: { projectSlug: 'alpha', terminalId: 'old_terminal' },
      });
      expect(mapped.terminalId).toBe(opened.terminalId);
      const replay = mapped.journal.records
        .map((record) => record.data)
        .join('');
      expect(replay.match(/legacy🙂/g)).toHaveLength(1);
      expect(replay).not.toContain('must not import twice');
      const metadata = JSON.parse(
        await readFile(join(home, 'terminal-sessions.json'), 'utf8'),
      );
      expect(metadata).toHaveLength(1);
      await expect(
        sessions.open(
          request(),
          { projectId: 'project-b', bindingKey: 'project' },
          {
            ...dimensions,
            legacy: { projectSlug: 'alpha', terminalId: 'old_terminal' },
          },
        ),
      ).rejects.toThrow('Ambiguous');
    });

    test('oversized unowned legacy history can be rewritten without inventing provenance', async () => {
      const directory = join(home, 'terminal-history');
      await mkdir(directory);
      const path = join(directory, 'alpha-big.txt');
      await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1));
      const history = new FileTerminalHistoryStore(directory);
      await expect(
        history.loadForProject('alpha:big', 'project-a'),
      ).rejects.toThrow('import bound');
      await history.save('alpha:big', 'bounded tail\n', 'project-a');
      expect(await readFile(path, 'utf8')).toBe('bounded tail\n');
      expect(
        (await history.loadForProject('alpha:big', 'project-a')).state,
      ).toBe('unavailable');
    });

    test('legacy provenance keeps the Project incarnation captured at shell open', async () => {
      const history = new FileTerminalHistoryStore(
        join(home, 'terminal-history'),
      );
      let projectId = 'project-a';
      const legacy = new TerminalService(
        new NodePtyAdapter(),
        history,
        () => '/bin/sh',
        () => projectId,
      );
      try {
        const opened = await legacy.open({
          projectSlug: 'alpha',
          terminalId: 'captured',
          cwd: root,
          ...dimensions,
        });
        projectId = 'project-b';
        legacy.write(
          opened.sessionId,
          "printf '%s%s' 'incarnation:' 'first'\r",
        );
        await expect
          .poll(() => legacy.readProcess(opened.sessionId)?.history, {
            timeout: 10000,
          })
          .toContain('incarnation:first');
        await legacy.close(opened.sessionId);
        expect(
          (await history.loadForProject(opened.sessionId, 'project-a')).state,
        ).toBe('owned');
        expect(
          (await history.loadForProject(opened.sessionId, 'project-b')).state,
        ).toBe('unavailable');
      } finally {
        await legacy.dispose();
      }
    });

    test('a wrong first claimant, an unowned raw history and changed history bytes cannot be imported', async () => {
      const history = new FileTerminalHistoryStore(
        join(home, 'terminal-history'),
      );
      await history.save(
        'alpha-beta:default',
        'other Project secret\n',
        'project-b',
      );
      await expect(
        sessions.open(request(), scope, {
          ...dimensions,
          legacy: { projectSlug: 'alpha', terminalId: 'beta-default' },
        }),
      ).rejects.toThrow('ownership unavailable');
      await writeFile(
        join(home, 'terminal-history', 'alpha-raw.txt'),
        'unowned old history\n',
      );
      await expect(
        sessions.open(request(), scope, {
          ...dimensions,
          legacy: { projectSlug: 'alpha', terminalId: 'raw' },
        }),
      ).rejects.toThrow('ownership unavailable');
      await history.save('alpha:raw', 'rewritten old history\n', 'project-a');
      await expect(
        sessions.open(request(), scope, {
          ...dimensions,
          legacy: { projectSlug: 'alpha', terminalId: 'raw' },
        }),
      ).rejects.toThrow('ownership unavailable');
      await history.save('alpha:changed', 'original\n', 'project-a');
      await writeFile(
        join(home, 'terminal-history', 'alpha-changed.txt'),
        'changed behind receipt\n',
      );
      await expect(
        sessions.open(request(), scope, {
          ...dimensions,
          legacy: { projectSlug: 'alpha', terminalId: 'changed' },
        }),
      ).rejects.toThrow('ownership unavailable');
      expect(await sessions.list(request(), scope)).toEqual([]);
    });

    test('journal overload latches unavailable output and kills a real shell that ignores HUP', async () => {
      await sessions.dispose();
      create({ maxPendingBytes: 1024 });
      const opened = await sessions.open(request(), scope, dimensions);
      await sessions.write(
        request(),
        scope,
        opened.terminalId,
        "trap '' HUP; while :; do printf '%8192s' x; done\r",
      );
      await expect
        .poll(async () => (await sessions.list(request(), scope))[0]?.status, {
          timeout: 10000,
        })
        .toBe('failed');
      await expect(
        sessions.read(request(), scope, opened.terminalId),
      ).rejects.toThrow('journal unavailable');
      await expect
        .poll(
          () => {
            try {
              process.kill(opened.pid!, 0);
              return true;
            } catch (error) {
              if (
                error instanceof Error &&
                'code' in error &&
                error.code === 'ESRCH'
              )
                return false;
              throw error;
            }
          },
          { timeout: 10000 },
        )
        .toBe(false);
      await expect(sessions.dispose()).rejects.toThrow('overloaded');
      create();
      await expect(
        sessions.read(request(), scope, opened.terminalId),
      ).rejects.toThrow('journal unavailable');
    });
  },
);
