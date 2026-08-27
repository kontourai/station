import type { PreToolPolicyToolIdentity } from '../../runtime/agents/pre-tool-policy.js';
import { canonicalizeExternalToolName } from '../../runtime/tools/tool-executor.js';

/** Derive only the matching names understood by the shared policy stages. */
export function externalPreToolPolicyIdentity(
  rawToolName: string,
): PreToolPolicyToolIdentity {
  const delegationToolName = canonicalizeExternalToolName(rawToolName);
  if (!rawToolName.startsWith('mcp__')) {
    return {
      delegationToolName,
      configProtectionToolName: rawToolName,
    };
  }
  const separator = rawToolName.indexOf('__', 'mcp__'.length);
  return {
    delegationToolName,
    configProtectionToolName:
      separator === -1 || separator + 2 >= rawToolName.length
        ? rawToolName
        : rawToolName.slice(separator + 2),
  };
}
