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

async function connect(era: 'modern' | 'legacy') {
  const connection = await connectMCP({
    id: 'fixture',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    ...(era === 'legacy' ? { env: { STATION_MCP_FIXTURE_ERA: 'legacy' } } : {}),
  });
  open.push(connection);
  expect(connection.negotiation.era).toBe(era);
  return connection;
}

/** What the fixture server says it received, read from its tool result. */
async function askDetails(
  connection: MCPConnection,
  route?: MCPElicitationRoute,
): Promise<unknown> {
  const call = () =>
    connection.client.callTool({ name: 'ask_details', arguments: {} });
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
      await opened;
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
