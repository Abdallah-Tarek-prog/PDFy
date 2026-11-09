// Tiptap edits the common Markdown structures. These atoms preserve the existing note syntax
// (equations, wiki links, comments and literal HTML) without evaluating HTML or loading images.
import { Extension, Mark, Node, type MarkdownToken } from '@tiptap/core';
import { Lexer, Tokenizer } from 'marked';

const rawNode = (inline: boolean) => Node.create({
  name: inline ? 'noteRawInline' : 'noteRawBlock', group: inline ? 'inline' : 'block', inline, atom: true,
  addAttributes: () => ({ raw: { default: '' }, kind: { default: 'literal' } }),
  parseHTML: () => [],
  renderHTML({ node }) {
    const raw = String(node.attrs.raw), kind = String(node.attrs.kind);
    const label = kind === 'comment' ? 'Comment' : kind === 'wiki' ? raw.slice(2,-2).split('|').at(-1)! : raw;
    return [inline ? 'span' : 'pre', { class: `md-preserved md-preserved-${kind}`, title: raw, 'data-note-raw': raw, contenteditable: 'false' }, label];
  },
  renderMarkdown: node => String(node.attrs?.raw ?? ''),
});

const raw = (token: MarkdownToken, kind: string, block = false) => ({
  type: block ? 'noteRawBlock' : 'noteRawInline', attrs: { raw: token.raw ?? token.text ?? '', kind },
});

function syntax(name: string, kind: string, level: 'inline' | 'block', start: string, rule: RegExp) {
  return Extension.create({
    name, priority: 1100, markdownTokenName: name,
    markdownTokenizer: {
      name, level, start: source => source.indexOf(start),
      tokenize(source) { const match = rule.exec(source); if (match) return { type: name, raw: match[0] }; },
    },
    parseMarkdown: token => raw(token, kind, level === 'block'),
  });
}

export const NoteColor = Mark.create({
  name: 'noteColor', priority: 1100,
  addAttributes: () => ({ color: { default: '#1a56db' } }),
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => ['span', { class: 'md-color', style: `color:${/^#[0-9a-f]{6}$/i.test(HTMLAttributes.color) ? HTMLAttributes.color : '#1a56db'}` }, 0],
  markdownTokenizer: {
    name: 'noteColor', level: 'inline', start: source => source.indexOf('<span'),
    tokenize(source, _tokens, lexer) {
      const match = /^<span\s+style=["']color:\s*(#[0-9a-f]{6});?["']>([\s\S]*?)<\/span>/i.exec(source);
      if (match) return { type: 'noteColor', raw: match[0], color: match[1], tokens: lexer.inlineTokens(match[2]) };
    },
  },
  parseMarkdown: (token, helpers) => helpers.applyMark('noteColor', helpers.parseInline(token.tokens ?? []), { color: token.color }),
  renderMarkdown: (node, helpers) => `<span style="color:${node.attrs?.color ?? '#1a56db'}">${helpers.renderChildren(node)}</span>`,
});

// Use Marked's own HTML tokenization, but give the tokens safe literal node types before
// Tiptap's HTML parser sees them. Only our colour spans and underline syntax are formatting.
const colourSpan = /^<span\s+style=["']color:\s*(#[0-9a-f]{6});?["']>([\s\S]*?)<\/span>/i;
const underlineSpan = /^<u>[\s\S]*?<\/u>/i;
function literalHtml(block: boolean) {
  const name = block ? 'noteHtmlBlock' : 'noteHtmlInline';
  return Extension.create({
    name, priority: 1100, markdownTokenName: name,
    markdownTokenizer: {
      name, level: block ? 'block' : 'inline', start: source => block ? source.search(/(^|\n)(?=<)/m) : source.indexOf('<'),
      tokenize(source) {
        if (!source.startsWith('<')) return;
        if (!block && (colourSpan.test(source) || underlineSpan.test(source))) return;
        const tokenizer = new Tokenizer(); new Lexer({ gfm: true, tokenizer });
        const token = block ? tokenizer.html(source) : tokenizer.tag(source);
        if (token) return { type: name, raw: token.raw };
      },
    },
    parseMarkdown(token, helpers) {
      const text = String(token.raw ?? '').trim();
      const match = colourSpan.exec(text) ?? underlineSpan.exec(text);
      if (block && match?.[0] === text && helpers.tokenizeInline)
        return helpers.createNode('paragraph', undefined, helpers.parseInline(helpers.tokenizeInline(text)));
      return raw(token, 'literal', block);
    },
  });
}

export const preservedMarkdown = [
  rawNode(true), rawNode(false), NoteColor,
  syntax('noteMathBlock', 'math', 'block', '$$', /^\$\$\s*[\s\S]+?\s*\$\$[ \t]*(?:\n+|$)/),
  syntax('noteMathInline', 'math', 'inline', '$', /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/),
  syntax('noteWiki', 'wiki', 'inline', '[[', /^\[\[[^\]\n]+\]\]/),
  syntax('noteComment', 'comment', 'inline', '%%', /^%%[\s\S]*?%%/),
  literalHtml(true), literalHtml(false),
  Extension.create({ name: 'noteSafeImage', priority: 1100, markdownTokenName: 'image', parseMarkdown: token => raw(token, 'image') }),
];
