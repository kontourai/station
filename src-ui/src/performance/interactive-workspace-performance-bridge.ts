const BRIDGE_VERSION = 1 as const;
const BRIDGE_SOURCE = 'station-ui-production-bridge' as const;
const BRIDGE_GLOBAL = '__stationInteractiveWorkspacePerformance';
const MODE_PARAM = 'station-performance-reference';
const MODE_VALUE = 'interactive-workspace-v3';
const WORKSPACE_PANE_HOST_RESTORED_EVENT = 'station:perf:host-restored';
const WORKSPACE_PANE_HOST_RESTORED_MARK = 'station:perf:host-restored';
const PRODUCT_MARK_TIMEOUT_MS = import.meta.env.MODE === 'test' ? 50 : 30_000;
const REFERENCE_SAMPLE_SETTLE_MS = import.meta.env.MODE === 'test' ? 0 : 4_000;
const COLLABORATION_SAMPLE_SETTLE_MS =
  import.meta.env.MODE === 'test' ? 0 : 4_000;
const RECONNECT_SAMPLE_SETTLE_MS = import.meta.env.MODE === 'test' ? 0 : 4_000;
const ONE_HOUR_REFERENCE_DURATION_MS = 60 * 60 * 1000;

interface Sampling {
  readonly warmups: number;
  readonly samples: number;
}

interface ActionSpecification {
  readonly id: string;
  readonly marks: readonly string[];
}

interface FixtureSpecification {
  readonly id: string;
  readonly workloads: readonly string[];
  readonly measurementPhases: Readonly<
    Record<string, readonly ActionSpecification[]>
  >;
}

interface MeasureInput {
  readonly sampling: Sampling;
  readonly fixtureCorpus: { readonly id: string; readonly sha256: string };
  readonly fixtures: readonly FixtureSpecification[];
}

interface BatchTiming {
  readonly taskId: string;
  readonly ingressAt: number;
  readonly acceptedAt: number;
}

interface BatchObserver {
  next(): Promise<BatchTiming>;
  close(): void;
}
interface FilePreviewFetchObserver {
  next(path: string): Promise<void>;
  close(): void;
}

type ForegroundOccurrence = 'start' | 'completion';

type ReconnectRenderReceipt = Pick<
  TaskEditorCommitMark,
  'taskId' | 'workingRevision' | 'committedEpochMs'
>;
type ReconnectApplyReceipt = Pick<
  TaskDocumentApplyMark,
  'taskId' | 'workingRevision' | 'appliedEpochMs'
>;

interface ProductMarkObserver {
  taskInput(input: {
    taskId: string;
    workingRevision: string;
    text: string;
  }): Promise<TaskInputHandlerMark>;
  taskCommit(input: {
    taskId: string;
    workingRevision?: string;
    notWorkingRevision?: string;
    text?: string;
    afterEpochMs: number;
  }): Promise<TaskEditorCommitMark>;
  taskApply(input: {
    taskId: string;
    workingRevision?: string;
    afterEpochMs: number;
  }): Promise<TaskDocumentApplyMark>;
  diffCommit(afterEpochMs: number): Promise<DiffSurfaceCommitMark>;
  filePreviewCommit(input: {
    path: string;
    refreshNonce?: string;
    afterEpochMs: number;
  }): Promise<FilePreviewCommitMark>;
  filePreviewScroll(input: {
    path: string;
    afterEpochMs: number;
  }): Promise<FilePreviewScrollMark>;
  roomPresence(input: {
    peerActorId: string;
    afterEpochMs: number;
  }): Promise<RoomPresenceCommitMark>;
  remoteCursor(input: {
    peerActorId: string;
    workingRevision: string;
    anchor: number;
    focus: number;
    sampleNonce: string;
    afterEpochMs: number;
  }): Promise<RemoteCursorCommitMark>;
  latestTaskCommit(): TaskEditorCommitMark | undefined;
  reconnectStrategy(input: {
    taskId: string;
    strategy: 'delta' | 'snapshot' | 'gap';
    afterEpochMs: number;
  }): Promise<ReconnectStrategyMark>;
  replayForegroundWork(journal: ForegroundWorkJournal): void;
  close(): void;
}

type PerformanceReferenceDriverCommand =
  | {
      kind: 'prepare-100k-corpus';
      phase: 'warm' | 'cold';
      iteration: number;
    }
  | { kind: 'collaboration-presence'; iteration: number }
  | { kind: 'collaboration-cursor'; iteration: number }
  | { kind: 'reconnect-cycle'; iteration: number }
  | {
      kind:
        | 'work-board-keyboard-move-resize'
        | 'work-board-pointer-move-resize';
      iteration: number;
    };

type PerformanceReferenceDriverReceipt =
  | {
      kind: 'prepared';
      path: string;
      corpusId: string;
      sha256: string;
      lineCount: number;
      rebuilt: boolean;
    }
  | { kind: 'unavailable'; reason?: string }
  | {
      kind: 'presence-published';
      peerActorId: string;
      ingressStartedEpochMs: number;
      sentEpochMs: number;
    }
  | {
      kind: 'cursor-published';
      peerActorId: string;
      workingRevision: string;
      anchor: number;
      focus: number;
      startedEpochMs: number;
      sampleNonce: string;
    }
  | {
      kind: 'reconnect-observed';
      operationCount: 10_000;
      baseRevision: string;
      revision: string;
      fallbackRevision: string;
      retainedStartedEpochMs: number;
      retained: {
        strategy: ReconnectStrategyMark;
        apply: ReconnectApplyReceipt;
        render: ReconnectRenderReceipt;
      };
      fallbackStartedEpochMs: number;
      fallback: {
        strategy: ReconnectStrategyMark;
        apply: ReconnectApplyReceipt;
        render: ReconnectRenderReceipt;
      };
    }
  | { kind: 'work-board-interaction-completed' };

type PerformanceReferenceDriver = (
  command: PerformanceReferenceDriverCommand,
) => Promise<PerformanceReferenceDriverReceipt>;

declare global {
  interface Window {
    __stationInteractiveWorkspacePerformance?: {
      readonly version: 1;
      measure(input: MeasureInput): Promise<unknown>;
      observeReconnect(input: {
        strategy: 'delta' | 'snapshot' | 'gap';
        afterEpochMs: number;
        expectedRevision: string;
      }): Promise<{
        strategy: ReconnectStrategyMark;
        apply: ReconnectApplyReceipt;
        render: ReconnectRenderReceipt;
      }>;
      restartStream(): void;
      reconnectCheckpoint(): string | undefined;
      /** Board-only readiness signal; it exposes no Board data or authority. */
      waitForBoardDriver(): Promise<void>;
    };
    __stationInteractiveWorkspacePerformanceDriver?: PerformanceReferenceDriver;
    __stationInteractiveWorkspaceReconnectRelease?: (input: {
      taskId: string;
      strategy: 'delta' | 'snapshot' | 'gap';
    }) => Promise<void>;
  }
}

export function interactiveWorkspaceReferenceModeEnabled(): boolean {
  return (
    import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1' &&
    new URLSearchParams(window.location.search).get(MODE_PARAM) === MODE_VALUE
  );
}

export function installInteractiveWorkspacePerformanceBridge(): boolean {
  const taskId = taskIdFromLocation();
  if (
    !interactiveWorkspaceReferenceModeEnabled() ||
    window[BRIDGE_GLOBAL] !== undefined ||
    (!taskId && !projectPaneRouteFromLocation())
  )
    return false;
  let resolveBoardDriver: (() => void) | undefined;
  const boardDriverReady = new Promise<void>((resolve) => {
    resolveBoardDriver = resolve;
  });
  window.addEventListener(
    WORK_BOARD_DRIVER_READY_EVENT,
    () => resolveBoardDriver?.(),
    { once: true },
  );
  window[BRIDGE_GLOBAL] = Object.freeze({
    version: BRIDGE_VERSION,
    measure: (input) => measureInteractiveWorkspace(input, taskId),
    observeReconnect: (input) => {
      if (!taskId)
        throw new Error('Task-only reconnect surface is unavailable');
      return observeReconnectMark(taskId, input);
    },
    restartStream: () =>
      taskId &&
      window.dispatchEvent(
        new CustomEvent(INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT, {
          detail: taskId,
        }),
      ),
    reconnectCheckpoint: () =>
      taskId ? latestReconnectCheckpoint(taskId)?.id : undefined,
    waitForBoardDriver: () => boardDriverReady,
  });
  return true;
}

export async function observeReconnectMark(
  taskId: string,
  input: {
    strategy: 'delta' | 'snapshot' | 'gap';
    afterEpochMs: number;
    expectedRevision: string;
  },
): Promise<{
  strategy: ReconnectStrategyMark;
  apply: ReconnectApplyReceipt;
  render: ReconnectRenderReceipt;
}> {
  const marks = observeProductMarks();
  try {
    let strategy: ReconnectStrategyMark;
    try {
      strategy = await marks.reconnectStrategy({
        taskId,
        strategy: input.strategy,
        afterEpochMs: input.afterEpochMs,
      });
    } catch {
      throw new Error('reconnect strategy wait timed out');
    }
    await window.__stationInteractiveWorkspaceReconnectRelease?.({
      taskId,
      strategy: input.strategy,
    });
    let apply: TaskDocumentApplyMark;
    try {
      apply = await marks.taskApply({
        taskId,
        workingRevision: input.expectedRevision,
        afterEpochMs: strategy.receivedEpochMs,
      });
    } catch {
      throw new Error('reconnect apply wait timed out');
    }
    // A matching DOM revision may have been rendered before the restart. Only
    // the product-owned commit mark, emitted after this strategy event, proves
    // that the reconnect applied and laid out this exact revision.
    let commit: TaskEditorCommitMark;
    try {
      commit = await marks.taskCommit({
        taskId,
        workingRevision: input.expectedRevision,
        afterEpochMs: apply.appliedEpochMs,
      });
    } catch {
      const latest = marks.latestTaskCommit();
      const latestDetail = latest
        ? latest.taskId !== taskId
          ? 'latest task commit belongs to another task'
          : latest.workingRevision !== input.expectedRevision
            ? `latest task commit ${latest.workingRevision.slice(-12)} expected ${input.expectedRevision.slice(-12)}`
            : latest.committedEpochMs < apply.appliedEpochMs
              ? 'matching task commit preceded reconnect apply'
              : 'matching task commit was rejected unexpectedly'
        : 'no task commit observed';
      throw new Error(
        `reconnect revision render wait timed out; ${latestDetail}`,
      );
    }
    const render = contentFreeReconnectRender(commit);
    return {
      strategy,
      apply: {
        taskId: apply.taskId,
        workingRevision: apply.workingRevision,
        appliedEpochMs: apply.appliedEpochMs,
      },
      render,
    };
  } finally {
    marks.close();
  }
}

