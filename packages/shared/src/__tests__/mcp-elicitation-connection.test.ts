import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  connectMCP,
  type MCPConnection,
  type MCPElicitationRoute,
} from '../mcp.js';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/mcp-elicitation-server.mjs', import.meta.url),
);

const open: MCPConnection[] = [];

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((item) => item.close()));
});

async function connect(
  era: 'modern' | 'legacy',
  env: Record<string, string> = {},
) {
  const connection = await connectMCP({
    id: 'fixture',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: {
      ...env,
      ...(era === 'legacy' ? { STATION_MCP_FIXTURE_ERA: 'legacy' } : {}),
    },
  });
  open.push(connection);
  expect(connection.negotiation.era).toBe(era);
  return connection;
}

/** What the fixture server says it received, read from its tool result. */
async function askDetails(
  connection: MCPConnection,
  route?: MCPElicitationRoute,
  tool = 'ask_details',
): Promise<unknown> {
  const call = () => connection.client.callTool({ name: tool, arguments: {} });
  const result = route
    ? await connection.withElicitationRoute!(route, call)
    : await call();
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    // A tool that failed reports its error as text (`isError`).
    return { toolError: text };
  }
}

describe.each(['modern', 'legacy'] as const)(
  'MCP elicitation through the real client connection (%s era)',
  (era) => {
    test.each(['optional', 'required'] as const)(
      'refuses a raw %s __proto__ field before opening a turn form',
      async (variant) => {
        const connection = await connect(era, {
          STATION_MCP_FIXTURE_PROTO_FIELD: variant,
        });
        const seen: unknown[] = [];
        const outcome = await askDetails(connection, async (request) => {
          seen.push(request);
          return { action: 'accept', content: { name: 'Ada' } };
        }).then(
          (value) => ({ value }),
          (error: Error) => ({ error: error.message }),
        );
        expect(seen).toEqual([]);
        expect(JSON.stringify(outcome)).toContain(
          'Station refuses MCP elicitation fields named __proto__',
        );
      },
    );

    test('accept returns the content the person entered', async () => {
      const connection = await connect(era);
      const seen: unknown[] = [];
      const received = await askDetails(connection, async (request) => {
        seen.push(request);
        return { action: 'accept', content: { name: 'Ada', age: 36 } };
      });
      expect(received).toEqual({
        action: 'accept',
        content: { name: 'Ada', age: 36 },
      });
      expect(seen).toEqual([
        expect.objectContaining({
          serverId: 'fixture',
          params: expect.objectContaining({
            message: 'Who should the report be addressed to?',
            requestedSchema: expect.objectContaining({ required: ['name'] }),
          }),
        }),
      ]);
    });

    test('decline and cancel reach the server as themselves', async () => {
      const connection = await connect(era);
      expect(
        await askDetails(connection, async () => ({ action: 'decline' })),
      ).toEqual({ action: 'decline', content: null });
      expect(
        await askDetails(connection, async () => ({ action: 'cancel' })),
      ).toEqual({ action: 'cancel', content: null });
    });

    test('with no turn waiting, the elicitation is refused, not answered', async () => {
      const connection = await connect(era);
      const outcome = await askDetails(connection).then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message }),
      );
      // Never a fabricated decline/cancel: either the call fails, or the
      // server reports the refusal it received in its own result.
      expect(JSON.stringify(outcome)).toMatch(/No Station turn is waiting/);
      expect(JSON.stringify(outcome)).not.toMatch(
        /"action":"(decline|cancel)"/,
      );
    });

    test('lists the server prompt and reads it with arguments', async () => {
      const connection = await connect(era);
      const { prompts } = await connection.client.listPrompts();
      expect(prompts).toEqual([
        expect.objectContaining({
          name: 'summarize',
          description: 'Summarize a topic in a chosen tone.',
          arguments: [
            expect.objectContaining({ name: 'topic', required: true }),
            expect.objectContaining({ name: 'tone', required: false }),
          ],
        }),
      ]);
      const prompt = await connection.client.getPrompt({
        name: 'summarize',
        arguments: { topic: 'MCP', tone: 'brisk' },
      });
      expect(prompt.messages).toEqual([
        {
          role: 'user',
          content: { type: 'text', text: 'Summarize MCP in a brisk tone.' },
        },
      ]);
    });
  },
);

/** Settles to `{ value }` or `{ error }`, so a refusal can be asserted. */
const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );

