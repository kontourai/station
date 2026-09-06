import { expect, test } from 'vitest';
import type {
  HomeControlSessionCapability,
  HomeControlSessionInspectionObservation,
  HomeControlSessionOpenObservation,
  HomeControlSessionRetirementObservation,
} from '../cloud-move.js';

test('home control session observations keep authority limits explicit', () => {
  const capability: HomeControlSessionCapability = {
    homeRef: 'paired:device-a',
    openId: 'open-a',
    generation: 1,
    token: 'a'.repeat(64),
  };
  const opened: HomeControlSessionOpenObservation = {
    schemaVersion: 'station.home-control-session-open/v1',
    capability,
    replayed: false,
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  };
  const inspected: HomeControlSessionInspectionObservation = {
    schemaVersion: 'station.home-control-session-inspection/v1',
    homeRef: capability.homeRef,
    openId: capability.openId,
    generation: capability.generation,
    state: 'active',
    unresolvedAdmissionCount: 0,
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  };
  const retired: HomeControlSessionRetirementObservation = {
    schemaVersion: 'station.home-control-session-retirement/v1',
    homeRef: capability.homeRef,
    generation: capability.generation,
    state: 'retired',
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  };

  expect(Object.keys(opened).sort()).toEqual(
    [
      'schemaVersion',
      'capability',
      'replayed',
      'executionAuthorityTransferred',
      'executionResumeAvailable',
    ].sort(),
  );
  expect(inspected).not.toHaveProperty('token');
  expect(inspected).not.toHaveProperty('capabilityDigest');
  expect(retired).not.toHaveProperty('openId');
});
