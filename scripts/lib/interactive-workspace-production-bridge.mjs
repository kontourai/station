/** Product-owned browser bridge contract consumed by station#2892. */
export const PRODUCTION_BRIDGE_VERSION = 1;
export const PRODUCTION_BRIDGE_GLOBAL =
  '__stationInteractiveWorkspacePerformance';

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function normalizeBridgeCounts(value) {
  const valid =
    nonNegativeInteger(value?.failures) && nonNegativeInteger(value?.degraded);
  return {
    valid,
    counts: {
      failures: valid ? value.failures : 0,
      degraded: valid ? value.degraded : 0,
    },
  };
}

function namedReasons(value, fallback) {
  const reasons = Array.isArray(value)
    ? value.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : [];
  return reasons.length > 0 ? reasons : [fallback];
}

export function unavailableBridgeObservations(config, reason, evidence = []) {
  return config.fixtures.map((fixture) => {
    const observed = evidence.find((item) => item?.fixtureId === fixture.id);
    return {
      fixtureId: fixture.id,
      status: 'NOT_VERIFIED',
      reasonCodes: [reason],
      counts: normalizeBridgeCounts(observed?.counts).counts,
    };
  });
}

function derivationEntries(fixture) {
  return [
    ...fixture.metrics.map((metric) => ({
      id: metric.id,
      kind: 'metric',
      mapping: fixture.derivation?.metrics?.[metric.id],
    })),
    ...fixture.requiredComponents.map((id) => ({
      id,
      kind: 'component',
      mapping: fixture.derivation?.components?.[id],
    })),
  ];
}

function requiredPhases(fixture) {
  return [
    ...new Set(
      derivationEntries(fixture)
        .map((entry) => entry.mapping?.phase)
        .filter(Boolean),
    ),
  ];
}

function phaseActions(fixture, phase) {
  return fixture.measurementPhases?.[phase];
}

function endpointIsDeclared(fixture, mapping, endpoint) {
  if (!Array.isArray(endpoint) || endpoint.length !== 2) return false;
  const action = phaseActions(fixture, mapping?.phase)?.find(
    (item) => item?.id === endpoint[0],
  );
  return Boolean(action?.marks?.includes(endpoint[1]));
}

function sameIdentifiers(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value, index) => value === right[index])
  );
}

