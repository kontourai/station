/**
 * Binds live Browser sessions to live surfaces (#90 wave 2).
 *
 * When a session goes live, a Chromium screencast producer is registered for
 * it in the live-surface registry, under a surface id that names the session
 * AND its browser generation. When the session closes, its browser exits, or
 * it is reopened on a new generation, the old surface is unregistered: a
 * reference to an earlier generation's surface is a 404, never a stream from
 * a different process.
 *
 * JavaScript dialogs: one that opens while a PERSON holds the live view's
 * control is held for a person to answer (`pendingDialogFor` /
 * `answerDialog`); one that opens while an agent holds it, or nobody does,
 * is answered automatically, exactly as before. The agent path is
 * unchanged, and an agent never answers a dialog a person is being shown.
 *
 * Each binding also captures the page's console (`consoleFor`), in memory
 * and bounded, for the generation it serves.
 *
 * Every surface action is authorized per request (D5 + D7): the Station
 * operator may view and drive any session; a Project admin/owner only
 * sessions in their OWN profile; everyone else nothing. A check with no
 * request to judge (a principal alone) is refused: this layer cannot verify
 * a bare principal string, so an agent path must bring verified authority
 * of its own — the browser tools' grant — before it can drive a surface.
 */
import type {
  LiveSurfaceAction,
  LiveSurfaceController,
  LiveSurfaceInput,
} from '@kontourai/station-contracts/live-surface';
import type {
  LiveSurfaceAuthorizationContext,
  LiveSurfaceRegistry,
} from '../live-surface/registry.js';
import type { BrowserProjectAuthorizer } from './browser-access.js';
import { browserAgentGrantAllows } from './browser-agent-authority.js';
import {
  BrowserConsoleLog,
  type BrowserConsoleSnapshot,
} from './browser-console-log.js';
import {
  actorOwnsSessionProfile,
  type BrowserSessionActor,
  type BrowserSessionRecord,
  type BrowserSessionRegistry,
} from './browser-session-registry.js';
import {
  type AnswerDialogResult,
  ChromiumScreencastProducer,
  type PendingJavaScriptDialog,
} from './chromium-screencast-producer.js';

/** `bs_<uuid>` + generation → a live-surface id (no `_` in that grammar). */
export function browserSurfaceId(
  browserSessionId: string,
  generation: number,
): string {
  return `browser:${browserSessionId.replace(/^bs_/, '')}:g${generation}`;
}

interface Binding {
  surfaceId: string;
  generation: number;
  producer: ChromiumScreencastProducer;
  console: BrowserConsoleLog;
  unregister: () => Promise<void>;
  offNavigated: () => void;
  offLease: () => void;
}

export interface BrowserLiveSurfacesOptions {
  sessions: Pick<
    BrowserSessionRegistry,
    | 'onSessionChange'
    | 'liveTarget'
    | 'listSessions'
    | 'recordDialog'
    | 'observeCommittedUrl'
    | 'noteInput'
    | 'recordControlChange'
    | 'recordDialogAnswer'
  >;
  surfaces: Pick<LiveSurfaceRegistry, 'register' | 'get'>;
  authorizeProject: BrowserProjectAuthorizer;
  dispatchTimeoutMs?: number;
  /** How long a dialog held for a person waits before its automatic answer. */
  dialogHoldMs?: number;
  onError?: (message: string, error: unknown) => void;
}

/**
 * The D5 + D7 decision for one session and one surface action.
 */
export async function authorizeBrowserSurfaceAction(
  authorizeProject: BrowserProjectAuthorizer,
  record: Pick<BrowserSessionRecord, 'projectId' | 'principalKey'>,
  principal: string,
  action: LiveSurfaceAction,
  context: LiveSurfaceAuthorizationContext | undefined,
): Promise<boolean> {
  // An agent path (browser tools) brings a grant minted by the verified
  // caller chain (`browser-agent-authority.ts`); it admits exactly one
  // Project profile for exactly the principal it was minted for.
  if (context?.agentGrant !== undefined)
    return browserAgentGrantAllows(context.agentGrant, record, principal);
  const request = context?.request;
  if (!request) return false;
  const actor = await authorizeProject(
    request,
    record.projectId,
    action === 'view' ? 'view' : 'drive',
  );
  if (!actor) return false;
  // The live-surface layer's principal and the Project authority must be the
  // same person, or the lease would attribute one person's input to another.
  if (actor.kind === 'project-admin' && actor.principalId !== principal)
    return false;
  return actorOwnsSessionProfile(record, actor);
}

/**
 * Who holds control, as one comparable key for the control history: a
 * person by principal (their device does not matter: the same person on
 * another device is not a takeover), an agent by principal AND session (two
 * sessions acting for the same person are different drivers, and an agent
 * acting for the operator is not the operator).
 */
function controlIdentity(holder: LiveSurfaceController): string {
  return holder.kind === 'human'
    ? `human:${holder.principal}`
    : `agent:${holder.principal}:${holder.sessionId}`;
}

