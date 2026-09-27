/**
 * Source invariants of `orchestration-service.ts`, moved here unchanged from
 * `orchestration-service.test.ts` (#2176). Two of them scan the whole
 * `src-server/services` tree, which no import edge connects to a test, so the
 * `repo-scans` pull-request job runs this file; the third shares their
 * `readMethodBody` helper. None of them constructs the service.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('OrchestrationService', () => {
  /** A class-member declaration at the file's two-space member indent. */
  const MEMBER_DECLARATION =
    /^ {2}(?:private |public |protected )?(?:static )?(?:readonly )?(?:async )?[A-Za-z_$][\w$]*\(/gm;

  /**
   * One method's body: from its declaration to whatever member is declared
   * NEXT, whichever that turns out to be.
   *
   * Review L6 (archive#4218) called out the previous form — a slice between two
   * NAMED markers — as not-a-body, since a member declared between them but
   * CALLED from above the gate keeps every relative index intact while
   * inverting the ordering the invariant exists to protect. That was not
   * hypothetical: applying this helper immediately showed
   * `captureUsagePricingSnapshot` had already landed between
   * `consumeAdapterEvents` and `isAdapterCurrent`, so the ingest scan was
   * reading two members as one body. Naming the next marker is what rots;
   * this finds it, so an insertion narrows the slice instead of widening it.
   */
  function readMethodBody(source: string, declaration: string): string {
    const start = source.indexOf(declaration);
    expect(
      start,
      `declaration not found: ${declaration}`,
    ).toBeGreaterThanOrEqual(0);
    const rest = source.slice(start + declaration.length);
    const next = [...rest.matchAll(MEMBER_DECLARATION)][0];
    expect(next, 'no member follows the scanned declaration').toBeDefined();
    return declaration + rest.slice(0, next?.index ?? rest.length);
  }

  describe('the cooperative-stop settle-read precedes the quarantine gate (source invariant)', () => {
    /**
     * Slice 10 (archive#4204): moving `settleCompletedTurn` below the quarantine
     * gate changes observable behavior ONLY for a quarantined thread with
     * an in-flight cooperative stop — a state no runtime fixture had ever
     * constructed, so the perturbation was 100% green under the whole
     * suite. The ordering's owner is this scan; its behavioral complement
     * is the I2 guard fixture beside the stop tests.
     */
    test('publishCanonicalEvent settles a completed stop before it can decline the event', () => {
      const source = readFileSync(
        join(__dirname, '..', 'orchestration-service.ts'),
        'utf8',
      );
      const body = readMethodBody(source, '\n  private publishCanonicalEvent(');
      const settle = body.indexOf('.settleCompletedTurn(');
      const gate = body.indexOf('this.quarantinedThreads.has(');
      expect(settle).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(settle).toBeLessThan(gate);
      // Exactly one dispatch of the settle, file-wide (double-settle guard).
      // RAW scan, comments included: a service-side comment that writes the
      // literal call form `.settleCompletedTurn(` would red this on its own
      // rationale — keep prose references name-only (same warning as the
      // forgetThreadState invariant above).
      expect(source.split('.settleCompletedTurn(').length - 1).toBe(1);
    });
  });

  describe('the ingest policy/spool calls sit below the publish continue-gate (source invariant)', () => {
    /**
     * Slice 11 (archive#4218): the two FlowPolicySidecar ingest calls must run
     * ONLY for events the publish seam accepted — moving either above the
     * continue-gate changes observable behavior only for events the gate
     * declines (coalesced deltas, quarantined threads), populations no
     * runtime fixture combined with tool events before this slice. The
     * ordering's owner is this scan; its behavioral complement is the
     * quarantined-ingest guard in the S3 policy band. Prose that names the
     * calls stays name-only (no `this.flowPolicy.` + paren call form) or
     * this scan reds on its own rationale — same warning as the two
     * invariants above.
     */
    test('consumeAdapterEvents orders gate < post-hoc policy < command spool, each dispatched once file-wide', () => {
      const source = readFileSync(
        join(__dirname, '..', 'orchestration-service.ts'),
        'utf8',
      );
      const body = readMethodBody(
        source,
        '\n  private async consumeAdapterEvents(',
      );
      const gate = body.indexOf('if (!this.projectAndPublishEvent(');
      const postHoc = body.indexOf('.applyPostHocToolPolicies(');
      const spool = body.indexOf('.spoolCommandEvidence(');
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(postHoc).toBeGreaterThan(gate);
      expect(spool).toBeGreaterThan(postHoc);
      // The gate must be the ONLY one in the body: with two, the ingest
      // calls could sit above the real gate and still be `> gate`.
      expect(body.split('if (!this.projectAndPublishEvent(').length - 1).toBe(
        1,
      );
      // Exactly one dispatch of each across the SERVICES TREE, not just this
      // file (review M2): before slice 11 both were private members of this
      // class, so "file-wide" was "everywhere". They are public members of an
      // exported class now — any module holding the sidecar can dispatch
      // them, and a second appender spooling the same event would double
      // every command into durable Flow evidence. RAW scan, comments
      // included, so prose naming them stays name-only.
      const servicesTree = readdirSync(join(__dirname, '..', '..'), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && String(entry.name).endsWith('.ts'))
        .map((entry) => join(String(entry.parentPath), String(entry.name)))
        .filter((file) => !file.includes('__tests__'))
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      expect(servicesTree.split('.applyPostHocToolPolicies(').length - 1).toBe(
        1,
      );
      expect(servicesTree.split('.spoolCommandEvidence(').length - 1).toBe(1);
    });
  });

  describe('shutdown reads the retiring set before it drains (source invariant)', () => {
    /**
     * Slice 12 (archive#4024): `retiringAdapters()` and `shutdownRetirementTasks()`
     * used to be one expression over one map. Split across a module seam,
     * they are two calls that MUST happen at the same synchronous tick —
     * an await between them lets a retirement settle and drop out of the
     * set, after which the second arm stops an adapter the first arm is
     * already stopping. Nothing at any level observes that ordering, so
     * this scan owns it.
     */
    test('the two retirement reads are adjacent, with no await between them', () => {
      const source = readFileSync(
        join(__dirname, '..', 'orchestration-service.ts'),
        'utf8',
      );
      const body = readMethodBody(
        source,
        '\n  async shutdown(): Promise<void> {',
      );
      const set = body.indexOf('.retiringAdapters()');
      const drain = body.indexOf('.shutdownRetirementTasks()');
      expect(set).toBeGreaterThanOrEqual(0);
      expect(drain).toBeGreaterThan(set);
      // The window starts at the read, so an await IMMEDIATELY BEFORE it —
      // `const x = await this.adapterRetirement.retiringAdapters()`, if that
      // ever became async — would suspend outside the scan and stay green
      // while a retirement settles out of the drain map (review L2). Pin the
      // call's awaitless form directly.
      expect(body).toContain(
        'const retiringAdapters = this.adapterRetirement.retiringAdapters();',
      );
      // The ONLY await permitted between them is the one that opens the
      // `Promise.allSettled([` whose array literal CONTAINS the drain: that
      // await does not suspend until after the array is built, so the two
      // reads still happen at one tick. Any OTHER await does suspend, and
      // that is the hazard. RAW scan, comments included, so prose between
      // them stays name-only.
      const between = body
        .slice(set, drain)
        .replace('await Promise.allSettled([', '');
      expect(between).not.toMatch(/\bawait\b/);
      // Exactly one dispatch of each across the services tree: a second
      // drain would double-stop every retiring adapter.
      const servicesTree = readdirSync(join(__dirname, '..', '..'), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && String(entry.name).endsWith('.ts'))
        .map((entry) => join(String(entry.parentPath), String(entry.name)))
        .filter((file) => !file.includes('__tests__'))
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      expect(servicesTree.split('.shutdownRetirementTasks(').length - 1).toBe(
        1,
      );
    });
  });
});
