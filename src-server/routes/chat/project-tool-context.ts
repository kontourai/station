import {
  captureRuntimeConfigurationLease,
  requireStableRuntimeConfigurationAcross,
  runtimeConfigurationLeaseIsCurrent,
} from '../../runtime/plugins/runtime-configuration-lease.js';
import { guardRuntimeGenerationTools } from '../../runtime/tools/runtime-generation-tools.js';
import type { IAgent, RuntimeContext } from '../../runtime/types.js';

export async function projectToolContext(
  ctx: RuntimeContext,
  slug: string,
  projectSlug: string | undefined,
  agent: IAgent,
): Promise<IAgent> {
  const loadProjectTools = ctx.loadProjectTools;
  if (!projectSlug || !loadProjectTools) return agent;
  const lease = captureRuntimeConfigurationLease(ctx);
  if (!lease) throw new Error('Agent configuration is changing.');
  const tools = await requireStableRuntimeConfigurationAcross(ctx, lease, () =>
    loadProjectTools(slug, projectSlug),
  );
  if (!tools?.length) return agent;
  if (!agent.withAdditionalTools)
    throw new Error('Project tool views are unavailable.');
  return agent.withAdditionalTools(
    guardRuntimeGenerationTools(
      tools,
      () => runtimeConfigurationLeaseIsCurrent(ctx, lease),
      (operation) =>
        requireStableRuntimeConfigurationAcross(ctx, lease, operation),
    ),
  );
}