function contentFreeReconnectRender(
  mark: TaskEditorCommitMark,
): ReconnectRenderReceipt {
  return {
    taskId: mark.taskId,
    workingRevision: mark.workingRevision,
    committedEpochMs: mark.committedEpochMs,
  };
}

export async function measureInteractiveWorkspace(
  input: MeasureInput,
  taskId = taskIdFromLocation(),
) {
  if (!validMeasureInput(input))
    return { version: BRIDGE_VERSION, source: BRIDGE_SOURCE, observations: [] };
  const isBoardFixture = (fixture: FixtureSpecification) =>
    fixture.id === 'work-board-200-pins-v1' ||
    fixture.id === 'work-board-one-hour-v1';
  const requiresTaskIdentity = input.fixtures.some(
    (fixture) => !isBoardFixture(fixture),
  );
  if (requiresTaskIdentity && !taskId)
    return {
      version: BRIDGE_VERSION,
      source: BRIDGE_SOURCE,
      observations: input.fixtures.map((fixture) => ({
        fixtureId: fixture.id,
        status: 'NOT_VERIFIED',
        reasonCodes: ['AUTHENTICATED_TASK_IDENTITY_UNAVAILABLE'],
        counts: { failures: 0, degraded: 0 },
      })),
    };
  const editor = requiresTaskIdentity
    ? await waitForElement<HTMLTextAreaElement>(
        'textarea[data-station-performance-surface="task-editor"]',
        30_000,
      )
    : undefined;
  if (editor && taskId)
    await waitFor(() => validEditorIdentity(editor, taskId), 30_000);
  let activeJournal: ForegroundWorkJournal | undefined;
  const marks = observeProductMarks(() => activeJournal);
  const batches = observeBatchFetches();
  const filePreviewFetches = observeFilePreviewFetches();
  const observations: Array<{
    fixtureId: string;
    readonly [key: string]: unknown;
  }> = [];
  const fixtureOrder = new Map(
    input.fixtures.map((fixture, index) => [fixture.id, index]),
  );
  const executionFixtures = [...input.fixtures].sort(
    (left, right) => fixturePriority(right.id) - fixturePriority(left.id),
  );
  try {
    // Exercise the durable remote path while the one shared stream is fresh;
    // the local-only handler/layout fixture does not depend on stream writes.
    for (const fixture of executionFixtures) {
      const journal = createForegroundWorkJournal();
      activeJournal = journal;
      marks.replayForegroundWork(journal);
      try {
        if (isBoardFixture(fixture))
          observations.push(await measureWorkBoard(fixture, input.sampling));
        else if (fixture.id === 'local-input-apply')
          observations.push(
            await measureLocalInput(
              fixture,
              input.sampling,
              editor!,
              taskId!,
              marks,
            ),
          );
        else if (fixture.id === 'remote-apply')
          observations.push(
            await measureRemoteApply(
              fixture,
              input.sampling,
              editor!,
              taskId!,
              marks,
              batches,
            ),
          );
        else if (fixture.id === 'open-100k-lines')
          observations.push(
            await measure100kFile(
              fixture,
              input.sampling,
              input.fixtureCorpus,
              marks,
              filePreviewFetches,
            ),
          );
        else if (fixture.id === 'synthetic-collaboration')
          observations.push(
            await measureCollaboration(fixture, input.sampling, marks),
          );
        else if (fixture.id === 'long-session-bounded-growth')
          observations.push(
            await measureLongSession(fixture, input.sampling, marks),
          );
        else if (fixture.id === 'reconnect-10k-operations')
          observations.push(await measureReconnect(fixture, input.sampling));
        else observations.push(unavailableFixture(fixture.id));
      } catch (error) {
        observations.push({
          fixtureId: fixture.id,
          status: 'NOT_VERIFIED',
          reasonCodes: [
            `PRODUCT_MARK_MEASUREMENT_FAILED_${fixture.id}`,
            productMarkFailureCode(error),
          ],
          ...(error instanceof ClosedCollaborationFailure
            ? { driverFailure: error.receipt }
            : {}),
          counts: { failures: 1, degraded: 0 },
        });
      } finally {
        const observation = observations.at(-1);
        if (observation)
          (observation as { foregroundWork?: unknown }).foregroundWork =
            journal.snapshot();
        journal.close();
        activeJournal = undefined;
      }
    }
  } finally {
    batches.close();
    filePreviewFetches.close();
    marks.close();
  }
  observations.sort(
    (left, right) =>
      (fixtureOrder.get(left.fixtureId) ?? Number.MAX_SAFE_INTEGER) -
      (fixtureOrder.get(right.fixtureId) ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    version: BRIDGE_VERSION,
    source: BRIDGE_SOURCE,
    observations,
  };
}

async function measureWorkBoard(
  fixture: FixtureSpecification,
  sampling: Sampling,
): Promise<WorkBoardPerformanceObservation> {
  const driver = workBoardPerformanceDriver();
  if (!driver)
    return unavailableFixture(fixture.id) as WorkBoardPerformanceObservation;
  return driver.measure({
    fixtureId: fixture.id as WorkBoardPerformanceFixtureId,
    warmups: sampling.warmups,
    samples: sampling.samples,
    smoke: false,
    pins: WORK_BOARD_200_PIN_MIX,
  });
}

async function measureReconnect(
  fixture: FixtureSpecification,
  sampling: Sampling,
) {
  const driver = window.__stationInteractiveWorkspacePerformanceDriver;
  if (!driver) throw new Error('Reconnect driver is unavailable');
  const measurements = [];
  for (
    let iteration = 0;
    iteration < sampling.warmups + sampling.samples;
    iteration += 1
  ) {
    let receipt: PerformanceReferenceDriverReceipt;
    try {
      receipt = await driver({ kind: 'reconnect-cycle', iteration });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('reconnect-strategy product mark timed out'))
        throw new Error(`reconnect strategy timed out at ${iteration}`);
      if (message.includes('reconnect editor render'))
        throw new Error(`reconnect render timed out at ${iteration}`);
      throw new Error(`reconnect driver ${reconnectDriverStage(message)}`);
    }
    if (
      receipt.kind !== 'reconnect-observed' ||
      receipt.operationCount !== 10_000 ||
      receipt.retained.strategy.strategy !== 'delta' ||
      receipt.retained.strategy.revision !== receipt.revision ||
      receipt.retained.apply.workingRevision !== receipt.revision ||
      receipt.retained.render.workingRevision !== receipt.revision ||
      receipt.fallback.strategy.strategy !== 'gap' ||
      receipt.fallback.apply.workingRevision !== receipt.fallbackRevision ||
      receipt.fallback.render.workingRevision !== receipt.fallbackRevision
    )
      throw new Error('Reconnect strategy receipt is invalid');
    if (iteration >= sampling.warmups)
      measurements.push({
        iteration: iteration - sampling.warmups,
        phases: {
          retained: {
            actions: [
              action(fixture, 'retained', 'reconnect', {
                reconnectStartedAt: timeline(receipt.retainedStartedEpochMs),
                transportReadyAt: timeline(
                  receipt.retained.strategy.receivedEpochMs,
                ),
              }),
              action(fixture, 'retained', 'replay-apply', {
                replayStartedAt: timeline(
                  receipt.retained.strategy.receivedEpochMs,
                ),
                replayAppliedAt: timeline(
                  receipt.retained.apply.appliedEpochMs,
                ),
              }),
              action(fixture, 'retained', 'render-commit', {
                renderStartedAt: timeline(
                  receipt.retained.apply.appliedEpochMs,
                ),
                renderCommittedAt: timeline(
                  receipt.retained.render.committedEpochMs,
                ),
              }),
            ],
          },
          fallback: {
            actions: [
              action(fixture, 'fallback', 'snapshot-fallback', {
                fallbackStartedAt: timeline(receipt.fallbackStartedEpochMs),
                fallbackAppliedAt: timeline(
                  receipt.fallback.apply.appliedEpochMs,
                ),
              }),
            ],
          },
        },
      });
    await new Promise((resolve) =>
      setTimeout(resolve, RECONNECT_SAMPLE_SETTLE_MS),
    );
  }
  return {
    ...verifiedFixture(fixture, sampling, measurements),
    fallback: {
      retainedOperations: 10_000,
      beyondWindowStrategy: 'snapshot',
    },
  };
}

export function reconnectDriverStage(message: string): string {
  const named = /Reconnect stage ([A-Z0-9_]+) failed/.exec(message);
  if (named) {
    if (message.includes('strategy wait')) return `${named[1]}_STRATEGY`;
    if (message.includes('apply wait')) return `${named[1]}_APPLY`;
    const documentStatus = /document status ([0-9]+|none)/.exec(message);
    if (documentStatus && documentStatus[1] !== '200')
      return `${named[1]}_DOCUMENT_${documentStatus[1]!.toUpperCase()}`;
    if (message.includes('editor missing after reconnect'))
      return `${named[1]}_EDITOR_MISSING`;
    if (/editor revision [0-9a-f]{12} expected [0-9a-f]{12}/.test(message))
      return `${named[1]}_EDITOR_REVISION_MISMATCH`;
    if (message.includes('no task commit observed'))
      return `${named[1]}_RENDER_NO_COMMIT`;
    if (message.includes('belongs to another task'))
      return `${named[1]}_RENDER_TASK_MISMATCH`;
    if (message.includes('preceded reconnect apply'))
      return `${named[1]}_RENDER_BEFORE_APPLY`;
    if (message.includes('rejected unexpectedly'))
      return `${named[1]}_RENDER_MATCH_REJECTED`;
    if (/latest task commit [0-9a-f]{12} expected [0-9a-f]{12}/.test(message))
      return `${named[1]}_RENDER_REVISION_MISMATCH`;
    if (message.includes('revision render wait')) return `${named[1]}_RENDER`;
    return named[1]!;
  }
  if (message.includes('old stream was not aborted')) return 'OLD_STREAM_ABORT';
  if (message.includes('active stream lacks Last-Event-ID'))
    return 'ACTIVE_CURSOR_MISSING';
  if (message.includes('request boundary')) return 'RESUME_REQUEST_TIMEOUT';
  if (message.includes('missing Last-Event-ID')) return 'RESUME_HEADER_MISSING';
  if (message.includes('request identity changed'))
    return 'RESUME_HEADER_MISMATCH';
  if (message.includes('seed receipt')) return 'SEED_RECEIPT_INVALID';
  if (message.includes('seed is unavailable')) return 'SEED_UNAVAILABLE';
  return 'UNCLASSIFIED';
}

