// Keyboard shortcuts. The defaults are Xodo's own, read from the Xodo app installed on this PC
// (version 6.3.4), so the same fingers work in both. Every one can be changed, and changed back.
//
// Keys are matched by their position on the keyboard, not the letter they type, so the shortcuts
// keep working with an Arabic keyboard layout switched on.

import { confirmDialog, openDialog } from './dialogs';
import { clear, h, icon, toast } from './dom';

export type ShortcutGroup = 'Navigating' | 'Annotating' | 'Study' | 'Other';

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  label: string;
  icon: string;
  keys: string[];
  /** Also works while typing in a box, like Ctrl+S. */
  global?: boolean;
  /** Shown in the list but handled by the page itself, such as scrolling. Cannot be changed. */
  fixed?: boolean;
  /** Not in Xodo. PDFy's own addition. */
  pdfy?: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  // Navigating, as in Xodo
  { id: 'next-tab', group: 'Navigating', label: 'Next document', icon: 'chevRight', keys: ['Ctrl+Tab'], global: true },
  { id: 'prev-tab', group: 'Navigating', label: 'Previous document', icon: 'chevLeft', keys: ['Ctrl+Shift+Tab'], global: true },
  { id: 'scroll-up', group: 'Navigating', label: 'Scroll up', icon: 'chevUp', keys: ['Up'], fixed: true },
  { id: 'scroll-down', group: 'Navigating', label: 'Scroll down', icon: 'chevDown', keys: ['Down'], fixed: true },
  { id: 'page-up', group: 'Navigating', label: 'Scroll one page up', icon: 'chevUp', keys: ['PageUp'], fixed: true },
  { id: 'page-down', group: 'Navigating', label: 'Scroll one page down', icon: 'chevDown', keys: ['PageDown'], fixed: true },
  { id: 'first-page', group: 'Navigating', label: 'Go to first page', icon: 'firstPage', keys: ['Home'] },
  { id: 'last-page', group: 'Navigating', label: 'Go to last page', icon: 'lastPage', keys: ['End'] },
  { id: 'zoom-in', group: 'Navigating', label: 'Zoom in (also Ctrl+mouse wheel)', icon: 'zoomIn', keys: ['Ctrl+Plus', 'Ctrl+Shift+Plus'], global: true },
  { id: 'zoom-out', group: 'Navigating', label: 'Zoom out (also Ctrl+mouse wheel)', icon: 'zoomOut', keys: ['Ctrl+Minus'], global: true },
  { id: 'fit-page', group: 'Navigating', label: 'Fit the whole page', icon: 'fitPage', keys: ['Ctrl+0'], global: true },
  { id: 'tab-n', group: 'Navigating', label: 'Go to document 1 to 9', icon: 'thumbs', keys: ['Ctrl+1-9'], global: true, fixed: true },
  { id: 'close-tab', group: 'Navigating', label: 'Close current document', icon: 'close', keys: ['Ctrl+W'], global: true },
  { id: 'escape', group: 'Navigating', label: 'Close the current menu or dialog', icon: 'close', keys: ['Escape'], fixed: true },
  // Annotating, as in Xodo
  { id: 'pan', group: 'Annotating', label: 'Pan', icon: 'hand', keys: ['P'] },
  { id: 'select', group: 'Annotating', label: 'Select text and objects', icon: 'cursor', keys: ['Escape'], fixed: true },
  { id: 'sticky', group: 'Annotating', label: 'Sticky note', icon: 'sticky', keys: ['C'] },
  { id: 'highlight', group: 'Annotating', label: 'Highlight', icon: 'highlight', keys: ['H'] },
  { id: 'underline', group: 'Annotating', label: 'Underline', icon: 'underline', keys: ['U'] },
  { id: 'strikeout', group: 'Annotating', label: 'Strikeout', icon: 'strike', keys: ['X'] },
  { id: 'squiggly', group: 'Annotating', label: 'Squiggly', icon: 'squiggly', keys: ['G'] },
  { id: 'stamper', group: 'Annotating', label: 'Stamper (an image)', icon: 'stamper', keys: ['K'] },
  { id: 'signature', group: 'Annotating', label: 'Signature', icon: 'signature', keys: ['S'] },
  { id: 'ink', group: 'Annotating', label: 'Ink (pen)', icon: 'pen', keys: ['I'] },
  { id: 'eraser', group: 'Annotating', label: 'Eraser', icon: 'eraser', keys: ['E'] },
  { id: 'marker', group: 'Annotating', label: 'Marker', icon: 'marker', keys: ['M'] },
  { id: 'textbox', group: 'Annotating', label: 'Text box', icon: 'text', keys: ['T'] },
  { id: 'square', group: 'Annotating', label: 'Square', icon: 'rect', keys: ['R'] },
  { id: 'oval', group: 'Annotating', label: 'Oval', icon: 'ellipse', keys: ['O'] },
  { id: 'line', group: 'Annotating', label: 'Line', icon: 'line', keys: ['L'] },
  { id: 'arrow', group: 'Annotating', label: 'Arrow', icon: 'arrow', keys: ['A'] },
  { id: 'multiselect', group: 'Annotating', label: 'Multi-select', icon: 'multiselect', keys: ['Ctrl+M'] },
  { id: 'lasso', group: 'Annotating', label: 'Lasso', icon: 'lasso', keys: ['Ctrl+L'] },
  { id: 'copy', group: 'Annotating', label: 'Copy', icon: 'copy', keys: ['Ctrl+C'], fixed: true },
  { id: 'paste', group: 'Annotating', label: 'Paste (pictures too)', icon: 'paste', keys: ['Ctrl+V'], fixed: true },
  { id: 'cut', group: 'Annotating', label: 'Cut', icon: 'cut', keys: ['Ctrl+X'] },
  { id: 'undo', group: 'Annotating', label: 'Undo', icon: 'undo', keys: ['Ctrl+Z'] },
  { id: 'redo', group: 'Annotating', label: 'Redo', icon: 'redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'] },
  { id: 'delete', group: 'Annotating', label: 'Delete selected object', icon: 'trash', keys: ['Delete', 'Backspace'], fixed: true },
  { id: 'duplicate', group: 'Annotating', label: 'Duplicate selected object', icon: 'copy', keys: ['Ctrl+D'], pdfy: true },
  // Study tools, PDFy's own
  { id: 'lookup', group: 'Study', label: 'Look up the selected word', icon: 'book', keys: ['D'], pdfy: true },
  { id: 'lookup-toggle', group: 'Study', label: 'Word lookup on or off', icon: 'book', keys: ['Ctrl+Shift+D'], pdfy: true },
  { id: 'markdown', group: 'Study', label: 'Markdown note', icon: 'markdown', keys: ['Ctrl+Shift+M'], pdfy: true },
  { id: 'equation', group: 'Study', label: 'Equation', icon: 'sigma', keys: ['Ctrl+Shift+E'], pdfy: true },
  { id: 'read-picture', group: 'Study', label: 'Read text from a picture', icon: 'ocr', keys: ['Ctrl+Shift+R'], pdfy: true },
  // Other, as in Xodo
  { id: 'open', group: 'Other', label: 'Open', icon: 'open', keys: ['Ctrl+O'], global: true },
  { id: 'new', group: 'Other', label: 'New document', icon: 'file', keys: ['Ctrl+N'], global: true, pdfy: true },
  { id: 'save', group: 'Other', label: 'Save', icon: 'save', keys: ['Ctrl+S'], global: true },
  { id: 'save-as', group: 'Other', label: 'Save as', icon: 'saveas', keys: ['Ctrl+Shift+S'], global: true },
  { id: 'fullscreen', group: 'Other', label: 'Full screen on (Escape turns it off)', icon: 'fullscreen', keys: ['F11'], global: true },
  { id: 'find', group: 'Other', label: 'Find', icon: 'search', keys: ['Ctrl+F'], global: true },
  { id: 'next-result', group: 'Other', label: 'Next search result', icon: 'chevDown', keys: ['F3'], global: true },
  { id: 'prev-result', group: 'Other', label: 'Previous search result', icon: 'chevUp', keys: ['Shift+F3'], global: true },
  { id: 'print', group: 'Other', label: 'Print', icon: 'print', keys: ['Ctrl+P'], global: true },
  { id: 'speech', group: 'Other', label: 'Read aloud', icon: 'speak', keys: ['Ctrl+R'], global: true },
  { id: 'edit-mode', group: 'Other', label: 'Edit tools on or off', icon: 'edit', keys: ['Ctrl+E'], global: true, pdfy: true },
  { id: 'actions', group: 'Other', label: 'Find any tool', icon: 'actions', keys: ['Ctrl+K'], global: true, pdfy: true },
  { id: 'help', group: 'Other', label: 'This list of shortcuts', icon: 'keyboard', keys: ['F1'], global: true, pdfy: true },
];

