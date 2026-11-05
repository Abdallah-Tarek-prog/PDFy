import type { Palette } from './engine';

export interface ThemeStyle { id: string; name: string; light: Palette; dark: Palette }

export const THEME_STYLES: ThemeStyle[] = [
  {
    id: 'neutral', name: 'Neutral',
    light: { bg: '#ffffff', surface: '#f2f3f5', text: '#1f1f1f' },
    dark: { bg: '#121212', surface: '#1f1f1f', text: '#e6e6e6' },
  },
  {
    id: 'gemini', name: 'Gemini',
    light: { bg: '#ffffff', surface: '#f0f4f9', text: '#1f1f1f' },
    dark: { bg: '#131314', surface: '#1e1f20', text: '#e3e3e3' },
  },
  {
    id: 'chatgpt', name: 'ChatGPT',
    light: { bg: '#ffffff', surface: '#f4f4f4', text: '#0d0d0d' },
    dark: { bg: '#212121', surface: '#2f2f2f', text: '#ececec' },
  },
  {
    id: 'claude', name: 'Claude',
    light: { bg: '#faf9f5', surface: '#f0eee6', text: '#141413' },
    dark: { bg: '#262624', surface: '#30302e', text: '#faf9f5' },
  },
  {
    id: 'github', name: 'GitHub',
    light: { bg: '#ffffff', surface: '#f6f8fa', text: '#1f2328' },
    dark: { bg: '#0d1117', surface: '#161b22', text: '#e6edf3' },
  },
  {
    id: 'vscode', name: 'VS Code',
    light: { bg: '#ffffff', surface: '#f3f3f3', text: '#1f1f1f' },
    dark: { bg: '#1e1e1e', surface: '#252526', text: '#d4d4d4' },
  },
  {
    id: 'sepia', name: 'Sepia',
    light: { bg: '#f4ecd8', surface: '#ece2c8', text: '#3b2f23' },
    dark: { bg: '#2b2318', surface: '#3a3022', text: '#e8dcc0' },
  },
];

const CUSTOM_KEY = 'pdfy.customStyle';
const CUSTOM_DEFAULT: ThemeStyle = {
  id: 'custom', name: 'Custom…',
  light: { bg: '#ffffff', surface: '#eef2f7', text: '#1a1a1a' },
  dark: { bg: '#101418', surface: '#1b2128', text: '#e8eaed' },
};

export function customStyle(): ThemeStyle {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) return { ...CUSTOM_DEFAULT, ...JSON.parse(raw) };
  } catch { /* Storage may be off. */ }
  return CUSTOM_DEFAULT;
}

export function saveCustomStyle(light: Palette, dark: Palette) {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify({ light, dark })); } catch { /* Storage may be off. */ }
}

export const styleById = (id: string): ThemeStyle => (id === 'custom' ? customStyle() : THEME_STYLES.find(s => s.id === id) ?? THEME_STYLES[0]);
