// The feature guide: a short illustrated tour of what PDFy does that other PDF apps do not.
// It opens by itself the first time PDFy starts and once after each update, and any time from
// Settings or the More menu. The pictures are drawn with the page's own styles, so the guide
// weighs a few kilobytes and follows the interface theme.

import { getSettings, saveSettings } from '../core/settings';
import { h, icon } from './dom';

/** Raise this when the guide gains something new, so it opens once after the update. */
export const GUIDE_VERSION = '2026-11-06';

interface Slide { id: string; title: string; lead: string; points: string[]; keys?: string[]; isNew?: boolean; art: () => HTMLElement }

const el = (cls: string, ...kids: (Node | string | null)[]) => h('div', { class: cls }, ...kids);
const line = (w: number, cls = '') => h('span', { class: `ga-line ${cls}`, style: { width: `${w}%` } });
const page = (...kids: (Node | null)[]) => el('ga-page', ...kids);

const SLIDES: Slide[] = [
  {
    id: 'welcome', title: 'Welcome to PDFy', lead: 'A PDF editor for studying and note-taking. Here is what makes it different, in about two minutes.',
    points: ['Read, annotate and organise PDFs, with familiar keyboard shortcuts.', 'Paste screenshots and turn them light or dark to match your notes.', 'Markdown notes, equations, a dictionary with Arabic, and reading words from pictures.'],
    art: () => el('ga-art ga-welcome', el('ga-logo', icon('contrast', 46)), el('ga-chips', ...['Paste', 'Themes', 'Notes', 'Equations', 'Dictionary', 'Pen'].map(t => h('span', { class: 'ga-chip' }, t)))),
  },
  {
    id: 'paste', title: 'Paste a screenshot, then flip its theme', lead: 'Copy anything on screen and press Ctrl+V. It lands on the page, and one click turns a dark screenshot light, or a light one dark.',
    points: ['Colours keep their meaning: blue stays blue, red stays red.', 'Photos inside the screenshot are left alone.', 'Hold “Compare” to see the original. Undo always brings it back.'],
    keys: ['Ctrl+V'],
    art: () => el('ga-art ga-row', el('ga-shot dark', line(70, 'hl'), line(90), line(55), el('ga-photo')), el('ga-arrow', icon('chevRight', 26)), el('ga-shot light', line(70, 'hl'), line(90), line(55), el('ga-photo'))),
  },
  {
    id: 'crop', title: 'Crop pasted pictures, and convert any area', lead: 'Select a pasted picture to crop it, rotate it, or change its theme. The theme still works after cropping.',
    points: ['Theme snip: drag over any part of a page to turn just that area light or dark.', 'Page theme converts whole pages, and the text stays searchable.', 'Paste with no document open and a new one is made around the picture.'],
    art: () => el('ga-art', page(line(60), line(80), el('ga-crop', el('ga-shot dark small', line(80, 'hl'), line(60))), line(70))),
  },
  {
    id: 'markdown', title: 'Markdown notes that format themselves', lead: 'Choose Markdown on the Edit toolbar, click the page and type. Click away and it becomes neat notes, like Obsidian.',
    points: ['Headings, bold, ==highlights==, tasks, tables, callouts, code and equations.', 'Double-click a note to edit the Markdown again.', 'Pick a look, or make your own, under Note themes. Notes print as sharp text.'],
    keys: ['Ctrl+Shift+M'],
    art: () => el('ga-art ga-row', el('ga-md raw', h('code', null, '# Key idea'), h('code', null, 'Energy is **conserved**'), h('code', null, '- [x] Read chapter 2'), h('code', null, '> [!tip] Remember')),
      el('ga-arrow', icon('chevRight', 26)),
      el('ga-md done', h('strong', { class: 'ga-h' }, 'Key idea'), h('span', null, 'Energy is ', h('b', null, 'conserved')), h('span', { class: 'ga-task' }, '☑ Read chapter 2'), h('span', { class: 'ga-callout' }, 'Remember'))),
  },
  {
    id: 'equations', title: 'Equations with a live preview', lead: 'Type LaTeX and watch it appear as you type. It lands on the page as an object you can move and resize.',
    points: ['A palette of symbols for when you do not remember the command.', 'Saved as sharp vector drawing, and still editable after reopening.'],
    keys: ['Ctrl+Shift+E'],
    art: () => el('ga-art ga-row', el('ga-md raw', h('code', null, '\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}')), el('ga-arrow', icon('chevRight', 26)),
      el('ga-eq', h('span', null, 'x = '), h('span', { class: 'ga-frac' }, h('span', null, '−b ± √(b²−4ac)'), h('span', null, '2a')))),
  },
  {
    id: 'words', title: 'Look up words, and read words from pictures', lead: 'Turn on Word lookup, then double-click any word: meanings, UK and US pronunciation, and Arabic.',
    points: ['Cambridge, Oxford and Longman pages appear inside the pop-up when you are online.', 'Read picture: drag over a screenshot or scan. Its words become real text you can select, copy and find with Ctrl+F.', 'Nothing is drawn on the page, so nothing is left behind.'],
    art: () => el('ga-art', page(line(70), h('span', { class: 'ga-word' }, 'resilient'), line(85), line(50)), el('ga-pop', h('strong', null, 'resilient'), h('small', null, 'UK /rɪˈzɪl.i.ənt/'), h('span', null, 'able to recover quickly'), h('span', { class: 'ga-ar', dir: 'rtl' }, 'مَرِن'))),
  },
  {
    id: 'pen', title: 'Made for a pen and a graphics tablet', lead: 'Each pen colour keeps its own thickness and opacity, so a thin black pen and a thick yellow marker are one click apart.',
    points: ['Choose the pointer: cross, dot, a ring the size of the pen, or hidden.', 'The pen’s side button and eraser end can erase, select or move the page.', 'Hold Shift while writing for a straight line. “Only the pen draws” keeps the mouse for moving.'],
    keys: ['I', 'M', 'E'], isNew: true,
    art: () => el('ga-art ga-row', el('ga-swatches', ...[['#111', 2], ['#d92d20', 3], ['#ffd400', 10], ['#1a56db', 4]].map(([c, w]) => el('ga-sw', h('span', { class: 'ga-dot', style: { background: String(c) } }), h('span', { class: 'ga-stroke', style: { background: String(c), height: `${w}px`, opacity: c === '#ffd400' ? '0.6' : '1' } })))),
      el('ga-cursors', ...['cross', 'dot', 'ring'].map(k => h('span', { class: `ga-cur ${k}` })))),
  },
  {
    id: 'move', title: 'Move around freely', lead: 'Pinch the touchpad, or hold Ctrl and turn the wheel, to zoom right where the pointer is.',
    points: ['Drag with the middle mouse button, or hold Space and drag, to move in any direction.', 'On a touch screen, one finger moves and two fingers zoom.', 'In Settings, the mouse wheel can zoom without Ctrl.'],
    isNew: true,
    art: () => el('ga-art', el('ga-zoom', page(line(70), line(85), line(60)), el('ga-pinch', h('span', null), h('span', null)))),
  },
  {
    id: 'pages', title: 'Arrange pages full screen, and start new documents', lead: 'The Pages button opens every page large. Tick pages to rotate, delete or extract them, and drag to reorder.',
    points: ['The round + inserts a PDF, a picture or new pages.', 'Create document makes blank, lined, grid, dotted, graph, Cornell or music paper, in any size.', 'The + beside the document tabs opens a file or creates a document.'],
    isNew: true,
    art: () => el('ga-art ga-grid', ...Array.from({ length: 6 }, (_, i) => el(`ga-thumb${i === 1 || i === 4 ? ' on' : ''}`, line(70), line(85), line(50))), el('ga-fab', icon('plus', 18))),
  },
  {
    id: 'notes', title: 'Voice notes and bookmarks', lead: 'Record a voice note and pin it to the page. Click it later to play it, skip through it, change the speed or save it.',
    points: ['Voice notes are saved inside the PDF and play again after reopening.', 'Ctrl+B bookmarks the page you are on. The ribbon beside the page number shows it.', 'Bookmarks are saved in the PDF, so other apps show them too.'],
    keys: ['Ctrl+B', 'Ctrl+Shift+B'], isNew: true,
    art: () => el('ga-art ga-row', el('ga-player', h('span', { class: 'ga-play' }, icon('play', 14)), h('span', { class: 'ga-bar' }, h('span', null)), h('small', null, '0:04 / 0:12')),
      page(el('ga-ribbon'), line(70), line(85), line(60))),
  },
  {
    id: 'home', title: 'Collections and recently closed', lead: 'The house button beside the tabs opens Home: your recent files, the documents you closed this week, and your collections.',
    points: ['Put PDFs into collections, such as one per subject. Only a link is kept, never a copy.', 'Recently closed documents reopen at the page you left, for 7 days.', 'Ctrl+Shift+T reopens the last one you closed.'],
    keys: ['Ctrl+Shift+T'], isNew: true,
    art: () => el('ga-art ga-home', el('ga-nav', ...[['#4f8cf7', 'Physics'], ['#e5534b', 'Exams'], ['#3fb27f', 'Reading']].map(([c, n]) => el('ga-coll', h('span', { class: 'ga-cdot', style: { background: c } }), n))),
      el('ga-list', ...['Chapter 3.pdf', 'Past paper 2025.pdf', 'Lecture notes.pdf'].map(n => el('ga-file', icon('file', 13), n)))),
  },
  {
    id: 'keys', title: 'Every tool is one search away', lead: 'Press Ctrl+K and type what you want to do. The shortcuts are Xodo’s, and F1 lists them all and lets you change any.',
    points: ['Ctrl+E opens the Edit tools. Escape goes back to reading.', 'This guide is in Settings, under General and help.'],
    keys: ['Ctrl+K', 'F1', 'Ctrl+E'],
    art: () => el('ga-art', el('ga-search', icon('search', 15), h('span', null, 'compress')), el('ga-results', el('ga-res on', icon('compress', 14), 'Compress'), el('ga-res', icon('toImage', 14), 'To images'), el('ga-res', icon('ocr', 14), 'OCR'))),
  },
];

