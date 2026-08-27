import { RuntimeConfigurationConflictError } from '../plugins/runtime-configuration-lease.js';
import type { ITool } from '../types.js';

const RUNTIME_GENERATION_GUARDED = Symbol('runtime-generation-guarded');
const RUNTIME_GENERATION_EXECUTE_WITHIN_LEASE = Symbol(
  'runtime-generation-execute-within-lease',
);

type RuntimeExecutableTool = {
  name: string;
  execute?: (input: any, options?: any) => unknown;
};

export async function executeRuntimeGenerationToolWithinLease<R>(
  tool: RuntimeExecutableTool,
  input: unknown,
  options?: unknown,
): Promise<R> {
  const executeWithinLease = (
    tool as RuntimeExecutableTool & {
      [RUNTIME_GENERATION_EXECUTE_WITHIN_LEASE]?: (
        input: unknown,
        options?: unknown,
      ) => Promise<R>;
    }
  )[RUNTIME_GENERATION_EXECUTE_WITHIN_LEASE];
  if (executeWithinLease) return executeWithinLease(input, options);
  if (!tool.execute) throw new Error(`Tool ${tool.name} cannot be executed`);
  return tool.execute(input, options) as R | Promise<R>;
}

export function guardRuntimeGenerationTools<T extends ITool>(
  tools: T[],
  isCurrent: () => boolean,
  runWhenCurrent?: <R>(operation: () => Promise<R>) => Promise<R>,
): T[] {
  return tools.map((tool) => {
    if (
      (tool as T & { [RUNTIME_GENERATION_GUARDED]?: boolean })[
        RUNTIME_GENERATION_GUARDED
      ]
    ) {
      return tool;
    }
    const execute =
      typeof tool.execute === 'function' ? tool.execute.bind(tool) : undefined;
    return new Proxy(tool, {
      get(target, property, receiver) {
        if (property === RUNTIME_GENERATION_GUARDED) return true;
        if (property === RUNTIME_GENERATION_EXECUTE_WITHIN_LEASE && execute) {
          return async (input: unknown, options?: unknown) => {
            if (!isCurrent()) throw new RuntimeConfigurationConflictError();
            return execute(input, options);
          };
        }
        if (property !== 'execute' || !execute) {
          return Reflect.get(target, property, receiver);
        }
        return async (input: unknown, options?: unknown) => {
          if (!isCurrent()) throw new RuntimeConfigurationConflictError();
          const operation = () => execute(input, options);
          return runWhenCurrent ? runWhenCurrent(operation) : operation();
        };
      },
    });
  });
}