/**
 * The session actor a live-surface controller is. A human in the operator's
 * profile can only be the operator (nobody else may drive it, D7); in an
 * admin's profile, that admin.
 */
function actorForController(
  principalKey: string,
  holder: LiveSurfaceController,
): BrowserSessionActor {
  if (holder.kind === 'agent')
    return {
      kind: 'agent',
      principalId: holder.principal,
      sessionId: holder.sessionId,
    };
  // The profile's own principal is the admin whose session it is; any other
  // human allowed to drive it is the operator (D5/D7 admit nobody else).
  return principalKey === `principal:${holder.principal}`
    ? { kind: 'project-admin', principalId: holder.principal }
    : { kind: 'operator' };
}

function isUserActivation(input: LiveSurfaceInput): boolean {
  if (input.kind === 'text') return true;
  if (input.kind === 'key') return input.type === 'down';
  // Narrowed explicitly: an input kind a later producer adds (a device
  // button) is not a browser activation, and has no pointer fields to read.
  if (input.kind === 'pointer')
    return input.type === 'down' || input.type === 'up';
  return false;
}

export class BrowserLiveSurfaces {
  private readonly bindings = new Map<string, Binding>();
  private readonly offChange: () => void;
  private disposed = false;

  constructor(private readonly options: BrowserLiveSurfacesOptions) {
    this.offChange = options.sessions.onSessionChange((record) =>
      this.reconcile(record),
    );
    // Sessions already live when the binder starts (none on a fresh boot).
    for (const summary of options.sessions.listSessions())
      if (summary.state === 'live') this.reconcile(summary);
  }

  /** The current surface id of a live session, else undefined. */
  surfaceIdFor(browserSessionId: string): string | undefined {
    return this.bindings.get(browserSessionId)?.surfaceId;
  }

  /** The dialog a live session's page holds for a person, if any. */
  pendingDialogFor(
    browserSessionId: string,
  ): PendingJavaScriptDialog | undefined {
    return (
      this.bindings.get(browserSessionId)?.producer.pendingDialog() ?? undefined
    );
  }

  /**
   * A person's answer to the dialog `dialogId` held on this session's page.
   * The caller has already authorized `actor` to drive the session; the
   * answer is recorded as theirs. `no-dialog` when that dialog is no longer
   * the one held (answered elsewhere, timed out, the page moved on).
   */
  async answerDialog(
    browserSessionId: string,
    dialogId: string,
    answer: { accept: boolean; promptText?: string },
    actor: BrowserSessionActor,
  ): Promise<AnswerDialogResult> {
    const binding = this.bindings.get(browserSessionId);
    if (!binding) return { ok: false, code: 'no-dialog' };
    const result = await binding.producer.answerDialog(dialogId, answer);
    if (result.ok)
      this.options.sessions.recordDialogAnswer(
        browserSessionId,
        binding.generation,
        {
          type: result.dialog.type,
          message: result.dialog.message,
          accepted: answer.accept,
        },
        actor,
      );
    return result;
  }

  /** A live session's console entries newer than `after`, else undefined. */
  consoleFor(
    browserSessionId: string,
    after?: number,
  ): (BrowserConsoleSnapshot & { generation: number }) | undefined {
    const binding = this.bindings.get(browserSessionId);
    // The generation names which browser the entries came from: `seq`
    // restarts with each one, so a reader must not mix two.
    return binding
      ? { ...binding.console.read(after), generation: binding.generation }
      : undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.offChange();
    const bindings = [...this.bindings.values()];
    this.bindings.clear();
    await Promise.allSettled(bindings.map((binding) => this.release(binding)));
  }

