/**
 * Station's intentionally tiny public Datum seam for secret references.
 * Keep this out of the contracts root: browser/root consumers must not gain a
 * secret runner merely by importing Station contracts.
 */

export type { AuthRef, SecretRunner } from '@kontourai/datum';
export {
  DatumError,
  defaultSecretRunner,
  describeAuth,
  materializeAuthRef,
  parseAuthRef,
} from '@kontourai/datum';
