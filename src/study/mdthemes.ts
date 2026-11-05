// How Markdown boxes look. A theme is a set of plain settings, so every one can be changed and saved.

export interface MdTheme {
  id: string;
  name: string;
  builtIn?: boolean;
  font: string;
  headingFont: string;
  monoFont: string;
  size: number;
  lineHeight: number;
  headingWeight: number;
  text: string;
  heading: string;
  strong: string;
  accent: string;
  link: string;
  markBg: string;
  markFg: string;
  codeBg: string;
  codeFg: string;
  quoteBar: string;
  quoteText: string;
  border: string;
  /** Colour of the card behind the note. Off means the page shows through. */
  background: string;
  showBackground: boolean;
  padding: number;
  radius: number;
}

const SANS = 'Segoe UI', SERIF = 'Georgia', MONO = 'Consolas';

const dark = (id: string, name: string, p: Partial<MdTheme>): MdTheme => ({
  id, name, builtIn: true, font: SANS, headingFont: SANS, monoFont: MONO, size: 12, lineHeight: 1.5, headingWeight: 650,
  text: '#dcddde', heading: '#f1f1f3', strong: '#ffffff', accent: '#8a6cf0', link: '#a78bfa',
  markBg: '#6b5a15', markFg: '#fff6c9', codeBg: '#2a2a31', codeFg: '#e6c07b', quoteBar: '#8a6cf0', quoteText: '#b4b6ba',
  border: '#44454d', background: '#1e1e22', showBackground: true, padding: 10, radius: 6, ...p,
});
const light = (id: string, name: string, p: Partial<MdTheme>): MdTheme => ({
  id, name, builtIn: true, font: SANS, headingFont: SANS, monoFont: MONO, size: 12, lineHeight: 1.5, headingWeight: 650,
  text: '#2e3338', heading: '#16181c', strong: '#111317', accent: '#6d4fd8', link: '#5a3fc4',
  markBg: '#fff2a8', markFg: '#2e2a12', codeBg: '#f1f1f4', codeFg: '#b0345a', quoteBar: '#6d4fd8', quoteText: '#5c6168',
  border: '#d5d6db', background: '#ffffff', showBackground: false, padding: 8, radius: 6, ...p,
});

/** "Obsidian" and "GitHub" here mean a look in that spirit. The colours were chosen by eye, not copied. */
export const BUILT_IN_THEMES: MdTheme[] = [
  light('obsidian-light', 'Obsidian light', {}),
  dark('obsidian-dark', 'Obsidian dark', {}),
  light('github-light', 'GitHub light', {
    text: '#1f2328', heading: '#1f2328', accent: '#0969da', link: '#0969da', quoteBar: '#d0d7de', quoteText: '#59636e',
    codeBg: '#eff1f3', codeFg: '#1f2328', border: '#d0d7de', headingWeight: 600,
  }),
  dark('github-dark', 'GitHub dark', {
    text: '#e6edf3', heading: '#e6edf3', accent: '#4493f8', link: '#4493f8', quoteBar: '#3d444d', quoteText: '#9198a1',
    codeBg: '#262c36', codeFg: '#e6edf3', border: '#3d444d', background: '#0d1117', headingWeight: 600,
  }),
  light('academic', 'Academic serif', {
    font: SERIF, headingFont: SERIF, size: 12, lineHeight: 1.55, headingWeight: 700,
    text: '#1a1a1a', heading: '#0d0d0d', accent: '#7a1f2b', link: '#7a1f2b', quoteBar: '#b9a9a2', quoteText: '#4a4a4a',
    codeBg: '#f3f1ec', codeFg: '#3b3b3b', markBg: '#f6e7b4', border: '#c9c5bd',
  }),
  light('sepia', 'Sepia notes', {
    font: SERIF, headingFont: SANS, text: '#43372a', heading: '#2f2519', strong: '#2a2015', accent: '#a85a1b', link: '#9a4f12',
    markBg: '#f1d78a', markFg: '#3a2c12', codeBg: '#ebdfc8', codeFg: '#7c3b12', quoteBar: '#c49a6c', quoteText: '#6a5843',
    border: '#d3c2a4', background: '#f7efdf', showBackground: true, padding: 10,
  }),
  light('revision', 'Exam revision', {
    size: 12, lineHeight: 1.42, headingWeight: 700, heading: '#a4161a', strong: '#a4161a', accent: '#d9480f', link: '#1864ab',
    markBg: '#ffe066', quoteBar: '#d9480f', codeFg: '#1864ab', background: '#fffdf5', showBackground: true, padding: 10,
  }),
  dark('night-owl', 'Night reading', {
    text: '#d6deeb', heading: '#ffffff', strong: '#ffffff', accent: '#7fdbca', link: '#82aaff', markBg: '#3f5f4f', markFg: '#eafff3',
    codeBg: '#01111d', codeFg: '#ecc48d', quoteBar: '#7fdbca', quoteText: '#a2b4c8', border: '#2b3f55', background: '#011627',
  }),
];

