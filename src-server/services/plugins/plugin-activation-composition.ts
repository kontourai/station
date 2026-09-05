import type { PluginProviderReadView } from '../../providers/registries/registry.js';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from './package-mcp-admission.js';
import {
  type PluginActivationPermit,
  type PluginActivationPlan,
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
  intent: 'install' | 'compensation';
  verifyResources(plan: PluginActivationPlan): Promise<void>;
}
interface Session {
  phase: 'collecting' | 'composing' | 'completed' | 'closed';
  entries: Entry[];
  notifications: Array<() => void>;
}
const sessions = new WeakMap<PluginActivationSession, Session>();
const compositions = new WeakMap<PluginActivationComposition, Session>();

export function createPluginActivationSession(): PluginActivationSession {
  const key = Object.freeze({}) as PluginActivationSession;
  sessions.set(key, { phase: 'collecting', entries: [], notifications: [] });
  return key;
}

export function registerPluginActivation(
  session: PluginActivationSession,
  journal: PackageMcpAdmissionJournal,
  installation: PackageMcpInstallation,
  verifyResources: (plan: PluginActivationPlan) => Promise<void>,
  intent: 'install' | 'compensation' = 'install',
): PluginActivationPermit {
  const state = sessions.get(session);
  if (state?.phase !== 'collecting')
    throw new Error('Plugin activation session is unavailable');
  const existingIndex = state.entries.findIndex(
    (entry) =>
      entry.journal === journal &&
      entry.installation.pluginId === installation.pluginId,
  );
  if (existingIndex < 0 && state.entries.length >= 256)
    throw new Error(
      'Plugin activation graph exceeds the supported transaction size',
    );
  if (
    existingIndex >= 0 &&
    state.entries[existingIndex]!.installation.incarnation ===
      installation.incarnation
  )
    throw new Error('Plugin activation graph contains a repeated installation');
  const permit = journal.claimActivation(installation);
  const entry = {
    journal,
    installation: Object.freeze({ ...installation }),
    permit,
    verifyResources,
    intent,
  };
  if (existingIndex >= 0) {
    journal.closeActivationPermit(state.entries[existingIndex]!.permit);
    state.entries[existingIndex] = entry;
  } else state.entries.push(entry);
  return permit;
}

/** Removes only an exact member whose owned withdrawal already completed.
 * This does not infer termination or erase the durable journal evidence. */
export function retirePluginActivation(
  session: PluginActivationSession | undefined,
  journal: PackageMcpAdmissionJournal,
  generation: string,
): void {
  if (!session) return;
  const state = sessions.get(session);
  if (state?.phase !== 'collecting')
    throw new Error('Plugin activation session is unavailable');
  const entry = state.entries.find(
    (candidate) =>
      candidate.journal === journal &&
      candidate.installation.incarnation === generation,
  );
  if (!entry) return;
  const selected = journal.currentInstallation(entry.installation.pluginId);
  if (
    selected.state === 'unavailable' ||
    (selected.state === 'observed' &&
      selected.installation.incarnation === generation)
  )
    throw new Error('Plugin activation withdrawal was not observed');
  journal.closeActivationPermit(entry.permit);
  state.entries = state.entries.filter((candidate) => candidate !== entry);
}

/** Installer-only ownership reads while collecting the graph. This does not
 * authorize runtime execution or grant public discovery of a pending package. */
export function pluginActivationSessionPermit(
  session: PluginActivationSession | undefined,
  journal: PackageMcpAdmissionJournal,
  pluginId: string,
): PluginActivationPermit | undefined {
  if (!session) return undefined;
  const state = sessions.get(session);
  if (state?.phase !== 'collecting') return undefined;
  const entry = state.entries.find(
    (candidate) =>
      candidate.journal === journal &&
      candidate.installation.pluginId === pluginId,
  );
  if (!entry) return undefined;
  journal.activationInstallation(entry.permit);
  return entry.permit;
}

