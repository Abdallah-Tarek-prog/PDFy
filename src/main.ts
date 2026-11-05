import { App } from './app';
import * as jobs from './core/jobs';
import * as engine from './core/engine';
import { Session } from './core/session';
import * as recovery from './features/recovery';
import * as images from './features/images';
import * as decor from './features/decor';
import * as convert from './features/convert';
import * as compare from './features/compare';
import * as xfdf from './features/xfdf';
import * as search from './features/search';
import * as decoders from './features/decoders';
import * as detect from './features/detect';
import * as ocr from './features/ocr';
import * as batch from './features/batch';
import { onHostMessage } from './features/office';
import * as office from './features/office';
import * as sign from './features/sign';
import * as docmodel from './features/docmodel';
import * as docxEditor from './features/docx-editor';
import { unzipSync, strFromU8 } from 'fflate';
import { reportError, toast } from './ui/dom';
import { onFontMessage, restoreAddedFonts, installedFonts, addFontFiles } from './study/fonts';
import { ensureRichCss } from './study/mdthemes';
import { onPageMessage } from './study/publishers';
import * as study from './study/testing';

// Last line of defence. An unexpected error shows a message and the app carries on.
window.addEventListener('error', e => {
  if (e.message?.includes('ResizeObserver')) return;
  console.error('Uncaught', e.error ?? e.message);
  toast(`Something went wrong, but your work is safe: ${e.message}`, 'error');
});
window.addEventListener('unhandledrejection', e => {
  const reason = e.reason as Error | undefined;
  if (reason?.name === 'RenderingCancelledException' || reason?.name === 'AbortError') return;
  reportError('A background task', reason);
});

try {
  const saved = localStorage.getItem('pdfy.uiTheme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* Storage may be off. */ }

ensureRichCss();
void restoreAddedFonts();
const app = new App(document.getElementById('app')!);

// The Windows app hands over files opened with "Open with" or passed on the command line.
window.chrome?.webview?.addEventListener('message', e => {
  onHostMessage(e.data as Parameters<typeof onHostMessage>[0]);
  onFontMessage(e.data as Parameters<typeof onFontMessage>[0]);
  onPageMessage(e.data as Parameters<typeof onPageMessage>[0]);
  const handle = e.additionalObjects?.[0] as FileSystemFileHandle | undefined;
  if (handle) app.openHandle(handle).catch(err => reportError('Opening', err));
  if ((e.data as { type?: string })?.type === 'close-request') {
    app.closeAllForExit().then(ok => { if (ok) window.chrome?.webview?.postMessage({ type: 'close-ok' }); }).catch(err => reportError('Closing', err));
  }
});
window.chrome?.webview?.postMessage({ type: 'ready' });

// Used by the automated tests.
if (location.hostname === 'localhost' || new URLSearchParams(location.search).has('test')) {
  Object.assign(window, { __pdfy: app, __api: { ...jobs, ...engine, ...recovery, ...images, ...decor, ...convert, ...compare, ...xfdf, ...search, ...decoders, ...detect, ...batch, ...ocr, ...office, ...sign, ...docmodel, ...docxEditor, ...study, installedFonts, addFontFiles, unzipSync, strFromU8, Session } });
}
