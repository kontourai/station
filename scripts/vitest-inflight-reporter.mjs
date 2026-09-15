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

function moduleLabel(testModule) {
  return String(
    testModule?.relativeModuleId ?? testModule?.moduleId ?? '<unknown module>',
  )
    .replace(/[\r\n]+/g, ' ')
    .slice(0, MAX_MODULE_LABEL_LENGTH);
}

/**
 * Emits a bounded heartbeat naming every test module that started but has not
 * ended. The interval is unref'd so diagnostics can never keep Vitest alive.
 */
export { DEFAULT_INTERVAL_MS, HEARTBEATS_PER_TIMEOUT_BUDGET };

export class VitestInflightReporter {
  constructor({
    intervalMs = DEFAULT_INTERVAL_MS,
    write = (message) => process.stdout.write(message),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.intervalMs = intervalMs;
    this.write = write;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.inFlight = new Map();
    this.timer = null;
  }

  onTestRunStart() {
    this.stopTimer();
    this.timer = this.setIntervalFn(
      () => this.emit('[vitest-progress] in-flight:'),
      this.intervalMs,
    );
    this.timer?.unref?.();
  }

  onTestModuleStart(testModule) {
    const key = String(testModule?.moduleId ?? moduleLabel(testModule));
    this.inFlight.set(key, moduleLabel(testModule));
  }

  onTestModuleEnd(testModule) {
    const key = String(testModule?.moduleId ?? moduleLabel(testModule));
    this.inFlight.delete(key);
  }

  onTestRunEnd() {
    this.stopTimer();
    this.emit('[vitest-progress] final in-flight:');
  }

  emit(prefix) {
    const labels = [...this.inFlight.values()].sort();
    const visible = labels.slice(0, MAX_IN_FLIGHT_MODULES);
    const omitted = labels.length - visible.length;
    const summary = visible.length === 0 ? 'none' : visible.join(', ');
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