const KEY = 'pdfy.shortcuts';

function overrides(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string[]>; } catch { return {}; }
}
function saveOverrides(o: Record<string, string[]>) {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* Storage may be off. */ }
}

export function keysFor(id: string): string[] {
  const s = SHORTCUTS.find(x => x.id === id);
  if (!s) return [];
  return overrides()[id] ?? s.keys;
}

/** How a shortcut is written for people: "Ctrl+Plus" becomes "Ctrl++". */
export const pretty = (combo: string) => combo.replace('Plus', '+').replace('Minus', '−').replace(/^Up$/, '↑').replace(/^Down$/, '↓').replace(/^Left$/, '←').replace(/^Right$/, '→');
export const keyLabel = (id: string) => keysFor(id).map(pretty).join(', ');

const CODE_NAMES: Record<string, string> = {
  Equal: 'Plus', NumpadAdd: 'Plus', Minus: 'Minus', NumpadSubtract: 'Minus', Space: 'Space', Tab: 'Tab', Escape: 'Escape', Enter: 'Enter', NumpadEnter: 'Enter',
  Delete: 'Delete', Backspace: 'Backspace', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
};

/** The combination a key press makes, written the way the list writes it. Null for a lone modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  let k: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) k = e.code.slice(6);
  else if (/^F\d{1,2}$/.test(e.code)) k = e.code;
  else k = CODE_NAMES[e.code];
  if (!k) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  const mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  return [...mods, k].join('+');
}

/** Which shortcut a key press means, if any. */
export function match(e: KeyboardEvent): Shortcut | null {
  const combo = comboOf(e);
  if (!combo) return null;
  const o = overrides();
  return SHORTCUTS.find(s => !s.fixed && (o[s.id] ?? s.keys).includes(combo)) ?? null;
}