function fixturePriority(fixtureId: string): number {
  return fixtureId === 'remote-apply'
    ? 2
    : fixtureId === 'synthetic-collaboration'
      ? 1
      : 0;
}

async function measureCollaboration(
  fixture: FixtureSpecification,
  sampling: Sampling,
  marks: ProductMarkObserver,
) {
  const driver = window.__stationInteractiveWorkspacePerformanceDriver;
  if (!driver) throw new Error('Collaboration driver is unavailable');
  const stage = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const receipt = readClosedCollaborationFailure(error);
      if (receipt) throw new ClosedCollaborationFailure(receipt);
      const message = error instanceof Error ? error.message : 'unknown';
      const diagnostic =
        /Live command (Leave room|Join room|Announce work) status (\d{3}|UNKNOWN) outcome (DEPARTED|JOINED|UPDATED|REFRESHED|CLEARED|PAUSED|DEGRADED|REFUSED|UNAVAILABLE|INVALID|FORBIDDEN|IDENTITY_CHANGED|CAPACITY_EXCEEDED|RATE_LIMITED|UNKNOWN)/.exec(
          message,
        );
      const presence =
        /^Collaboration presence (navigation|leave|owner-absence|join|announce) failed(?:: Live command (Leave room|Join room|Announce work) status [1-5][0-9][0-9] outcome (DEPARTED|JOINED|UPDATED|REFRESHED|CLEARED|PAUSED|DEGRADED|REFUSED|UNAVAILABLE|INVALID|FORBIDDEN|IDENTITY_CHANGED|CAPACITY_EXCEEDED|RATE_LIMITED|UNKNOWN))?$/.exec(
          message,
        );
      throw new Error(
        presence
          ? `Collaboration measure ${name} failed: ${presence[0]}`
          : diagnostic
            ? `Collaboration measure ${name} failed: ${diagnostic[0]}`
            : `Collaboration measure ${name} failed`,
      );
    }
  };
  await stage('owner-publish', () => publishCurrentViewer());
  const measurements = [];
  for (
    let iteration = 0;
    iteration < sampling.warmups + sampling.samples;
    iteration += 1
  ) {
    const presenceReceipt = await stage('peer-publish', () =>
      driver({
        kind: 'collaboration-presence',
        iteration,
      }),
    );
    if (presenceReceipt.kind !== 'presence-published')
      throw new Error('Collaboration presence receipt is invalid');
    const presence = await stage('owner-presence', () =>
      marks.roomPresence({
        peerActorId: presenceReceipt.peerActorId,
        afterEpochMs: presenceReceipt.sentEpochMs,
      }),
    );
    if (
      presence.viewerActorId === presenceReceipt.peerActorId ||
      !presence.participantActorIds.includes(presenceReceipt.peerActorId)
    )
      throw new Error('Collaboration identities are not distinct');
    const cursorReceipt = await stage('peer-cursor', () =>
      driver({
        kind: 'collaboration-cursor',
        iteration,
      }),
    );
    if (
      cursorReceipt.kind !== 'cursor-published' ||
      cursorReceipt.peerActorId !== presenceReceipt.peerActorId
    )
      throw new Error('Collaboration cursor receipt is invalid');
    const cursor = await stage('owner-cursor', () =>
      marks.remoteCursor({
        peerActorId: cursorReceipt.peerActorId,
        workingRevision: cursorReceipt.workingRevision,
        anchor: cursorReceipt.anchor,
        focus: cursorReceipt.focus,
        sampleNonce: cursorReceipt.sampleNonce,
        afterEpochMs: cursorReceipt.startedEpochMs,
      }),
    );
    if (iteration >= sampling.warmups)
      measurements.push({
        iteration: iteration - sampling.warmups,
        phases: {
          measured: {
            actions: [
              action(fixture, 'measured', 'remote-ingress', {
                ingressStartedAt: timeline(
                  presenceReceipt.ingressStartedEpochMs,
                ),
                sentAt: timeline(presenceReceipt.sentEpochMs),
              }),
              action(fixture, 'measured', 'participant-update', {
                presenceStartedAt: timeline(presenceReceipt.sentEpochMs),
                presenceVisibleAt: timeline(presence.committedEpochMs),
              }),
              action(fixture, 'measured', 'cursor-update', {
                cursorStartedAt: timeline(cursorReceipt.startedEpochMs),
                cursorVisibleAt: timeline(cursor.committedEpochMs),
              }),
            ],
          },
        },
      });
    await new Promise((resolve) =>
      setTimeout(resolve, COLLABORATION_SAMPLE_SETTLE_MS),
    );
  }
  return verifiedFixture(fixture, sampling, measurements);
}

async function publishCurrentViewer(): Promise<void> {
  const join = button('Join room');
  if (!join.disabled) join.click();
  await waitFor(() => !button('Announce work').disabled, 10_000);
  button('Announce work').click();
  await waitFor(() => !button('Leave room').disabled, 10_000);
}

async function measureLongSession(
  fixture: FixtureSpecification,
  sampling: Sampling,
  marks: ProductMarkObserver,
) {
  const driver = window.__stationInteractiveWorkspacePerformanceDriver;
  if (!driver) throw new Error('long-session runner is unavailable');
  const totalIterations = sampling.warmups + sampling.samples;
  if (totalIterations <= 0) throw new Error('long-session sampling is invalid');
  await publishCurrentViewer();
  await establishLongSessionPeer(driver, marks);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  const startedAt = performance.now();
  const growthStart = longSessionGrowthSnapshot();
  const health = observeLongSessionHealth();
  const measurements = [];
  try {
    for (let iteration = 0; iteration < totalIterations; iteration += 1) {
      await waitForLongSessionSlot(
        startedAt +
          Math.floor(
            (iteration * ONE_HOUR_REFERENCE_DURATION_MS) / totalIterations,
          ),
      );
      health.assert();
      const bookkeepingStartedAt = browserEpochMs();
      const presenceReceipt = await driver({
        kind: 'collaboration-presence',
        iteration,
      });
      if (presenceReceipt.kind !== 'presence-published')
        throw new Error('long-session presence receipt is invalid');
      const presence = await marks.roomPresence({
        peerActorId: presenceReceipt.peerActorId,
        afterEpochMs: presenceReceipt.sentEpochMs,
      });
      const cursorReceipt = await driver({
        kind: 'collaboration-cursor',
        iteration,
      });
      if (
        cursorReceipt.kind !== 'cursor-published' ||
        cursorReceipt.peerActorId !== presenceReceipt.peerActorId
      )
        throw new Error('long-session cursor receipt is invalid');
      const cursor = await marks.remoteCursor({
        peerActorId: cursorReceipt.peerActorId,
        workingRevision: cursorReceipt.workingRevision,
        anchor: cursorReceipt.anchor,
        focus: cursorReceipt.focus,
        sampleNonce: cursorReceipt.sampleNonce,
        afterEpochMs: cursorReceipt.startedEpochMs,
      });
      const bookkeepingFinishedAt = browserEpochMs();
      if (iteration >= sampling.warmups)
        measurements.push({
          iteration: iteration - sampling.warmups,
          phases: {
            measured: {
              actions: [
                action(fixture, 'measured', 'participant-update', {
                  presenceStartedAt: timeline(presenceReceipt.sentEpochMs),
                  presenceAppliedAt: timeline(presence.committedEpochMs),
                }),
                action(fixture, 'measured', 'cursor-update', {
                  cursorStartedAt: timeline(cursorReceipt.startedEpochMs),
                  cursorVisibleAt: timeline(cursor.committedEpochMs),
                }),
                action(fixture, 'measured', 'long-session', {
                  bookkeepingStartedAt: timeline(bookkeepingStartedAt),
                  bookkeepingFinishedAt: timeline(bookkeepingFinishedAt),
                }),
              ],
            },
          },
        });
    }
    await waitForLongSessionSlot(startedAt + ONE_HOUR_REFERENCE_DURATION_MS);
    health.assert();
    const observedDurationMs = Math.floor(performance.now() - startedAt);
    if (observedDurationMs < ONE_HOUR_REFERENCE_DURATION_MS)
      throw new Error('long-session duration is insufficient');
    const growthEnd = longSessionGrowthSnapshot();
    return {
      ...verifiedFixture(fixture, sampling, measurements),
      growth: Object.fromEntries(
        Object.entries(growthStart).map(([name, start]) => [
          name,
          {
            start,
            end: growthEnd[name as keyof typeof growthEnd],
          },
        ]),
      ),
      duration: {
        logicalDurationMs: ONE_HOUR_REFERENCE_DURATION_MS,
        observedDurationMs,
        scaled: false,
      },
    };
  } finally {
    health.close();
  }
}

async function establishLongSessionPeer(
  driver: PerformanceReferenceDriver,
  marks: ProductMarkObserver,
): Promise<void> {
  const presence = await driver({
    kind: 'collaboration-presence',
    iteration: 0,
  });
  if (presence.kind !== 'presence-published')
    throw new Error('long-session presence receipt is invalid');
  await marks.roomPresence({
    peerActorId: presence.peerActorId,
    afterEpochMs: presence.sentEpochMs,
  });
  const cursor = await driver({ kind: 'collaboration-cursor', iteration: 0 });
  if (cursor.kind !== 'cursor-published')
    throw new Error('long-session cursor receipt is invalid');
  await marks.remoteCursor({
    peerActorId: cursor.peerActorId,
    workingRevision: cursor.workingRevision,
    anchor: cursor.anchor,
    focus: cursor.focus,
    sampleNonce: cursor.sampleNonce,
    afterEpochMs: cursor.startedEpochMs,
  });
}

