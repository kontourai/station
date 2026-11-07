import { describeStationFailure } from '../../utils/stationFailure';
/**
 * #4470: starts a troubleshooting conversation on the Station Assistant.
 *
 * `start` checks the assistant can run, prepares a run on the Station the
 * person is looking at (the active API base), and hands the prepared seed to
 * the intro dialog. `launch` opens a new conversation with the assistant in no
 * project. The person's own description is the visible first message; the
 * prepared context rides out of band as ambient context, so the transcript
 * shows only what they typed.
 *
 * When the assistant has no usable engine, or the host cannot prepare a run,
 * the entry point opens Report a problem and shows the `station triage`
 * command. It never navigates to engine settings on its own.
 */

import { STATION_AGENT_ID } from '@kontourai/station-contracts/agent-identity';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  TROUBLESHOOT_CLI_COMMAND,
  type TroubleshootPrepareResponse,
  type TroubleshootSeed,
} from '@kontourai/station-contracts/troubleshoot';
import {
  useEngineConnectionsQuery,
  usePrepareTroubleshootMutation,
} from '@kontourai/station-sdk';
import { readTroubleshootCapability } from '@kontourai/station-sdk/client';
import { useCallback, useRef, useState } from 'react';
import { useAgent } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useToast } from '../../contexts/ToastContext';
import { useLaunchChat } from '../../hooks/useActiveChatSessions';
import { copyToClipboard } from '../../lib/clipboard';
import { requestReportProblem } from '../../lib/reportProblemEvents';
import {
  canAgentStartChat,
  resolveAgentExecution,
} from '../../utils/execution';
import { agentRunnability } from '../agent-runnability';

/** How long prepare may take before a pending toast appears. */
export const TROUBLESHOOT_PENDING_TOAST_DELAY_MS = 700;

const COPY_CLI_ACTION = {
  label: `Copy ${TROUBLESHOOT_CLI_COMMAND}`,
  onClick: () => void copyToClipboard(TROUBLESHOOT_CLI_COMMAND),
};

export function useStartTroubleshoot() {
  const { apiBase } = useApiBase();
  const launchChat = useLaunchChat(apiBase);
  const station = useAgent(STATION_AGENT_ID);
  const { data: connections = [] } = useEngineConnectionsQuery() as {
    data?: ConnectionConfig[];
  };
  const prepare = usePrepareTroubleshootMutation();
  const { upsertToast, dismissToast } = useToast();
  const [prepared, setPrepared] = useState<TroubleshootPrepareResponse | null>(
    null,
  );
  const starting = useRef(false);

  const fallBack = useCallback(
    (message: string) => {
      requestReportProblem();
      upsertToast({
        dedupeKey: 'troubleshoot-fallback',
        message,
        detail: `If the app itself is broken, run ${TROUBLESHOOT_CLI_COMMAND} in a terminal.`,
        tone: 'warning',
        duration: 0,
        actions: [COPY_CLI_ACTION],
      });
    },
    [upsertToast],
  );

  const start = useCallback(
    async (seed?: TroubleshootSeed) => {
      if (starting.current) return;
      if (
        !station ||
        !agentRunnability(station).runnable ||
        !canAgentStartChat(station, connections)
      ) {
        fallBack('The Station Assistant has no engine to troubleshoot with.');
        return;
      }
      starting.current = true;
      // Read at click time, not on app load: `null` (handshake unreadable)
      // still tries, and a failure there lands in the failure toast below.
      if ((await readTroubleshootCapability(apiBase)) === false) {
        starting.current = false;
        fallBack(
          'This Station can’t troubleshoot in the app. Updating it may help.',
        );
        return;
      }
      let pendingToast: string | undefined;
      const pendingTimer = setTimeout(() => {
        pendingToast = upsertToast({
          dedupeKey: 'troubleshoot-pending',
          message: 'Preparing troubleshooting…',
          duration: 0,
        });
      }, TROUBLESHOOT_PENDING_TOAST_DELAY_MS);
      try {
        setPrepared(await prepare.mutateAsync(seed ? { seed } : {}));
      } catch (error) {
        upsertToast({
          dedupeKey: 'troubleshoot-failed',
          message: 'Troubleshooting couldn’t start.',
          detail: error ? describeStationFailure(error).body : undefined,
          tone: 'error',
          duration: 0,
          actions: [
            { label: 'Report a problem', onClick: requestReportProblem },
            COPY_CLI_ACTION,
          ],
        });
      } finally {
        clearTimeout(pendingTimer);
        if (pendingToast) dismissToast(pendingToast);
        starting.current = false;
      }
    },
    [
      station,
      connections,
      apiBase,
      prepare,
      upsertToast,
      dismissToast,
      fallBack,
    ],
  );

  const launch = useCallback(
    async (description: string) => {
      if (!prepared || !station) return;
      const run = prepared;
      setPrepared(null);
      await launchChat(
        STATION_AGENT_ID,
        station.name,
        description.trim() || run.openingMessage,
        undefined,
        undefined,
        resolveAgentExecution(station),
        run.ambientContext,
      );
    },
    [prepared, station, launchChat],
  );

  const cancel = useCallback(() => setPrepared(null), []);

  return { start, prepared, launch, cancel };
}
