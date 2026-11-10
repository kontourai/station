/**
 * #4774: what `station doctor` says about confinement. The facts come from
 * the running Station (`GET /api/diagnostics/confinement-preflight`), which
 * answers from the same provider check and credential check a start makes,
 * with the server's own environment and home. This module only renders that
 * answer, or says why it was not obtained; it derives none of it.
 */
import type {
  ConfinementPreflight,
  EngineConfinementPreflight,
} from '@kontourai/station-contracts/execution-confinement';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';

/** Which Station answered, by saved name and how it was selected. */
export interface DoctorConfinementTarget {
  station: string | null;
  source: string;
}

/**
 * - `checked: true`: the Station answered with its preflight.
 * - `checked: false`: no answer was obtained; `reason` says why. Nothing
 *   about confinement is known then, and no check reads as healthy.
 */
export type DoctorConfinement =
  | {
      checked: true;
      target: DoctorConfinementTarget;
      preflight: ConfinementPreflight;
    }
  | { checked: false; target?: DoctorConfinementTarget; reason: string };

type DoctorCheckRow = {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
};

/** Text from a Station or an error: paths, URLs and known secrets removed. */
export function doctorConfinementText(text: string): string {
  return sanitizeFreeText(text, 1_024);
}

/**
 * The preflight with every free-text field passed through
 * {@link doctorConfinementText}, so `--json` carries no path either: the
 * server already removes them, and an older or other server is not trusted
 * to.
 */
export function sanitizeConfinementPreflight(
  preflight: ConfinementPreflight,
): ConfinementPreflight {
  return {
    decidedAtStart: [...preflight.decidedAtStart],
    engines: preflight.engines.map((entry) => {
      const credential = entry.confinedAuthentication;
      return {
        ...entry,
        mechanismReason: doctorConfinementText(entry.mechanismReason),
        confinedAuthentication:
          credential.state === 'unavailable'
            ? {
                ...credential,
                remedy: doctorConfinementText(credential.remedy),
              }
            : credential.state === 'unverified' ||
                credential.state === 'not-applicable'
              ? {
                  ...credential,
                  reason: doctorConfinementText(credential.reason),
                }
              : { ...credential },
      };
    }),
  };
}

export function describeConfinementTarget(
  target: DoctorConfinementTarget | undefined,
): string {
  if (!target) return 'the selected Station';
  return target.station
    ? `Station "${target.station}"`
    : `the Station selected by ${target.source}`;
}

function mechanismCheck(entry: EngineConfinementPreflight): DoctorCheckRow {
  const label = `Confinement mechanism (${entry.engine}: ${entry.mechanism})`;
  const reason = doctorConfinementText(entry.mechanismReason);
  const notApplicable =
    entry.confinedAuthentication.state === 'not-applicable'
      ? ` ${doctorConfinementText(entry.confinedAuthentication.reason)}`
      : '';
  switch (entry.mechanismState) {
    case 'available':
      return {
        label,
        status: 'pass',
        detail: `Available on this host: ${reason}.${notApplicable}`,
      };
    case 'unavailable':
      return {
        label,
        status: 'warn',
        detail: `Unavailable on this host: ${reason}. A ${entry.engine} start that requires ${entry.level} confinement is refused.${notApplicable}`,
      };
    case 'engine-reported':
      return {
        label,
        status: 'warn',
        detail: `Decided by the engine at start, not checkable before one: ${reason}.${notApplicable}`,
      };
  }
}

function credentialCheck(
  entry: EngineConfinementPreflight,
): DoctorCheckRow | null {
  const label = `Confined credential (${entry.engine})`;
  const credential = entry.confinedAuthentication;
  switch (credential.state) {
    case 'available':
      return {
        label,
        status: 'pass',
        detail:
          credential.source === 'environment'
            ? 'A credential a confined start can use is in its environment.'
            : "A credential a confined start can use is enrolled in Station's confined configuration.",
      };
    case 'unavailable':
      return {
        label,
        status: 'warn',
        detail: `None a confined start can use (${credential.fallback}): a start that asks for confinement runs at Auto with nothing engaged. ${doctorConfinementText(credential.remedy)}`,
      };
    case 'unverified':
      return {
        label,
        status: 'warn',
        detail: `Not verified: ${doctorConfinementText(credential.reason)}`,
      };
    case 'not-applicable':
      // Folded into the mechanism row: nothing was checked, and a row of
      // its own would read either as healthy or as a problem.
      return null;
  }
}

/**
 * The doctor rows for a confinement answer. Only an answered, available
 * fact is `pass`; everything not checked or not checkable is `warn`.
 */
export function confinementDoctorChecks(
  confinement: DoctorConfinement,
): DoctorCheckRow[] {
  if (!confinement.checked)
    return [
      {
        label: 'Confinement preflight',
        status: 'warn',
        detail: `Not checked: ${doctorConfinementText(confinement.reason)}`,
      },
    ];
  if (confinement.preflight.engines.length === 0)
    return [
      {
        label: 'Confinement preflight',
        status: 'warn',
        detail: `${describeConfinementTarget(confinement.target)} reported no engine it can confine.`,
      },
    ];
  return confinement.preflight.engines.flatMap((entry) => {
    const credential = credentialCheck(entry);
    return credential
      ? [mechanismCheck(entry), credential]
      : [mechanismCheck(entry)];
  });
}
