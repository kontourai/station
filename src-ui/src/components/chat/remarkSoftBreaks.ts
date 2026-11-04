/**
 * Single newlines in prose as line breaks (#4385).
 *
 * CommonMark folds a lone newline inside a paragraph into a space, which is
 * right for hard-wrapped documents and wrong for chat: an agent that answers
 * one item per line ("1\n2\n3", a poem, an address) means those lines. This is
 * the GFM `breaks` behaviour, done in place so no further dependency is needed:
 * every newline in a text node becomes a `break` node.
 *
 * Only `text` nodes are split. Code (`code`, `inlineCode`) and raw `html` keep
 * their own values, and a paragraph boundary (a blank line) is already a
 * separate node, so it is untouched.
 */

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
};

const NEWLINE = /\r?\n/;

function splitText(node: MdNode): MdNode[] {
  const lines = (node.value ?? '').split(NEWLINE);
  if (lines.length === 1) return [node];
  const parts: MdNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) parts.push({ type: 'break' });
    if (line) parts.push({ type: 'text', value: line });
  });
  return parts;
}

function visit(parent: MdNode): void {
  if (!parent.children) return;
  let changed = false;
  const next: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === 'text' && child.value && NEWLINE.test(child.value)) {
      next.push(...splitText(child));
      changed = true;
    } else {
      visit(child);
      next.push(child);
    }
  }
  if (changed) parent.children = next;
}

/** Remark plugin: soft line breaks render as `<br>`. */
export function remarkSoftBreaks() {
  return (tree: MdNode) => {
    visit(tree);
  };
}