async function verifyActivationEntry(
  state: Session,
  entry: Entry,
  plan: PluginActivationPlan,
): Promise<void> {
  await entry.verifyResources(plan);
  for (const dependency of plan.ownedDependencies) {
    if (!dependency.generation) continue; // Legacy custody does not gain generation authority here.
    const current = entry.journal.currentInstallation(dependency.id);
    if (
      current.state !== 'observed' ||
      current.installation.incarnation !== dependency.generation ||
      current.installation.contentDigest !== dependency.contentDigest
    )
      throw new Error(
        `Plugin activation dependency '${dependency.id}' changed`,
      );
    if (
      !entry.journal.admissionOpen(current.installation) &&
      !state.entries.some(
        (candidate) =>
          candidate.journal === entry.journal &&
          candidate.installation.incarnation === dependency.generation,
      )
    )
      throw new Error(
        `Plugin activation dependency '${dependency.id}' needs its own recovery`,
      );
  }
}

export async function preparePluginActivationComposition(
  session: PluginActivationSession,
  intent: 'install' | 'compensation' = 'install',
): Promise<PluginActivationComposition> {
  const state = sessions.get(session);
  if (state?.phase !== 'collecting')
    throw new Error('Plugin activation session is unavailable');
  if (
    intent === 'compensation' &&
    state.entries.some((entry) => entry.intent !== 'compensation')
  )
    throw new Error('An incomplete failed installation remains pending');
  if (intent === 'compensation') state.notifications = [];
  for (const entry of state.entries) {
    entry.journal.activationInstallation(entry.permit);
    const plan = entry.journal.activationPlan(entry.installation);
    if (!plan) throw new Error('Plugin activation plan is unavailable');
    await verifyActivationEntry(state, entry, plan);
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
    await entry.journal.verifyActivation(entry.permit, (plan) =>
      verifyActivationEntry(state, entry, plan),
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

/** Notifications are hints, not readiness authority. The configuration owner
 * delivers them only after releasing its runtime access barrier. */
export function deferPluginActivationNotification(
  session: PluginActivationSession,
  notify: () => void,
): void {
  const state = sessions.get(session);
  if (state?.phase !== 'collecting')
    throw new Error('Plugin activation notification owner is unavailable');
  if (state.notifications.length >= 256)
    throw new Error(
      'Plugin activation notification graph exceeds supported size',
    );
  state.notifications.push(notify);
}

export function deliverPluginActivationNotifications(
  session: PluginActivationSession,
  onError: (error: unknown) => void,
): void {
  const state = sessions.get(session);
  if (state?.phase !== 'completed') return;
  const notifications = state.notifications.splice(0);
  for (const notify of notifications) {
    try {
      notify();
    } catch (error) {
      // Observer failure cannot undo a committed installation.
      try {
        onError(error);
      } catch {
        /* Diagnostic delivery is best effort. */
      }
    }
  }
}

/** The provider view is the same explicit owner key, not a new authority or
 * ambient scope. Private handles expire when that owner's composition settles. */
export function pluginActivationProviderReadView(
  owner: PluginActivationSession | PluginActivationComposition,
): PluginProviderReadView {
  const view = owner as unknown as PluginProviderReadView;
  if (!pluginActivationProviderReadViewCurrent(view))
    throw new Error('Plugin provider composition view is unavailable');
  return view;
}

export function pluginActivationProviderReadViewCurrent(
  view: PluginProviderReadView,
): boolean {
  const state =
    sessions.get(view as unknown as PluginActivationSession) ??
    compositions.get(view as unknown as PluginActivationComposition);
  return state?.phase === 'collecting' || state?.phase === 'composing';
}

export function pluginActivationProviderViewPermit(
  view: PluginProviderReadView,
  journal: PackageMcpAdmissionJournal,
  pluginId: string,
): PluginActivationPermit | undefined {
  if (!pluginActivationProviderReadViewCurrent(view)) return undefined;
  const state =
    sessions.get(view as unknown as PluginActivationSession) ??
    compositions.get(view as unknown as PluginActivationComposition);
  const entry = state?.entries.find(
    (candidate) =>
      candidate.journal === journal &&
      candidate.installation.pluginId === pluginId,
  );
  if (!entry) return undefined;
  const selected = journal.activationInstallation(entry.permit);
  return selected.incarnation === entry.installation.incarnation
    ? entry.permit
    : undefined;
}
