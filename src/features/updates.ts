import { h, toast } from '../ui/dom';

interface UpdateState {
  type: 'app-update';
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  message: string;
  currentVersion: string;
  latestVersion?: string;
  enabled: boolean;
}

let state: UpdateState | null = null;
const listeners = new Set<() => void>();
const send = (message: unknown) => window.chrome?.webview?.postMessage(message);

export function onUpdateMessage(message: unknown) {
  const next = message as UpdateState | null;
  if (next?.type !== 'app-update') return;
  const wasReady = state?.phase === 'ready';
  state = next;
  for (const listener of listeners) listener();
  if (next.phase === 'ready' && !wasReady) toast(`Meletiq PDF ${next.latestVersion} is ready. It installs when you close the app.`, 'ok', 10000);
}

/** Uses existing Settings controls; no updater is shown in the browser-only build. */
export function updateControls(): HTMLElement {
  const host = h('div', { class: 'st-updates' });
  if (!window.chrome?.webview) return host;
  const status = h('p', { class: 'muted update-status', role: 'status', 'aria-live': 'polite' });
  const automatic = h('input', { type: 'checkbox', class: 'st-switch', role: 'switch', 'aria-label': 'Automatic updates' });
  automatic.onchange = () => send({ type: 'update-enabled', enabled: automatic.checked });
  const check = h('button', { class: 'btn small', onclick: () => send({ type: 'update-check' }) }, 'Check for updates');
  const install = h('button', { class: 'btn small primary', hidden: true, onclick: () => send({ type: 'update-install' }) }, 'Restart to update');
  host.append(h('h3', { class: 'st-sub' }, 'App updates'),
    h('div', { class: 'st-row' }, h('div', { class: 'st-text' }, h('div', { class: 'st-label' }, 'Automatic updates'),
      h('div', { class: 'st-about' }, 'Check for GitHub releases at startup and every six hours. Verified updates install when you close the app.')),
      h('div', { class: 'st-control' }, automatic)), status, h('div', { class: 'row-gap' }, check, install));
  const draw = () => {
    if (!host.isConnected && connected) { listeners.delete(draw); return; }
    if (host.isConnected) connected = true;
    automatic.checked = state?.enabled ?? true;
    status.textContent = state ? `Version ${state.currentVersion}. ${state.message}` : 'Reading update status…';
    check.disabled = state?.phase === 'checking' || state?.phase === 'downloading';
    install.hidden = state?.phase !== 'ready';
  };
  let connected = false;
  listeners.add(draw); draw(); send({ type: 'update-state' });
  return host;
}
