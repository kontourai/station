import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from './package-mcp-admission.js';
import {
  type PluginActivationPermit,
  verifyPluginActivation,
} from './plugin-activation-plan.js';

/** Explicit internal capability. It is never read from ambient async context,
 * request data, a persisted token, or a runtime-global mutable field. */
export interface PluginActivationComposition {
  readonly __pluginActivationComposition: unique symbol;
}
export interface PluginActivationSession {
  readonly __pluginActivationSession: unique symbol;
}
interface Entry {
  journal: PackageMcpAdmissionJournal;
  installation: PackageMcpInstallation;
  permit: PluginActivationPermit;
  verifyResources(): Promise<void>;
}
interface Session {
  phase: 'collecting' | 'composing' | 'completed' | 'closed';
  entries: Entry[];
}
const sessions = new WeakMap<PluginActivationSession, Session>();
const compositions = new WeakMap<PluginActivationComposition, Session>();

export function createPluginActivationSession(): PluginActivationSession {
  const key = Object.freeze({}) as PluginActivationSession;
  sessions.set(key, { phase: 'collecting', entries: [] });
  return key;
}

export function registerPluginActivation(
  session: PluginActivationSession,
  journal: PackageMcpAdmissionJournal,
  installation: PackageMcpInstallation,
  verifyResources: () => Promise<void>,
): PluginActivationPermit {
  const state = sessions.get(session);
  if (state?.phase !== 'collecting')
    throw new Error('Plugin activation session is unavailable');
  if (state.entries.length >= 256)
    throw new Error(
      'Plugin activation graph exceeds the supported transaction size',
    );
  if (
    state.entries.some(
      (entry) =>
        entry.journal === journal &&
        entry.installation.pluginId === installation.pluginId,
    )
  )
    throw new Error('Plugin activation graph contains a repeated installation');
  const permit = journal.claimActivation(installation);
  state.entries.push({
    journal,
    installation: Object.freeze({ ...installation }),
    permit,
    verifyResources,
  });
  return permit;
}

export async function preparePluginActivationComposition(
  session: PluginActivationSession,
): Promise<PluginActivationComposition> {
  const state = sessions.get(session);
  if (state?.phase !== 'collecting')
    throw new Error('Plugin activation session is unavailable');
  for (const entry of state.entries) {
    entry.journal.activationInstallation(entry.permit);
    await entry.verifyResources();
    entry.journal.activationInstallation(entry.permit);
  }
  if (state.phase !== 'collecting')
    throw new Error('Plugin activation session was closed during preparation');
  state.phase = 'composing';
  const capability = Object.freeze({}) as PluginActivationComposition;
  compositions.set(capability, state);
  return capability;
}

/** Called only by explicit runtime composition readers, never public readers.
 * Every use rechecks the journal-owned generation and its pending permit. */
export function pluginActivationCompositionPermit(
  capability: PluginActivationComposition | undefined,
  journal: PackageMcpAdmissionJournal,
  pluginId: string,
): PluginActivationPermit | undefined {
  if (!capability) return undefined;
  const state = compositions.get(capability);
  if (state?.phase !== 'composing') return undefined;
  const entry = state.entries.find(
    (candidate) =>
      candidate.journal === journal &&
      candidate.installation.pluginId === pluginId,
  );
  if (!entry) return undefined;
  const current = journal.activationInstallation(entry.permit);
  if (current.incarnation !== entry.installation.incarnation)
    throw new Error('Plugin activation generation changed');
  return entry.permit;
}

/** The existing configuration owner calls this only after its authoritative
 * applied outcome, while it still owns the runtime publication barrier. */
export async function completePluginActivationComposition(
  capability: PluginActivationComposition,
): Promise<void> {
  const state = compositions.get(capability);
  if (state?.phase !== 'composing')
    throw new Error('Plugin activation composition is unavailable');
  // Verify the whole graph before any member becomes ready. Parents register
  // before their children, so reverse publication keeps a parent pending until
  // its owned children have passed their exact-generation CAS.
  for (const entry of state.entries) {
    await verifyPluginActivation(
      entry.permit,
      entry.journal,
      entry.verifyResources,
    );
    if (state.phase !== 'composing')
      throw new Error('Plugin activation composition was abandoned');
  }
  for (const entry of [...state.entries].reverse()) {
    if (
      state.phase !== 'composing' ||
      entry.journal.completeActivation(entry.permit).state !== 'applied'
    ) {
      state.phase = 'closed';
      throw new Error(
        'Plugin activation publication is uncertain; pending resources are retained',
      );
    }
  }
  state.phase = 'completed';
}

/** Closing does not withdraw, erase, or declare any effect terminated. The
 * durable plan remains pending for fresh-authority recovery after interruption. */
export function closePluginActivationSession(
  session: PluginActivationSession,
): void {
  const state = sessions.get(session);
  if (state && state.phase !== 'completed') {
    state.phase = 'closed';
    for (const entry of state.entries)
      entry.journal.closeActivationPermit(entry.permit);
  }
}
export function closePluginActivationComposition(
  capability: PluginActivationComposition,
): void {
  const state = compositions.get(capability);
  if (state && state.phase !== 'completed') {
    state.phase = 'closed';
    for (const entry of state.entries)
      entry.journal.closeActivationPermit(entry.permit);
  }
}
