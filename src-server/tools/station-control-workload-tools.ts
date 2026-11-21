/**
 * `workload_status`: the calling Session's own workload budget and usage.
 *
 * The session is never an argument. The REST side
 * (`GET /api/system/workload/session`) re-derives it from the verified
 * station-control credential this call forwards, and reads that Session's
 * scope from its cgroup v2 files. Loaded by the stdio child too, so it
 * imports nothing from Station's services.
 */
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const WORKLOAD_STATUS_TOOL_NAME = 'workload_status';
const WORKLOAD_STATUS_API_PATH = '/api/system/workload/session';

const WORKLOAD_STATUS_DESCRIPTION =
  "Report this session's Station workload budget: whether Linux memory enforcement is active (or why not), the memory limit shared by this engine and every command it runs, and the scope's memory, peak, swap, out-of-memory kills, tasks and, near the limit, `pressure` with its largest processes. Check it before memory-heavy work like builds, full test suites, repository-wide linters or browsers, and run those one at a time near the limit.";

export function registerWorkloadTools(registry: StationControlToolRegistry) {
  registry.tool(
    WORKLOAD_STATUS_TOOL_NAME,
    WORKLOAD_STATUS_DESCRIPTION,
    {},
    async () => {
      let response: unknown;
      try {
        response = await api(WORKLOAD_STATUS_API_PATH);
      } catch {
        return jsonToolResult({
          success: false,
          error: 'Station did not answer the workload status read.',
        });
      }
      // The route's own envelope, refusals included, is passed through.
      return jsonToolResult(
        response ?? { success: false, error: 'Empty workload status.' },
      );
    },
  );
}
