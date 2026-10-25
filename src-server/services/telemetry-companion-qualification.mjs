import { createHash } from 'node:crypto';

const COMPANION_INSTALL_PROFILE =
  'station-companion-product-diagnostics/v1';
const CHECKS = [
  'real-station-metric-query',
  'real-station-trace-query',
  'diagnostic-privacy',
  'delta-counter-rate-histogram',
  'station-collector-restart',
  'product-commit-deduplication',
  'real-station-product-query',
  'product-disclosure-and-destination-separation',
  'receiver-store-restart',
  'fresh-backup-restore-fence',
  'publisher-privacy-reconciliation',
  'version-upgrade-rollback',
  'credential-network-isolation',
];
const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;

function keys(value, names) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...names].sort())
  );
}

/** Excludes the qualification itself so sealing the evidence is not self-referential. */
function companionContentDigest(manifest) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: manifest.source,
        target: manifest.target,
        images: manifest.images,
        files: manifest.files,
      }),
    )
    .digest('hex');
}

/** Consistency only. The existing signed parent archive must authenticate these bytes. */
export function assertCompanionQualification(receipt, manifest) {
  if (
    !keys(receipt, [
      'protocol',
      'profile',
      'source',
      'contentSha256',
      'qualifications',
      'installationAuthority',
    ]) ||
    receipt.protocol !== 'station-companion-qualification/v1' ||
    receipt.profile !== COMPANION_INSTALL_PROFILE ||
    typeof receipt.source !== 'string' ||
    !SHA.test(receipt.source) ||
    receipt.source !== manifest.source ||
    typeof receipt.contentSha256 !== 'string' ||
    !SHA256.test(receipt.contentSha256) ||
    receipt.contentSha256 !== companionContentDigest(manifest) ||
    receipt.installationAuthority !== false ||
    !Array.isArray(receipt.qualifications) ||
    receipt.qualifications.length < 1 ||
    receipt.qualifications.length > 2
  )
    throw new Error(
      'Companion install qualification does not match its payload',
    );
  const architectures = new Set();
  for (const qualification of receipt.qualifications) {
    if (
      !keys(qualification, [
        'containerOs',
        'architecture',
        'evidenceSha256',
        'checks',
      ]) ||
      qualification.containerOs !== 'linux' ||
      !['amd64', 'arm64'].includes(qualification.architecture) ||
      architectures.has(qualification.architecture) ||
      typeof qualification.evidenceSha256 !== 'string' ||
      !SHA256.test(qualification.evidenceSha256) ||
      !Array.isArray(qualification.checks) ||
      JSON.stringify(qualification.checks.map((check) => check?.id).sort()) !==
        JSON.stringify([...CHECKS].sort()) ||
      !qualification.checks.every(
        (check) => keys(check, ['id', 'state']) && check.state === 'passed',
      )
    )
      throw new Error('Companion install profile is incomplete or unsupported');
    architectures.add(qualification.architecture);
  }
  return receipt;
}
