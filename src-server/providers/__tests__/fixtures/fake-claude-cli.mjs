// A stand-in for the Claude Code CLI, for claude-code-spawn.sdk.test.ts. It
// speaks just enough of the stream-json control protocol for the real Agent
// SDK to call `canUseTool` twice: once for an ask replayed on the
// `initialize` response, once for a live ask. It then writes to stderr and
// exits 3, so the test can read the exit error.
import { createInterface } from 'node:readline';

const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ask = (requestId, reason) => ({
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: 'git push' },
    ...reason,
    tool_use_id: `toolu_${requestId}`,
  },
});

let answers = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (
    message.type === 'control_request' &&
    message.request?.subtype === 'initialize'
  ) {
    write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          models: [],
          output_style: 'normal',
          available_output_styles: ['normal'],
          account: {},
          pid: process.pid,
        },
        pending_permission_requests: [
          ask('req-replay', { decision_reason_type: 'rule' }),
        ],
        pending_user_dialog_requests: [],
      },
    });
    return;
  }
  if (message.type === 'user') {
    // A multi-byte line first: the SDK must read the stream unchanged.
    write({ type: 'system', subtype: 'status', note: 'héllo — 日本語 🙂' });
    write(
      ask('req-live', {
        decision_reason:
          'This command uses the `&` background operator, which defers execution past approval-time safety checks. Approve only if you trust it.',
        decision_reason_type: 'safetyCheck',
        classifier_approvable: false,
      }),
    );
    return;
  }
  if (message.type === 'control_response') {
    answers += 1;
    if (answers === 2) {
      process.stderr.write('fake engine: failing on purpose\n');
      process.exit(3);
    }
  }
});
