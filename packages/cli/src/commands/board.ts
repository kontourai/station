import {
  BOARD_WIDGET_SIZES,
  type BoardReference,
} from '@kontourai/station-contracts/board';
import {
  getBoard,
  getPersonalBoard,
  listPersonalLayouts,
  moveBoardWidget,
  pinBoardWidget,
  unpinBoardWidget,
} from '@kontourai/station-sdk/client';
import {
  loadJsonPayload,
  optionalValueFlag,
  type ParsedCoreArgs,
  printJson,
  requirePositional,
} from './core-api.js';

export async function runBoardCommand(
  command: 'board' | 'boards',
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const action = parsed.positionals[0];
  if (command === 'boards') {
    if (action === 'list') {
      printJson(await listPersonalLayouts(apiBase));
      return;
    }
    if (action === 'get') {
      printJson(
        await getPersonalBoard(
          apiBase,
          requirePositional(parsed, 1, 'Board slug'),
        ),
      );
      return;
    }
    throw new Error('Unknown boards action. See station boards --help.');
  }

  if (
    action !== 'read' &&
    action !== 'pin' &&
    action !== 'unpin' &&
    action !== 'move'
  ) {
    throw new Error('Unknown board action. See station board --help.');
  }
  const kind = requirePositional(parsed, 1, 'reference kind');
  if (kind !== 'session' && kind !== 'task') {
    throw new Error('Board reference kind must be session or task.');
  }
  const id = requirePositional(parsed, 2, 'reference id');
  const projectId = optionalValueFlag(parsed, 'project');
  let reference: BoardReference;
  if (kind === 'task') {
    if (!projectId) throw new Error('Task Boards require --project=<slug>.');
    reference = { kind, id, projectId };
  } else {
    if (projectId !== undefined)
      throw new Error('Session Boards use the Session ID alone.');
    reference = { kind, id };
  }

  if (action === 'read') {
    printJson(await getBoard(apiBase, reference));
    return;
  }

  const name = requirePositional(parsed, 3, 'widget name');
  if (action === 'unpin') {
    printJson(await unpinBoardWidget(apiBase, reference, name));
    return;
  }

  const tabId = optionalValueFlag(parsed, 'tab');
  const after = optionalValueFlag(parsed, 'after');
  if (action === 'move') {
    printJson(
      await moveBoardWidget(apiBase, { reference, name, tabId, after }),
    );
    return;
  }

  const tabTitle = optionalValueFlag(parsed, 'tab-title');
  const sizeFlag = optionalValueFlag(parsed, 'size');
  const size = BOARD_WIDGET_SIZES.find((value) => value === sizeFlag);
  if (sizeFlag !== undefined && size === undefined) {
    throw new Error(`--size must be one of ${BOARD_WIDGET_SIZES.join(', ')}.`);
  }
  const block = await loadJsonPayload(parsed);
  printJson(
    await pinBoardWidget(apiBase, {
      reference,
      name,
      block,
      tabId,
      tabTitle,
      size,
      after,
    }),
  );
}