let showing = false;

/** Opens the guide. Resolves when it is closed. */
export function showGuide(startAt = 0): Promise<void> {
  if (showing) return Promise.resolve();
  showing = true;
  saveSettings({ guideSeen: GUIDE_VERSION });
  return new Promise(resolve => {
    let at = Math.max(0, Math.min(SLIDES.length - 1, startAt));
    const stage = el('guide-stage');
    const dots = el('guide-dots');
    const back = h('button', { class: 'btn', onclick: () => go(at - 1) }, 'Back');
    const next = h('button', { class: 'btn primary', onclick: () => (at === SLIDES.length - 1 ? close() : go(at + 1)) }, 'Next');
    const panel = h('div', { class: 'guide', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Feature guide' },
      h('button', { class: 'icon-btn guide-close', title: 'Close (Escape)', 'aria-label': 'Close the guide', onclick: () => close() }, icon('close', 16)),
      stage,
      h('div', { class: 'guide-foot' }, dots, h('div', { class: 'guide-nav' }, h('button', { class: 'btn guide-skip', onclick: () => close() }, 'Skip'), back, next)));
    const overlay = h('div', { class: 'overlay-bg guide-bg', onpointerdown: (e: Event) => { if (e.target === overlay) close(); } }, panel);
    SLIDES.forEach((s, i) => dots.append(h('button', { class: 'guide-dot', title: s.title, 'aria-label': `${i + 1}: ${s.title}`, onclick: () => go(i) })));

    function go(i: number) {
      at = Math.max(0, Math.min(SLIDES.length - 1, i));
      const s = SLIDES[at];
      stage.replaceChildren(el('guide-slide',
        el('guide-visual', s.art()),
        el('guide-text',
          h('div', { class: 'guide-step' }, `${at + 1} of ${SLIDES.length}`, s.isNew ? h('span', { class: 'guide-new' }, 'New') : null),
          h('h2', null, s.title),
          h('p', { class: 'guide-lead' }, s.lead),
          h('ul', null, ...s.points.map(p => h('li', null, p))),
          s.keys ? el('guide-keys', ...s.keys.map(k => h('span', { class: 'guide-key' }, ...k.split('+').flatMap((part, j) => [j ? '+' : null, h('kbd', null, part)]).filter(Boolean) as Node[]))) : null)));
      dots.querySelectorAll('.guide-dot').forEach((d, j) => d.classList.toggle('on', j === at));
      back.disabled = at === 0;
      next.textContent = at === SLIDES.length - 1 ? 'Start using PDFy' : 'Next';
      next.focus();
    }
    const key = (e: KeyboardEvent) => {
      if (overlay !== [...document.querySelectorAll('.overlay-bg')].pop()) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(at + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(at - 1); }
    };
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', key, true);
      showing = false;
      resolve();
    }
    document.addEventListener('keydown', key, true);
    document.body.append(overlay);
    go(at);
  });
}

/** The first start, or the first start after an update that changed the guide: show it once. */
export async function maybeShowGuide() {
  const automated = navigator.webdriver || /Headless/i.test(navigator.userAgent) || new URLSearchParams(location.search).has('test');
  if (automated || getSettings().guideSeen === GUIDE_VERSION) return;
  // Wait for anything already asking a question, such as recovering unsaved work.
  for (let i = 0; i < 600 && document.querySelector('.overlay-bg'); i++) await new Promise(r => setTimeout(r, 500));
  await showGuide();
}