function uniqueSubset(left, right) {
  return (
    Array.isArray(left) &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function sameSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    new Set(left).size === right.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

/** The checked-in schema prevents unowned marks and ambiguous components. */
function derivationSchemaMatches(fixture) {
  const entries = derivationEntries(fixture);
  const phases = requiredPhases(fixture);
  if (
    !fixture.derivation ||
    !sameIdentifiers(
      Object.keys(fixture.derivation.metrics ?? {}),
      fixture.metrics.map((metric) => metric.id),
    ) ||
    !sameIdentifiers(
      Object.keys(fixture.derivation.components ?? {}),
      fixture.requiredComponents,
    ) ||
    !sameIdentifiers(Object.keys(fixture.measurementPhases ?? {}), phases)
  )
    return false;
  const coveredMarks = new Set();
  const componentMappings = new Set();
  for (const entry of entries) {
    const mapping = entry.mapping;
    if (
      !mapping ||
      !phases.includes(mapping.phase) ||
      !endpointIsDeclared(fixture, mapping, mapping.start) ||
      !endpointIsDeclared(fixture, mapping, mapping.end)
    )
      return false;
    coveredMarks.add(`${mapping.phase}:${mapping.start.join(':')}`);
    coveredMarks.add(`${mapping.phase}:${mapping.end.join(':')}`);
    if (entry.kind === 'component') {
      const identity = JSON.stringify([
        mapping.phase,
        mapping.start,
        mapping.end,
      ]);
      if (componentMappings.has(identity)) return false;
      componentMappings.add(identity);
    }
  }
  return (
    sameSet(
      phases.flatMap((phase) =>
        phaseActions(fixture, phase)?.map((action) => action?.id),
      ),
      fixture.workloads,
    ) &&
    phases.every((phase) => {
      const actions = phaseActions(fixture, phase);
      return (
        uniqueSubset(
          actions?.map((action) => action?.id),
          fixture.workloads,
        ) &&
        actions.every(
          (action) =>
            typeof action.startMark === 'string' &&
            typeof action.endMark === 'string' &&
            sameIdentifiers(action.marks, [...new Set(action.marks)]) &&
            action.marks[0] === action.startMark &&
            action.marks.at(-1) === action.endMark &&
            action.marks.includes(action.startMark) &&
            action.marks.includes(action.endMark) &&
            action.marks.every((mark) =>
              coveredMarks.has(`${phase}:${action.id}:${mark}`),
            ),
        )
      );
    })
  );
}

function actionMark(record, phase, actionKind, mark) {
  const actions = record?.phases?.[phase]?.actions;
  const action = Array.isArray(actions)
    ? actions.find((item) => item?.kind === actionKind)
    : undefined;
  return action?.marks?.[mark];
}

function measurementRecordsMatch(fixture, observation, samples) {
  const records = observation.measurements;
  const phases = requiredPhases(fixture);
  if (
    !Array.isArray(records) ||
    records.length !== samples ||
    new Set(records.map((record) => record?.iteration)).size !== samples
  )
    return false;
  for (let iteration = 0; iteration < samples; iteration += 1) {
    const record = records.find((item) => item?.iteration === iteration);
    if (
      !record ||
      !sameIdentifiers(Object.keys(record.phases ?? {}), phases) ||
      !phases.every((phase) => Array.isArray(record.phases?.[phase]?.actions))
    )
      return false;
    for (const phase of phases) {
      const actions = record.phases[phase].actions;
      const expected = phaseActions(fixture, phase);
      if (
        !sameIdentifiers(
          actions.map((action) => action?.kind),
          expected.map((action) => action.id),
        ) ||
        actions.some((action, index) => {
          const specification = expected[index];
          return (
            !sameIdentifiers(
              Object.keys(action?.marks ?? {}),
              specification.marks,
            ) ||
            specification.marks.some(
              (mark) => !Number.isFinite(action.marks[mark]),
            ) ||
            specification.marks.some(
              (mark, markIndex) =>
                markIndex > 0 &&
                action.marks[mark] <
                  action.marks[specification.marks[markIndex - 1]],
            ) ||
            action.marks[specification.startMark] >
              action.marks[specification.endMark]
          );
        })
      )
        return false;
      for (let index = 1; index < actions.length; index += 1) {
        if (
          actions[index].marks[expected[index].startMark] <
          actions[index - 1].marks[expected[index - 1].endMark]
        )
          return false;
      }
    }
  }
  return true;
}

function deriveSamples(fixture, observation, samples) {
  const derived = { metrics: {}, components: {} };
  for (const entry of derivationEntries(fixture)) {
    const mapping = entry.mapping;
    if (
      !mapping ||
      !Array.isArray(mapping.start) ||
      !Array.isArray(mapping.end) ||
      mapping.start.length !== 2 ||
      mapping.end.length !== 2
    )
      return null;
    const values = [];
    for (let iteration = 0; iteration < samples; iteration += 1) {
      const record = observation.measurements.find(
        (item) => item.iteration === iteration,
      );
      const start = actionMark(record, mapping.phase, ...mapping.start);
      const end = actionMark(record, mapping.phase, ...mapping.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        return null;
      values.push(end - start);
    }
    derived[entry.kind === 'metric' ? 'metrics' : 'components'][entry.id] =
      values;
  }
  return derived;
}

function suppliedArraysMatch(supplied, derived, fixture, kind) {
  if (supplied === undefined) return true;
  const expected = kind === 'metric' ? derived.metrics : derived.components;
  const entries = derivationEntries(fixture).filter(
    (entry) => entry.kind === kind,
  );
  return (
    supplied &&
    entries.every((entry) => {
      const actual = supplied[entry.id];
      const expectedValues = expected[entry.id];
      return (
        Array.isArray(actual) &&
        actual.length === expectedValues.length &&
        actual.every(
          (value, index) =>
            Number.isFinite(value) && value === expectedValues[index],
        )
      );
    })
  );
}

/**
 * Raw bridge marks are the sole reference-evidence source. Optional aggregate
 * arrays are only an integrity cross-check and are replaced with this result.
 */
export function deriveBridgeFixtureEvidence(config, fixture, observation) {
  if (!derivationSchemaMatches(fixture))
    return {
      reasons: [`DERIVATION_SCHEMA_MISMATCH_${fixture.id}`],
      observation,
    };
  if (!measurementRecordsMatch(fixture, observation, config.sampling.samples))
    return {
      reasons: [`MEASUREMENT_RECORD_MISMATCH_${fixture.id}`],
      observation,
    };
  const derived = deriveSamples(fixture, observation, config.sampling.samples);
  if (!derived)
    return {
      reasons: [`MEASUREMENT_DERIVATION_MISMATCH_${fixture.id}`],
      observation,
    };
  const reasons = [];
  if (!suppliedArraysMatch(observation.samples, derived, fixture, 'metric'))
    reasons.push(`DERIVED_METRIC_MISMATCH_${fixture.id}`);
  if (
    !suppliedArraysMatch(observation.components, derived, fixture, 'component')
  )
    reasons.push(`DERIVED_COMPONENT_MISMATCH_${fixture.id}`);
  return {
    reasons,
    observation: {
      ...observation,
      samples: derived.metrics,
      components: derived.components,
    },
  };
}

function malformedFallback(fixture, observation) {
  if (!fixture.fallback) return false;
  const fallback = observation.fallback;
  return (
    !nonNegativeInteger(fallback?.retainedOperations) ||
    typeof fallback?.beyondWindowStrategy !== 'string' ||
    fallback.beyondWindowStrategy.length === 0
  );
}

function malformedGrowth(fixture, observation) {
  return Object.keys(fixture.growth ?? {}).some((name) => {
    const growth = observation.growth?.[name];
    return !Number.isFinite(growth?.start) || !Number.isFinite(growth?.end);
  });
}

export function bridgeFixtureReasons(config, fixture, observation) {
  const reasons = [];
  if (!observation || observation.fixtureId !== fixture.id)
    return [`MISSING_BRIDGE_FIXTURE_${fixture.id}`];
  const normalizedCounts = normalizeBridgeCounts(observation.counts);
  if (observation.status === 'NOT_VERIFIED') {
    return [
      ...namedReasons(
        observation.reasonCodes,
        `INVALID_NOT_VERIFIED_REASON_${fixture.id}`,
      ),
      ...(normalizedCounts.valid ? [] : [`INVALID_COUNTS_${fixture.id}`]),
    ];
  }
  if (!normalizedCounts.valid) reasons.push(`INVALID_COUNTS_${fixture.id}`);
  if (!Object.hasOwn(observation, 'foregroundWork'))
    reasons.push(`MISSING_FOREGROUND_WORK_JOURNAL_${fixture.id}`);
  if (
    observation.sampling?.warmups !== config.sampling.warmups ||
    observation.sampling?.samples !== config.sampling.samples
  )
    reasons.push(`SAMPLING_MISMATCH_${fixture.id}`);
  reasons.push(
    ...deriveBridgeFixtureEvidence(config, fixture, observation).reasons,
  );
  if (
    fixture.id === 'open-100k-lines' &&
    (observation.corpus?.id !== config.fixtureCorpus.id ||
      observation.corpus?.sha256 !== config.fixtureCorpus.sha256 ||
      observation.corpus?.lineCount !== 100_000)
  )
    reasons.push('FIXTURE_CORPUS_EVIDENCE_MISMATCH');
  if (
    fixture.id === 'open-100k-lines' &&
    (observation.warmCold?.warmupsDiscarded !== config.sampling.warmups ||
      observation.warmCold?.coldCorpusRebuilt !== true ||
      observation.warmCold?.source !== 'product-owned-bridge')
  )
    reasons.push('WARM_COLD_EVIDENCE_MISMATCH');
  if (malformedFallback(fixture, observation))
    reasons.push(`FALLBACK_EVIDENCE_MALFORMED_${fixture.id}`);
  if (malformedGrowth(fixture, observation))
    reasons.push(`GROWTH_EVIDENCE_MALFORMED_${fixture.id}`);
  if (
    fixture.duration &&
    (!Number.isFinite(observation.duration?.logicalDurationMs) ||
      !Number.isFinite(observation.duration?.observedDurationMs) ||
      observation.duration.logicalDurationMs !==
        fixture.duration.referenceDurationMs ||
      observation.duration.scaled !== false ||
      observation.duration.observedDurationMs <
        fixture.duration.referenceDurationMs)
  )
    reasons.push(`DURATION_EVIDENCE_MISMATCH_${fixture.id}`);
  return reasons;
}

function normalizedObservation(config, fixture, observation) {
  const reasons = bridgeFixtureReasons(config, fixture, observation);
  const normalized = normalizeBridgeCounts(observation?.counts);
  return reasons.length > 0
    ? {
        fixtureId: fixture.id,
        status: 'NOT_VERIFIED',
        reasonCodes: reasons,
        counts: normalized.counts,
      }
    : {
        ...deriveBridgeFixtureEvidence(config, fixture, observation)
          .observation,
        counts: normalized.counts,
      };
}

export function validateProductionBridgeEvidence(config, evidence) {
  if (
    evidence?.version !== PRODUCTION_BRIDGE_VERSION ||
    evidence?.source !== 'station-ui-production-bridge' ||
    !Array.isArray(evidence?.observations)
  )
    return {
      valid: false,
      reason: 'MALFORMED_PRODUCTION_BRIDGE_EVIDENCE',
      observations: unavailableBridgeObservations(
        config,
        'MALFORMED_PRODUCTION_BRIDGE_EVIDENCE',
        evidence?.observations,
      ),
    };
  const expectedIds = config.fixtures.map((fixture) => fixture.id);
  const receivedIds = evidence.observations.map(
    (observation) => observation?.fixtureId,
  );
  if (
    receivedIds.length !== expectedIds.length ||
    new Set(receivedIds).size !== receivedIds.length ||
    receivedIds.some((id) => !expectedIds.includes(id))
  )
    return {
      valid: false,
      reason: 'BRIDGE_FIXTURE_IDENTITIES_MISMATCH',
      observations: unavailableBridgeObservations(
        config,
        'BRIDGE_FIXTURE_IDENTITIES_MISMATCH',
        evidence.observations,
      ),
    };
  return {
    valid: true,
    observations: config.fixtures.map((fixture) =>
      normalizedObservation(
        config,
        fixture,
        evidence.observations.find((item) => item.fixtureId === fixture.id),
      ),
    ),
  };
}

export function buildReceiptMatches(receipt, attached) {
  return (
    receipt?.sha256 === attached?.sha256 &&
    receipt?.uiCommit === attached?.uiCommit
  );
}