// ---- The list, where keys can be changed ----

const GROUP_TEXT: Record<ShortcutGroup, string> = {
  Navigating: 'Moving around documents and pages.',
  Annotating: 'Press a key to pick a tool, then draw on the page.',
  Study: 'PDFy’s study tools. Not in Xodo.',
  Other: 'Files, search, printing and more.',
};

export async function shortcutsDialog(): Promise<void> {
  const filter = h('input', { class: 'sc-filter', placeholder: 'Find a shortcut', 'aria-label': 'Find a shortcut', spellcheck: false });
  const list = h('div', { class: 'sc-list' });
  let capturing: { id: string; done(): void } | null = null;

  const draw = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const o = overrides();
    for (const group of ['Navigating', 'Annotating', 'Study', 'Other'] as ShortcutGroup[]) {
      const rows = SHORTCUTS.filter(s => s.group === group && (!q || s.label.toLowerCase().includes(q) || keysFor(s.id).join(' ').toLowerCase().includes(q)));
      if (!rows.length) continue;
      list.append(h('div', { class: 'sc-group' }, h('h3', null, group), h('p', { class: 'muted' }, GROUP_TEXT[group])));
      for (const s of rows) {
        const changed = !!o[s.id];
        const keys = keysFor(s.id);
        const chips = h('span', { class: 'sc-keys' }, ...(keys.length ? keys : ['—']).map(k => h('span', { class: 'sc-combo' }, ...(k === '—' ? [h('span', { class: 'muted' }, 'none')] : k.split('+').map((part, i) => [i ? h('span', { class: 'sc-plus' }, '+') : null, h('kbd', null, pretty(part))]).flat()))));
        const row = h('div', { class: `sc-row${changed ? ' changed' : ''}`, 'data-id': s.id },
          icon(s.icon, 18),
          h('span', { class: 'sc-label' }, s.label, s.pdfy ? h('span', { class: 'sc-tag' }, 'PDFy') : null),
          chips,
          s.fixed ? h('span', { class: 'sc-fixed', title: 'Built in, like in Xodo' }, 'Fixed') : h('span', { class: 'sc-actions' },
            h('button', { class: 'btn small', onclick: () => capture(s, row) }, 'Change'),
            changed ? h('button', { class: 'btn small', title: 'Back to Xodo’s key', onclick: () => {
              const x = overrides();
              delete x[s.id];
              for (const k of s.keys) for (const other of SHORTCUTS) if (other.id !== s.id && x[other.id]?.includes(k)) x[other.id] = x[other.id].filter(v => v !== k);
              saveOverrides(x);
              draw();
            } }, 'Reset') : null));
        list.append(row);
      }
    }
  };

  const capture = (s: Shortcut, row: HTMLElement) => {
    capturing?.done();
    row.classList.add('capturing');
    const hint = h('span', { class: 'sc-hint' }, 'Press the new keys. Escape cancels, Backspace removes the shortcut.');
    row.querySelector('.sc-keys')!.replaceChildren(hint);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { done(); draw(); return; }
      const combo = e.key === 'Backspace' && !e.ctrlKey && !e.shiftKey ? '' : comboOf(e);
      if (combo === null) return;
      const o = overrides();
      // A key can only mean one thing, so it is taken from wherever else it was used.
      if (/^Ctrl\+[1-9]$/.test(combo)) { toast(`${pretty(combo)} is built in for going to a document. Choose another.`, 'info'); return; }
      const clash = combo ? SHORTCUTS.find(x => x.id !== s.id && (o[x.id] ?? x.keys).includes(combo)) : undefined;
      if (clash?.fixed) { toast(`${pretty(combo)} is built in for “${clash.label}”. Choose another.`, 'info'); return; }
      if (clash) {
        o[clash.id] = (o[clash.id] ?? clash.keys).filter(k => k !== combo);
        toast(`${pretty(combo)} was “${clash.label}”. That one now has ${o[clash.id].length ? pretty(o[clash.id][0]) : 'no shortcut'}.`, 'info', 5000);
      }
      o[s.id] = combo ? [combo] : [];
      saveOverrides(o);
      done();
      draw();
    };
    // On the window, so it hears the keys before the dialog does (Escape and Enter would close it).
    const done = () => { window.removeEventListener('keydown', onKey, true); row.classList.remove('capturing'); capturing = null; };
    capturing = { id: s.id, done };
    window.addEventListener('keydown', onKey, true);
  };

  filter.addEventListener('input', draw);
  filter.addEventListener('keydown', e => e.stopPropagation());
  draw();
  const body = h('div', { class: 'sc-dialog' },
    h('p', { class: 'muted' }, 'These are Xodo’s keys, so your habits carry over. Click Change to choose your own.'),
    filter, list,
    h('div', { class: 'sc-foot' }, h('button', {
      class: 'btn small',
      onclick: async () => {
        capturing?.done();
        if (!await confirmDialog('Use Xodo’s keys again?', 'Every shortcut you changed goes back to Xodo’s.', 'Reset all')) return;
        saveOverrides({});
        draw();
      },
    }, 'Reset all to Xodo’s keys')));
  await openDialog('Keyboard shortcuts', body, [{ label: 'Close', value: true, primary: true }], true, undefined, true);
  (capturing as { done(): void } | null)?.done();
}
