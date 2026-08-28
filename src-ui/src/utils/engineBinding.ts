/**
* archive#1194: the pure logic behind BOTH surfaces
 * that talk about the built-in assistant's engine binding — the picker
 * (`components/EnginePicker.tsx`) and the Settings row that opens it
 * (`views/settings/BuiltinEngineRow.tsx`).
 *
 * It lives in its own module, apart from the picker component, for one
 * concrete reason: `BuiltinEngineRow` lazy-loads `EnginePicker` (low-traffic
 * modal, see `views/settings/composite-editors.tsx`), and importing a named
 * helper out of that component would pull the whole modal — and its CSS —
 * into the Settings bundle eagerly, defeating the split.
 *
 * Everything here reads `@kontourai/station-contracts/engine-capability-matrix`
* the same matrix the agent editor's own engine picker reads (archive#975)
 * and the same one `session-agent-resolution.ts` keys its station-control
 * exemption on — so no surface here ever hardcodes a per-engine-id branch.
 */

import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
  type ControlPlaneObservation,
  ENGINE_CAPABILITY_MATRICES,
  type EngineCapabilityMatrix,
  type EngineControlPlaneCapability,
  engineControlPlaneCapability,
  resolveBuiltinAgentEngineBinding,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';

export interface EnginePickerOption {
/** `null` names Station's own engine — every other engine names its live connection id. */
  connectionId: EngineConnectionId | null;
  name: string;
  capability: EngineControlPlaneCapability;
  matrix: EngineCapabilityMatrix;
/**
* archive#1549: this connection's own live-handshake evidence, carried
* alongside the matrix so every downstream caller re-derives the
* capability from the SAME two inputs the server bootstrap used.
*/
  controlPlaneObservation?: ControlPlaneObservation;
}

/**
 * True when a station model connection is already chat-ready — mirrors
 * `setupBannerVariant`'s own `configuredChatReady`/`configured-chat-ready`
 * check (`components/onboardingGateUtils.ts`), so the Station row appears
 * under the exact same condition that hides the rest of the setup banner
 * for Station.
 */
export function isStationChatReady(status: {
  providers?: { configuredChatReady?: boolean };
  recommendation?: { code?: string };
}): boolean {
  return !!(
    status.providers?.configuredChatReady ||
    status.recommendation?.code === 'configured-chat-ready'
  );
}

/**
 * Every READY engine — Station first (when its own chat is ready), each
 * carrying the matrix-derived capability. A connection must be enabled,
 * `agent-runtime`-capable, and currently `ready` to appear; this mirrors the
 * agent editor's own `externalEngineOptions` filter (archive#975,
 * `AgentEditorBasicTab.tsx`) plus the readiness check, generalized to
 * include command-backed connections (which that filter already covers too).
 *
 * Readiness only — capability is a separate question, answered by
 * `capableEngineOptions` below. Callers that need to EXPLAIN a state (the
 * none-capable panel, the Settings row's stale-choice note) need to see the
 * ready-but-incapable engines by name, so this list must not pre-filter them
 * away.
 */
export function readyEngineOptions(input: {
  stationChatReady: boolean;
  connections: AgentConnectionView[];
}): EnginePickerOption[] {
  const options: EnginePickerOption[] = [];
  if (input.stationChatReady) {
    options.push({
      connectionId: null,
      name: 'Station',
      capability: 'full',
      matrix: ENGINE_CAPABILITY_MATRICES.station,
    });
  }
  for (const connection of input.connections) {
    if (connection.kind !== 'agent' || !connection.enabled) continue;
    if (!connection.capabilities.includes('agent-runtime')) continue;
    if (connection.status !== 'ready') continue;
    const matrix = resolveEngineCapabilityMatrix(connection.id, connection);
    if (matrix.engineId === 'station') continue;
    options.push({
      connectionId: connection.id,
      name: connection.name,
// archive#1549: subject-aware. For every engine whose cell declares a
 // static mechanism this is byte-identical to the pre-archive#1549 call; only
// an observation-based cell reads the second argument.
      capability: engineControlPlaneCapability(
        matrix,
        connection.controlPlaneObservation,
      ),
      matrix,
      controlPlaneObservation: connection.controlPlaneObservation,
    });
  }
  return options;
}

/**
 * The engines the picker may actually offer (owner directive, archive#1194):
 * only those that can carry the built-in `station-control` server. The
 * built-in assistant's whole identity is "the assistant that operates
 * Station"; on an engine whose `toolServers` delivery cannot carry that
 * server it registers, responds, and cannot do the one thing it exists for.
 * `resolveBuiltinAgentEngineBinding` applies the same capability filter
 * itself, so what is offered and what will resolve cannot diverge.
 *
 * archive#1549: `'observation-required'` is deliberately NOT offered here.
 * Offering a radio for a connection Station has never observed would be an
 * implicit "yes" nobody can honestly make. Those rows are surfaced
 * separately by `pendingObservationEngineOptions` below, listed and
 * explained but not selectable.
 */
export function capableEngineOptions(
  options: EnginePickerOption[],
): EnginePickerOption[] {
  return options.filter((option) => option.capability === 'full');
}