function observeLongSessionHealth() {
  let failure: Error | undefined;
  const check = () => {
    if (document.visibilityState !== 'visible')
      failure ??= new Error('long-session display is unavailable');
    if (!navigator.onLine)
      failure ??= new Error('long-session runner is offline');
  };
  check();
  const interval = window.setInterval(check, 1_000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('offline', check);
  return {
    assert: () => {
      check();
      if (failure) throw failure;
    },
    close: () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('offline', check);
    },
  };
}

function longSessionGrowthSnapshot() {
  const retention = interactiveWorkspacePerformanceRetention();
  return {
    retainedUiNodes: document.querySelectorAll(
      '[data-station-performance-surface="task-room-presence"] *, [data-station-performance-surface="task-editor"]',
    ).length,
    listeners: retention.listeners,
    perOperationBookkeeping: retention.perOperationBookkeeping,
  };
}

async function waitForLongSessionSlot(targetMs: number): Promise<void> {
  const delay = Math.max(0, targetMs - performance.now());
  if (delay > 0)
    await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
}

async function measure100kFile(
  fixture: FixtureSpecification,
  sampling: Sampling,
  fixtureCorpus: MeasureInput['fixtureCorpus'],
  marks: ProductMarkObserver,
  filePreviewFetches: FilePreviewFetchObserver,
) {
  const driver = window.__stationInteractiveWorkspacePerformanceDriver;
  if (!driver) throw fileMeasurementStageError('PREPARE_CORPUS');
  const measurements = [];
  let attestedPath: string | undefined;
  let coldCorpusRebuilt = true;
  let coldNetworkFetched = true;
  let warmNetworkFetched = true;
  for (
    let iteration = 0;
    iteration < sampling.warmups + sampling.samples;
    iteration += 1
  ) {
    // Keep the serialized contract order (`warm`, then `cold`) independent
    // from the execution order below (cold rebuild before warm reuse).
    const phases: Record<string, { actions: unknown[] }> = {
      warm: { actions: [] },
      cold: { actions: [] },
    };
    // A cold rebuild is the explicit first phase. Warm follows it against the
    // same corpus identity and must not manufacture a new file.
    for (const phase of ['cold', 'warm'] as const) {
      const prepared = await measure100kStage('PREPARE_CORPUS', async () => {
        const receipt = await driver({
          kind: 'prepare-100k-corpus',
          phase,
          iteration,
        });
        if (
          receipt.kind !== 'prepared' ||
          receipt.corpusId !== fixtureCorpus.id ||
          receipt.sha256 !== fixtureCorpus.sha256 ||
          receipt.lineCount !== 100_000
        ) {
          if (
            receipt.kind === 'unavailable' &&
            receipt.reason === 'Task workspace is unavailable'
          )
            throw new Error('task workspace is unavailable');
          throw new Error(corpusReceiptDiagnostic(receipt, fixtureCorpus));
        }
        attestedPath ??= receipt.path;
        if (attestedPath !== receipt.path)
          throw new Error('corpus path changed');
        if (phase === 'cold' && !receipt.rebuilt) {
          coldCorpusRebuilt = false;
          throw new Error('cold corpus was not rebuilt');
        }
        if (phase === 'warm' && receipt.rebuilt)
          throw new Error('warm corpus was unexpectedly rebuilt');
        return receipt;
      });
      const openStartedAt = browserEpochMs();
      const commit = await measure100kStage('OPEN_FILE', async () => {
        if (
          !document.querySelector(
            '[data-station-performance-surface="workspace-file-preview"]',
          )
        ) {
          const mounted = marks.filePreviewCommit({
            path: prepared.path,
            afterEpochMs: openStartedAt,
          });
          buttonContaining(prepared.path).click();
          await mounted;
        }
        const refreshNonce = `fp-${iteration}-${phase}`;
        const fetched = filePreviewFetches.next(prepared.path);
        const commitMark = marks.filePreviewCommit({
          path: prepared.path,
          refreshNonce,
          afterEpochMs: openStartedAt,
        });
        window.dispatchEvent(
          new CustomEvent(INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT, {
            detail: {
              projectSlug: currentFilePreviewProjectSlug(),
              path: prepared.path,
              nonce: refreshNonce,
            },
          }),
        );
        await fetched;
        const receipt = await commitMark;
        if (
          receipt.lineCount !== 100_000 ||
          receipt.sizeBytes < 100_000 ||
          receipt.renderedLineCount !== 2_000
        )
          throw new Error('invalid file preview projection');
        return receipt;
      });
      if (phase === 'cold') coldNetworkFetched &&= true;
      else warmNetworkFetched &&= true;
      const editableAt = timeline(commit.committedEpochMs);
      const scrollStartedAt = Math.max(performance.now(), editableAt);
      const scroll = await measure100kStage('SCROLL_FILE', async () => {
        const scrollMark = marks.filePreviewScroll({
          path: prepared.path,
          afterEpochMs: browserEpochMs(),
        });
        const surface = document.querySelector<HTMLElement>(
          '[data-station-performance-surface="workspace-file-preview"]',
        );
        if (!surface) throw new Error('file preview surface unavailable');
        surface.scrollTop = surface.scrollHeight;
        surface.dispatchEvent(new Event('scroll', { bubbles: true }));
        const receipt = await scrollMark;
        if (receipt.scrollTop <= 0)
          throw new Error('file preview did not scroll');
        return receipt;
      });
      const diffStartedAt = timeline(scroll.committedEpochMs);
      const diff = await measure100kStage('RENDER_DIFF', async () => {
        const diffMark = marks.diffCommit(scroll.committedEpochMs);
        button('Inspect worktree diff').click();
        const receipt = await diffMark;
        if (receipt.patchBytes < 1 || receipt.fileCount < 1)
          throw new Error('DiffPanel content unavailable');
        return receipt;
      });
      phases[phase] = {
        actions: [
          action(fixture, phase, 'file-open', {
            openStartedAt: timeline(openStartedAt),
            editableAt,
          }),
          action(fixture, phase, 'scroll', {
            scrollStartedAt,
            scrollRenderedAt: timeline(scroll.committedEpochMs),
          }),
          action(fixture, phase, 'diff-render', {
            diffStartedAt,
            diffRenderedAt: timeline(diff.committedEpochMs),
          }),
        ],
      };
    }
    if (iteration >= sampling.warmups)
      measurements.push({
        iteration: iteration - sampling.warmups,
        phases,
      });
  }
  return {
    ...verifiedFixture(fixture, sampling, measurements),
    corpus: { ...fixtureCorpus, lineCount: 100_000 },
    warmCold: {
      warmupsDiscarded: sampling.warmups,
      coldCorpusRebuilt,
      coldNetworkFetched,
      warmNetworkFetched,
      cacheOnlyEvidence: 'NOT_ACCEPTED',
      source: 'product-owned-bridge',
    },
  };
}

type FileMeasurementStage =
  | 'PREPARE_CORPUS'
  | 'OPEN_FILE'
  | 'SCROLL_FILE'
  | 'RENDER_DIFF';

function fileMeasurementStageError(stage: FileMeasurementStage): Error {
  return new Error(`100k file measurement ${stage} failed`);
}

function corpusReceiptDiagnostic(
  receipt: unknown,
  corpus: MeasureInput['fixtureCorpus'],
): string {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    return '100k corpus receipt UNKNOWN';
  const value = receipt as Record<string, unknown>;
  if (
    value.kind === 'unavailable' &&
    [
      'CONTROL_TIMEOUT',
      'CONTROL_CONNECTION',
      'CONTROL_FRAMING',
      'CONTROL_RECEIPT_TOO_LARGE',
      'CONTROL_INVALID_JSON',
      'CONTROL_UNKNOWN',
    ].includes(value.reason as string)
  )
    return `100k corpus receipt ${value.reason}`;
  if (value.kind !== 'prepared')
    return `100k corpus receipt ${value.kind === 'refused' ? 'REFUSED' : 'UNKNOWN'}`;
  if (value.corpusId !== corpus.id)
    return '100k corpus receipt CORPUS_ID_MISMATCH';
  if (value.sha256 !== corpus.sha256)
    return '100k corpus receipt DIGEST_MISMATCH';
  if (value.lineCount !== 100_000)
    return '100k corpus receipt LINE_COUNT_MISMATCH';
  return '100k corpus receipt UNKNOWN';
}

async function measure100kStage<T>(
  stage: FileMeasurementStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof Error &&
      /^(task workspace is unavailable|100k corpus receipt (CONTROL_TIMEOUT|CONTROL_CONNECTION|CONTROL_FRAMING|CONTROL_RECEIPT_TOO_LARGE|CONTROL_INVALID_JSON|CONTROL_UNKNOWN|UNAVAILABLE|REFUSED|UNKNOWN|CORPUS_ID_MISMATCH|DIGEST_MISMATCH|LINE_COUNT_MISMATCH))$/.test(
        error.message,
      )
    )
      throw error;
    // Preserve only the stable stage in the public reason code. Driver and DOM
    // failures may contain volatile paths or browser text, neither of which is
    // suitable for a durable performance receipt.
    throw fileMeasurementStageError(stage);
  }
}

