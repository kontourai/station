import type { ConfigLoader } from '../../domain/config-loader.js';
import type { IIntegrationRegistryProvider } from '../../providers/provider-interfaces.js';
import { recordIntegrationOrigin } from './integration-origin.js';

export async function installRegistryIntegration(
  provider: IIntegrationRegistryProvider,
  loader: ConfigLoader,
  id: string,
  expectedRegistryId: string | undefined,
) {
  const installed = provider.installWithDefinition
    ? await provider.installWithDefinition(id, expectedRegistryId)
    : {
        result: await provider.install(id),
        definition: (await provider.getToolDef(id)) ?? undefined,
      };
  if (!installed.result.success) return installed.result;
  if (
    !('origin' in installed) ||
    installed.origin?.registryId !== expectedRegistryId
  )
    return {
      success: false,
      message: 'The catalog source changed. Reopen the tool list.',
    };
  const definition = installed.definition;
  if (!definition || definition.id !== id)
    return {
      success: false,
      message: 'The catalog did not return a tool source.',
    };
  let existing:
    | Awaited<ReturnType<ConfigLoader['loadIntegration']>>
    | undefined;
  try {
    existing = await loader.loadIntegration(definition.id);
  } catch {
    /* First installation. */
  }
  if (Object.keys(existing?.secretEnvRefs ?? {}).length)
    return {
      success: false,
      message: 'Unbind secrets before replacing this source.',
    };
  const persisted = { ...definition, enabled: false };
  delete persisted.secretEnvRefs;
  await loader.saveIntegration(definition.id, persisted);
  if ('origin' in installed && installed.origin)
    recordIntegrationOrigin(
      loader.getProjectHomeDir(),
      persisted,
      installed.origin,
    );
  return installed.result;
}
