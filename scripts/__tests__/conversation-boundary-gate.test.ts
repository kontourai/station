import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  conversationBoundaryCommands,
  discoverConversationFiles,
  evaluateConversationBaseline,
  scanConversationSources,
} from '../conversation-boundary-gate.mjs';

const surface = 'src-ui/src/components/RenamedConversation.tsx';
function fixtureManifest() {
  return {
    version: 1,
    roots: ['src-ui/src'],
    owners: [
      {
        concern: 'body',
        file: 'src-ui/src/shared/Body.tsx',
        symbol: 'ConversationBody',
        reason: 'Shared body.',
      },
      {
        concern: 'delivery',
        file: 'src-ui/src/shared/Delivery.tsx',
        symbol: 'MessageDeliveryNote',
        reason: 'Shared delivery.',
      },
      {
        concern: 'failure',
        file: 'src-ui/src/shared/failure.ts',
        symbol: 'describeStationFailure',
        reason: 'Shared translator.',
      },
      {
        concern: 'stop',
        file: 'src-ui/src/shared/Stop.tsx',
        symbol: 'ConversationStopControl',
        reason: 'Shared control.',
      },
    ],
    surfaces: [
      {
        file: surface,
        requires: [] as string[],
        reason: 'Conversation adapter.',
      },
    ],
    modules: [] as string[],
    contracts: [] as Array<{
      file: string;
      rule: string;
      symbols: string[];
      reason: string;
      fingerprints?: string[];
    }>,
  };
}
function scan(
  source: string,
  extra: Record<string, string> = {},
  manifest = fixtureManifest(),
) {
  return scanConversationSources({ [surface]: source, ...extra }, manifest, {
    enforceScope: false,
  });
}
function rules(source: string, extra: Record<string, string> = {}) {
  return scan(source, extra).sites.map((site) => site.rule);
}

// The removed PeerChatBody's actual composition: host scope, a polled peer
// window, local send/interrupt/answer mutations, and separate transcript/editor.
const originalPeerChatBody = `
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { sendExecutionMessage } from '@kontourai/station-sdk/client';
import { interruptOrchestrationTurn } from '@kontourai/station-sdk';
import { answerOrchestrationRequest } from '../../hooks/orchestration/answerRequest';
import { SessionReplyComposer } from '../session-detail/SessionReplyComposer';
import { SessionTranscript } from '../session-detail/SessionTranscript';
import { READ_ONLY_UI_BLOCK_ACTIONS } from '../chat/UIBlockActionsContext';
export function PeerChatBody({ binding }) {
  const scope = useHostRequestAuthorityScope();
  const history = useQuery({ queryKey: ['peer-chat-history', binding.conversationId], refetchInterval: 3000 });
  const send = () => sendExecutionMessage(scope.apiBase, binding.pending);
  const stop = () => interruptOrchestrationTurn({ threadId: binding.sessionId });
  const answer = () => answerOrchestrationRequest(scope.apiBase, binding.request);
  const error = history.error;
  return <><SessionTranscript messages={history.data}/><SessionReplyComposer onSend={send}/>
    <button onClick={stop}>Stop</button><ErrorState description={error.message}/>
    <UIBlockActionsContext.Provider value={READ_ONLY_UI_BLOCK_ACTIONS}/></>;
}`;