const KEY = 'pdfy.mdThemes';

export function customThemes(): MdTheme[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as MdTheme[]; } catch { return []; }
}

export function saveCustomThemes(list: MdTheme[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* Storage may be off. */ }
}

export const allThemes = (): MdTheme[] => [...BUILT_IN_THEMES, ...customThemes()];

export function themeById(id?: string): MdTheme {
  return allThemes().find(t => t.id === id) ?? BUILT_IN_THEMES[0];
}

const quote = (name: string) => `'${String(name).replace(/[^\p{L}\p{N} ._&+-]/gu, '').trim().slice(0, 80)}'`;
const colour = (c: string, fallback: string) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : fallback);
const number = (n: number, lo: number, hi: number, fallback: number) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, +n)) : fallback);
const stack = (name: string, tail: string) => `${quote(name)}, ${tail}`;

/** The theme as inline settings on one box, so each box can have its own without extra rules. */
export function themeVars(t: MdTheme, fontSize?: number): string {
  const vars: [string, string][] = [
    ['--md-font', stack(t.font, "'Segoe UI', Tahoma, sans-serif")],
    ['--md-hfont', stack(t.headingFont, "'Segoe UI', Tahoma, sans-serif")],
    ['--md-mono', stack(t.monoFont, "Consolas, 'Courier New', monospace")],
    ['--md-lh', String(number(t.lineHeight, 0.8, 4, 1.5))],
    ['--md-hweight', String(number(t.headingWeight, 100, 900, 650))],
    ['--md-text', colour(t.text, '#222222')], ['--md-heading', colour(t.heading, '#111111')], ['--md-strong', colour(t.strong, '#111111')],
    ['--md-accent', colour(t.accent, '#6d4fd8')], ['--md-link', colour(t.link, '#5a3fc4')],
    ['--md-mark-bg', colour(t.markBg, '#fff2a8')], ['--md-mark-fg', colour(t.markFg, '#222222')], ['--md-code-bg', colour(t.codeBg, '#f1f1f4')], ['--md-code-fg', colour(t.codeFg, '#b0345a')],
    ['--md-quote-bar', colour(t.quoteBar, '#6d4fd8')], ['--md-quote-fg', colour(t.quoteText, '#5c6168')], ['--md-border', colour(t.border, '#d5d6db')],
    ['--md-bg', t.showBackground ? colour(t.background, '#ffffff') : 'transparent'], ['--md-solid', colour(t.background, '#ffffff')],
    ['--md-pad', `${number(t.padding, 0, 80, 8)}px`], ['--md-radius', t.showBackground ? `${number(t.radius, 0, 60, 6)}px` : '0'],
  ];
  return `${vars.map(([k, v]) => `${k}:${v}`).join(';')};font-size:${number(fontSize ?? t.size, 2, 200, 12)}px`;
}

