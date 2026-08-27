export interface CodingChatContextItem {
  id: string;
  label: string;
  detail: string;
  messageLine: string;
}

export interface CodingChatContextDraft {
  title: string;
  description: string;
  items: CodingChatContextItem[];
}

export function buildCodingChatContextDraft({
  workingDir,
  selectedFile,
  activeTabLabel,
  isDiffView,
}: {
  workingDir: string;
  selectedFile: string | null;
  activeTabLabel?: string | null;
  isDiffView: boolean;
}): CodingChatContextDraft {
  const items: CodingChatContextItem[] = [];

  if (workingDir) {
    items.push({
      id: 'working-directory',
      label: 'Working dir',
      detail: workingDir,
      messageLine: `- Working directory: ${workingDir}`,
    });
  }

  if (selectedFile) {
    items.push({
      id: 'selected-file',
      label: 'File',
      detail: selectedFile,
      messageLine: `- Selected file: ${selectedFile}`,
    });
  } else if (isDiffView) {
    items.push({
      id: 'diff-view',
      label: 'Surface',
      detail: 'Git diff view',
      messageLine: '- Current surface: Git diff view',
    });
  }

  if (activeTabLabel) {
    items.push({
      id: 'active-terminal',
      label: 'Terminal',
      detail: activeTabLabel,
      messageLine: `- Active terminal: ${activeTabLabel}`,
    });
  }

  return {
    title: 'Coding context handoff',
    description:
      'Choose which coding context to carry into the next chat. The selection is prefilled in the composer so it stays inspectable and removable.',
    items,
  };
}

export function buildCodingChatInitialMessage(
  items: CodingChatContextItem[],
): string {
  if (items.length === 0) {
    return '';
  }

  return [
    'Coding context for this chat:',
    '',
    ...items.map((item) => item.messageLine),
    '',
    'Use this context when relevant, but ask before assuming stale terminal or diff state.',
  ].join('\n');
}
