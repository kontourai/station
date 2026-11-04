/**
 * #4519 round 1: the Vite dev server under a managed policy whose
 * `limits.clients` leaves out `remote`.
 *
 * `station start --watch` checks its own `--host`, but `npm run dev:ui`
 * starts Vite directly, and Vite's `--host` (or `server.host` from any
 * config layer) replaces the loopback default. So the check runs on the
 * final resolved configuration, CLI overrides included, before anything
 * listens: under the limit `server.host` and `preview.host` must each be a
 * literal loopback address, or Vite refuses to start. Once the server is
 * bound, and before it serves anything (round 2), its actual address is
 * checked and its actual port goes through the server's listener admission:
 * a Tailscale Serve route (HTTP or TCP) to that port, or a Tailscale that
 * cannot say, refuses it, and every held connection is destroyed. The policy
 * is loaded the
 * way the CLI loads it (`loadInstalledManagedPolicy`); a policy that cannot
 * be loaded throws its own refusal, as the server would.
 */
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Plugin } from 'vite';

interface HeldListener {
  admitted(): void;
  refused(): void;
}

interface ManagedHostGate {
  /** The managed refusal sentence, or `null` when remote clients are allowed. */
  denial: string | null;
  isLiteralLoopbackAddress(host: string): boolean;
  /** Holds every request and upgrade until `admitted()`; see the server's gate. */
  hold(server: HttpServer): HeldListener;
  /** The server's listener admission for the bound port; throws its refusal. */
  admit(listener: { name: string; host: string; port: number }): Promise<void>;
}

/**
 * Vite bundles this config with workspace packages left external, and plain
 * Node cannot load their TypeScript sources, so the policy modules are
 * loaded through tsx, only when a server is about to start.
 */
async function loadInstalledGate(): Promise<ManagedHostGate> {
  const { tsImport } = await import('tsx/esm/api');
  const [shared, contracts, exposure, gate] = await Promise.all([
    tsImport('../packages/shared/src/managed-policy.ts', import.meta.url),
    tsImport('../packages/contracts/src/managed-policy.ts', import.meta.url),
    tsImport(
      '../src-server/security/managed-network-exposure.ts',
      import.meta.url,
    ),
    tsImport(
      '../src-server/security/listener-admission-gate.ts',
      import.meta.url,
    ),
  ]);
  const loaded = shared.loadInstalledManagedPolicy();
  // The same admission the server uses: the trusted Tailscale CLI, or the
  // test stand-in only for a test-override policy.
  const admission = exposure.createManagedListenerAdmission(
    loaded,
    exposure.managedTailscaleCommand(loaded),
  );
  return {
    denial:
      loaded && !contracts.managedPolicyAllowsRemoteClients(loaded.summary)
        ? contracts.managedRemoteClientsDenial(loaded.summary)
        : null,
    isLiteralLoopbackAddress: exposure.isLiteralLoopbackAddress,
    hold: (server) => gate.gateServerUntilAdmitted(server),
    admit: (listener) => admission.admit(listener),
  };
}

function refusal(denial: string, host: unknown): Error {
  return new Error(
    `${denial} The UI dev server listens only on this computer; host ${JSON.stringify(host)} is not supported. Use --host 127.0.0.1.`,
  );
}

export function managedPolicyHost(
  loadGate: () => Promise<ManagedHostGate> = loadInstalledGate,
): Plugin {
  let gate: ManagedHostGate | null = null;
  // Vite's `host`: `true` and `''` mean every interface.
  const exposed = (host: unknown) =>
    typeof host !== 'string' || !gate?.isLiteralLoopbackAddress(host);
  const watchListening = (
    httpServer: HttpServer | null | undefined,
    name: string,
    logError: (message: string) => void,
    close: () => Promise<unknown>,
  ) => {
    // `listening` is emitted on the tick after bind, before any connection
    // is processed, and after Vite has attached every request and upgrade
    // handler (HMR and proxy included), so the hold sees all of them.
    httpServer?.once('listening', () => {
      if (!gate?.denial) return;
      const held = gate.hold(httpServer);
      const refuse = (message: string) => {
        held.refused();
        logError(message);
        void close().finally(() => process.exit(1));
      };
      const address = httpServer.address() as AddressInfo | null;
      if (!address || exposed(address.address)) {
        refuse(refusal(gate.denial, address?.address).message);
        return;
      }
      gate.admit({ name, host: address.address, port: address.port }).then(
        () => held.admitted(),
        (error: unknown) =>
          refuse(error instanceof Error ? error.message : String(error)),
      );
    });
  };
  return {
    name: 'station-managed-policy-host',
    async configResolved(config) {
      // `vite dev` and `vite preview` both resolve as `serve`; a build
      // listens on nothing.
      if (config.command !== 'serve') return;
      gate = await loadGate();
      if (!gate.denial) return;
      if (exposed(config.server.host))
        throw refusal(gate.denial, config.server.host);
      if (exposed(config.preview.host))
        throw refusal(gate.denial, config.preview.host);
    },
    configureServer(server) {
      watchListening(
        server.httpServer as HttpServer | null,
        'UI dev server',
        (message) => server.config.logger.error(message),
        () => server.close(),
      );
    },
    configurePreviewServer(server) {
      watchListening(
        server.httpServer as HttpServer,
        'UI preview server',
        (message) => server.config.logger.error(message),
        () => server.close(),
      );
    },
  };
}