describe('conversation boundaries: known-bad catches', () => {
  test('rejects the original PeerChatBody shape even under an unrelated filename', () => {
    const result = scanConversationSources(
      { 'src-ui/src/components/Unrelated.tsx': originalPeerChatBody },
      fixtureManifest(),
      { enforceScope: false },
    );
    expect(result.errors).toEqual([]);
    expect(new Set(result.sites.map((site) => site.rule))).toEqual(
      new Set(['G1', 'G2', 'G3', 'G4', 'G5']),
    );
  });
  test.each([
    `import {useApiBase as target} from '../contexts/ApiBaseContext'; const base = target();`,
    `import * as context from '../contexts/ApiBaseContext'; const read = context.useApiBase; const base = read();`,
    `import * as context from '../contexts/ApiBaseContext'; const namespace = context; const {useApiBase: read} = namespace; read();`,
    `import * as context from '../contexts/AgentsContext'; useContext(context.AgentsContext);`,
    `import {useApiBase} from '../contexts/ApiBaseContext'; const first = useApiBase; const second = first; second();`,
    `import {useTarget} from '../wrapper'; useTarget();`,
    `import * as wrapper from '../wrapper'; wrapper.useTarget();`,
    `import {_getApiBase as read} from '@kontourai/station-sdk/client'; read();`,
    `import {useActiveStationName as label} from '../host'; label();`,
    `import {useProjects as catalog} from '../contexts/ProjectsContext'; catalog();`,
    `import {useAgent as target} from '../contexts/AgentsContext'; target('codex');`,
  ])('G1 follows authority bindings: %s', (source) => {
    expect(
      rules(source, {
        'src-ui/src/wrapper.ts': `export { useApiBase as useTarget } from './contexts/ApiBaseContext';`,
        'src-ui/src/contexts/ApiBaseContext.tsx': `export function useApiBase() {return {apiBase:'host'}}`,
      }),
    ).toContain('G1');
  });
  test('follows a locally rebound re-export', () => {
    expect(
      rules(`import {useTarget} from '../wrapper'; useTarget();`, {
        'src-ui/src/wrapper.ts': `import {useApiBase as read} from './contexts/ApiBaseContext'; export const useTarget = read;`,
        'src-ui/src/contexts/ApiBaseContext.tsx': `export function useApiBase() {return {}}`,
      }),
    ).toContain('G1');
  });
  test.each([
    `export const Copy = () => <><ChatMessageList/><ChatInputArea/></>;`,
    `export const Copy = () => <textarea onKeyDown={send}/>;`,
    `import {interruptTurn as stop} from '@kontourai/station-sdk/client'; stop(base, turn);`,
    `import * as sdk from '@kontourai/station-sdk/client'; sdk.respondToRequest(base, decision);`,
    `import { answerOrchestrationRequest as reply } from '../hooks/orchestration/answerRequest'; reply(base, decision);`,
    `useQuery({refetchInterval: query => query.state.data ? 1000 : 3000});`,
    `setInterval(refreshTranscript, 1000);`,
    `export const Copy = () => <button onClick={cancel}>Stop</button>;`,
    `export const Copy = () => <button onClick={cancel} aria-label="Stop the current turn"><Icon/></button>;`,
    `export function ConversationBody() { return null; }`,
  ])('G2 catches copied concerns and mutations: %s', (source) =>
    expect(rules(source)).toContain('G2'),
  );
  test('catches a copied delivery renderer and counts two copies separately', () => {
    const copy = `<div className="message-delivery"><span>Not sent</span><button>Retry</button><button>Edit</button></div>`;
    expect(
      scan(`const Copy = () => <>${copy}${copy}</>;`).sites.filter((site) =>
        site.syntax.startsWith('copied delivery note'),
      ),
    ).toHaveLength(2);
  });
  test('catches defect 1: a new standalone delivery-note wrapper outside the user bubble', () => {
    const source = `import {MessageDeliveryNote} from '../shared/Delivery'; export const Refused = ({notice,port}) => <div><MessageDeliveryNote state={notice.state} port={port}/><p>{notice.description}</p></div>`;
    const result = scanConversationSources(
      {
        'src-ui/src/components/Other.tsx': source,
        'src-ui/src/shared/Delivery.tsx':
          'export function MessageDeliveryNote(){return null}',
      },
      fixtureManifest(),
      { enforceScope: false },
    );
    expect(result.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'G5',
          syntax: 'register conversation surface',
        }),
      ]),
    );
  });
  test.each([
    `try {read()} catch(error) {return <p>{error.message}</p>}`,
    `try {read()} catch(problem) {const alias = problem; const {message: detail} = alias; return <ErrorState description={detail}/>}`,
    `const {error: failure} = useQuery(); const detail = failure.code; toast(detail);`,
    `const query = useQuery(); return <p>{query.error.message}</p>;`,
    `read().catch(problem => showToast({message: problem.message}));`,
    `try {read()} catch(err) {setFailure(err.code)}`,
    `try {read()} catch(err) {const detail = err.message; setError(detail || 'Failed')}`,
    `try {read()} catch(error) {setError(String(error))}`,
    `try {read()} catch(error) {updateChat(id,{error:error.message})}`,
    `try {read()} catch(error) {addEphemeralMessage(id,{content:error.message})}`,
    `try {read()} catch(error) {reportOutboundQueueUnavailable(error.message)}`,
  ])('G3 catches visible raw failure flow: %s', (source) =>
    expect(rules(source)).toContain('G3'),
  );
  test.each([
    `interface PeerCapabilities { send: boolean }`,
    `interface PeerProps { canSend: boolean }`,
    `type ChatPermissions = {reply: boolean};`,
    `const allowed = session.callerAccess.continue;`,
    `const {messageWrite: writable} = capabilities;`,
    `const enabled = capabilities.historyRead;`,
    `const disabled = child.sessionUnanswerable;`,
    `const policy = READ_ONLY_UI_BLOCK_ACTIONS;`,
    `const canReply = Boolean(context);`,
  ])('G4 catches a foreign capability vocabulary: %s', (source) =>
    expect(rules(source)).toContain('G4'),
  );
  test('G5 requires consuming the owner, not merely importing it', () => {
    const manifest = fixtureManifest();
    manifest.surfaces[0].requires = ['body'];
    const extra = {
      'src-ui/src/shared/Body.tsx':
        'export function ConversationBody(){return null}',
    };
    expect(
      scan(
        `import {ConversationBody} from '../shared/Body'; export const Adapter = () => <p/>;`,
        extra,
        manifest,
      ).sites.map((site) => site.rule),
    ).toContain('G5');
    expect(
      scan(
        `import {ConversationBody} from '../shared/Body'; type Props = typeof ConversationBody;`,
        extra,
        manifest,
      ).sites.map((site) => site.rule),
    ).toContain('G5');
    expect(
      scan(
        `import {ConversationBody as Body} from '../shared/Body'; export const Adapter = () => <Body/>;`,
        extra,
        manifest,
      ).sites,
    ).toEqual([]);
  });
  test('G5 follows a consumed LazyBoundary loader but rejects its unused declaration', () => {
    const manifest = fixtureManifest();
    manifest.surfaces[0].requires = ['body'];
    const extra = {
      'src-ui/src/shared/Body.tsx':
        'export function ConversationBody(){return null}',
    };
    const loader = `const load = () => import('../shared/Body').then(module => ({default:module.ConversationBody}));`;
    expect(
      scan(
        `${loader} export const Adapter = () => <LazyBoundary load={load}/>;`,
        extra,
        manifest,
      ).sites,
    ).toEqual([]);
    expect(
      scan(
        `${loader} export const Adapter = () => <p/>;`,
        extra,
        manifest,
      ).sites.map((site) => site.rule),
    ).toContain('G5');
  });
});

