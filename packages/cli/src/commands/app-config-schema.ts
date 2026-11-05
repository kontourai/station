import { appConfigSemanticError } from '@kontourai/station-contracts/config';
import { managedSettingsSchemaError } from '@kontourai/station-contracts/managed-policy';
import {
  type LoadedManagedPolicy,
  loadInstalledManagedPolicy,
  ManagedPolicyInvalidError,
} from '@kontourai/station-shared/managed-policy';
import Ajv, { type ValidateFunction } from 'ajv';
import appSchema from '../../../../schemas/app.schema.json' with {
  type: 'json',
};

/**
 * #4517: the settings file validation server startup runs
 * (`src-server/domain/validator.ts` `validateAppConfig`), for `station
 * policy check`: the same `schemas/app.schema.json`, bundled into the CLI,
 * compiled with the same AJV options, followed by the same
 * `appConfigSemanticError` rules. Throws the first problem found.
 */
let compiled: ValidateFunction | undefined;

export function validateAppConfigOffline(config: unknown): void {
  compiled ??= new Ajv({ allErrors: false, verbose: true }).compile(appSchema);
  if (!compiled(config)) {
    const [first] = compiled.errors ?? [];
    throw new Error(
      `${first?.instancePath || '/'}: ${first?.message ?? 'validation failed'}`,
    );
  }
  const semanticError = appConfigSemanticError(config);
  if (semanticError) throw new Error(semanticError);
}

/**
 * The installed managed policy as server startup accepts it: decoded, and
 * every managed setting checked against the settings file schema. Throws
 * the same `ManagedPolicyInvalidError` startup would, so the CLI's offline
 * readers and writers, and `policy show`, refuse what startup refuses.
 */
export function loadInstalledManagedPolicyChecked(): LoadedManagedPolicy | null {
  const loaded = loadInstalledManagedPolicy();
  const problem = managedSettingsSchemaError(
    loaded?.document.settings,
    validateAppConfigOffline,
  );
  if (loaded && problem)
    throw new ManagedPolicyInvalidError(
      loaded.source.location,
      `a managed setting does not match the settings schema (${problem})`,
    );
  return loaded;
}
