#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const KONTOUR_TEAM_ID = 'U7KHF2QAC4';
const IDENTITY_PATTERN = new RegExp(
  `^Developer ID Application: Kontour AI LLC \\(${KONTOUR_TEAM_ID}\\)$`,
);

export function rawDesignatedRequirement(output) {
  const requirement = String(output)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*#?\s*designated =>\s+(.+)$/)?.[1])
    .find(Boolean);
  return requirement?.trim();
}

export function isStableNightlySigningIdentity(identity) {
  // Apple Development and Apple Distribution identities are intentionally
  // excluded. This installed `/Applications` bundle owns persistent Keychain
  // credentials; a developer build/profile is not a durable authorization
  // boundary, and #1818's physical probe proved the App Store distribution
  // certificate cannot sign this generic desktop app even after its trust
  // chain and key ACL are repaired. No local-development certificate flow has
  // been designed here, so Developer ID Application is the only safe contract.
  return typeof identity === 'string' && IDENTITY_PATTERN.test(identity);
}

export function signingIdentityRecordsFromSecurityOutput(output) {
  const records = [
    ...String(output).matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"$/gim),
  ]
    .map((match) => ({ fingerprint: match[1].toUpperCase(), name: match[2] }))
    .filter((identity) => isStableNightlySigningIdentity(identity.name));
  const byFingerprint = new Map();
  for (const identity of records) {
    const existing = byFingerprint.get(identity.fingerprint);
    if (existing && existing.name !== identity.name) {
      throw new Error(
        'One macOS certificate fingerprint reported conflicting approved identity names; refusing to select a credential owner.',
      );
    }
    byFingerprint.set(identity.fingerprint, identity);
  }
  return [...byFingerprint.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
}

export function signingIdentitiesFromSecurityOutput(output) {
  return signingIdentityRecordsFromSecurityOutput(output).map(
    (identity) => identity.name,
  );
}

function approvedCandidateRecords(discoveredIdentities) {
  const byFingerprint = new Map();
  for (const candidate of discoveredIdentities) {
    if (
      !candidate ||
      typeof candidate.fingerprint !== 'string' ||
      !/^[0-9A-F]{40}$/i.test(candidate.fingerprint) ||
      !isStableNightlySigningIdentity(candidate.name)
    ) {
      continue;
    }
    const fingerprint = candidate.fingerprint.toUpperCase();
    const existing = byFingerprint.get(fingerprint);
    if (existing && existing.name !== candidate.name) {
      throw new Error(
        'One macOS certificate fingerprint reported conflicting approved identity names; refusing to select a credential owner.',
      );
    }
    byFingerprint.set(fingerprint, { fingerprint, name: candidate.name });
  }
  return [...byFingerprint.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
}

/**
 * A desktop bundle holding persistent Keychain credentials must never default
 * to ad-hoc signing: its designated requirement is CDHash-bound and changes
 * with every rebuild. An explicit configured identity is preferred, but is
 * still constrained to Kontour's Developer ID Application identity. Without one,
 * selecting exactly one discovered eligible identity is deterministic; zero or
 * multiple candidates demand an explicit operator choice rather than guessing.
 */
export function selectNightlyMacosSigningIdentity({
  explicitIdentity,
  discoveredIdentities,
}) {
  const explicit = explicitIdentity?.trim();
  // The production parser already filters `security` output, but this public
  // selector also validates its own input. A future caller/test must not be
  // able to re-admit Apple Distribution or Apple Development by passing a
  // hand-authored record directly to the selection seam.
  const candidates = approvedCandidateRecords(discoveredIdentities);
  if (explicit) {
    const fingerprint = explicit.toUpperCase();
    if (/^[0-9A-F]{40}$/.test(fingerprint)) {
      const matching = candidates.find(
        (candidate) => candidate.fingerprint === fingerprint,
      );
      if (matching) return matching.fingerprint;
      throw new Error(
        'STATION_NIGHTLY_CODESIGN_IDENTITY fingerprint is not an installed approved Kontour Developer ID Application identity.',
      );
    }
    if (!isStableNightlySigningIdentity(explicit)) {
      throw new Error(
        'STATION_NIGHTLY_CODESIGN_IDENTITY must name a Kontour Developer ID Application identity, or its approved SHA-1 fingerprint; Apple Distribution and ad-hoc signing (-) are not allowed.',
      );
    }
    const matching = candidates.filter(
      (candidate) => candidate.name === explicit,
    );
    if (matching.length === 1) return matching[0].fingerprint;
    if (matching.length > 1) {
      throw new Error(
        'STATION_NIGHTLY_CODESIGN_IDENTITY matches multiple approved certificates. Set its exact SHA-1 fingerprint to select one deliberately.',
      );
    }
    throw new Error(
      'STATION_NIGHTLY_CODESIGN_IDENTITY is not an installed approved Kontour Developer ID Application identity.',
    );
  }

  if (candidates.length === 1) return candidates[0].fingerprint;
  if (candidates.length === 0) {
    throw new Error(
      'No approved Kontour Developer ID Application identity is available. Install one, then set STATION_NIGHTLY_CODESIGN_IDENTITY to its name or SHA-1 fingerprint before installing Nightly.',
    );
  }
  throw new Error(
    'Multiple approved Kontour Developer ID Application identities are available. Set STATION_NIGHTLY_CODESIGN_IDENTITY explicitly; Nightly will not guess which Keychain credential owner should sign the app.',
  );
}

export function designatedRequirementFromCodesignOutput(output) {
  const requirement = rawDesignatedRequirement(output);
  if (!requirement || /\bcdhash\b/i.test(requirement)) {
    throw new Error(
      'Nightly requires a stable certificate-backed designated requirement; CDHash-only/ad-hoc signing is refused.',
    );
  }
  return requirement;
}

export function equivalentDesignatedRequirements(first, second) {
  return (
    designatedRequirementFromCodesignOutput(first) ===
    designatedRequirementFromCodesignOutput(second)
  );
}

/**
 * A current ad-hoc Nightly is the known broken state, so its first migration
 * to a stable certificate requirement is deliberately observable and allowed.
 * Once an app is already stable, however, changing the designated requirement
 * would re-prompt its Keychain ACL. Refuse that unreviewed migration rather
 * than silently replacing one prompt storm with another.
 */
export function designatedRequirementTransition(existing, candidate) {
  const next = designatedRequirementFromCodesignOutput(candidate);
  const previous = rawDesignatedRequirement(existing);
  if (!previous) {
    throw new Error(
      'Existing Station Nightly has no readable designated requirement; refusing to replace a credential-owning app.',
    );
  }
  if (/\bcdhash\b/i.test(previous)) {
    return { kind: 'ad-hoc-to-stable', requirement: next };
  }
  if (previous !== next) {
    throw new Error(
      'Existing Station Nightly has a different stable designated requirement. Keep its signing identity or perform an explicit credential migration; replacement is refused.',
    );
  }
  return { kind: 'equivalent', requirement: next };
}

export function currentStableNightlyMacosSigningIdentity({
  explicitIdentity = process.env.STATION_NIGHTLY_CODESIGN_IDENTITY,
  securityOutput = execFileSync(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8' },
  ),
} = {}) {
  return selectNightlyMacosSigningIdentity({
    explicitIdentity,
    discoveredIdentities:
      signingIdentityRecordsFromSecurityOutput(securityOutput),
  });
}

function readStandardInput() {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      value += chunk;
    });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  });
}

export async function runMacosSigningIdentityCli({
  command,
  currentIdentity = currentStableNightlyMacosSigningIdentity,
  readInput = readStandardInput,
}) {
  // Normal installer selection runs while stdin may still be this terminal.
  // Read stdin ONLY for parser subcommands; awaiting it before this branch
  // makes an interactive install hang before it can even list identities.
  if (command === '--candidate-designated-requirement') {
    return designatedRequirementFromCodesignOutput(await readInput());
  }
  if (command === '--raw-designated-requirement') {
    const requirement = rawDesignatedRequirement(await readInput());
    if (!requirement) {
      throw new Error('codesign did not report a designated requirement.');
    }
    return requirement;
  }
  return currentIdentity();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(await runMacosSigningIdentityCli({ command: process.argv[2] }));
}