async function measureLocalInput(
  fixture: FixtureSpecification,
  sampling: Sampling,
  editor: HTMLTextAreaElement,
  taskId: string,
  marks: ProductMarkObserver,
) {
  const measurements = [];
  const initial = editor.value;
  const total = sampling.warmups + sampling.samples;
  for (let iteration = 0; iteration < total; iteration += 1) {
    const workingRevision = exactEditorRevision(editor, taskId);
    const desired = `${initial}${String(iteration % 10)}`;
    const inputMark = marks.taskInput({
      taskId,
      workingRevision,
      text: desired,
    });
    setTextAreaValue(editor, desired);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const input = await inputMark;
    const commit = await marks.taskCommit({
      taskId,
      workingRevision,
      text: desired,
      afterEpochMs: input.exitedEpochMs,
    });
    const diffMark = marks.diffCommit(commit.committedEpochMs);
    button(
      iteration === 0
        ? 'Inspect worktree diff'
        : iteration % 2 === 0
          ? 'Expand all'
          : 'Collapse all',
    ).click();
    const diffCommit = await diffMark;
    if (diffCommit.patchBytes < 1 || diffCommit.fileCount < 1)
      throw new Error('Actual worktree diff content is unavailable');
    const inputAt = timeline(input.enteredEpochMs);
    const handledAt = timeline(input.exitedEpochMs);
    const applyStartedAt = handledAt;
    const modelCommittedAt = timeline(commit.committedEpochMs);
    const renderStartedAt = modelCommittedAt;
    const renderCommittedAt = timeline(diffCommit.committedEpochMs);
    if (iteration >= sampling.warmups)
      measurements.push({
        iteration: iteration - sampling.warmups,
        phases: {
          measured: {
            actions: [
              action(fixture, 'measured', 'typing', {
                inputAt,
                handledAt,
              }),
              action(fixture, 'measured', 'input-apply', {
                applyStartedAt,
                modelCommittedAt,
              }),
              action(fixture, 'measured', 'diff-render', {
                renderStartedAt,
                renderCommittedAt,
              }),
            ],
          },
        },
      });
  }
  const resetRevision = exactEditorRevision(editor, taskId);
  const resetInputMark = marks.taskInput({
    taskId,
    workingRevision: resetRevision,
    text: initial,
  });
  setTextAreaValue(editor, initial);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  const resetInput = await resetInputMark;
  await marks.taskCommit({
    taskId,
    workingRevision: resetRevision,
    text: initial,
    afterEpochMs: resetInput.exitedEpochMs,
  });
  return verifiedFixture(fixture, sampling, measurements);
}

async function measureRemoteApply(
  fixture: FixtureSpecification,
  sampling: Sampling,
  editor: HTMLTextAreaElement,
  taskId: string,
  marks: ProductMarkObserver,
  observer: BatchObserver,
) {
  await publishCurrentViewer();
  const save = button('Save shared document');
  const measurements = [];
  const total = sampling.warmups + sampling.samples;
  for (let iteration = 0; iteration < total; iteration += 1) {
    const workingRevision = exactEditorRevision(editor, taskId);
    const desired = `${editor.value}${String(iteration % 10)}`;
    const inputMark = marks.taskInput({
      taskId,
      workingRevision,
      text: desired,
    });
    setTextAreaValue(editor, desired);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const input = await inputMark;
    try {
      await waitFor(() => !save.disabled, 5_000, 'save readiness');
    } catch (error) {
      const state = settledAdoptionFailure(statusText());
      if (state !== 'settled-text adoption timed out') throw new Error(state);
      throw error;
    }
    const timing = observer.next();
    save.click();
    const accepted = await timing;
    if (accepted.taskId !== taskId)
      throw new Error('Batch timing Task identity changed');
    const applied = await marks.taskApply({
      taskId,
      afterEpochMs: accepted.acceptedAt,
    });
    const commit = await marks.taskCommit({
      taskId,
      text: desired,
      notWorkingRevision: workingRevision,
      afterEpochMs: input.exitedEpochMs,
    });
    if (commit.committedEpochMs < accepted.acceptedAt)
      throw new Error('Server and browser epoch ordering is invalid');
    if (applied.workingRevision !== commit.workingRevision)
      throw new Error('Authoritative document and layout revisions diverged');
    const ingressStartedAt = timeline(input.enteredEpochMs);
    const sentAt = timeline(input.exitedEpochMs);
    const transportStartedAt = sentAt;
    const arrivedAt = timeline(accepted.ingressAt);
    const acceptanceStartedAt = arrivedAt;
    const acceptedAt = timeline(accepted.acceptedAt);
    const applyStartedAt = acceptedAt;
    if (
      editor.value !== desired ||
      exactEditorRevision(editor, taskId) !== commit.workingRevision
    )
      throw new Error('Task editor commit identity does not match its mark');
    const appliedAt = timeline(applied.appliedEpochMs);
    const renderStartedAt = appliedAt;
    const renderCommittedAt = timeline(commit.committedEpochMs);
    if (iteration >= sampling.warmups)
      measurements.push({
        iteration: iteration - sampling.warmups,
        phases: {
          measured: {
            actions: [
              action(fixture, 'measured', 'remote-ingress', {
                ingressStartedAt,
                sentAt,
              }),
              action(fixture, 'measured', 'transport', {
                transportStartedAt,
                arrivedAt,
              }),
              action(fixture, 'measured', 'server-acceptance', {
                acceptanceStartedAt,
                acceptedAt,
              }),
              action(fixture, 'measured', 'authoritative-document-apply', {
                applyStartedAt,
                appliedAt,
              }),
              action(fixture, 'measured', 'render-commit', {
                renderStartedAt,
                renderCommittedAt,
              }),
            ],
          },
        },
      });
    // The authoritative SSE/layout commit may precede the mutation hook's
    // settled-text adoption. Fence the next sample on the shipped terminal UI
    // state so a late adoption cannot overwrite its draft. This wait is not a
    // performance mark and contributes to no measured phase.
    try {
      await waitFor(
        () => statusText().includes('Shared document saved.'),
        10_000,
        'settled-text adoption',
      );
    } catch {
      throw new Error(settledAdoptionFailure(statusText()));
    }
    // Reference samples are independent interactions, not one burst. Leave
    // this fixed interval outside every action mark so the shared SSE stream
    // can drain its bounded pending queue without inventing evidence.
    await settleReferenceSample();
  }
  return verifiedFixture(fixture, sampling, measurements);
}

function observeBatchFetches(): BatchObserver {
  const original = window.fetch.bind(window);
  const waiters: Array<{
    resolve(timing: BatchTiming): void;
    reject(error: Error): void;
  }> = [];
  const queued: BatchTiming[] = [];
  const errors: Error[] = [];
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const batch = url.includes('/room/batches');
    const editPlan = url.includes('/room/edit-plan');
    const live = url.includes('/room/live');
    if (!batch && !editPlan && !live) return original(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(
      INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER,
      INTERACTIVE_WORKSPACE_TIMING_MODE,
    );
    try {
      const response = await original(input, { ...init, headers });
      if (editPlan || live) return response;
      const receipt = parseInteractiveWorkspaceBatchTiming(
        response.headers.get(INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER),
      );
      if (!receipt)
        throw new Error('Authenticated server timing receipt is unavailable');
      const timing = {
        taskId: receipt.taskId,
        ingressAt: receipt.ingressEpochMs,
        acceptedAt: receipt.acceptedEpochMs,
      };
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(timing);
      else queued.push(timing);
      return response;
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error('Batch timing failed');
      const waiter = waiters.shift();
      if (waiter) waiter.reject(failure);
      else errors.push(failure);
      throw failure;
    }
  };
  return {
    next: () => {
      const error = errors.shift();
      if (error) return Promise.reject(error);
      const timing = queued.shift();
      return timing
        ? Promise.resolve(timing)
        : new Promise<BatchTiming>((resolve, reject) =>
            waiters.push({ resolve, reject }),
          );
    },
    close: () => {
      window.fetch = original;
      for (const waiter of waiters.splice(0))
        waiter.reject(new Error('Batch observer closed'));
      errors.splice(0);
    },
  };
}

/** Records a real preview request. Cached query data never reaches this seam. */
function observeFilePreviewFetches(): FilePreviewFetchObserver {
  const original = window.fetch.bind(window);
  const queued: string[] = [];
  const waiters: Array<{
    path: string;
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const isPreview = /\/api\/projects\/[^/]+\/file-preview(?:\?|$)/.test(url);
    try {
      const response = await original(input, init);
      if (isPreview && response.ok) {
        // The exact product query key supplies the path; this observer's job
        // is solely to reject a cache-only "refresh".
        const waiter = waiters.shift();
        if (waiter) waiter.resolve();
        else queued.push(url);
      }
      return response;
    } catch (error) {
      if (isPreview) {
        const waiter = waiters.shift();
        if (waiter)
          waiter.reject(
            error instanceof Error
              ? error
              : new Error('File preview fetch failed'),
          );
      }
      throw error;
    }
  };
  return {
    next: (path) => {
      if (!path)
        return Promise.reject(new Error('File preview path is invalid'));
      if (queued.length) {
        queued.shift();
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) =>
        waiters.push({ path, resolve, reject }),
      );
    },
    close: () => {
      window.fetch = original;
      for (const waiter of waiters.splice(0))
        waiter.reject(new Error('File preview observer closed'));
      queued.splice(0);
    },
  };
}

function currentFilePreviewProjectSlug(): string {
  const surface = document.querySelector<HTMLElement>(
    '[data-station-performance-surface="workspace-file-preview"]',
  );
  const projectSlug = surface?.dataset.stationProjectSlug;
  if (!projectSlug)
    throw new Error('100k file preview project identity is unavailable');
  return projectSlug;
}