/** Used on screen and in the saved file, so the two look the same. */
export const RICH_CSS = `
.md-box{box-sizing:border-box;width:100%;min-height:100%;padding:var(--md-pad);color:var(--md-text);background:var(--md-bg);border-radius:var(--md-radius);font-family:var(--md-font);line-height:var(--md-lh);overflow-wrap:anywhere;text-rendering:geometricPrecision;-webkit-print-color-adjust:exact;print-color-adjust:exact;user-select:none}
.md-box>:first-child{margin-top:0}.md-box>:last-child{margin-bottom:0}
.md-box p{margin:0 0 .7em}
.md-box h1,.md-box h2,.md-box h3,.md-box h4,.md-box h5,.md-box h6{font-family:var(--md-hfont);color:var(--md-heading);font-weight:var(--md-hweight);line-height:1.25;margin:1em 0 .42em}
.md-box h1{font-size:1.72em}.md-box h2{font-size:1.42em}.md-box h3{font-size:1.2em}.md-box h4{font-size:1.06em}.md-box h5{font-size:1em}.md-box h6{font-size:.92em;opacity:.8}
.md-box strong{font-weight:700;color:var(--md-strong)}.md-box em{font-style:italic}.md-box del{opacity:.65}
.md-box mark{background:var(--md-mark-bg);color:var(--md-mark-fg);padding:.04em .2em;border-radius:.2em}
.md-box a,.md-box .md-wiki{color:var(--md-link);text-decoration:underline;text-underline-offset:.14em}
.md-box code{font-family:var(--md-mono);font-size:.88em;background:var(--md-code-bg);color:var(--md-code-fg);padding:.1em .32em;border-radius:.25em}
.md-box pre{direction:ltr;text-align:left;background:var(--md-code-bg);padding:.68em .85em;border-radius:.42em;margin:0 0 .8em;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.38}
.md-box pre code{background:none;padding:0;font-size:.86em;color:var(--md-code-fg)}
.md-box blockquote{margin:0 0 .8em;padding-block:.08em;padding-inline:.85em 0;border-inline-start:.22em solid var(--md-quote-bar);color:var(--md-quote-fg)}
.md-box blockquote p:last-child{margin-bottom:0}
.md-box ul,.md-box ol{margin:0 0 .7em;padding-inline-start:1.45em}.md-box li{margin:.14em 0}.md-box li>p{margin:0}.md-box li>ul,.md-box li>ol{margin-bottom:.1em}
.md-box li.md-task{list-style:none;margin-inline-start:-1.3em}
.md-box .md-check{display:inline-block;box-sizing:border-box;width:.95em;height:.95em;border:.09em solid var(--md-accent);border-radius:.2em;vertical-align:-.12em;margin-inline-end:.42em;text-align:center;font-size:.92em;line-height:.76em;color:transparent}
.md-box .md-check.on{background:var(--md-accent);color:var(--md-solid);font-weight:700}
.md-box li.md-task-done{color:var(--md-quote-fg)}
.md-box hr{border:0;border-top:.08em solid var(--md-border);margin:1em 0}
.md-box table{border-collapse:collapse;margin:0 0 .8em;width:100%;font-size:.95em}
.md-box th,.md-box td{border:.06em solid var(--md-border);padding:.28em .55em;text-align:start;vertical-align:top}
.md-box th{background:var(--md-code-bg);font-weight:650}
.md-box .md-callout{--c:var(--md-accent);margin:0 0 .8em;padding:.5em .8em;border-radius:.42em;border:0;border-inline-start:.24em solid var(--c);background:color-mix(in srgb,var(--c) 11%,transparent);color:inherit}
.md-box .md-callout-title{font-weight:700;color:var(--c);margin-bottom:.22em}
.md-box .c-note,.md-box .c-info{--c:#3b82c4}.md-box .c-tip,.md-box .c-hint,.md-box .c-important{--c:#14a085}.md-box .c-success,.md-box .c-check,.md-box .c-done{--c:#2f9e44}
.md-box .c-question,.md-box .c-help,.md-box .c-faq{--c:#d9820f}.md-box .c-warning,.md-box .c-caution,.md-box .c-attention{--c:#e8590c}
.md-box .c-danger,.md-box .c-error,.md-box .c-failure,.md-box .c-bug{--c:#e03131}.md-box .c-example{--c:#7c5ce0}.md-box .c-quote,.md-box .c-cite{--c:#868e96}
.md-box .md-math-block{margin:.55em 0;text-align:center;direction:ltr}
.md-box .md-math-block svg{max-width:100%}
.md-box .md-math-error{color:#e03131;font-family:var(--md-mono);font-size:.85em}
.md-box .tk-k{color:var(--md-accent);font-weight:600}.md-box .tk-s{color:#2f9e44}.md-box .tk-n{color:#d9820f}.md-box .tk-c{opacity:.62;font-style:italic}
.annot-text{box-sizing:border-box;width:100%;height:100%;padding:4px;line-height:1.2;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden}
.math-box{width:100%;height:100%;display:block}.math-box svg{display:block;width:100%;height:100%}
`;

let added = false;
export function ensureRichCss() {
  if (added) return;
  added = true;
  document.head.append(Object.assign(document.createElement('style'), { textContent: RICH_CSS }));
}
