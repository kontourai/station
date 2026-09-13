import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
} from './owned-process.mjs';

/** Adapt a local Muse image run to the existing review response validator. */
export function museReviewResponse(stdout) {
  const records = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const terminal = records
    .filter((r) => r.payload_type?.startsWith('run.terminal.'))
    .at(-1);
  if (
    terminal?.payload_type !== 'run.terminal.completed' ||
    typeof terminal.payload?.text !== 'string'
  ) {
    throw new Error('Muse image review did not complete.');
  }
  const configuration = records.find(
    (r) => r.payload_type === 'run.model.configured',
  );
  return {
    status: 'completed',
    id: terminal.id,
    model: configuration?.payload?.model_id ?? 'muse-cli',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: terminal.payload.text }],
      },
    ],
  };
}

export async function localMuseReviewFetch(_url, request) {
  const body = JSON.parse(request.body);
  const content = body.input[0].content;
  const directory = mkdtempSync(join(tmpdir(), 'station-image-review-'));
  try {
    const args = [
      'exec',
      '--json',
      '--disable-shell',
      '--disable-write',
      '--disable-web-tools',
      '--no-foreign-personal-context',
      '--no-session-log',
      '--max-model-steps',
      '1',
    ];
    const prompt = [];
    let index = 0;
    for (const part of content) {
      if (part.type === 'input_text') prompt.push(part.text);
      else if (part.type === 'input_image') {
        const prefix = 'data:image/png;base64,';
        if (!part.image_url.startsWith(prefix))
          throw new Error('Local image review requires PNG captures.');
        const path = join(directory, `image-${++index}.png`);
        writeFileSync(
          path,
          Buffer.from(part.image_url.slice(prefix.length), 'base64'),
          { mode: 0o600 },
        );
        args.push('--image', path);
      }
    }
    const promptPath = join(directory, 'prompt.txt');
    writeFileSync(
      promptPath,
      prompt.join('\n') +
        '\nImages are attached in the listed ID order. Do not use tools.',
      { mode: 0o600 },
    );
    args.push('--prompt-file', promptPath);
    const execution = executeOwnedProcess(
      'muse',
      args,
      undefined,
      'local Muse image review',
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const stop = () => {
      void execution.forceTerminate();
    };
    request.signal?.addEventListener('abort', stop, { once: true });
    if (request.signal?.aborted) stop();
    const output = captureOwnedProcessOutput(execution, {
      maxBytes: 2 * 1024 * 1024,
      onOverflow: stop,
    });
    try {
      const result = await execution.promise;
      const captured = output.finish();
      if (
        request.signal?.aborted ||
        result.status !== 0 ||
        captured.truncated ||
        captured.invalidUtf8
      )
        throw new Error(
          'Local Muse image review failed or exceeded its output/time limit.',
        );
      return new Response(
        JSON.stringify(museReviewResponse(captured.stdout.text)),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      request.signal?.removeEventListener('abort', stop);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
