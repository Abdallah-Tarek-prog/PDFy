// Ready-made sets of preferences: one click sets fonts, colours, note style, reading mode and lookup
// together. Each one can be changed, and your own can be saved beside them.

export interface PrefSet {
  id: string;
  name: string;
  about: string;
  builtIn?: boolean;
  textFont: string;
  textSize: number;
  textColor: string;
  highlight: string;
  highlightOpacity: number;
  underline: string;
  pen: string;
  penWidth: number;
  marker: string;
  mdTheme: string;
  reading: 'normal' | 'night' | 'sepia';
  uiTheme: 'light' | 'dark';
  lookup: boolean;
}

export const BUILT_IN_SETS: PrefSet[] = [
  {
    id: 'study', name: 'Study notes', about: 'Clear sans text, soft yellow highlights, blue pen. Word lookup is on.', builtIn: true,
    textFont: 'Segoe UI', textSize: 12, textColor: '#1f2328', highlight: '#ffe066', highlightOpacity: 0.55, underline: '#0b8a4f',
    pen: '#1a56db', penWidth: 1.75, marker: '#ffe066', mdTheme: 'obsidian-light', reading: 'normal', uiTheme: 'light', lookup: true,
  },
  {
    id: 'exam', name: 'Exam revision', about: 'Larger text, strong colours that stand out when you skim. Word lookup is on.', builtIn: true,
    textFont: 'Calibri', textSize: 13, textColor: '#a4161a', highlight: '#ffa8a8', highlightOpacity: 0.55, underline: '#d9480f',
    pen: '#d92d20', penWidth: 2, marker: '#ffc078', mdTheme: 'revision', reading: 'normal', uiTheme: 'light', lookup: true,
  },
  {
    id: 'report', name: 'Clean report', about: 'Serif text and quiet colours for documents other people will read. Word lookup is off.', builtIn: true,
    textFont: 'Georgia', textSize: 11, textColor: '#111111', highlight: '#fff2a8', highlightOpacity: 0.45, underline: '#343a40',
    pen: '#343a40', penWidth: 1.25, marker: '#e9ecef', mdTheme: 'academic', reading: 'normal', uiTheme: 'light', lookup: false,
  },
  {
    id: 'night', name: 'Night reading', about: 'Dark pages and interface, with colours that stay readable on them. Word lookup is on.', builtIn: true,
    textFont: 'Segoe UI', textSize: 12, textColor: '#d6deeb', highlight: '#7fdbca', highlightOpacity: 0.4, underline: '#82aaff',
    pen: '#82aaff', penWidth: 1.75, marker: '#3f5f4f', mdTheme: 'night-owl', reading: 'night', uiTheme: 'dark', lookup: true,
  },
  {
    id: 'arabic', name: 'Arabic notes', about: 'A font made for Arabic at a comfortable size, for notes written right to left. Word lookup is on.', builtIn: true,
    textFont: 'Sakkal Majalla', textSize: 16, textColor: '#1f2328', highlight: '#b2f2bb', highlightOpacity: 0.55, underline: '#0b8a4f',
    pen: '#0b8a4f', penWidth: 1.75, marker: '#b2f2bb', mdTheme: 'obsidian-light', reading: 'normal', uiTheme: 'light', lookup: true,
  },
];

const KEY = 'pdfy.prefSets';

export function customSets(): PrefSet[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as PrefSet[]; } catch { return []; }
}

export function saveCustomSets(list: PrefSet[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* Storage may be off. */ }
}

export const allSets = () => [...BUILT_IN_SETS, ...customSets()];
