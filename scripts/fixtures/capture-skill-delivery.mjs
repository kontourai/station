// Manual, non-billable CLI fixture capture. Outputs are raw local artifacts; scrub before committing.

import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';

// Deliberately no real credentials: the only inference endpoint is this local fixture.
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL'].includes(key))
    delete process.env[key];
}
const mode = process.argv[2];
const executable = process.argv[3];
if (!['skill', 'read'].includes(mode) || !executable || !isAbsolute(executable))
  throw new Error(
    'Usage: node scripts/fixtures/capture-skill-delivery.mjs <skill|read> /absolute/path/to/claude',
  );
await mkdir(resolve('.kontourai/skill-captures'), { recursive: true });
const root = await mkdtemp(resolve('.kontourai/skill-captures/local-cli-'));
const cwd = join(root, 'workspace');
const config = join(root, 'config');
const skill = 'delivery-fixture';
await mkdir(join(cwd, '.claude/skills', skill), { recursive: true });
await mkdir(config);
await mkdir(join(cwd, '.claude/skills', skill, 'scripts'));
await writeFile(
  join(cwd, '.claude/skills', skill, 'scripts/probe.mjs'),
  'console.log("fixture-only-nonce");\n',
);
await writeFile(
  join(cwd, '.claude/skills', skill, 'SKILL.md'),
  `---\nname: ${skill}\ndescription: A local fixture capture skill.\n---\nReturn CAPTURE_COMPLETE.\n`,
);
let requests = 0;
const schema = [];
function events(block, stop) {
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_fixture_${requests}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block:
          block.type === 'tool_use'
            ? { ...block, input: {} }
            : { type: 'text', text: '' },
      },
    ],
    ...(block.type === 'tool_use'
      ? [
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(block.input),
              },
            },
          ],
        ]
      : [
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: block.text },
            },
          ],
        ]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(
      ([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`,
    )
    .join('');
}
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    body = {};
  }
  if (req.url?.includes('/messages/count_tokens')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ input_tokens: 1 }));
    return;
  }
  if (!req.url?.includes('/messages')) {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  requests++;
  const tool = body.tools?.find(
    (entry) => entry.name === (mode === 'skill' ? 'Skill' : 'Read'),
  );
  const field = mode === 'skill' ? 'skill' : 'file_path';
  if (
    !tool?.input_schema?.properties?.[field] ||
    !tool.input_schema.required?.includes(field)
  ) {
    res.writeHead(400);
    res.end('{"error":"Required tool schema absent"}');
    return;
  }
  if (tool) schema.push(tool);
  console.log(
    'Local request',
    requests,
    'Selected tool schema present:',
    !!tool,
  );
  if (requests > 2) {
    res.writeHead(400);
    res.end('{}');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'request-id': `fixture-${requests}`,
  });
  res.end(
    requests === 1
      ? events(
          mode === 'read'
            ? {
                type: 'tool_use',
                id: 'toolu_read_fixture',
                name: 'Read',
                input: {
                  file_path: join(
                    cwd,
                    '.claude/skills',
                    skill,
                    'scripts/probe.mjs',
                  ),
                },
              }
            : {
                type: 'tool_use',
                id: 'toolu_skill_fixture',
                name: 'Skill',
                input: { skill },
              },
          'tool_use',
        )
      : events({ type: 'text', text: 'CAPTURE_COMPLETE' }, 'end_turn'),
  );
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: origin,
  ANTHROPIC_API_KEY: 'fixture-only-not-a-real-key',
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  NO_PROXY: '127.0.0.1,localhost',
  HTTP_PROXY: origin,
  HTTPS_PROXY: origin,
});
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const messages = [];
let q;
const timeout = setTimeout(() => q?.close(), 45000);
try {
  q = query({
    prompt: 'Use delivery-fixture.',
    options: {
      cwd,
      pathToClaudeCodeExecutable: await realpath(executable),
      model: 'claude-sonnet-4-5',
      settingSources: ['project'],
      tools: ['Skill', 'Read'],
      allowedTools: ['Skill', 'Read'],
      permissionMode: 'default',
      persistSession: false,
      maxTurns: 2,
      env: process.env,
      stderr: (data) => {
        if (data.trim()) console.log('CLI stderr:', data.slice(0, 300));
      },
    },
  });
  for await (const message of q) {
    messages.push(message);
    console.log(
      'SDK',
      message.type,
      message.subtype ?? '',
      message.type === 'assistant'
        ? JSON.stringify(message.message.content)
        : '',
    );
  }
  const result = messages.findLast((message) => message.type === 'result');
  if (!result || result.is_error || requests !== 2)
    throw new Error(
      'Capture did not complete successfully within two local requests',
    );
} finally {
  clearTimeout(timeout);
  q?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(
    join(root, 'messages.jsonl'),
    `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`,
  );
  await writeFile(
    join(root, 'skill-schema.json'),
    JSON.stringify(schema, null, 2),
  );
  console.log(
    'Capture directory:',
    root,
    'local inference requests:',
    requests,
  );
}