  private reconcile(
    record: Pick<
      BrowserSessionRecord,
      'browserSessionId' | 'state' | 'generation' | 'projectId' | 'principalKey'
    >,
  ): void {
    if (this.disposed) return;
    const id = record.browserSessionId;
    const current = this.bindings.get(id);
    if (record.state === 'live' && current?.generation === record.generation)
      return;
    if (current) {
      this.bindings.delete(id);
      void this.release(current);
    }
    if (record.state !== 'live') return;
    const live = this.options.sessions.liveTarget(id);
    if (!live || live.generation !== record.generation) return;
    const surfaceId = browserSurfaceId(id, live.generation);
    const generation = live.generation;
    let producer: ChromiumScreencastProducer;
    let consoleLog: BrowserConsoleLog | undefined;
    let offNavigated: () => void;
    try {
      const cdp = live.host.cdp();
      producer = new ChromiumScreencastProducer({
        surfaceId,
        cdp,
        cdpSessionId: live.target.cdpSessionId,
        ...(this.options.dispatchTimeoutMs !== undefined
          ? { dispatchTimeoutMs: this.options.dispatchTimeoutMs }
          : {}),
        onDialog: (dialog) =>
          this.options.sessions.recordDialog(id, generation, dialog),
        // Held for a person only while a person holds control: their input
        // (or their page, while they drive it) opened it. An agent's input,
        // or a page nobody controls, is answered automatically as before.
        holdDialog: () =>
          this.options.surfaces.get(surfaceId)?.lease.snapshot().holder
            ?.kind === 'human',
        ...(this.options.dialogHoldMs !== undefined
          ? { dialogHoldMs: this.options.dialogHoldMs }
          : {}),
        // Whoever holds control is who this input is from; a navigation it
        // causes is then attributed to them, not to the page.
        onInput: (input) => {
          // Only user activation arms the link attribution: a click, a key
          // press or typed text. Moving the mouse or scrolling does not.
          if (!isUserActivation(input)) return;
          const holder = this.options.surfaces
            .get(surfaceId)
            ?.lease.snapshot().holder;
          const actor = holder
            ? actorForController(record.principalKey, holder)
            : undefined;
          if (actor) this.options.sessions.noteInput(id, actor);
        },
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      });
      consoleLog = new BrowserConsoleLog({
        cdp,
        cdpSessionId: live.target.cdpSessionId,
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      });
      void consoleLog.enable();
      offNavigated = cdp.on('Page.frameNavigated', (params, sessionId) => {
        if (sessionId !== live.target.cdpSessionId) return;
        const frame = (
          params as { frame?: { parentId?: string; url?: string } }
        )?.frame;
        if (!frame || frame.parentId !== undefined) return;
        if (typeof frame.url === 'string')
          this.options.sessions.observeCommittedUrl(id, generation, frame.url);
      });
    } catch (error) {
      consoleLog?.dispose();
      this.options.onError?.('browser surface could not be created', error);
      return;
    }
    const owner = {
      projectId: record.projectId,
      principalKey: record.principalKey,
    };
    // Control is history (D6), without noise (owner decision): a takeover is
    // recorded when control passes to a DIFFERENT controller than the last
    // one to hold it (agent to person, one person to another, a person
    // after an agent's hold lapsed), or when a person presses Take control.
    // `control-released` is recorded ONLY for an explicit release: a POST
    // of `{action: 'release'}` to the live-surface lease route
    // (`releaseHumanControl`). Today no Station UI sends one — the canvas
    // never releases, and closing a pane does not release — so in practice
    // a person's control ends by lapsing, which is not recorded. (acd763e77
    // said Release, pane close and hand-back each record a release; only a
    // call to that route does.) A person re-claiming by input after their
    // own hold lapsed, and the lapse itself, are not recorded; after an
    // explicit release, the same person's next claim IS a takeover again.
    const recordControl = (
      kind: 'control-taken' | 'control-released',
      holder: LiveSurfaceController,
    ) =>
      this.options.sessions.recordControlChange(
        id,
        generation,
        kind,
        actorForController(record.principalKey, holder),
      );
    let lastHolderKey: string | null = null;
    let takenAtFence: number | null = null;
    let unregister: () => Promise<void>;
    try {
      unregister = this.options.surfaces.register(producer, {
        onExplicitControl: ({ action, human, fence }) => {
          if (action === 'release') {
            recordControl('control-released', human);
            // They gave it back: their next claim, even by input, takes it.
            lastHolderKey = null;
            return;
          }
          lastHolderKey = controlIdentity(human);
          // A claim that also changed hands was recorded by the lease
          // listener below, at this same fence.
          if (takenAtFence !== fence) recordControl('control-taken', human);
          takenAtFence = fence;
        },
        authorize: (principal, _surfaceId, action, context) =>
          authorizeBrowserSurfaceAction(
            this.options.authorizeProject,
            owner,
            principal,
            action,
            context,
          ),
      });
    } catch (error) {
      producer.dispose();
      consoleLog.dispose();
      offNavigated();
      this.options.onError?.('browser surface could not be registered', error);
      return;
    }
    const lease = this.options.surfaces.get(surfaceId)?.lease;
    const offLease =
      lease?.onChange((next) => {
        const holder = next.holder;
        // A dialog held for a person does not outlive their control: once
        // it is released, lapses or passes to an agent, it is dismissed, so
        // nobody is left behind a modal page (the pane renews the person's
        // hold while it shows them the dialog).
        if (holder?.kind !== 'human') producer.releaseHeldDialog();
        // Nobody holding (a lapse or a release) says nothing about who
        // drives next; the last holder is remembered across it.
        if (!holder) return;
        const key = controlIdentity(holder);
        const changedHands = key !== lastHolderKey;
        lastHolderKey = key;
        if (holder.kind === 'human' && changedHands) {
          takenAtFence = lease?.snapshot().fence ?? null;
          recordControl('control-taken', holder);
        }
      }) ?? (() => {});
    this.bindings.set(id, {
      surfaceId,
      generation,
      producer,
      console: consoleLog,
      unregister,
      offNavigated,
      offLease,
    });
  }

  private async release(binding: Binding): Promise<void> {
    binding.offLease();
    binding.offNavigated();
    binding.producer.dispose();
    binding.console.dispose();
    try {
      await binding.unregister();
    } catch (error) {
      this.options.onError?.('browser surface unregister failed', error);
    }
  }
}
