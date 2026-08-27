import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type {
  AgentConfigurationActivation,
  AgentConfigurationMutationOperation,
  AgentConfigurationMutationOptions,
  AgentConfigurationMutationRunner,
} from '../../runtime/types.js';

export interface ConfigurationMutationResult<T> {
  value: T;
  activation?: AgentConfigurationActivation;
}

export async function captureConfigurationMutation<T>(
  runner: AgentConfigurationMutationRunner | undefined,
  operation: AgentConfigurationMutationOperation<T>,
  options?: AgentConfigurationMutationOptions<T>,
): Promise<ConfigurationMutationResult<T>> {
  let activation: AgentConfigurationActivation | undefined;
  const value = runner
    ? await runner((beginMutation, receipt) => {
        activation = receipt;
        return operation(beginMutation, receipt);
      }, options)
    : await operation(() => undefined);
  return { value, activation };
}

export function configurationActivationPayload(
  activation: AgentConfigurationActivation | undefined,
): { configurationActivation?: AgentConfigurationActivation } {
  return activation?.status === 'pending'
    ? { configurationActivation: activation }
    : {};
}

export function configurationMutationStatus(
  activation: AgentConfigurationActivation | undefined,
  appliedStatus: ContentfulStatusCode,
): ContentfulStatusCode {
  return activation?.status === 'pending' ? 202 : appliedStatus;
}

export async function configurationMutationResponse(
  result: ConfigurationMutationResult<Response>,
): Promise<Response> {
  if (result.activation?.status !== 'pending') return result.value;
  const body = (await result.value.clone().json()) as Record<string, unknown>;
  return Response.json(
    { ...body, ...configurationActivationPayload(result.activation) },
    { status: 202, headers: result.value.headers },
  );
}
