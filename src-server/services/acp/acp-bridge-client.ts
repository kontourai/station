import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import {
  type Client,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { ApprovalRegistry } from '../approvals/approval-registry.js';
import type {
  ExtendedCreateTerminalRequest,
  ExtendedRequestPermissionRequest,
  ManagedTerminal,
} from './acp-bridge-types.js';

type ACPStreamWriter = (chunk: any) => Promise<void>;

interface ACPBridgeClientContext {
  cwd: string;
  terminals: Map<string, ManagedTerminal>;
  approvalRegistry: ApprovalRegistry;
  getActiveWriter: () => ACPStreamWriter | null;
  nextTerminalId: () => string;
  onSessionUpdate: (params: SessionNotification) => Promise<void>;
  onExtNotification: (method: string, params: Record<string, unknown>) => void;
  /**
   * Answers an inbound agent→client extension REQUEST, or throws to refuse
   * it. A thrown `RequestError` reaches the wire verbatim (the SDK's
   * dispatcher emits its code); anything else becomes `-32603`. Returning a
   * value here is a claim that Station computed an answer — see
   * `acp-inbound-extension-policy.ts`, which is what the adapter supplies.
   *
   * Promise-returning is allowed so a future reviewed handler is not forced
   * to be synchronous (and therefore not forced to route around the policy);
   * the SDK already awaits this result.
   */
  onExtMethod: (
    method: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export function createACPBridgeClient(context: ACPBridgeClientContext): Client {
  return {
    sessionUpdate: async (params: SessionNotification) => {
      await context.onSessionUpdate(params);
    },

    requestPermission: async (
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      return handleACPBridgePermissionRequest(
        params as ExtendedRequestPermissionRequest,
        {
          approvalRegistry: context.approvalRegistry,
          getActiveWriter: context.getActiveWriter,
        },
      );
    },

    readTextFile: async (
      params: ReadTextFileRequest,
    ): Promise<ReadTextFileResponse> => {
      const content = await readFile(params.path, 'utf-8');
      return { content };
    },

    writeTextFile: async (params: WriteTextFileRequest) => {
      await writeFile(params.path, params.content);
      return {};
    },

    createTerminal: async (
      params: CreateTerminalRequest,
    ): Promise<CreateTerminalResponse> => {
      return handleACPBridgeCreateTerminal(
        params as ExtendedCreateTerminalRequest,
        {
          cwd: context.cwd,
          terminals: context.terminals,
          nextTerminalId: context.nextTerminalId,
        },
      );
    },

    terminalOutput: async (
      params: TerminalOutputRequest,
    ): Promise<TerminalOutputResponse> => {
      const term = context.terminals.get(params.terminalId);
      if (!term) {
        // Same class as the inbound-extension fabrication this change
        // exists for: `{ output: '', truncated: false }` is a SUCCESS, and
        // the agent reads it as "the command ran and printed nothing" for a
        // terminal Station does not have. It then reports success, skips a
        // retry, or summarises output it never saw. The sibling
        // `waitForTerminalExit` two handlers down already answers a
        // distinguishable `-1` for this exact condition — the empty-output
        // success was the outlier, not the house style. An unknown terminal
        // id is a caller error, and `-32602` says so.
        throw RequestError.invalidParams(
          { terminalId: params.terminalId },
          `unknown terminal '${params.terminalId}'`,
        );
      }
      return {
        output: term.output,
        truncated: false,
        // `exited` — not `exitCode !== null` — decides whether an exit status
        // exists. A child killed by a signal has a null exitCode and HAS
        // exited; the old test reported it as still running.
        exitStatus: term.exited
          ? { exitCode: term.exitCode, signal: term.signal }
          : null,
      };
    },

    releaseTerminal: async (params: ReleaseTerminalRequest) => {
      const term = context.terminals.get(params.terminalId);
      if (term) {
        term.process.kill();
        context.terminals.delete(params.terminalId);
      }
    },

    waitForTerminalExit: async (
      params: WaitForTerminalExitRequest,
    ): Promise<WaitForTerminalExitResponse> => {
      const term = context.terminals.get(params.terminalId);
      if (!term) {
        // Was `{ exitCode: -1 }` — a fabricated exit status for a terminal
        // Station does not have. `-1` is not a real POSIX exit code, but it
        // is a plausible-looking one, and the agent cannot tell it apart
        // from a command that genuinely failed. Same class as
        // `terminalOutput`'s empty-output success above.
        throw RequestError.invalidParams(
          { terminalId: params.terminalId },
          `unknown terminal '${params.terminalId}'`,
        );
      }
      if (term.exited) {
        return { exitCode: term.exitCode, signal: term.signal };
      }
      return new Promise((resolve) => {
        // `code ?? -1` reported a SIGNAL death as exit code -1 — for a real
        // terminal, on the live chat path, and Station is the one sending
        // the signal (`releaseTerminal` and `killTerminal` both call
        // `kill()`). So every terminal Station tore down was reported to the
        // agent as a process that ran and failed. ACP models the two
        // outcomes separately; report which one happened.
        term.process.on('exit', (code, signal) =>
          resolve({ exitCode: code, signal: signal ?? null }),
        );
      });
    },

    killTerminal: async (params: KillTerminalRequest) => {
      const term = context.terminals.get(params.terminalId);
      if (term) term.process.kill();
    },

    extNotification: async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      context.onExtNotification(method, params);
    },

    extMethod: async (method: string, params: Record<string, unknown>) => {
      return context.onExtMethod(method, params);
    },
  };
}

interface ACPBridgePermissionContext {
  approvalRegistry: ApprovalRegistry;
  getActiveWriter: () => ACPStreamWriter | null;
}

export async function handleACPBridgePermissionRequest(
  params: ExtendedRequestPermissionRequest,
  context: ACPBridgePermissionContext,
): Promise<RequestPermissionResponse> {
  const approvalId = ApprovalRegistry.generateId('acp');
  const toolTitle = params.toolCall?.title || 'Unknown tool';
  const activeWriter = context.getActiveWriter();

  if (activeWriter) {
    await activeWriter({
      type: 'tool-approval-request',
      approvalId,
      toolName: toolTitle,
      server: '',
      tool: toolTitle,
      toolArgs: params.toolCall?.rawInput,
    });
  }

  const approved = await context.approvalRegistry.register(approvalId, {
    metadata: {
      source: 'acp',
      title: toolTitle,
      tool: toolTitle,
      toolName: toolTitle,
    },
  });
  const preferredKinds = approved
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  const selectedOption = preferredKinds
    .map((kind) => params.options.find((option) => option.kind === kind))
    .find((option) => option !== undefined);

  if (!selectedOption) {
    return { outcome: { outcome: 'cancelled' } };
  }

  return {
    outcome: { outcome: 'selected', optionId: selectedOption.optionId },
  };
}

interface ACPBridgeTerminalContext {
  cwd: string;
  terminals: Map<string, ManagedTerminal>;
  nextTerminalId: () => string;
}

export async function handleACPBridgeCreateTerminal(
  params: ExtendedCreateTerminalRequest,
  context: ACPBridgeTerminalContext,
): Promise<CreateTerminalResponse> {
  const id = context.nextTerminalId();
  const proc = spawn(params.command, params.args || [], {
    cwd: params.cwd || context.cwd,
    env: childProcessEnvironment(
      params.env
        ? Object.fromEntries(
            params.env.map((entry) => [entry.name, entry.value]),
          )
        : undefined,
    ),
    windowsHide: true,
  });

  const term: ManagedTerminal = {
    process: proc,
    output: '',
    exitCode: null,
    signal: null,
    exited: false,
  };
  proc.stdout?.on('data', (data: Buffer) => {
    term.output += data.toString();
  });
  proc.stderr?.on('data', (data: Buffer) => {
    term.output += data.toString();
  });
  proc.on('exit', (code, signal) => {
    term.exitCode = code;
    term.signal = signal ?? null;
    term.exited = true;
  });

  context.terminals.set(id, term);
  return { terminalId: id };
}
