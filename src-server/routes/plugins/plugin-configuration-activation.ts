import type {
  AgentConfigurationActivation,
  AgentConfigurationMutationOptions,
  AgentConfigurationMutationRunner,
} from '../../runtime/types.js';
import {
  closePluginActivationSession,
  completePluginActivationComposition,
  createPluginActivationSession,
  type PluginActivationSession,
  preparePluginActivationComposition,
} from '../../services/plugins/plugin-activation-composition.js';
import { captureConfigurationMutation } from '../system/configuration-activation.js';

/** The plugin route passes its private session explicitly to the installer and
 * the existing runtime owner. It never enters request JSON or ambient context. */
export async function capturePluginConfigurationMutation<T>(
  runner: AgentConfigurationMutationRunner | undefined,
  operation: (
    beginMutation: () => void,
    activation: AgentConfigurationActivation | undefined,
    session: PluginActivationSession,
  ) => Promise<T>,
  options?: Omit<AgentConfigurationMutationOptions<T>, 'pluginActivation'>,
) {
  const session = createPluginActivationSession();
  try {
    const result = await captureConfigurationMutation(
      runner,
      (begin, activation) => operation(begin, activation, session),
      { ...options, pluginActivation: session },
    );
    // Domain-only callers have no live runtime to rebuild. Their same local
    // resource verifier still owns readiness; production supplies its runner.
    if (!runner) {
      const composition = await preparePluginActivationComposition(session);
      await completePluginActivationComposition(composition);
    }
    return result;
  } finally {
    closePluginActivationSession(session);
  }
}
