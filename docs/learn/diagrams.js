import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'default',
  fontFamily: 'system-ui, sans-serif',
  suppressErrorRendering: true,
  flowchart: { htmlLabels: false },
});

let generation = 0;
let sequence = 0;

export async function renderDiagrams(root) {
  const current = ++generation;
  for (const code of root.querySelectorAll('code.language-mermaid')) {
    const source = code.textContent;
    const original = code.closest('pre');
    const figure = document.createElement('figure');
    figure.className = 'diagram';
    const controls = document.createElement('div');
    controls.className = 'diagram-controls';
    const canvas = document.createElement('div');
    canvas.className = 'diagram-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'region');
    canvas.setAttribute(
      'aria-label',
      'Architecture diagram; scroll to explore',
    );
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Diagram source';
    details.append(summary, original.cloneNode(true));
    figure.append(controls, canvas, details);
    original.replaceWith(figure);
    try {
      const { svg } = await mermaid.render(
        `station-diagram-${++sequence}`,
        source,
      );
      if (current !== generation || !figure.isConnected) return;
      canvas.innerHTML = svg;
      const drawing = canvas.querySelector('svg');
      const width = drawing.viewBox.baseVal.width;
      drawing.style.width = `${width}px`;
      drawing.style.height = 'auto';
      for (const [label, size] of [
        ['Fit width', '100%'],
        ['Actual size', `${width}px`],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          drawing.style.width = size;
        });
        controls.append(button);
      }
    } catch (error) {
      if (current !== generation || !figure.isConnected) return;
      canvas.textContent = `Diagram could not render: ${error.message}`;
      canvas.setAttribute('role', 'alert');
      details.open = true;
    }
  }
}
