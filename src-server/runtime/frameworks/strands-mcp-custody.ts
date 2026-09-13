import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  type MCPLocalClaim,
  MCPLocalCustodyError,
  type MCPPreparedConnection,
} from '@kontourai/station-shared/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpClient } from '@strands-agents/sdk';

const localCurrentness = Symbol(
  'Station first-party Strands local currentness',
);
export function isStrandsClientCurrent(client: McpClient): boolean {
  const inspect = (
    client as McpClient & { [localCurrentness]?: () => boolean }
  )[localCurrentness];
  return inspect ? inspect() : true;
}

/** Fixed first-party adapter. SDK settlement is not descendant/remote drain proof. */
export function createCustodiedStrandsClient(
  claim: MCPLocalClaim,
  parameters: ConstructorParameters<typeof StdioClientTransport>[0],
  definition?: ToolDef,
): McpClient {
  let transport: StdioClientTransport | undefined;
  let client: McpClient | undefined;
  let phase: ReturnType<MCPPreparedConnection['inspect']>['phase'] = 'prepared';
  let retired = false;
  let closing: Promise<void> | undefined;
  let activity = 0;
  const pending = new Set<Promise<void>>();
  const assertCurrent = () => {
    if (retired || !claim.isCurrent()) throw new MCPLocalCustodyError('stale');
  };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(completion);
    activity += 1;
    // Reserve the operation before invoking SDK methods or user callbacks.
    return Promise.resolve()
      .then(() => {
        assertCurrent();
        phase = 'connecting';
        return operation();
      })
      .then((value) => {
        assertCurrent();
        phase = 'connected';
        return value;
      })
      .catch((error: unknown) => {
        if (!retired) phase = 'failed';
        throw error;
      })
      .finally(() => {
        activity += 1;
        pending.delete(completion);
        finish();
      });
  };
  // The SDK may close its transport more than once. Join exact in-flight
  // cleanup; only a settled rejection or later SDK activity permits a retry.
  let physicalClose: (() => Promise<void>) | undefined;
  let transportClose: Promise<void> | undefined;
  let closeActivity = -1;
  let closeSucceeded = false;
  const closeTransport = (): Promise<void> => {
    if (!physicalClose) return Promise.resolve();
    if (transportClose && (!closeSucceeded || closeActivity === activity))
      return transportClose;
    closeActivity = activity;
    closeSucceeded = false;
    transportClose = Promise.resolve()
      .then(physicalClose)
      .then(
        () => {
          closeSucceeded = true;
        },
        (error: unknown) => {
          transportClose = undefined;
          throw error;
        },
      );
    return transportClose;
  };
  const closePair = async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => client?.disconnect()),
      closeTransport(),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      throw new MCPLocalCustodyError('failed');
  };
  const resource: Pick<MCPPreparedConnection, 'close' | 'inspect'> = {
    inspect: () => ({ phase, pendingOperations: pending.size }),
    close: () => {
      retired = true;
      if (closing) return closing;
      phase = 'closing';
      closing = Promise.resolve()
        .then(async () => {
          const started = activity;
          await closePair();
          while (pending.size) await Promise.all([...pending]);
          if (activity !== started) await closePair();
          phase = 'closed';
        })
        .catch((error: unknown) => {
          phase = 'close-failed';
          closing = undefined;
          throw error;
        });
      return closing;
    },
  };
  claim.attach(resource, definition); // Before either constructor, including partial failure.
  try {
    assertCurrent();
    transport = new StdioClientTransport(parameters);
    physicalClose = transport.close.bind(transport);
    transport.close = closeTransport;
    client = new McpClient({ transport });
    return new Proxy(client, {
      get(target, key) {
        if (key === localCurrentness)
          return () => !retired && claim.isCurrent();
        if (key === 'disconnect') return claim.close;
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function' || key === 'constructor') return value;
        return (...args: unknown[]) =>
          track(() => Promise.resolve(Reflect.apply(value, target, args)));
      },
    });
  } catch (error) {
    phase = 'failed';
    // Caller reports the establishment error; custody retains cleanup failures.
    void claim.close().catch(() => {});
    throw error;
  }
}