describe.each(['modern', 'legacy'] as const)(
  'every request in flight on the connection counts, bridged or not (%s era)',
  (era) => {
    test('a bridged call alone is still routed', async () => {
      const connection = await connect(era);
      const routed: unknown[] = [];
      expect(
        await askDetails(connection, async (request) => {
          routed.push(request.params);
          return { action: 'accept', content: { name: 'Ada' } };
        }),
      ).toEqual({ action: 'accept', content: { name: 'Ada' } });
      expect(routed).toHaveLength(1);
    });

    test('an unbridged call alone is refused', async () => {
      const connection = await connect(era);
      const outcome = await settle(askDetails(connection));
      expect(JSON.stringify(outcome)).toMatch(/No Station turn is waiting/);
      expect(JSON.stringify(outcome)).not.toMatch(/"action":"accept"/);
    });

    test('an unbridged call concurrent with a bridged one is refused, and neither gets the other’s answer', async () => {
      const connection = await connect(era);
      // A: a turn's call whose form is open and still being answered.
      let answerA!: () => void;
      const answered = new Promise<void>((resolve) => {
        answerA = resolve;
      });
      const formsShownToA: unknown[] = [];
      let formOpen!: () => void;
      const opened = new Promise<void>((resolve) => {
        formOpen = resolve;
      });
      const a = askDetails(connection, async (request) => {
        formsShownToA.push(request.params);
        // A's person answers their own form once released; any further form
        // routed here is answered at once, as the person would, so a
        // misrouted form surfaces as a leaked answer rather than a hang.
        if (formsShownToA.length === 1) {
          formOpen();
          await answered;
        }
        return { action: 'accept', content: { name: 'A-private' } };
      });
      // A's call settling first means its form never opened.
      await Promise.race([opened, a]);
      expect(formsShownToA).toHaveLength(1);
      // B: an unbridged call on the same connection (an MCP Apps or
      // station-control call) that elicits while A is in flight.
      const b = await settle(askDetails(connection));
      answerA();
      expect(await a).toEqual({
        action: 'accept',
        content: { name: 'A-private' },
      });
      // B's form never reached A, and A's answer never reached B.
      expect(formsShownToA).toHaveLength(1);
      expect(JSON.stringify(b)).toMatch(/several concurrent requests/);
      expect(JSON.stringify(b)).not.toMatch(/A-private|"action":"accept"/);
    });
  },
);

/** A route that records each form it is shown and answers `content`. */
function recordingRoute(content: Record<string, string>) {
  const forms: string[] = [];
  const route: MCPElicitationRoute = async (request) => {
    forms.push((request.params as { message: string }).message);
    return { action: 'accept', content };
  };
  return { forms, route };
}

describe.each(['modern', 'legacy'] as const)(
  'two turns’ calls on one connection (%s era)',
  (era) => {
    test('both in flight: refused as ambiguous; once one settles, the other’s form reaches its own turn', async () => {
      const connection = await connect(era);
      // Turn A: a call that asks twice. Its first form stays open until
      // turn B's call has come and gone.
      let releaseA!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let firstFormOpen!: () => void;
      const opened = new Promise<void>((resolve) => {
        firstFormOpen = resolve;
      });
      const formsA: string[] = [];
      const routeA: MCPElicitationRoute = async (request) => {
        formsA.push((request.params as { message: string }).message);
        let content: Record<string, string> = { note: 'A-again' };
        if (formsA.length === 1) {
          firstFormOpen();
          await released;
          content = { name: 'A-first' };
        }
        return { action: 'accept', content };
      };
      const a = askDetails(connection, routeA, 'ask_twice');
      await Promise.race([opened, a]);
      expect(formsA).toHaveLength(1);
      // Turn B: its own call elicits while A's is in flight.
      const b = recordingRoute({ name: 'B-private' });
      const outcomeB = await settle(askDetails(connection, b.route));
      expect(JSON.stringify(outcomeB)).toMatch(/several concurrent requests/);
      expect(b.forms).toEqual([]);
      // B has settled. A's second form arrives with only A in flight and
      // reaches A, answered by A.
      releaseA();
      const outcomeA = await a;
      expect(formsA).toEqual([
        'Who should the report be addressed to?',
        'Anything else for the report?',
      ]);
      expect(JSON.stringify(outcomeA)).toMatch(/A-again/);
      expect(JSON.stringify(outcomeA)).not.toMatch(/B-private/);
    });

    test('an idle route with nothing in flight does not make a form ambiguous', async () => {
      const connection = await connect(era);
      let releaseIdle!: () => void;
      const idle = connection.withElicitationRoute!(
        async () => ({ action: 'accept', content: { name: 'idle' } }),
        () =>
          new Promise<void>((resolve) => {
            releaseIdle = resolve;
          }),
      );
      const own = recordingRoute({ name: 'Ada' });
      expect(await askDetails(connection, own.route)).toEqual({
        action: 'accept',
        content: { name: 'Ada' },
      });
      expect(own.forms).toHaveLength(1);
      releaseIdle();
      await idle;
    });
  },
);

describe.each(['modern', 'legacy'] as const)(
  'a catalog read in flight during a turn’s form (%s era)',
  (era) => {
    test(
      era === 'modern'
        ? 'a prompt listing cannot elicit, so the form still reaches the turn'
        : 'the 2025 era sets no limit on which request a form belongs to, so the form is refused',
      async () => {
        const connection = await connect(era, {
          STATION_MCP_FIXTURE_HOLD_LIST: '1',
        });
        // Held by the fixture until the tool below has reported.
        const listing = connection.client.listPrompts();
        const own = recordingRoute({ name: 'Ada' });
        const outcome = await settle(askDetails(connection, own.route));
        await listing;
        if (era === 'modern') {
          expect(outcome).toEqual({
            value: { action: 'accept', content: { name: 'Ada' } },
          });
          expect(own.forms).toHaveLength(1);
        } else {
          expect(JSON.stringify(outcome)).toMatch(
            /several concurrent requests/,
          );
          expect(own.forms).toEqual([]);
        }
      },
    );
  },
);
