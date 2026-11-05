// Markdown to formatted text, in the Obsidian style: highlights, callouts, task lists, tables,
// equations. Text comes from the user or from a saved file, so nothing in it is ever run as code.

import { Marked, type Tokens } from 'marked';
import { texToInline } from './math';

const esc = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const waitFor = (tex: string, display: boolean) => `<span class="math-wait" data-tex="${esc(tex)}" data-display="${display ? 1 : 0}"></span>`;

const KEYWORDS = /^(?:abstract|and|as|async|await|bool|break|case|catch|char|class|const|continue|def|default|del|delete|do|double|elif|else|enum|except|export|extends|false|final|finally|float|fn|for|from|func|function|if|implements|import|in|int|interface|is|lambda|let|long|match|mut|namespace|new|None|nil|not|null|or|package|pass|private|protected|public|raise|return|select|self|short|static|string|struct|super|switch|this|throw|true|True|False|try|type|typedef|undefined|union|unsigned|use|using|var|void|volatile|where|while|with|yield)$/;

/** A simple colouring that works for most languages. It only ever adds colour, never changes the text. */
function colourCode(code: string): string {
  const parts = code.split(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d[\d_.xXa-fA-F]*\b|\b[A-Za-z_]\w*\b)/);
  return parts.map((p, i) => {
    if (i % 2 === 0 || !p) return esc(p);
    if (p.startsWith('//') || p.startsWith('/*') || p.startsWith('#')) return `<span class="tk-c">${esc(p)}</span>`;
    if (/^["'`]/.test(p)) return `<span class="tk-s">${esc(p)}</span>`;
    if (/^\d/.test(p)) return `<span class="tk-n">${esc(p)}</span>`;
    return KEYWORDS.test(p) ? `<span class="tk-k">${esc(p)}</span>` : esc(p);
  }).join('');
}

const md = new Marked({ gfm: true, breaks: true });

md.use({
  extensions: [
    {
      name: 'mathBlock', level: 'block',
      start: (src: string) => { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer(src: string) {
        const m = /^\$\$\s*([\s\S]+?)\s*\$\$[ \t]*(?:\n+|$)/.exec(src);
        return m ? { type: 'mathBlock', raw: m[0], tex: m[1] } : undefined;
      },
      renderer: (t: Tokens.Generic) => `<div class="md-math-block">${waitFor(t.tex as string, true)}</div>`,
    },
    {
      name: 'mathInline', level: 'inline',
      start: (src: string) => { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer(src: string) {
        const big = /^\$\$([^$]+?)\$\$/.exec(src);
        if (big) return { type: 'mathInline', raw: big[0], tex: big[1], big: true };
        // "$5 and $6" must stay money: no space just inside the signs, no digit right after.
        const m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src);
        return m ? { type: 'mathInline', raw: m[0], tex: m[1] } : undefined;
      },
      renderer: (t: Tokens.Generic) => waitFor(t.tex as string, !!t.big),
    },
    {
      name: 'mark', level: 'inline',
      start: (src: string) => { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer(this: { lexer: { inlineTokens(s: string): Tokens.Generic[] } }, src: string) {
        const m = /^==(?=\S)([^\n]*?\S)==/.exec(src);
        return m ? { type: 'mark', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
      },
      renderer(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Generic) { return `<mark>${this.parser.parseInline(t.tokens as Tokens.Generic[])}</mark>`; },
    },
    {
      name: 'wikiLink', level: 'inline',
      start: (src: string) => { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
      tokenizer(src: string) {
        const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
        return m ? { type: 'wikiLink', raw: m[0], text: m[2] ?? m[1] } : undefined;
      },
      renderer: (t: Tokens.Generic) => `<span class="md-wiki">${esc(t.text as string)}</span>`,
    },
    {
      name: 'hiddenComment', level: 'inline',
      start: (src: string) => { const i = src.indexOf('%%'); return i < 0 ? undefined : i; },
      tokenizer(src: string) {
        const m = /^%%[\s\S]*?%%/.exec(src);
        return m ? { type: 'hiddenComment', raw: m[0] } : undefined;
      },
      renderer: () => '',
    },
  ],
  renderer: {
    // Raw HTML is shown as the words typed, never used.
    html: (t: Tokens.HTML | Tokens.Tag) => esc(t.text),
    // A picture from a web address would quietly reach out to the internet, so it stays a label.
    image: (t: Tokens.Image) => `<em>[image: ${esc(t.text || t.href)}]</em>`,
    link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Link) {
      const safe = /^(https?:|mailto:)/i.test(t.href) ? t.href : '';
      const text = this.parser.parseInline(t.tokens);
      return safe ? `<a href="${esc(safe)}">${text}</a>` : text;
    },
    code: (t: Tokens.Code) => `<pre><code>${colourCode(t.text)}</code></pre>`,
    checkbox: (t: Tokens.Checkbox) => `<span class="md-check${t.checked ? ' on' : ''}">✓</span>`,
    listitem(this: { parser: { parse(t: Tokens.Generic[], loose?: boolean): string } }, item: Tokens.ListItem) {
      const body = this.parser.parse(item.tokens, !!item.loose);
      if (!item.task) return `<li>${body}</li>`;
      return `<li class="md-task${item.checked ? ' md-task-done' : ''}">${body}</li>`;
    },
    blockquote(this: { parser: { parse(t: Tokens.Generic[]): string } }, t: Tokens.Blockquote) {
      const body = this.parser.parse(t.tokens);
      const m = /^\s*<p>\[!([a-zA-Z]+)\][+-]? ?([^\n<]*)(?:<br\s*\/?>\s*|\n)?/.exec(body);
      if (!m) return `<blockquote>${body}</blockquote>`;
      const type = m[1].toLowerCase();
      const title = m[2].trim() || type[0].toUpperCase() + type.slice(1);
      const rest = `<p>${body.slice(m[0].length)}`.replace(/^<p>\s*<\/p>\s*/, '');
      return `<div class="md-callout c-${esc(type)}"><div class="md-callout-title">${title}</div>${rest}</div>`;
    },
  },
});

const ALLOWED = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
const ATTRS: Record<string, string[]> = { '*': ['class', 'dir'], A: ['href'], OL: ['start'], TD: ['align'], TH: ['align'], SPAN: ['class', 'data-tex', 'data-display'] };

/** A second safety net behind the renderer: anything not on the list is removed. */
function clean(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (root: ParentNode) => {
    for (const el of [...root.children]) {
      if (!ALLOWED.has(el.tagName)) { el.replaceWith(document.createTextNode(el.textContent ?? '')); continue; }
      for (const at of [...el.attributes]) {
        if (!ATTRS['*'].includes(at.name) && !(ATTRS[el.tagName] ?? []).includes(at.name)) el.removeAttribute(at.name);
      }
      if (el.tagName === 'A' && !/^(https?:|mailto:)/i.test(el.getAttribute('href') ?? '')) el.removeAttribute('href');
      walk(el);
    }
  };
  walk(tpl.content);
  return tpl.content;
}

/** Fills a box with formatted notes. Equations show a moment later, once their engine has loaded. */
export function renderMarkdownInto(el: HTMLElement, text: string): Promise<void> {
  const html = md.parse(text, { async: false }) as string;
  el.replaceChildren(clean(html));
  el.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th').forEach(n => n.setAttribute('dir', 'auto'));
  return typesetIn(el);
}

async function typesetIn(el: HTMLElement) {
  const waiting = [...el.querySelectorAll<HTMLElement>('.math-wait')];
  if (!waiting.length) return;
  await Promise.all(waiting.map(async n => {
    const tex = n.dataset.tex ?? '';
    try {
      const svg = await texToInline(tex, n.dataset.display === '1');
      n.outerHTML = svg;
    } catch (err) {
      n.className = 'md-math-error';
      n.textContent = `$${tex}$  (${(err as Error).message})`;
    }
  }));
}

/** The finished formatted text as one string, for saving. */
export async function markdownToHtml(text: string): Promise<string> {
  const host = document.createElement('div');
  await renderMarkdownInto(host, text);
  return host.innerHTML;
}

/** Saved into the file's comment field, so the box can still be edited after reopening. */
const MARK = /\n*<!-- pdfy:(\{.*\}) -->\s*$/;

export function withMarker(text: string, data: Record<string, unknown>): string {
  return `${text}\n\n<!-- pdfy:${JSON.stringify(data)} -->`;
}

export function readMarker(contents: string | undefined | null): { text: string; data: Record<string, unknown> } | null {
  if (!contents) return null;
  const m = MARK.exec(contents);
  if (!m) return null;
  try { return { text: contents.slice(0, m.index), data: JSON.parse(m[1]) as Record<string, unknown> }; } catch { return null; }
}