function observeProductMarks(
  journalForMark?: () => ForegroundWorkJournal | undefined,
): ProductMarkObserver {
  const taskInputs = markQueue<TaskInputHandlerMark>();
  const taskApplies = markQueue<TaskDocumentApplyMark>();
  const taskCommits = markQueue<TaskEditorCommitMark>();
  const diffCommits = markQueue<DiffSurfaceCommitMark>();
  const filePreviewCommits = markQueue<FilePreviewCommitMark>();
  const filePreviewScrolls = markQueue<FilePreviewScrollMark>();
  const roomPresenceCommits = markQueue<RoomPresenceCommitMark>();
  const remoteCursorCommits = markQueue<RemoteCursorCommitMark>();
  const reconnectStrategies = markQueue<ReconnectStrategyMark>();
  const restorationTimes = new Set<number>();
  const pendingRestorations: number[] = [];
  const restoreAt = (occurrenceTimeMs: number) => {
    if (
      !Number.isFinite(occurrenceTimeMs) ||
      restorationTimes.has(occurrenceTimeMs)
    )
      return;
    restorationTimes.add(occurrenceTimeMs);
    const journal = journalForMark?.();
    if (journal)
      markForegroundWork(
        journal,
        foregroundAttributionForPersistedHostDocumentRestoration(),
        performance.timeOrigin + occurrenceTimeMs,
        'completion',
      );
    else pendingRestorations.push(occurrenceTimeMs);
  };
  const restoredMarkTimes = () =>
    typeof performance.getEntriesByName === 'function'
      ? performance
          .getEntriesByName(WORKSPACE_PANE_HOST_RESTORED_MARK, 'mark')
          .map((entry) => entry.startTime)
      : [];
  const onWorkspacePaneHostRestored = (event: Event) => {
    const time =
      event instanceof CustomEvent && Number.isFinite(event.detail)
        ? event.detail
        : restoredMarkTimes().at(-1);
    if (typeof time === 'number') restoreAt(time);
  };
  window.addEventListener(
    WORKSPACE_PANE_HOST_RESTORED_EVENT,
    onWorkspacePaneHostRestored,
  );
  for (const occurrenceTimeMs of restoredMarkTimes())
    restoreAt(occurrenceTimeMs);
  const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks(
    (event: InteractiveWorkspacePerformanceProductMark) => {
      const journal = journalForMark?.();
      const foreground = foregroundAttributionForProductMark(event);
      if (foreground)
        markForegroundWork(
          journal,
          foreground.attribution,
          foreground.epochMs,
          foreground.occurrence,
        );
      if (event.kind === 'task-input') taskInputs.push(event.mark);
      else if (event.kind === 'task-apply') taskApplies.push(event.mark);
      else if (event.kind === 'task-commit') taskCommits.push(event.mark);
      else if (event.kind === 'diff-commit') diffCommits.push(event.mark);
      else if (event.kind === 'file-preview-commit')
        filePreviewCommits.push(event.mark);
      else if (event.kind === 'file-preview-scroll')
        filePreviewScrolls.push(event.mark);
      else if (event.kind === 'room-presence-commit')
        roomPresenceCommits.push(event.mark);
      else if (event.kind === 'remote-cursor-commit')
        remoteCursorCommits.push(event.mark);
      else if (event.kind === 'reconnect-strategy')
        reconnectStrategies.push(event.mark);
    },
  );
  return {
    replayForegroundWork: (journal) => {
      for (const occurrenceTimeMs of pendingRestorations.splice(0))
        markForegroundWork(
          journal,
          foregroundAttributionForPersistedHostDocumentRestoration(),
          performance.timeOrigin + occurrenceTimeMs,
          'completion',
        );
    },
    taskInput: (input) =>
      namedProductMark(
        taskInputs.take(
          (mark) =>
            mark.taskId === input.taskId &&
            mark.workingRevision === input.workingRevision &&
            (input.text === undefined || mark.text === input.text) &&
            mark.exitedEpochMs >= mark.enteredEpochMs,
        ),
        'task-input',
      ),
    taskCommit: (input) =>
      namedProductMark(
        taskCommits.take(
          (mark) =>
            mark.taskId === input.taskId &&
            (input.workingRevision === undefined ||
              mark.workingRevision === input.workingRevision) &&
            (input.notWorkingRevision === undefined ||
              mark.workingRevision !== input.notWorkingRevision) &&
            (input.text === undefined || mark.text === input.text) &&
            mark.committedEpochMs >= input.afterEpochMs,
        ),
        'task-commit',
      ),
    taskApply: (input) =>
      namedProductMark(
        taskApplies.take(
          (mark) =>
            mark.taskId === input.taskId &&
            (!input.workingRevision ||
              mark.workingRevision === input.workingRevision) &&
            mark.appliedEpochMs >= input.afterEpochMs,
        ),
        'task-apply',
      ),
    diffCommit: (afterEpochMs) =>
      namedProductMark(
        diffCommits.take((mark) => mark.committedEpochMs >= afterEpochMs),
        'diff-commit',
      ),
    filePreviewCommit: (input) =>
      namedProductMark(
        filePreviewCommits.take(
          (mark) =>
            mark.path === input.path &&
            mark.committedEpochMs >= input.afterEpochMs,
        ),
        'file-preview-commit',
      ),
    filePreviewScroll: (input) =>
      namedProductMark(
        filePreviewScrolls.take(
          (mark) =>
            mark.path === input.path &&
            mark.committedEpochMs >= input.afterEpochMs,
        ),
        'file-preview-scroll',
      ),
    roomPresence: (input) =>
      namedProductMark(
        roomPresenceCommits.take(
          (mark) =>
            mark.participantActorIds.includes(input.peerActorId) &&
            mark.committedEpochMs >= input.afterEpochMs,
        ),
        'room-presence-commit',
      ),
    remoteCursor: (input) =>
      namedProductMark(
        remoteCursorCommits.take(
          (mark) =>
            mark.actorId === input.peerActorId &&
            mark.workingRevision === input.workingRevision &&
            mark.anchor === input.anchor &&
            mark.focus === input.focus &&
            mark.sampleNonce === input.sampleNonce &&
            mark.committedEpochMs >= input.afterEpochMs,
        ),
        'remote-cursor-commit',
      ),
    latestTaskCommit: () => taskCommits.latest(),
    reconnectStrategy: (input) =>
      namedProductMark(
        reconnectStrategies.take(
          (mark) =>
            mark.taskId === input.taskId &&
            mark.strategy === input.strategy &&
            mark.receivedEpochMs >= input.afterEpochMs,
        ),
        'reconnect-strategy',
      ),
    close: () => {
      unsubscribe();
      window.removeEventListener(
        WORKSPACE_PANE_HOST_RESTORED_EVENT,
        onWorkspacePaneHostRestored,
      );
      taskInputs.close();
      taskApplies.close();
      taskCommits.close();
      diffCommits.close();
      filePreviewCommits.close();
      filePreviewScrolls.close();
      roomPresenceCommits.close();
      remoteCursorCommits.close();
      reconnectStrategies.close();
    },
  };
}

export function foregroundAttributionForProductMark(
  event: InteractiveWorkspacePerformanceProductMark,
):
  | {
      readonly attribution: ForegroundWorkAttribution;
      readonly epochMs: number;
      readonly occurrence: ForegroundOccurrence;
    }
  | undefined {
  if (event.kind === 'task-input')
    return {
      attribution: {
        phase: 'input',
        interaction: 'task-editor',
        action: 'local-input',
        pane: 'task-editor',
      },
      epochMs: event.mark.enteredEpochMs,
      occurrence: 'start',
    };
  if (event.kind === 'task-apply')
    return {
      attribution: {
        phase: 'authoritative-apply',
        interaction: 'collaboration',
        action: 'remote-apply',
        pane: 'task-editor',
      },
      epochMs: event.mark.appliedEpochMs,
      occurrence: 'completion',
    };
  if (event.kind === 'task-commit')
    return {
      attribution: {
        phase: 'layout',
        interaction: 'task-editor',
        action: 'layout-commit',
        pane: 'task-editor',
      },
      epochMs: event.mark.committedEpochMs,
      occurrence: 'completion',
    };
  if (event.kind === 'diff-commit')
    return {
      attribution: {
        phase: 'render',
        interaction: 'workspace-pane',
        action: 'layout-commit',
        pane: 'diff-panel',
      },
      epochMs: event.mark.committedEpochMs,
      occurrence: 'completion',
    };
  if (
    event.kind === 'file-preview-commit' ||
    event.kind === 'file-preview-scroll'
  )
    return {
      attribution: {
        phase: 'render',
        interaction: 'workspace-pane',
        action: 'layout-commit',
        pane: 'file-preview',
      },
      epochMs: event.mark.committedEpochMs,
      occurrence: 'completion',
    };
  if (
    event.kind === 'room-presence-commit' ||
    event.kind === 'remote-cursor-commit'
  )
    return {
      attribution: {
        phase: 'render',
        interaction: 'collaboration',
        action: 'presence-update',
        pane: 'task-editor',
      },
      epochMs: event.mark.committedEpochMs,
      occurrence: 'completion',
    };
  if (event.kind === 'reconnect-strategy')
    return {
      attribution: {
        phase: 'authoritative-apply',
        interaction: 'navigation',
        action: 'pane-restore',
        pane: 'task-editor',
      },
      epochMs: event.mark.receivedEpochMs,
      occurrence: 'completion',
    };
  return undefined;
}

export function foregroundAttributionForPersistedHostDocumentRestoration(): ForegroundWorkAttribution {
  return {
    phase: 'pane-restoration',
    interaction: 'navigation',
    action: 'pane-restore',
    pane: 'workspace-host',
  };
}

function markForegroundWork(
  journal: ForegroundWorkJournal | undefined,
  attribution: ForegroundWorkAttribution,
  epochMs: number,
  occurrence: ForegroundOccurrence,
): void {
  const occurrenceTimeMs = epochMs - performance.timeOrigin;
  if (Number.isFinite(occurrenceTimeMs) && occurrenceTimeMs >= 0)
    journal?.mark(attribution, occurrenceTimeMs, occurrence);
}

async function namedProductMark<T>(
  promise: Promise<T>,
  name: string,
): Promise<T> {
  try {
    return await promise;
  } catch {
    throw new Error(`${name} product mark timed out`);
  }
}

function markQueue<T>() {
  const values: T[] = [];
  let latestValue: T | undefined;
  const waiters: Array<{
    predicate(value: T): boolean;
    resolve(value: T): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  return {
    push: (value: T) => {
      latestValue = value;
      const index = waiters.findIndex((waiter) => waiter.predicate(value));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(value);
      } else {
        if (values.length >= 256) values.shift();
        values.push(value);
      }
    },
    take: (predicate: (value: T) => boolean) => {
      const index = values.findIndex(predicate);
      if (index >= 0) return Promise.resolve(values.splice(index, 1)[0]!);
      return new Promise<T>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const waiterIndex = waiters.indexOf(waiter);
            if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
            reject(new Error('Product performance mark timed out'));
          }, PRODUCT_MARK_TIMEOUT_MS),
        };
        waiters.push(waiter);
      });
    },
    latest: () => latestValue,
    close: () => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Product performance mark observer closed'));
      }
      values.splice(0);
    },
  };
}

function timeline(epochMs: number): number {
  const value = epochMs - performance.timeOrigin;
  if (!Number.isFinite(value) || value < 0 || value > performance.now() + 1_000)
    throw new Error('Performance epoch is outside this reference host');
  return value;
}