describe('conversation boundaries: harmless controls and ratchet', () => {
  test('the migration has no inherited conversation baseline rows', () => {
    const baseline = JSON.parse(
      readFileSync('scripts/conversation-boundary-baseline.json', 'utf8'),
    );
    expect(baseline.exceptions).toEqual([]);
  });
  test('a registered error publisher must actually consume the shared failure owner', () => {
    const manifest = {
      ...fixtureManifest(),
      failureSurfaces: [{ file: surface, reason: 'Visible request failure' }],
    };
    const extra = {
      'src-ui/src/shared/failure.ts':
        'export function describeStationFailure(){return {body:"safe"}}',
    };
    expect(
      scan('export const View=()=> <p>Failed</p>', extra, manifest).sites.some(
        (site) => site.syntax === 'adopt failure',
      ),
    ).toBe(true);
    expect(
      scan(
        `import {describeStationFailure} from '../shared/failure'; export const View=()=> <p>{describeStationFailure(error).body}</p>`,
        extra,
        manifest,
      ).sites,
    ).toEqual([]);
  });

  test.each([
    `const record = {message:'insufficient_scope'}; const View = () => <p>{record.message}</p>`,
    `try {read()} catch(error) { console.error(error.message, error.code); }`,
    `try {read()} catch(error) { setError(describeStationFailure(error).body); }`,
    `try {read()} catch(error) {return <ErrorState description={describeStationFailure(error).body}/>} `,
    `import type {useApiBase} from '../host'; type Scope = ReturnType<typeof useApiBase>;`,
    `import {type useApiBase} from '../host'; type Scope = ReturnType<typeof useApiBase>;`,
    `const maySend = capabilities.send && !busy;`,
    `const View = () => <p>Not sent Retry Edit</p>;`,
  ])(
    'does not mistake safe domain/diagnostic/translated code for a violation: %s',
    (source) => expect(scan(source).sites).toEqual([]),
  );
  test('allows the exact shared owner and a designated transport import contract', () => {
    const manifest = fixtureManifest();
    manifest.owners.find((owner) => owner.concern === 'stop')!.file = surface;
    expect(
      scan(
        `export const ConversationStopControl = () => <button onClick={onStop}>Stop</button>;`,
        {},
        manifest,
      ).sites,
    ).toEqual([]);
    manifest.contracts.push({
      file: surface,
      rule: 'G2',
      symbols: ['interruptTurn'],
      reason: 'Bound turn transport.',
    });
    expect(
      scan(
        `import {interruptTurn} from '@kontourai/station-sdk/client'; interruptTurn(base,turn);`,
        {},
        manifest,
      ).sites,
    ).toEqual([]);
  });
  test('permits a read-only task adapter using the shared record owner', () => {
    const manifest = fixtureManifest();
    manifest.owners.push({
      concern: 'history',
      file: 'src-ui/src/shared/History.tsx',
      symbol: 'SharedTaskHistoryList',
      reason: 'Shared records.',
    });
    manifest.surfaces[0].requires = ['history'];
    expect(
      scan(
        `import {SharedTaskHistoryList} from '../shared/History'; export const ReadOnly = ({records}) => <SharedTaskHistoryList records={records}/>;`,
        {
          'src-ui/src/shared/History.tsx':
            'export function SharedTaskHistoryList(){return null}',
        },
        manifest,
      ).sites,
    ).toEqual([]);
  });
  test('pins a non-transcript delivery query exception to its exact syntax', () => {
    const source =
      'useQuery({refetchInterval: deliveryRecovery ? 1000 : false});';
    const manifest = fixtureManifest();
    const site = scan(source).sites.find((site) => site.rule === 'G2');
    expect(site).toBeDefined();
    manifest.contracts.push({
      file: surface,
      rule: 'G2',
      symbols: ['transcript polling'],
      reason: 'Exact non-transcript delivery recovery query.',
      fingerprints: [site!.fingerprint],
    });
    expect(scan(source, {}, manifest).sites).toEqual([]);
    expect(
      scan(source.replace('1000', '2000'), {}, manifest).sites.map(
        (site) => site.rule,
      ),
    ).toContain('G2');
  });
  test('freezes syntax, file and multiplicity; update only shrinks', () => {
    const sites = scan(`useApiBase();`).sites;
    const baseline = {
      version: 1,
      exceptions: sites.map(({ rule, file, fingerprint, syntax }) => ({
        rule,
        file,
        fingerprint,
        syntax,
        count: 1,
        migrate: 'P2.6',
      })),
    };
    expect(evaluateConversationBaseline(sites, baseline).errors).toEqual([]);
    expect(
      evaluateConversationBaseline([...sites, ...sites], baseline).errors,
    ).not.toEqual([]);
    expect(
      evaluateConversationBaseline(
        sites.map((site) => ({
          ...site,
          file: site.file.replace('Renamed', 'Moved'),
        })),
        baseline,
      ).errors,
    ).not.toEqual([]);
    expect(
      evaluateConversationBaseline(scan(`useApiBase(other);`).sites, baseline)
        .errors,
    ).not.toEqual([]);
    expect(evaluateConversationBaseline([], baseline)).toEqual({
      errors: [],
      next: { version: 1, exceptions: [] },
    });
    expect(
      evaluateConversationBaseline(sites, { version: 1, exceptions: [] })
        .errors,
    ).not.toEqual([]);
    expect(
      evaluateConversationBaseline(sites, {
        version: 1,
        exceptions: [...baseline.exceptions, ...baseline.exceptions],
      }).errors,
    ).not.toEqual([]);
    expect(
      evaluateConversationBaseline(sites, {
        version: 1,
        exceptions: baseline.exceptions.map((row) => ({
          ...row,
          migrate: 'future',
        })),
      }).errors,
    ).not.toEqual([]);
  });
  test('fails closed on parse errors and malformed collections', () => {
    expect(scan('export const = ;').errors).not.toEqual([]);
    expect(scanConversationSources({}, {}, {}).errors).not.toEqual([]);
    expect(evaluateConversationBaseline([], {}).errors).not.toEqual([]);
  });
  test('routes source edits and the scanner policy suite through its own classifier', () => {
    for (const file of [
      'src-ui/src/App.tsx',
      'packages/sdk/src/client/http.ts',
      'packages/connect/src/react/ConnectionsContext.tsx',
      'scripts/conversation-surfaces.json',
      'scripts/conversation-boundary-baseline.json',
      'package.json',
    ])
      expect(conversationBoundaryCommands([file])).toContain(
        'node scripts/conversation-boundary-gate.mjs',
      );
    expect(
      conversationBoundaryCommands(['scripts/conversation-surfaces.json']).join(
        '\n',
      ),
    ).toContain('conversation-boundary-gate.test.ts');
    expect(conversationBoundaryCommands(['docs/README.md'])).toEqual([]);
  });
  test('discovers tracked and relevant untracked sources with bounded Git capture', () => {
    const capture = (_command: string, args: readonly string[]) => {
      expect(args).toEqual(
        expect.arrayContaining([
          '--cached',
          '--others',
          '--exclude-standard',
          'src-ui/src',
        ]),
      );
      return [
        'src-ui/src/NewSurface.tsx',
        'src-ui/src/Existing.ts',
        'src-ui/src/__tests__/test.tsx',
        'src-ui/src/Existing.ts',
      ].join('\0');
    };
    expect(discoverConversationFiles(process.cwd(), capture)).toEqual([
      'src-ui/src/Existing.ts',
      'src-ui/src/NewSurface.tsx',
    ]);
  });
});