/**
 * archive#1549: ready engines whose capability cannot be answered yet
 * because no successful handshake has ever been observed for this specific
 * connection.
 *
* ## Reachability, stated honestly (an earlier revision of
 * this comment had it backwards)
 *
 * For an ACP connection this state is currently NOT reachable, and the
 * reason is worth writing down rather than rediscovering: `readyEngineOptions`
 * above skips any connection whose `status !== 'ready'`, and an ACP
* connection is `ready` iff `probe.isAvailable` iff a `initialize` +
 * `session/new` handshake has already succeeded — which is the same event
 * that records the observation. So during the boot window the connection is
 * not `ready` and is filtered out BEFORE it can be pending; by the time it is
 * listed, it has been observed. The two are coupled at the source.
 *
 * This state is therefore defensive, not decorative, and it stays: the
 * derivation must have somewhere honest to go when evidence is absent, and
 * `resolveBuiltinAgentEngineBinding`'s `=== 'full'` filter depends on it to
 * refuse an optimistic bind. It becomes reachable the moment readiness stops
 * implying a handshake — a non-ACP engine class that adopts an
 * observation-based cell, or a projection that can be stale relative to
 * readiness.
 *
 * Kept distinct from `chat-only` on purpose: "not checked yet" and "checked,
 * and the answer is no" are different facts, and archive#1283's none-capable copy
 * ("⟨Kiro⟩ can chat, but it can't operate Station…") is only true of the
 * second. Note in particular that a handshake carrying NO `agentCapabilities`
 * is the SECOND case, not this one — see `projectControlPlaneObservation`.
 */
export function pendingObservationEngineOptions(
  options: EnginePickerOption[],
): EnginePickerOption[] {
  return options.filter(
    (option) => option.capability === 'observation-required',
  );
}

/**
 * archive#1549: the picker's sub-line for a not-yet-observed connection. A
 * function of the connection's own name — a command-backed engine is always
 * shown by its connection name, never by the protocol it speaks.
 */
export function pendingObservationCopy(
  name: string,
  checking: boolean,
): string {
  return checking
    ? `Checking what ${name} supports…`
    : `Not checked yet — Station verifies what ${name} supports when it connects.`;
}

/**
 * What the Settings row shows for `builtinAgentEngineConnectionId`.
 *
 * `name` is the engine the runtime is ACTUALLY bound to — resolved through
 * `resolveBuiltinAgentEngineBinding`, the same function the server bootstrap
 * uses — never the raw persisted value. Rendering the raw value was the
 * defect this replaces: a config naming an engine that cannot run the
 * assistant (or that has gone away) displayed as if it were in effect, while
 * the resolver had already failed that binding safe to Station. Settings
 * would say "Kiro" for a Station-backed assistant.
 *
 * `note` carries the reason whenever the displayed engine is not simply the
 * value the user picked, so the difference is stated rather than swallowed.
 */
export interface BuiltinEngineDisplay {
  name: string;
  note?: string;
}

export function builtinEngineDisplay(input: {
/** The persisted (or drafted) `builtinAgentEngineConnectionId` verbatim. */
  value: EngineConnectionId | null | undefined;
  stationChatReady: boolean;
  connections: AgentConnectionView[];
}): BuiltinEngineDisplay {
  const options = readyEngineOptions({
    stationChatReady: input.stationChatReady,
    connections: input.connections,
  });
  const binding = resolveBuiltinAgentEngineBinding({
    explicitConnectionId: input.value,
    stationChatReady: input.stationChatReady,
    readyExternalEngines: options
      .filter(
        (
          option,
        ): option is EnginePickerOption & {
          connectionId: EngineConnectionId;
        } => option.connectionId !== null,
      )
      .map((option) => ({
        connectionId: option.connectionId,
        matrix: option.matrix,
        controlPlaneObservation: option.controlPlaneObservation,
      })),
  });

// `null` from the resolver means Station's own engine — the same
// convention every other engine-identity resolution in the matrix module
// uses.
  const boundOption = binding
    ? options.find((option) => option.connectionId === binding.connectionId)
    : undefined;
  const name = binding
    ? (boundOption?.name ?? binding.connectionId)
    : 'Station';

  if (input.value === undefined) {
// Nothing pinned: this is whatever the resolver derives each boot, and
// it can change when connections change. Say so — the name alone would
// read as a deliberate choice.
    return { name, note: 'Auto-detected' };
  }
  if (input.value === null) return { name };
  if (binding?.connectionId === input.value) return { name };

// The saved choice did not resolve. The resolver leaves the config
// untouched (a re-appearing or newly-capable engine binds again with no
// user action), so the choice is still real — but it is NOT what is
// running, and this row must not imply otherwise.
  const savedReady = options.find(
    (option) => option.connectionId === input.value,
  );
  if (savedReady) {
// archive#1549: a saved choice that is merely UNOBSERVED must not be
// reported as incapable. "Can't run the built-in assistant" is a verdict;
// Station has not reached one. Saying it anyway would tell the user to
// go change a setting that is about to start working on its own.
    if (savedReady.capability === 'observation-required') {
      return {
        name,
        note: `Station hasn't checked what ${savedReady.name} supports yet.`,
      };
    }
    return {
      name,
      note: `Your saved choice (${savedReady.name}) can't run the built-in assistant.`,
    };
  }
  const savedConnection = input.connections.find(
    (connection) => connection.id === input.value,
  );
  if (savedConnection) {
    return {
      name,
      note: `Your saved choice (${savedConnection.name}) isn't ready right now.`,
    };
  }
  return { name, note: 'Your saved engine is no longer connected.' };
}
