import { randomUUID } from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { FeaturePreviewSelector } from '../feature-previews/feature-preview-registry.js';
import {
  sessionTempRoot,
  removeSessionTmpDir,
} from '../infra/session-tmpdir.js';
import type { EventStore } from './event-store.js';
import {
  captureHostImages,
  type HostImageCaptureHooks,
  hostImageCaptureRoots,
  hostImagePaths,
} from './host-image-capture.js';

/** A turn's text deltas read for host-image paths, at most. */
const TURN_TEXT_EVENT_LIMIT = 5_000;

/**
 * The one line an agent is told while the `chat-host-images` preview is on,
 * naming only the places this session's images can actually come from.
 */
export function hostImageAgentInstruction(where: {
  workingDirectory: boolean;
  tmpdir: boolean;
}): string | undefined {
  const place =
    where.workingDirectory && where.tmpdir
      ? 'inside the working directory or $TMPDIR'
      : where.workingDirectory
        ? 'inside the working directory'
        : where.tmpdir
          ? 'inside $TMPDIR'
          : undefined;
  return place
    ? `[Station chat images: to show the person an image, save it as PNG, JPEG, GIF or WebP (at most 512 KiB) ${place} and reference it as ![alt](/absolute/path). Images at other paths will not render.]`
    : undefined;
}

export interface HostImageTurnCaptureDeps {
  preview: FeaturePreviewSelector | undefined;
  eventStore:
    | Pick<EventStore, 'listTurnEventsByMethods' | 'resolveEventContent'>
    | undefined;
  /** The session's working directory as the read model records it. */
  sessionCwd: (threadId: string) => string | undefined;
  /** Station's own publication path; the event is never an adapter's. */
  publish: (event: CanonicalRuntimeEvent) => void;
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
  hooks?: HostImageCaptureHooks;
}

/**
 * Turns a settled reply's host image paths into a `content.host-images`
 * event, and removes a session's temp directory when the session exits.
 *
 * Capture runs after the `turn.completed` is stored, detached and serialized
 * per thread, so a slow disk never delays the turn terminal and two captures
 * of one thread publish in turn order. The preview is read when the turn
 * settles and again before publishing: turning it off mid-capture publishes
 * nothing. A capture failure is logged and drops only this turn's images.
 */
export class HostImageTurnCapture {
  private readonly inflight = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly deps: HostImageTurnCaptureDeps) {}

  /** Whether the preview is on now (the instruction line reads this too). */
  enabled(): boolean {
    return (
      this.deps.preview?.select({
        enabled: () => true,
        disabled: () => false,
      }) ?? false
    );
  }

  /**
   * The first-turn instruction for this session, or undefined: nothing while
   * the preview is off, and nothing when the session has no admissible root
   * (a no-Project chat whose engine got no per-session temp folder), since no
   * image it saved could render. `$TMPDIR` is named only when the engine was
   * launched with a root Station recorded.
   */
  async instructionFor(threadId: string): Promise<string | undefined> {
    if (!this.enabled()) return undefined;
    const cwd = this.deps.sessionCwd(threadId);
    const tmpdir = sessionTempRoot(threadId);
    const roots = await hostImageCaptureRoots({
      cwd,
      listWorktrees: async () => [],
    });
    return hostImageAgentInstruction({
      workingDirectory: roots.length > 0,
      tmpdir: tmpdir !== undefined,
    });
  }

  /** Called with every committed event. */
  observe(event: CanonicalRuntimeEvent): void {
    if (event.method === 'turn.completed') {
      if (this.closed || !this.deps.eventStore || !this.enabled()) return;
      this.enqueue(event.threadId, () => this.capture(event));
    } else if (event.method === 'session.exited') {
      // After any capture still reading from it; whatever the preview says
      // now, a directory created while it was on is removed.
      this.enqueue(event.threadId, async () =>
        removeSessionTmpDir(event.threadId),
      );
    }
  }

  /** Shutdown: a capture still running publishes nothing; cleanup still runs. */
  close(): void {
    this.closed = true;
  }

  /** Resolves when every queued capture and cleanup has finished. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0)
      await Promise.allSettled([...this.inflight.values()]);
  }

  private enqueue(threadId: string, work: () => Promise<void>): void {
    const run = (this.inflight.get(threadId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) =>
        this.deps.logger.warn('Host image capture failed', {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    this.inflight.set(threadId, run);
    void run.finally(() => {
      if (this.inflight.get(threadId) === run) this.inflight.delete(threadId);
    });
  }

  private turnTexts(
    event: Extract<CanonicalRuntimeEvent, { method: 'turn.completed' }>,
  ): string[] {
    const store = this.deps.eventStore;
    if (!store) return [];
    const byItem = new Map<string, string>();
    for (const stored of store.resolveEventContent(
      store.listTurnEventsByMethods(
        event.threadId,
        event.turnId,
        ['content.text-delta'],
        TURN_TEXT_EVENT_LIMIT,
      ),
    )) {
      const payload = stored.payload;
      if (payload.method !== 'content.text-delta') continue;
      byItem.set(
        payload.itemId,
        (byItem.get(payload.itemId) ?? '') + payload.delta,
      );
    }
    const texts = [...byItem.values()];
    // Engines that report the whole reply on the terminal: also covers a
    // reply longer than the delta read bound.
    if (typeof event.outputText === 'string') texts.push(event.outputText);
    return texts;
  }

  private async capture(
    event: Extract<CanonicalRuntimeEvent, { method: 'turn.completed' }>,
  ): Promise<void> {
    const paths = hostImagePaths(this.turnTexts(event));
    if (paths.length === 0) return;
    const roots = await hostImageCaptureRoots({
      cwd: this.deps.sessionCwd(event.threadId),
      sessionTmpDir: sessionTempRoot(event.threadId),
    });
    const capture = await captureHostImages({
      paths,
      roots,
      hooks: this.deps.hooks,
    });
    if (this.closed || !this.enabled()) return;
    this.deps.publish({
      eventId: randomUUID(),
      provider: event.provider,
      threadId: event.threadId,
      turnId: event.turnId,
      createdAt: new Date().toISOString(),
      method: 'content.host-images',
      ...(capture.attachments.length > 0
        ? { attachments: capture.attachments }
        : {}),
      sources: capture.sources,
    });
  }
}
