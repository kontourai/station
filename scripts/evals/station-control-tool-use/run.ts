/**
 * station-control-tool-use: does a real model reach for the right
 * station-control tool, given this checkout's tool descriptions and schemas?
 * See README.md beside this file. Paid; never run in CI or hooks.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { buildMessages, loadCases, validateCases } from './cases.js';
import {
  type CaseComparison,
  compareRuns,
  gradeSample,
  type ResultRow,
  type ToolCall,
  type ToolUseCase,
} from './grade.js';
import {
  type Assurance,
  asAnthropicTools,
  HARNESS_TOOLS,
  type ListedTool,
  listStationControlTools,
  systemPrompt,
  toolJsonBytes,
} from './tools.js';

const DEFAULT_MODEL = 'claude-haiku-5-5';
const ANTHROPIC_API = 'https://api.anthropic.com';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    model: { type: 'string', default: DEFAULT_MODEL },
    samples: { type: 'string', default: '3' },
    case: { type: 'string', multiple: true },
    baseline: { type: 'string' },
    instructions: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
    context: { type: 'boolean', default: false },
  },
  strict: true,
});

const ASSURANCES: Assurance[] = ['bound', 'delegated-custody'];

async function listings(): Promise<Record<Assurance, ListedTool[]>> {
  const out = {} as Record<Assurance, ListedTool[]>;
  for (const a of ASSURANCES) out[a] = await listStationControlTools(a);
  return out;
}

function printContext(tools: Record<Assurance, ListedTool[]>): void {
  for (const a of ASSURANCES) {
    const sized = tools[a]
      .map((t) => ({ name: t.name, bytes: toolJsonBytes(t) }))
      .sort((x, y) => y.bytes - x.bytes);
    const total = sized.reduce((sum, t) => sum + t.bytes, 0);
    console.log(
      `${a}: ${sized.length} tools, ${total} bytes of name+description+schema`,
    );
    for (const t of sized.slice(0, 15)) console.log(`  ${t.bytes}\t${t.name}`);
  }
}

function readRows(path: string): ResultRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ResultRow);
}

function summary(
  model: string,
  comparisons: CaseComparison[],
  usage: { input: number; output: number },
  errors: ResultRow[],
): string {
  const lines = [
    `# station-control-tool-use: ${model}`,
    '',
    '| Case | Passed | Baseline | Verdict |',
    '| --- | --- | --- | --- |',
    ...comparisons.map(
      (c) =>
        `| ${c.caseId} | ${c.passed}/${c.graded} | ${c.baselineGraded === undefined ? '' : `${c.baselinePassed}/${c.baselineGraded}`} | ${c.regression ? 'REGRESSION' : c.fails ? 'fail' : 'pass'} |`,
    ),
    '',
    `Tokens: ${usage.input} input, ${usage.output} output.`,
  ];
  if (errors.length > 0) {
    lines.push('', `${errors.length} samples errored and are left out:`);
    for (const e of errors)
      lines.push(`- ${e.caseId} #${e.sample}: ${e.error}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<number> {
  const tools = await listings();
  if (values.context) {
    printContext(tools);
    return 0;
  }

  const all = loadCases();
  const problems = validateCases(all, {
    bound: new Set(tools.bound.map((t) => t.name)),
    'delegated-custody': new Set(tools['delegated-custody'].map((t) => t.name)),
  });
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  const wanted = new Set(values.case ?? []);
  const cases = wanted.size ? all.filter((c) => wanted.has(c.id)) : all;
  if (wanted.size && cases.length !== wanted.size) {
    console.error(`Unknown case id in: ${[...wanted].join(', ')}`);
    return 1;
  }

  const request = (c: ToolUseCase) => ({
    model: values.model,
    max_tokens: 4096,
    system: systemPrompt(c.assurance, values.instructions),
    tools: [...HARNESS_TOOLS, ...asAnthropicTools(tools[c.assurance])],
    messages: buildMessages(c),
  });

  if (values['dry-run']) {
    for (const c of cases) {
      const body = request(c);
      console.log(
        JSON.stringify(
          { case: c.id, ...body, tools: body.tools.map((t) => t.name) },
          null,
          2,
        ),
      );
    }
    return 0;
  }

  // Paid calls stay out of CI and hooks, whatever invokes this file.
  if (process.env.CI) {
    console.error(
      'station-control-tool-use calls a paid model and does not run in CI.',
    );
    return 2;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      'Skipped: set ANTHROPIC_API_KEY to run this eval. --dry-run and --context need no key.',
    );
    return 0;
  }
  if (!values.out) {
    console.error('--out <dir> is required.');
    return 1;
  }
  // Only this key, only Anthropic's API: never a session's auth token or proxy.
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: ANTHROPIC_API,
    maxRetries: 6,
  });

  const samples = Math.max(1, Number(values.samples));
  const jobs = cases.flatMap((c) =>
    Array.from({ length: samples }, (_, i) => ({ c, sample: i + 1 })),
  );
  const rows: ResultRow[] = [];
  const usage = { input: 0, output: 0 };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { c, sample } = jobs[next++];
      try {
        const response = await client.messages.create(request(c));
        usage.input += response.usage.input_tokens;
        usage.output += response.usage.output_tokens;
        const calls: ToolCall[] = response.content.flatMap((block) =>
          block.type === 'tool_use'
            ? [
                {
                  name: block.name,
                  input: block.input as Record<string, unknown>,
                },
              ]
            : [],
        );
        const grade = gradeSample(c.expect, calls);
        rows.push({
          caseId: c.id,
          model: values.model,
          sample,
          ...grade,
          calls,
        });
      } catch (error) {
        rows.push({
          caseId: c.id,
          model: values.model,
          sample,
          pass: false,
          failures: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker),
  );

  rows.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.sample - b.sample);
  mkdirSync(values.out, { recursive: true });
  writeFileSync(
    join(values.out, 'results.jsonl'),
    `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  const comparisons = compareRuns(
    rows,
    values.baseline ? readRows(values.baseline) : [],
  );
  const text = summary(
    values.model,
    comparisons,
    usage,
    rows.filter((r) => r.error),
  );
  writeFileSync(join(values.out, 'summary.md'), text);
  console.log(text);
  return comparisons.some((c) => c.regression) ? 1 : 0;
}

process.exitCode = await main();
