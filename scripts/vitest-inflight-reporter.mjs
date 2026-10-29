/**
 * The heartbeat period. It MUST be shorter than the timeout this reporter
 * exists to diagnose.
 *
 * It was 30_000 — exactly `vitest.config.ts`'s `testTimeout` AND its
 * `hookTimeout` — and the interval is anchored to RUN start, not module start.
 * A module that hung for its whole budget therefore got at MOST ONE heartbeat
 * and frequently zero, depending only on where its hang fell relative to the
 * run-wide tick. With `maxWorkers: 4`, that single line names four modules at
 * once, so even the lucky case does not identify which of them hung. The
 * diagnostic was timed out of existence by the thing it reports on: the one
 * question it is built to answer — WHICH module is stuck — was the question it
 * could not answer.
 *
 * Six ticks per budget, so a module that hangs to its deadline is named in at
 * least five heartbeats before it is killed, and the last heartbeat before the
 * kill is at most one interval stale. `scripts/__tests__/vitest-inflight-reporter.test.ts`
 * pins this against the config's own `testTimeout` rather than against a
 * transcribed literal, so raising the budget cannot silently restore the
 * matched-period defect.
 */
const HEARTBEATS_PER_TIMEOUT_BUDGET = 6;
const DEFAULT_INTERVAL_MS = 30_000 / HEARTBEATS_PER_TIMEOUT_BUDGET;
const MAX_IN_FLIGHT_MODULES = 16;
const MAX_MODULE_LABEL_LENGTH = 240;
const MAX_VISIBLE_ACTIVITIES = 2;

function safeLabel(value, length) {
  return String(value)
    .replace(/[\s\S]/g, (character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .slice(0, length);
}

function moduleLabel(testModule) {
  return safeLabel(
    testModule.relativeModuleId ?? testModule.moduleId,
    MAX_MODULE_LABEL_LENGTH,
  );
}

/**
 * Reports observed lifecycle state, not a liveness verdict. Queued is the last
 * observed enqueue: load/collection completion has not yet been observed.
 * It can persist while imports or top-level code execute. An empty set
 * establishes no teardown attribution.
 * The interval is unref'd so diagnostics can never keep Vitest alive.
 */
export { DEFAULT_INTERVAL_MS, HEARTBEATS_PER_TIMEOUT_BUDGET };

export class VitestInflightReporter {
  constructor({
    intervalMs = DEFAULT_INTERVAL_MS,
    write = (message) => process.stdout.write(message),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = () => performance.now(),
  } = {}) {
    this.intervalMs = intervalMs;
    this.write = write;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.now = now;
    this.inFlight = new Map();
    this.timer = null;
  }

  onTestRunStart() {
    this.stopTimer();
    this.inFlight.clear();
    this.timer = this.setIntervalFn(
      () => this.emit('[vitest-progress] in-flight:'),
      this.intervalMs,
    );
    this.timer?.unref?.();
  }

  onTestModuleStart(testModule) {
    this.observeModule(testModule, 'running');
  }

  onTestModuleQueued(testModule) {
    this.observeModule(testModule, 'queued');
  }

  onTestModuleCollected(testModule) {
    this.observeModule(testModule, 'collected');
  }

  observeModule(testModule, stage) {
    const key = testModule.moduleId;
    let state = this.inFlight.get(key);
    if (!state) {
      state = {
        label: moduleLabel(testModule),
        stage,
        since: this.now(),
        cases: new Map(),
        hooks: new Map(),
      };
      this.inFlight.set(key, state);
    } else if (state.stage !== stage) {
      state.stage = stage;
      state.since = this.now();
    }
    return state;
  }

  onTestCaseReady(testCase) {
    const state = this.observeModule(testCase.module, 'running');
    state.cases.set(testCase.id, this.now());
  }

  onTestCaseResult(testCase) {
    this.inFlight.get(testCase.module.moduleId)?.cases.delete(testCase.id);
  }

  onHookStart(hook) {
    const module =
      hook.entity.type === 'module' ? hook.entity : hook.entity.module;
    const state = this.observeModule(module, 'running');
    state.hooks.set(`${hook.entity.id}:${hook.name}`, {
      name: hook.name,
      since: this.now(),
    });
  }

  onHookEnd(hook) {
    const module =
      hook.entity.type === 'module' ? hook.entity : hook.entity.module;
    this.inFlight
      .get(module.moduleId)
      ?.hooks.delete(`${hook.entity.id}:${hook.name}`);
  }

  onTestModuleEnd(testModule) {
    this.inFlight.delete(testModule.moduleId);
  }

  onTestRunEnd() {
    this.stopTimer();
    this.emit('[vitest-progress] final in-flight:');
  }

  emit(prefix) {
    const now = this.now();
    const elapsed = (since) => Math.max(0, Math.floor(now - since));
    const rank = { running: 0, collected: 1, queued: 2 };
    const states = [...this.inFlight.values()].sort(
      (a, b) => rank[a.stage] - rank[b.stage] || a.label.localeCompare(b.label),
    );
    const visible = states.slice(0, MAX_IN_FLIGHT_MODULES).map((state) => {
      const cases = [...state.cases]
        .slice(0, MAX_VISIBLE_ACTIVITIES)
        .map(([id, since]) => `${safeLabel(id, 64)}@${elapsed(since)}ms`);
      const hooks = [...state.hooks.values()]
        .slice(0, MAX_VISIBLE_ACTIVITIES)
        .map((hook) => `${hook.name}@${elapsed(hook.since)}ms`);
      const activities = (labels, count) =>
        `${labels.join('|') || 'unknown'}${count > labels.length ? `|+${count - labels.length}` : ''}`;
      return `${state.label} {stage=${state.stage}; elapsedMs=${elapsed(state.since)}; cases=${activities(cases, state.cases.size)}; hooks=${activities(hooks, state.hooks.size)}}`;
    });
    const omitted = states.length - visible.length;
    const summary =
      visible.length === 0
        ? 'unknown (no observed module; teardown unobserved)'
        : visible.join(', ');
    this.write(
      `${prefix} ${summary}${omitted > 0 ? `, ... +${omitted}` : ''}\n`,
    );
  }

  stopTimer() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

export default VitestInflightReporter;