describe('real manifest and scope sentinels', () => {
  const manifest = JSON.parse(
    readFileSync('scripts/conversation-surfaces.json', 'utf8'),
  );
  const sources = Object.fromEntries(
    discoverConversationFiles().map((file) => [
      file,
      readFileSync(file, 'utf8'),
    ]),
  );
  test('keeps roots, every owner export and the scan nonempty', () => {
    const result = scanConversationSources(sources, manifest);
    expect(result.errors).toEqual([]);
    expect(
      evaluateConversationBaseline(
        result.sites,
        JSON.parse(
          readFileSync('scripts/conversation-boundary-baseline.json', 'utf8'),
        ),
      ).errors,
    ).toEqual([]);
    expect(
      scanConversationSources(sources, { ...manifest, roots: [] }).errors,
    ).not.toEqual([]);
    expect(scanConversationSources({}, manifest).errors).not.toEqual([]);
  });
  test('deleting or renaming a root sentinel cannot quietly reduce findings to zero', () => {
    const lost = { ...sources };
    const file = 'src-ui/src/components/chat-dock/MobileInboxPanel.tsx';
    delete lost[file];
    lost[file.replace('MobileInboxPanel', 'RenamedPanel')] = sources[file];
    expect(scanConversationSources(lost, manifest).errors).toContain(
      `scope lost sentinel: ${file}`,
    );
  });
  test('missing and duplicate owners are rejected', () => {
    expect(
      scanConversationSources(sources, {
        ...manifest,
        owners: manifest.owners.slice(1),
      }).errors,
    ).toContain('exactly one owner required: body');
    expect(
      scanConversationSources(sources, {
        ...manifest,
        owners: [...manifest.owners, manifest.owners[0]],
      }).errors,
    ).toContain('exactly one owner required: body');
    const removed = { ...sources };
    delete removed['src-ui/src/components/conversation/ConversationBody.tsx'];
    expect(scanConversationSources(removed, manifest).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('missing owner export')]),
    );
  });
});
