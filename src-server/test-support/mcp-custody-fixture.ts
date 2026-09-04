import type { ToolDef } from '@kontourai/station-contracts/tool';
import type {
  MCPConnection,
  MCPLocalClaim,
  MCPLocalConnectionCustody,
  MCPLocalPurpose,
  MCPManagerOptions,
  MCPPreparedConnection,
} from '@kontourai/station-shared/mcp';

/** Adapter for pre-existing service/loader catalog fixtures; actual SDK custody
 * has separate production-seam tests. The real owner still retains each claim. */
export function fixtureMCPCustody(
  Owner: typeof MCPLocalConnectionCustody,
  connect: (
    def: ToolDef,
    options?: MCPManagerOptions,
  ) => Promise<MCPConnection>,
): typeof MCPLocalConnectionCustody {
  return class extends Owner {
    override acquire(id: string, purpose: MCPLocalPurpose): MCPLocalClaim {
      const claim = super.acquire(id, purpose);
      let connection: MCPConnection | undefined;
      let transport: any;
      let phase: ReturnType<MCPPreparedConnection['inspect']>['phase'] =
        'prepared';
      let attached = false;
      let disconnect: (() => Promise<void>) | undefined;
      let connecting: Promise<MCPConnection> | undefined;
      let closing: Promise<void> | undefined;
      const resource: MCPPreparedConnection = {
        connect: async () => {
          throw new Error('Use the definition-bearing fixture connection');
        },
        retainForOAuth: () => {
          phase = 'oauth';
        },
        finishAuth: async (params) => {
          await transport.finishAuth(params);
        },
        inspect: () => ({ phase, pendingOperations: 0 }),
        close: () => {
          if (closing) return closing;
          if (phase === 'closed') return Promise.resolve();
          phase = 'closing';
          closing = Promise.resolve().then(async () => {
            try {
              await connecting?.catch(() => undefined);
              if (disconnect) await disconnect();
              else await transport?.close?.();
              phase = 'closed';
            } catch (error) {
              phase = 'close-failed';
              closing = undefined;
              throw error;
            }
          });
          return closing;
        },
      };
      return Object.assign(claim, {
        connect: async (def: ToolDef, options?: MCPManagerOptions) => {
          if (!claim.isCurrent()) throw new Error('stale fixture claim');
          if (!attached) {
            claim.attach(resource);
            attached = true;
          }
          phase = 'connecting';
          try {
            connecting = Promise.resolve()
              .then(() =>
                options
                  ? connect(def, {
                      ...options,
                      onTransport: (value) => {
                        transport = value;
                        options?.onTransport?.(value);
                      },
                    })
                  : connect(def),
              )
              .then((value) => {
                connection = value;
                disconnect =
                  value.disconnect?.bind(value) ?? value.close?.bind(value);
                return value;
              });
            connection = await connecting;
            if (!claim.isCurrent()) throw new Error('stale fixture claim');
            phase = 'connected';
            return {
              ...connection,
              disconnect: claim.close,
              close: claim.close,
              isUsable: claim.isCurrent,
            };
          } catch (error) {
            phase = 'failed';
            throw error;
          }
        },
        retainForOAuth: resource.retainForOAuth,
        finishAuth: resource.finishAuth,
      });
    }
  };
}
