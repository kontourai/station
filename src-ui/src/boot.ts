import { dismissInitialStartup } from './lib/startup-presentation';
import { observeInitialStartupVisibility } from './platform/native/startupPresentation';

observeInitialStartupVisibility();

// `rendered` settles after the first render, which can wait for a color-theme
// stylesheet; a render that throws then fails here like a module that did.
void import('./main')
  .then((main) => main.rendered)
  .catch(() => {
    dismissInitialStartup();
    const root = document.getElementById('root');
    if (!root) return;
    const screen = document.createElement('div');
    screen.className = 'station-startup';
    root.replaceChildren(screen);
    screen.setAttribute('aria-busy', 'false');
    screen.setAttribute('role', 'alert');
    screen.setAttribute('aria-label', 'Station could not start');
    const recovery = document.createElement('div');
    recovery.className = 'station-startup__recovery';
    const message = document.createElement('p');
    message.textContent = 'Station could not finish loading.';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload Station';
    reload.addEventListener('click', () => window.location.reload());
    recovery.append(message, reload);
    screen.append(recovery);
  });
