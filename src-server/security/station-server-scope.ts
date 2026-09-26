/**
 * #2377 slice A: the server-self attestation and the explicit server scope.
 *
 * Kept in its own module, imported only by the few places that mint, attach
 * or verify it, rather than in `utils/internal-api-token.ts`, which almost
 * every route and runtime module imports.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SERVER_SELF_ATTESTATION_KEY = Symbol.for('station.serverSelfAttestation');

type ServerSelfGlobal = typeof globalThis & {
  [SERVER_SELF_ATTESTATION_KEY]?: string;
};

/**
 * #2377 slice A: marks an internal request Station's OWN server code made to
 * its own API, as opposed to one a station-control tool made.
 *
 * Both carry the per-boot internal token, and that token is not a secret from
 * agents: every stdio station-control child receives it in its spawn env
 * (`withStationControlRuntimeEnv`), where a same-user process can read it.
 * Station's server also calls its own API with that token, from code no agent
 * drives directly — the execution-target dispatch a person's chat, a webhook,
 * a Discord message or a pane action runs in-process
 * (`executeExecutionTargetMessage` reading an Agent or a Connection back over
 * HTTP). The station-control authority guard must not refuse those, and it
 * cannot tell them from a pooled child by the internal token.
 *
 * This value is minted in the server process's memory, only when the
 * authority guard is installed, and is never written to any environment,
 * file, argv or response. A child process therefore never holds it, and a
 * stolen internal token does not include it.
 *
 * It is attached ONLY inside an explicit server scope
 * ({@link runAsStationServer}) that each server entry point enters
 * deliberately. Authority is never inferred from an absence (no caller
 * context): code that lost its context, or never had one, sends nothing and
 * the guard fails closed. A station-control tool call leaves any server
 * scope it inherited (`withStationControlCallerContext`), so a tool running
 * in Station's process never borrows it.
 */
export const INTERNAL_SERVER_SELF_HEADER = 'x-station-server-self';

/** Mint (once per process) the server-self attestation. Server boot only. */
export function enableStationServerSelfAttestation(): void {
  const state = globalThis as ServerSelfGlobal;
  state[SERVER_SELF_ATTESTATION_KEY] ??= randomBytes(32).toString('base64url');
}

/** The attestation, or `undefined` in any process that never minted one. */
function stationServerSelfAttestation(): string | undefined {
  return (globalThis as ServerSelfGlobal)[SERVER_SELF_ATTESTATION_KEY];
}

export function isStationServerSelfAttestation(
  candidate: string | null | undefined,
): boolean {
  const expected = stationServerSelfAttestation();
  if (typeof candidate !== 'string' || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(candidate).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

const serverScope = new AsyncLocalStorage<true>();

/**
 * Run `operation` as Station's own server code: an entry point Station itself
 * drives (a person's chat or pane action, a webhook, the Discord gateway, the
 * built-in engine's relay), never a station-control tool call. Requests made
 * inside it carry the server-self attestation.
 *
 * NOTE for #2377 slice C: a dispatch route handler runs its in-process
 * execution-target dispatch inside this scope, so the loopback calls that
 * dispatch makes (SSH connect, peer credential, Agent and Connection reads)
 * pass the authority guard as server code. Dispatch authority must therefore
 * be enforced at the dispatch ROUTE, never at those leaves.
 */
export function runAsStationServer<T>(operation: () => T): T {
  return serverScope.run(true, operation);
}

/** Run `operation` outside any server scope it would otherwise inherit. */
export function outsideStationServerScope<T>(operation: () => T): T {
  return serverScope.exit(operation);
}

/** The server-self header, only inside {@link runAsStationServer}. */
export function stationServerScopeHeaders(): Record<string, string> {
  if (serverScope.getStore() !== true) return {};
  const attestation = stationServerSelfAttestation();
  return attestation ? { [INTERNAL_SERVER_SELF_HEADER]: attestation } : {};
}

/** Test-only: forget the attestation so a suite starts from a clean process. */
export function __resetStationServerSelfAttestationForTests(): void {
  delete (globalThis as ServerSelfGlobal)[SERVER_SELF_ATTESTATION_KEY];
}