function exactEditorRevision(
  editor: HTMLTextAreaElement,
  taskId: string,
): string {
  const revision = editor.dataset.stationWorkingRevision;
  if (!validEditorIdentity(editor, taskId) || !revision)
    throw new Error('Exact shipped Task editor identity is unavailable');
  return revision;
}

function validEditorIdentity(
  editor: HTMLTextAreaElement,
  taskId: string,
): boolean {
  const revision = editor.dataset.stationWorkingRevision;
  return (
    editor.dataset.stationPerformanceSurface === 'task-editor' &&
    editor.dataset.stationTaskId === taskId &&
    typeof revision === 'string' &&
    /^swsr-v1:[0-9a-f]{64}$/.test(revision)
  );
}

function taskIdFromLocation(): string | undefined {
  const match = /^\/tasks\/([^/]+)$/.exec(window.location.pathname);
  if (!match) return undefined;
  try {
    const taskId = decodeURIComponent(match[1]!);
    return taskId.length > 0 && taskId.length <= 256 && taskId === taskId.trim()
      ? taskId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Board-only fixtures mount the canonical Project Pane route, never a task. */
function projectPaneRouteFromLocation(): boolean {
  const match = /^\/projects\/([^/]+)\/panes\/([^/]+)\/([^/]+)$/.exec(
    window.location.pathname,
  );
  if (!match) return false;
  try {
    return match.slice(1).every((part) => {
      const decoded = decodeURIComponent(part);
      return (
        decoded.length > 0 &&
        decoded.length <= 512 &&
        decoded === decoded.trim()
      );
    });
  } catch {
    return false;
  }
}

function action(
  fixture: FixtureSpecification,
  phase: string,
  kind: string,
  marks: Record<string, number>,
) {
  const specification = fixture.measurementPhases[phase]?.find(
    (candidate) => candidate.id === kind,
  );
  if (
    !specification ||
    specification.marks.length !== Object.keys(marks).length ||
    !specification.marks.every((mark) => Number.isFinite(marks[mark]))
  )
    throw new Error('Performance action does not match the v3 contract');
  return { kind, marks };
}

function verifiedFixture(
  fixture: FixtureSpecification,
  sampling: Sampling,
  measurements: readonly unknown[],
) {
  return {
    fixtureId: fixture.id,
    sampling: { ...sampling },
    workloads: [...fixture.workloads],
    measurements,
    counts: { failures: 0, degraded: 0 },
  };
}

function unavailableFixture(fixtureId: string) {
  const reasons: Record<string, string> = {
    'synthetic-collaboration': 'TWO_PARTICIPANT_REFERENCE_SURFACE_UNAVAILABLE',
    'open-100k-lines': 'PLAIN_TEXT_100K_SHIPPED_FILE_SURFACE_UNAVAILABLE',
    'reconnect-10k-operations': 'RETAINED_10K_RECONNECT_FIXTURE_UNAVAILABLE',
    'long-session-bounded-growth': 'ONE_HOUR_REFERENCE_OBSERVATION_NOT_RUN',
    'work-board-200-pins-v1': 'WORK_BOARD_PERFORMANCE_BRIDGE_UNAVAILABLE',
    'work-board-one-hour-v1': 'WORK_BOARD_ONE_HOUR_OBSERVATION_NOT_RUN',
  };
  return {
    fixtureId,
    status: 'NOT_VERIFIED',
    reasonCodes: [reasons[fixtureId] ?? 'SHIPPED_SURFACE_UNAVAILABLE'],
    counts: { failures: 0, degraded: 0 },
  };
}

interface ClosedCollaborationFailureReceipt {
  readonly version: 1;
  readonly stage: string;
  readonly iteration: number | 'UNKNOWN';
  readonly command: string | null;
  readonly joinOutcome: string;
  readonly stream: string;
  readonly join: string;
  readonly announce: string;
  readonly dialog: string;
  readonly telemetry: string;
}

// Exposed bindings serialize Error.message, not custom Error properties. Accept
// only the complete bounded wire form; never retain the original message/cause.
function readClosedCollaborationFailure(
  error: unknown,
): ClosedCollaborationFailureReceipt | undefined {
  if (!(error instanceof Error) || error.message.length > 768) return;
  const match =
    /^Collaboration presence (navigation-context|navigation|task-context|identity|leave-state|leave|owner-absence|join|ingress-clock|send-clock|announce) failed(?:: (Live command (?:(?:depart|join|announce|cursor) (?:input|response) (?:TIMEOUT|TARGET_CLOSED|FAILED)|(?:Leave room|Join room|Announce work) status [1-5][0-9][0-9] outcome (?:DEPARTED|JOINED|UPDATED|REFRESHED|CLEARED|PAUSED|DEGRADED|REFUSED|UNAVAILABLE|INVALID|FORBIDDEN|IDENTITY_CHANGED|CAPACITY_EXCEEDED|RATE_LIMITED|UNKNOWN))))?; iteration=(UNKNOWN|0|[1-9][0-9]{0,2}); joinOutcome=(NOT_OBSERVED|DEPARTED|JOINED|UPDATED|REFRESHED|CLEARED|PAUSED|DEGRADED|REFUSED|UNAVAILABLE|INVALID|FORBIDDEN|IDENTITY_CHANGED|CAPACITY_EXCEEDED|RATE_LIMITED|UNKNOWN); stream=(LIVE|CONNECTING|TERMINAL|UNKNOWN); join=(ABSENT|HIDDEN|AMBIGUOUS|DISABLED|ENABLED|UNKNOWN); announce=(ABSENT|HIDDEN|AMBIGUOUS|DISABLED|ENABLED|UNKNOWN); dialog=(VISIBLE|NONE|UNKNOWN); telemetry=(VISIBLE|NONE|UNKNOWN)$/.exec(
      error.message,
    );
  if (!match) return;
  const iteration = match[3] === 'UNKNOWN' ? 'UNKNOWN' : Number(match[3]);
  if (iteration !== 'UNKNOWN' && iteration > 209) return;
  return {
    version: 1,
    stage: match[1]!,
    command: match[2] ?? null,
    iteration,
    joinOutcome: match[4]!,
    stream: match[5]!,
    join: match[6]!,
    announce: match[7]!,
    dialog: match[8]!,
    telemetry: match[9]!,
  };
}

class ClosedCollaborationFailure extends Error {
  constructor(readonly receipt: ClosedCollaborationFailureReceipt) {
    super(`Collaboration presence ${receipt.stage} failed`);
  }
}

export function productMarkFailureCode(error: unknown): string {
  if (error instanceof ClosedCollaborationFailure)
    return `PRODUCT_COLLABORATION_PRESENCE_${error.receipt.stage.replaceAll('-', '_').toUpperCase()}_FAILED`;
  const message = error instanceof Error ? error.message : '';
  const corpusReceipt =
    /100k corpus receipt (CONTROL_TIMEOUT|CONTROL_CONNECTION|CONTROL_FRAMING|CONTROL_RECEIPT_TOO_LARGE|CONTROL_INVALID_JSON|CONTROL_UNKNOWN|UNAVAILABLE|REFUSED|UNKNOWN|CORPUS_ID_MISMATCH|DIGEST_MISMATCH|LINE_COUNT_MISMATCH)/.exec(
      message,
    );
  if (corpusReceipt)
    return `PRODUCT_FILE_100K_PREPARE_CORPUS_${corpusReceipt[1]!}`;
  const liveCommand =
    /Collaboration (?:presence|measure) ([a-z-]+) failed: (?:Collaboration presence (?:navigation|leave|owner-absence|join|announce) failed: )?Live command (?:Leave room|Join room|Announce work) status [1-5][0-9][0-9] outcome (DEPARTED|JOINED|UPDATED|REFRESHED|CLEARED|PAUSED|DEGRADED|REFUSED|UNAVAILABLE|INVALID|FORBIDDEN|IDENTITY_CHANGED|CAPACITY_EXCEEDED|RATE_LIMITED|UNKNOWN)/.exec(
      message,
    );
  if (liveCommand)
    return `PRODUCT_COLLABORATION_${liveCommand[1]!.replaceAll('-', '_').toUpperCase()}_LIVE_COMMAND_OUTCOME_${liveCommand[2]!}`;
  const fileMeasurementStage = /100k file measurement ([A-Z_]+) failed/.exec(
    message,
  );
  if (fileMeasurementStage)
    return `PRODUCT_FILE_100K_${fileMeasurementStage[1]!}_FAILED`;
  const presenceStage =
    /Collaboration presence (navigation|leave|owner-absence|join|announce) failed/.exec(
      message,
    );
  if (presenceStage)
    return `PRODUCT_COLLABORATION_PRESENCE_${presenceStage[1]!.replaceAll('-', '_').toUpperCase()}_FAILED`;
  const collaborationMeasure = /Collaboration measure ([a-z-]+) failed/.exec(
    message,
  );
  if (collaborationMeasure)
    if (
      /Live command .* outcome (DEPARTED|JOINED|UPDATED|REFRESHED|CLEARED|PAUSED|DEGRADED|REFUSED|UNAVAILABLE|INVALID|FORBIDDEN|IDENTITY_CHANGED|CAPACITY_EXCEEDED|RATE_LIMITED|UNKNOWN)/.test(
        message,
      )
    )
      return `PRODUCT_COLLABORATION_${collaborationMeasure[1]!.replaceAll('-', '_').toUpperCase()}_LIVE_COMMAND_OUTCOME_${message.match(/outcome ([A-Z]+)/)?.[1]}`;
  if (collaborationMeasure)
    return `PRODUCT_COLLABORATION_${collaborationMeasure[1]!.replaceAll('-', '_').toUpperCase()}_FAILED`;
  const reconnectIteration =
    /reconnect (strategy|render) timed out at (\d+)/.exec(message);
  if (reconnectIteration)
    return `PRODUCT_RECONNECT_${reconnectIteration[1]!.toUpperCase()}_TIMEOUT_AT_${reconnectIteration[2]}`;
  const reconnectDriver = /reconnect driver ([A-Z0-9_]+)/.exec(message);
  if (reconnectDriver) return `PRODUCT_RECONNECT_DRIVER_${reconnectDriver[1]!}`;
  if (message.includes('task-input product'))
    return 'PRODUCT_TASK_INPUT_TIMEOUT';
  if (message.includes('task-commit product'))
    return 'PRODUCT_TASK_COMMIT_TIMEOUT';
  if (message.includes('diff-commit product'))
    return 'PRODUCT_DIFF_COMMIT_TIMEOUT';
  if (message.includes('file-preview-commit product'))
    return 'PRODUCT_FILE_PREVIEW_COMMIT_TIMEOUT';
  if (message.includes('room-presence-commit product'))
    return 'PRODUCT_ROOM_PRESENCE_TIMEOUT';
  if (message.includes('remote-cursor-commit product'))
    return 'PRODUCT_REMOTE_CURSOR_TIMEOUT';
  if (message.includes('Collaboration presence receipt'))
    return 'PRODUCT_COLLABORATION_PRESENCE_RECEIPT_INVALID';
  if (message.includes('Collaboration cursor receipt'))
    return 'PRODUCT_COLLABORATION_CURSOR_RECEIPT_INVALID';
  if (message.includes('Collaboration identities'))
    return 'PRODUCT_COLLABORATION_IDENTITIES_INVALID';
  if (message.includes('working document is too short'))
    return 'PRODUCT_COLLABORATION_DOCUMENT_TOO_SHORT';
  if (message.includes('reconnect-strategy product'))
    return 'PRODUCT_RECONNECT_STRATEGY_TIMEOUT';
  if (message.includes('reconnect editor render'))
    return 'PRODUCT_RECONNECT_RENDER_TIMEOUT';
  if (message.includes('Reconnect strategy receipt'))
    return 'PRODUCT_RECONNECT_STRATEGY_RECEIPT_INVALID';
  if (message.includes('Reconnect seed receipt'))
    return 'PRODUCT_RECONNECT_SEED_RECEIPT_INVALID';
  if (message.includes('Reconnect old stream was not aborted'))
    return 'PRODUCT_RECONNECT_OLD_STREAM_ABORT_TIMEOUT';
  if (message.includes('Reconnect active stream lacks Last-Event-ID'))
    return 'PRODUCT_RECONNECT_ACTIVE_CURSOR_MISSING';
  if (message.includes('Reconnect observer did not go offline'))
    return 'PRODUCT_RECONNECT_OFFLINE_FENCE_TIMEOUT';
  if (message.includes('Reconnect request boundary'))
    return 'PRODUCT_RECONNECT_REQUEST_FENCE_TIMEOUT';
  if (message.includes('missing Last-Event-ID'))
    return 'PRODUCT_RECONNECT_LAST_EVENT_ID_MISSING';
  if (message.includes('request identity changed'))
    return 'PRODUCT_RECONNECT_LAST_EVENT_ID_MISMATCH';
  if (message.includes('diff content'))
    return 'PRODUCT_DIFF_CONTENT_UNAVAILABLE';
  if (message.includes('Task editor identity'))
    return 'PRODUCT_TASK_IDENTITY_UNAVAILABLE';
  if (message.includes('Authoritative document and layout revisions'))
    return 'PRODUCT_REMOTE_APPLY_REVISION_DIVERGED';
  if (message.includes('server timing receipt'))
    return 'PRODUCT_SERVER_RECEIPT_UNAVAILABLE';
  if (message.includes('corpus driver'))
    return 'PRODUCT_CORPUS_DRIVER_UNAVAILABLE';
  if (message.includes('task workspace is unavailable'))
    return 'PRODUCT_FILE_TASK_WORKSPACE_UNAVAILABLE';
  if (message.includes('corpus receipt'))
    return 'PRODUCT_CORPUS_RECEIPT_INVALID';
  if (message.includes('corpus path')) return 'PRODUCT_CORPUS_PATH_CHANGED';
  if (message.includes('cold corpus was not rebuilt'))
    return 'PRODUCT_COLD_CORPUS_NOT_REBUILT';
  if (message.includes('warm corpus was unexpectedly rebuilt'))
    return 'PRODUCT_WARM_CORPUS_REBUILT';
  if (message.includes('preview project identity'))
    return 'PRODUCT_FILE_PREVIEW_PROJECT_IDENTITY_UNAVAILABLE';
  if (message.includes('file preview projection'))
    return 'PRODUCT_FILE_PREVIEW_PROJECTION_INVALID';
  if (message.includes('file preview surface'))
    return 'PRODUCT_FILE_PREVIEW_SURFACE_UNAVAILABLE';
  if (message.includes('did not scroll')) return 'PRODUCT_FILE_SCROLL_INVALID';
  if (message.includes('DiffPanel content'))
    return 'PRODUCT_FILE_DIFF_UNAVAILABLE';
  if (message.includes('long-session display'))
    return 'PRODUCT_LONG_SESSION_DISPLAY_UNAVAILABLE';
  if (message.includes('long-session runner'))
    return 'PRODUCT_LONG_SESSION_RUNNER_UNAVAILABLE';
  if (message.includes('long-session duration'))
    return 'PRODUCT_LONG_SESSION_DURATION_INSUFFICIENT';
  if (message.includes('long-session presence'))
    return 'PRODUCT_LONG_SESSION_PRESENCE_RECEIPT_INVALID';
  if (message.includes('long-session cursor'))
    return 'PRODUCT_LONG_SESSION_CURSOR_RECEIPT_INVALID';
  if (message.includes('button containing'))
    return 'PRODUCT_FILE_REFERENCE_UNAVAILABLE';
  if (message.includes('save readiness'))
    return 'PRODUCT_SAVE_READINESS_TIMEOUT';
  if (message.includes('settled-text adoption'))
    return 'PRODUCT_SETTLED_ADOPTION_TIMEOUT';
  if (message.includes('settled state indeterminate'))
    return 'PRODUCT_SETTLED_STATE_INDETERMINATE';
  if (message.includes('settled state authorization-ended'))
    return 'PRODUCT_SETTLED_AUTHORIZATION_ENDED';
  if (message.includes('settled state document-stale'))
    return 'PRODUCT_SETTLED_DOCUMENT_STALE';
  if (message.includes('settled state room-unavailable'))
    return 'PRODUCT_SETTLED_ROOM_UNAVAILABLE';
  if (message.includes('settled state read-only'))
    return 'PRODUCT_SETTLED_READ_ONLY';
  if (message.includes('settled state refused'))
    return 'PRODUCT_SETTLED_REFUSED';
  if (message.includes('timed out')) return 'PRODUCT_MARK_TIMEOUT';
  if (message.includes('epoch')) return 'PRODUCT_EPOCH_MISMATCH';
  return 'PRODUCT_MARK_FAILURE_UNCLASSIFIED';
}

function validMeasureInput(value: MeasureInput): boolean {
  return (
    Number.isSafeInteger(value?.sampling?.warmups) &&
    value.sampling.warmups >= 0 &&
    Number.isSafeInteger(value.sampling.samples) &&
    value.sampling.samples > 0 &&
    typeof value.fixtureCorpus?.id === 'string' &&
    /^[0-9a-f]{64}$/.test(value.fixtureCorpus?.sha256) &&
    Array.isArray(value.fixtures)
  );
}

function setTextAreaValue(editor: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Task editor setter is unavailable');
  setter.call(editor, value);
}

function statusText(): string {
  return [...document.querySelectorAll<HTMLElement>('[role="status"]')]
    .map((node) => node.textContent ?? '')
    .join('\n');
}

function settledAdoptionFailure(status: string): string {
  if (status.includes('may have taken effect'))
    return 'settled state indeterminate';
  if (status.includes('authorization ended'))
    return 'settled state authorization-ended';
  if (status.includes('stale')) return 'settled state document-stale';
  if (
    status.includes('Task room is unavailable') ||
    status.includes('document is unavailable')
  )
    return 'settled state room-unavailable';
  if (status.includes('read-only') || status.includes('not readable'))
    return 'settled state read-only';
  if (status.includes('Save refused')) return 'settled state refused';
  return 'settled-text adoption timed out';
}

function button(name: string): HTMLButtonElement {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((candidate) => candidate.textContent?.trim() === name);
  if (!result) throw new Error(`Shipped button '${name}' is unavailable`);
  return result;
}

function buttonContaining(text: string): HTMLButtonElement {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((candidate) => candidate.textContent?.includes(text));
  if (!result)
    throw new Error(`Shipped button containing '${text}' is unavailable`);
  return result;
}

async function waitForElement<T extends Element>(
  selector: string,
  timeoutMs: number,
): Promise<T> {
  let result: T | null = null;
  await waitFor(() => {
    result = document.querySelector<T>(selector);
    return result !== null;
  }, timeoutMs);
  return result!;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label = 'Shipped performance surface',
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out`);
    await nextFrame();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function settleReferenceSample(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, REFERENCE_SAMPLE_SETTLE_MS),
  );
}

import {
  createForegroundWorkJournal,
  type ForegroundWorkAttribution,
  type ForegroundWorkJournal,
} from '@shared/foreground-work-journal';
import {
  INTERACTIVE_WORKSPACE_TIMING_MODE,
  INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER,
  INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER,
  parseInteractiveWorkspaceBatchTiming,
} from '@shared/interactive-workspace-performance-timing';
import {
  browserEpochMs,
  type DiffSurfaceCommitMark,
  type FilePreviewCommitMark,
  type FilePreviewScrollMark,
  INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT,
  INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT,
  type InteractiveWorkspacePerformanceProductMark,
  interactiveWorkspacePerformanceRetention,
  latestReconnectCheckpoint,
  type ReconnectStrategyMark,
  type RemoteCursorCommitMark,
  type RoomPresenceCommitMark,
  subscribeInteractiveWorkspacePerformanceMarks,
  type TaskDocumentApplyMark,
  type TaskEditorCommitMark,
  type TaskInputHandlerMark,
} from './interactive-workspace-performance-hooks';
import {
  WORK_BOARD_200_PIN_MIX,
  WORK_BOARD_DRIVER_READY_EVENT,
  type WorkBoardPerformanceFixtureId,
  type WorkBoardPerformanceObservation,
  workBoardPerformanceDriver,
} from './work-board-performance-bridge';
