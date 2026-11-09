// The Settings window. Each section changes something you can see straight away, and says plainly
// what it affects. Nothing here changes another section behind your back.

import { getSettings, saveSettings, DEFAULT_PEN, type PenSettings } from '../core/settings';
import { CLOSED_DAYS, clearClosed } from '../features/library';
import { updateControls } from '../features/updates';
import { allThemes } from '../study/mdthemes';
import { allSets, customSets, saveCustomSets } from '../study/prefsets';
import { OCR_LANGUAGES } from '../study/ui';
import type { App } from '../app';
import { colourButton } from './colorpicker';
import { confirmDialog, formDialog, openDialog } from './dialogs';
import { clear, h, icon, safe, toast } from './dom';
import {
  allUiThemes, applyUiTheme, contrast, currentUiTheme, deleteCustomUiTheme, deriveVars, saveCustomUiTheme, UI_THEMES, type CustomBase, type UiTheme,
} from './themes';

export type SettingsSection = 'appearance' | 'pen' | 'pages' | 'study' | 'setups' | 'general';

const SECTIONS: { id: SettingsSection; icon: string; name: string }[] = [
  { id: 'appearance', icon: 'palette', name: 'Appearance' },
  { id: 'pen', icon: 'tablet', name: 'Pen and tablet' },
  { id: 'pages', icon: 'grid', name: 'Pages and moving around' },
  { id: 'study', icon: 'book', name: 'Study tools' },
  { id: 'setups', icon: 'sparkle', name: 'Quick setups' },
  { id: 'general', icon: 'settings', name: 'General and help' },
];

/** A row with a label, a short explanation and its control. */
function setting(label: string, about: string, control: HTMLElement) {
  return h('div', { class: 'st-row' }, h('div', { class: 'st-text' }, h('div', { class: 'st-label' }, label), about ? h('div', { class: 'st-about' }, about) : null), h('div', { class: 'st-control' }, control));
}

function toggle(on: boolean, change: (v: boolean) => void, label: string) {
  const box = h('input', { type: 'checkbox', class: 'st-switch', checked: on, 'aria-label': label, role: 'switch' });
  box.addEventListener('change', () => change(box.checked));
  return box;
}

