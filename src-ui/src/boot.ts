import { releaseInitialStartupAnimation } from './lib/startup-animation';

void import('./main').catch(() => {
  releaseInitialStartupAnimation();
  const root = document.getElementById('root');
  if (!root) return;
  root.querySelector('canvas')?.remove();
  const screen = root.querySelector('.station-startup');
  screen?.setAttribute('aria-busy', 'false');
  screen?.setAttribute('role', 'alert');
  screen?.setAttribute('aria-label', 'Station could not start');
  const recovery = document.createElement('div');
  recovery.className = 'station-startup__recovery';
  const message = document.createElement('p');
  message.textContent = 'Station could not finish loading.';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload Station';
  reload.addEventListener('click', () => window.location.reload());
  recovery.append(message, reload);
  screen?.append(recovery);
});