function choice<T extends string>(value: T, options: [T, string][], change: (v: T) => void, label: string) {
  const sel = h('select', { class: 'st-select', 'aria-label': label }, ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
  sel.addEventListener('change', () => change(sel.value as T));
  return sel;
}

/** Big clickable cards for a few clear choices, with a small picture each. */
function cards<T extends string>(value: T, options: { id: T; name: string; about?: string; art: HTMLElement | SVGElement }[], change: (v: T) => void) {
  const box = h('div', { class: 'st-cards', role: 'radiogroup' });
  for (const o of options) {
    const b = h('button', { class: `st-card${o.id === value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(o.id === value), onclick: () => {
      box.querySelectorAll('.st-card').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      change(o.id);
    } }, h('span', { class: 'st-card-art' }, o.art), h('span', { class: 'st-card-name' }, o.name), o.about ? h('span', { class: 'st-card-about' }, o.about) : null);
    box.append(b);
  }
  return box;
}

/** A small picture of the whole window in a theme's colours. */
function themeMini(t: UiTheme, live = false) {
  return h('span', { class: `theme-scope theme-mini${live ? ' live' : ''}`, 'data-ui-theme': t.id, 'aria-hidden': 'true' },
    h('span', { class: 'tm-title' }, h('span', { class: 'tm-dot' }), h('span', { class: 'tm-dot' }), h('span', { class: 'tm-dot' })),
    h('span', { class: 'tm-tools' }, ...Array.from({ length: 6 }, (_, i) => h('span', { class: `tm-tool${i === 2 ? ' on' : ''}` }))),
    h('span', { class: 'tm-body' },
      h('span', { class: 'tm-side' }, h('span', { class: 'tm-line' }), h('span', { class: 'tm-line short' }), h('span', { class: 'tm-line' })),
      h('span', { class: 'tm-canvas' }, h('span', { class: 'tm-page' }, h('span', { class: 'tm-text' }), h('span', { class: 'tm-text' }), h('span', { class: 'tm-text short' }), h('span', { class: 'tm-mark' })))));
}

export async function openSettings(app: App, start: SettingsSection = 'appearance') {
  let section = start;
  const nav = h('nav', { class: 'st-nav', 'aria-label': 'Settings sections' });
  const main = h('div', { class: 'st-main' });
  const draw = () => {
    clear(nav);
    for (const s of SECTIONS) nav.append(h('button', { class: `st-nav-item${s.id === section ? ' on' : ''}`, onclick: () => { section = s.id; draw(); } }, icon(s.icon, 17), h('span', null, s.name)));
    clear(main);
    const body = section === 'appearance' ? appearance(app, draw) : section === 'pen' ? penAndTablet(app, draw) : section === 'pages' ? pages(app)
      : section === 'study' ? study(app) : section === 'setups' ? setups(app, draw) : general(app);
    main.append(h('h2', { class: 'st-h' }, SECTIONS.find(s => s.id === section)!.name), body);
    main.scrollTop = 0;
  };
  draw();
  await openDialog('Settings', h('div', { class: 'settings' }, nav, main), [{ label: 'Done', value: true, primary: true }], true, () => {
    // Start at the top of the section, with the keyboard on its name rather than on a control further down.
    (nav.querySelector('.st-nav-item.on') as HTMLElement | null)?.focus();
    main.scrollTop = 0;
  }, true);
  app.refreshStudy();
}

// ---- Appearance ----

function appearance(app: App, redraw: () => void): HTMLElement {
  const now = currentUiTheme();
  const gallery = h('div', { class: 'st-themes' });
  const drawGallery = () => {
    clear(gallery);
    const current = currentUiTheme();
    for (const t of allUiThemes()) {
      const card = h('button', { class: `st-theme${t.id === current ? ' on' : ''}`, title: `Use ${t.name}`, onclick: () => { applyUiTheme(t.id); app.refreshStudy(); drawGallery(); } },
        themeMini(t), h('span', { class: 'st-theme-name' }, icon(t.dark ? 'moon' : 'sun', 13), t.name, t.id === current ? h('span', { class: 'st-badge' }, 'In use') : null));
      gallery.append(t.custom ? h('div', { class: 'st-theme-wrap' }, card,
        h('div', { class: 'st-theme-tools' },
          h('button', { class: 'btn small', onclick: () => { void themeEditor(app, t).then(() => redraw()); } }, 'Edit'),
          h('button', { class: 'btn small', onclick: safe(async () => { if (await confirmDialog(`Delete “${t.name}”?`, 'Your other themes stay.', 'Delete', true)) { deleteCustomUiTheme(t.id); app.refreshStudy(); redraw(); } }) }, 'Delete'))) : card);
    }
    gallery.append(h('button', { class: 'st-theme new', onclick: () => { void themeEditor(app).then(() => redraw()); } },
      h('span', { class: 'st-theme-plus' }, icon('plus', 22), h('span', null, 'Make your own')), h('span', { class: 'st-theme-name' }, 'Five colours, every shade worked out for you')));
  };
  drawGallery();
  void now;
  return h('div', { class: 'st-section' },
    h('p', { class: 'st-lead' }, 'The interface theme colours the window around your document: the title bar, toolbars, panels and menus. Click a theme to try it straight away.'),
    gallery,
    h('h3', { class: 'st-sub' }, 'Page colours'),
    setting('Page colours', 'Changes only how the pages look while reading, never the saved file and never the interface.',
      choice(app.reading, [['normal', 'Normal'], ['night', 'Night: dark pages'], ['sepia', 'Sepia: warm pages']], v => app.setReading(v), 'Page colours')));
}

/** Make or edit a theme from five colours, with a live picture of the window. */
async function themeEditor(app: App, editing?: UiTheme) {
  const startFrom = editing?.custom ?? { chrome: '#202325', surface: '#25292b', canvas: '#141718', text: '#ebeeeb', accent: '#9ac5ae' };
  const base: CustomBase = { ...startFrom };
  const name = h('input', { type: 'text', class: 'st-input', value: editing?.name ?? 'My theme', 'aria-label': 'Theme name' });
  const preview = h('div', { class: 'st-editor-preview' });
  const warn = h('p', { class: 'st-warn', role: 'status' });
  const paint = () => {
    const vars = deriveVars(base);
    const mini = themeMini({ id: 'editing', name: '', dark: false, swatch: [base.chrome, base.canvas, base.accent] }, true);
    for (const [k, v] of Object.entries(vars)) if (k.startsWith('--')) mini.style.setProperty(k, v);
    preview.replaceChildren(mini);
    const c = contrast(base.text, base.surface);
    warn.textContent = c < 4.5 ? `The text is hard to read on the panels (contrast ${c.toFixed(1)} to 1, aim for at least 4.5). Try a lighter or darker text colour.` : '';
  };
  const pick = (key: keyof CustomBase, label: string, about: string) => setting(label, about, colourButton(base[key], c => { base[key] = c; paint(); }, label));
  const startList = h('div', { class: 'st-starts' }, h('span', { class: 'muted' }, 'Start from:'), ...UI_THEMES.map(t => h('button', {
    class: 'st-start', title: `Start from ${t.name}`, style: { background: `linear-gradient(135deg, ${t.swatch[0]} 0 50%, ${t.swatch[2]} 50%)` }, 'aria-label': `Start from ${t.name}`,
    onclick: () => {
      const probe = h('div', { class: 'theme-scope', 'data-ui-theme': t.id, style: { display: 'none' } });
      document.body.append(probe);
      const cs = getComputedStyle(probe);
      const get = (v: string) => cs.getPropertyValue(v).trim();
      Object.assign(base, { chrome: get('--chrome'), surface: get('--surface'), canvas: get('--canvas-bg'), text: get('--text'), accent: get('--accent') });
      probe.remove();
      editorBody.replaceWith(editorBody = buildBody());
      paint();
    },
  })));
  const buildBody = () => h('div', { class: 'st-editor-fields' },
    setting('Name', '', name),
    pick('chrome', 'Title bar and toolbar', 'The strip at the top of the window'),
    pick('surface', 'Panels and menus', 'Side lists, dialogs and drop-downs'),
    pick('canvas', 'Behind the pages', 'The area around each page'),
    pick('text', 'Text', 'Words on panels and menus'),
    pick('accent', 'Accent', 'Chosen buttons, links and highlights'));
  let editorBody = buildBody();
  paint();
  const ok = await openDialog(editing ? `Edit “${editing.name}”` : 'Make your own theme',
    h('div', { class: 'st-editor' }, h('div', null, startList, editorBody, warn), preview),
    [{ label: 'Cancel', value: false }, { label: 'Save and use', value: true, primary: true }], false, undefined, true);
  if (!ok) return;
  const id = saveCustomUiTheme({ id: editing?.id, name: name.value, base });
  applyUiTheme(id);
  app.refreshStudy();
  toast(`“${name.value.trim() || 'My theme'}” is in use.`, 'ok');
}

// ---- Pen and tablet ----

function penAndTablet(app: App, redraw: () => void): HTMLElement {
  const pen = getSettings().pen;
  const set = (patch: Partial<PenSettings>) => { saveSettings({ pen: { ...getSettings().pen, ...patch } }); app.tools.syncCursor(); };
  const art = (inner: string) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 40 40'); s.setAttribute('width', '40'); s.setAttribute('height', '40'); s.innerHTML = inner; return s; };
  const page = '<rect x="2" y="2" width="36" height="36" rx="5" fill="#fff"/><path d="M8 26c5-8 9 4 14-4s7 2 10-3" fill="none" stroke="#1a56db" stroke-width="2" stroke-linecap="round"/>';
  const pad = penTestPad(app);
  return h('div', { class: 'st-section' },
    h('p', { class: 'st-lead' }, 'Settings for writing with a graphics tablet or a pen screen. Each pen colour also keeps its own thickness and opacity: set the yellow marker thick once, and it stays thick.'),
    h('h3', { class: 'st-sub' }, 'Pointer while drawing'),
    cards(pen.cursor, [
      { id: 'cross', name: 'Cross', about: 'Thin crosshair', art: art(`${page}<path d="M20 11v18M11 20h18" stroke="#111" stroke-width="1.4"/>`) },
      { id: 'dot', name: 'Dot', about: 'A small dot at the pen tip', art: art(`${page}<circle cx="20" cy="20" r="3" fill="#111" stroke="#fff" stroke-width="1.5"/>`) },
      { id: 'size', name: 'Pen size', about: 'A ring as wide as the stroke', art: art(`${page}<circle cx="20" cy="20" r="7" fill="none" stroke="#fff" stroke-width="3"/><circle cx="20" cy="20" r="7" fill="none" stroke="#111" stroke-width="1.2"/>`) },
      { id: 'arrow', name: 'Arrow', about: 'The normal pointer', art: art(`${page}<path d="M15 10v17l4.5-4.5 3 6.5 3-1.4-3-6.3h6z" fill="#111" stroke="#fff" stroke-width="1.2"/>`) },
      { id: 'none', name: 'Hidden', about: 'Only the ink shows', art: art(page) },
    ], v => set({ cursor: v })),
    h('h3', { class: 'st-sub' }, 'Pen and mouse'),
    setting('What can draw', 'With "Only the pen", the mouse and fingers move the page while a drawing tool is chosen, so you never draw by accident.',
      choice(pen.drawWith, [['any', 'Pen, mouse and fingers'], ['pen', 'Only the pen']], v => set({ drawWith: v }), 'What can draw')),
    setting('Pen side button, while held', 'Hold the button on the side of the pen and touch the page.',
      choice(pen.sideButton, [['eraser', 'Erase'], ['select', 'Select by dragging a box'], ['pan', 'Move the page'], ['menu', 'Right-click menu (Windows default)']], v => set({ sideButton: v }), 'Pen side button')),
    setting('Back of the pen erases', 'Turn the pen over to erase, as with a pencil, if your pen has an eraser end.', toggle(pen.tailErases, v => set({ tailErases: v }), 'Back of the pen erases')),
    setting('Write straight away in Read', 'Touching a page with the pen starts writing in Ink, even without choosing a tool. The mouse still selects text.', toggle(pen.autoInk, v => set({ autoInk: v }), 'Write straight away')),
    setting('Smoothing', 'How much shaky lines are evened out. Off keeps every detail. Hold Shift while writing for a straight line.',
      choice(pen.smoothing, [['off', 'Off'], ['light', 'Light'], ['strong', 'Strong']], v => set({ smoothing: v }), 'Smoothing')),
    h('h3', { class: 'st-sub' }, 'Try it here'),
    pad,
    h('div', { class: 'row-gap' }, h('button', { class: 'btn small', onclick: () => { saveSettings({ pen: DEFAULT_PEN }); app.tools.syncCursor(); redraw(); toast('Pen settings are back to how they started.', 'ok'); } }, 'Reset pen settings')));
}

/** A small pad that draws and says what Windows reports: pen, mouse or touch, and the pressure. */
function penTestPad(app: App): HTMLElement {
  const canvas = h('canvas', { class: 'st-pad', width: 520, height: 150 });
  const info = h('div', { class: 'st-pad-info' }, 'Draw here with your pen.');
  const ctx = canvas.getContext('2d')!;
  let last: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    last = { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
    report(e);
  });
  canvas.addEventListener('pointermove', e => {
    report(e);
    if (!last || !(e.buttons & 1)) return;
    const r = canvas.getBoundingClientRect();
    const p = { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
    const st = app.tools.style('pen');
    ctx.strokeStyle = st.color;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, st.width * 1.5);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  canvas.addEventListener('pointerup', () => { last = null; });
  function report(e: PointerEvent) {
    const what = e.pointerType === 'pen' ? 'a pen' : e.pointerType === 'touch' ? 'a finger' : 'a mouse';
    const tail = e.pointerType === 'pen' && (e.buttons & 32) ? ', eraser end' : e.pointerType === 'pen' && (e.buttons & 2) ? ', side button held' : '';
    info.textContent = `Windows reports ${what}${tail}${e.pointerType === 'pen' ? `, pressure ${Math.round(e.pressure * 100)}%` : ''}.`
      + (e.pointerType === 'mouse' ? ' If this is your tablet pen, its driver has Windows Ink turned off. Turn it on in the tablet’s own settings for pressure and the pen buttons, or keep "Pen, mouse and fingers" above.' : '');
  }
  return h('div', { class: 'st-pad-box' }, canvas, info,
    h('button', { class: 'btn small', onclick: () => ctx.clearRect(0, 0, canvas.width, canvas.height) }, 'Clear'));
}

// ---- Pages and moving around ----

function pages(app: App): HTMLElement {
  const s = getSettings();
  return h('div', { class: 'st-section' },
    setting('The Pages button opens', 'The page editor fills the window with large pages to tick, rotate, delete, insert and drag. The side list is narrow and stays beside the document.',
      choice(s.pagesView, [['editor', 'Full-screen page editor'], ['sidebar', 'Side list']], v => { saveSettings({ pagesView: v }); if (v === 'sidebar') app.pageEditor.close(); }, 'Pages button')),
    setting('Mouse wheel zooms', 'On: the wheel zooms where the pointer is, and Shift with the wheel scrolls. Off: the wheel scrolls, and Ctrl with the wheel zooms. A touchpad pinch always zooms.',
      toggle(s.wheelZooms, v => saveSettings({ wheelZooms: v }), 'Mouse wheel zooms')),
    setting('Reopen at the page I left', 'Documents open again where you stopped reading.', toggle(s.reopenAtLastPage, v => saveSettings({ reopenAtLastPage: v }), 'Reopen at the page I left')),
    h('div', { class: 'st-tips' },
      h('h3', { class: 'st-sub' }, 'Ways to move around'),
      h('ul', null,
        h('li', null, 'Click the mouse wheel, then move the pointer to scroll. Click the wheel again to stop. Hold Space and drag to pan.'),
        h('li', null, 'Pinch on the touchpad, or hold Ctrl and turn the wheel, to zoom right where the pointer is.'),
        h('li', null, 'On a touch screen, one finger moves the page and two fingers pinch to zoom.'),
        h('li', null, 'Two fingers on the touchpad scroll up, down and sideways.'))));
}

// ---- Study tools ----

function study(app: App): HTMLElement {
  const s = getSettings();
  return h('div', { class: 'st-section' },
    setting('Word lookup', 'Double-click a word, or select a few, to see its meaning, pronunciation and Arabic. Also on the Edit toolbar.',
      toggle(app.study.lookupOn, v => app.study.toggleLookup(v), 'Word lookup')),
    setting('Online dictionaries', 'When online, read the Cambridge, Oxford and Longman pages for the word, with their recordings.',
      toggle(s.onlineDict, v => saveSettings({ onlineDict: v }), 'Online dictionaries')),
    setting('Dictionary shown first', '', choice(s.dictTab, [['cambridge', 'Cambridge English–Arabic'], ['oxford', "Oxford Learner's"], ['longman', 'Longman'], ['quick', 'Quick (offline)']], v => saveSettings({ dictTab: v }), 'Dictionary shown first')),
    setting('Language in pictures', 'Used by Read picture and OCR.', choice(s.ocrLang, OCR_LANGUAGES.map(l => [l.value, l.label] as [string, string]), v => saveSettings({ ocrLang: v }), 'Language in pictures')),
    setting('Look of new Markdown notes', '', h('div', { class: 'row-gap' },
      choice(s.mdTheme, allThemes().map(t => [t.id, t.name] as [string, string]), v => saveSettings({ mdTheme: v }), 'Note look'),
      h('button', { class: 'btn small', onclick: safe(() => app.study.themesDialog(getSettings().mdTheme), 'Themes') }, 'Edit note themes…'))));
}

// ---- Quick setups ----

function setups(app: App, redraw: () => void): HTMLElement {
  const active = getSettings().prefSet;
  const grid = h('div', { class: 'set-grid' });
  for (const set of allSets()) {
    grid.append(h('div', { class: `set-card${set.id === active ? ' on' : ''}` },
      h('div', { class: 'set-swatches' }, ...[set.highlight, set.pen, set.textColor].map(c => h('span', { style: { background: c } }))),
      h('div', { class: 'set-name' }, set.name),
      h('div', { class: 'set-about' }, set.about),
      h('div', { class: 'set-changes' }, `Sets: text in ${set.textFont} ${set.textSize} pt, highlight, pen and marker colours, the note look, ${set.reading === 'normal' ? 'normal' : set.reading} page colours, and word lookup ${set.lookup ? 'on' : 'off'}.`),
      h('div', { class: 'set-actions' },
        h('button', { class: 'btn small', 'data-set': set.id, onclick: safe(async () => { await app.study.applySet(set); redraw(); }, 'Applying') }, set.id === active ? 'In use' : 'Use this'),
        set.builtIn ? null : h('button', { class: 'btn small', onclick: () => { saveCustomSets(customSets().filter(x => x.id !== set.id)); redraw(); } }, 'Remove'))));
  }
  return h('div', { class: 'st-section' },
    h('p', { class: 'st-lead' }, 'A quick setup changes several tool settings at once, for a kind of work. It never changes the interface theme.'),
    grid,
    h('button', {
      class: 'btn small', onclick: safe(async () => {
        const f = await formDialog('Save your current tools as a setup', [{ key: 'name', label: 'Name', type: 'text', placeholder: 'My revision setup' }], 'Save');
        const name = f ? String(f.name).trim() : '';
        if (!name) return;
        const set = app.study.currentAsSet(name);
        saveCustomSets([...customSets(), set]);
        saveSettings({ prefSet: set.id });
        redraw();
      }, 'Saving the setup'),
    }, 'Save my current tools as a setup'));
}

// ---- General and help ----

function general(app: App): HTMLElement {
  const s = getSettings();
  const author = h('input', { type: 'text', class: 'st-input', value: s.author, 'aria-label': 'Your name' });
  author.addEventListener('change', () => saveSettings({ author: author.value.trim() || 'Meletiq PDF user' }));
  return h('div', { class: 'st-section' },
    setting('Your name', 'Shown on comments and markups you add.', author),
    updateControls(),
    setting('Recently closed documents', `Kept for ${CLOSED_DAYS} days on the Home screen, then forgotten. Only a link to each file is kept, never a copy.`,
      h('button', { class: 'btn small', onclick: safe(async () => { await clearClosed(); toast('The recently closed list is empty.', 'ok'); }) }, 'Clear the list')),
    h('h3', { class: 'st-sub' }, 'Help'),
    setting('Feature guide', 'A short illustrated tour of what Meletiq PDF does that other PDF apps do not. It also opens by itself after each update.',
      h('button', { class: 'btn small', onclick: () => app.showGuide() }, 'Show the guide')),
    setting('Keyboard shortcuts', 'Xodo’s keys, plus Meletiq PDF’s own. Change any of them.', h('button', { class: 'btn small', onclick: () => app.showHelp() }, 'Show shortcuts')));
}
