// Turns LaTeX into vector drawings. The engine is about 2 MB, so it loads the first time an equation
// is needed, not when the app starts.

/* eslint-disable @typescript-eslint/no-explicit-any */

let loading: Promise<any> | null = null;

function loadEngine(): Promise<any> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    (window as any).MathJax = {
      // No fonts on disk and no shared parts: every equation is a self-contained drawing.
      svg: { fontCache: 'none', scale: 1 },
      tex: {
        packages: { '[+]': ['ams', 'newcommand', 'boldsymbol', 'mathtools', 'cancel', 'color', 'mhchem', 'physics', 'braket', 'unicode'] },
        // A typing mistake becomes a message beside the box, not red text on the page.
        formatError: (_jax: unknown, err: Error) => { throw err; },
      },
      options: { enableMenu: false, enableAssistiveMml: false, renderActions: { addMenu: [] } },
      startup: {
        typeset: false,
        ready() {
          const mj = (window as any).MathJax;
          mj.startup.defaultReady();
          mj.startup.promise.then(() => resolve(mj), reject);
        },
      },
    };
    const tag = document.createElement('script');
    tag.src = new URL('vendor/math/tex-svg-full.js', document.baseURI).href;
    tag.async = true;
    tag.onerror = () => { loading = null; reject(new Error('The equation engine could not be loaded.')); };
    document.head.append(tag);
  });
  return loading;
}

/** LaTeX can ask for links (\\href) and other extras. None of that is kept. */
function cleanSvg(svg: SVGElement): SVGElement {
  for (const a of [...svg.querySelectorAll('a')]) a.replaceWith(...a.childNodes);
  const nudge = /vertical-align:\s*(-?[\d.]+)ex/.exec(svg.getAttribute('style') ?? '');
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const at of [...el.attributes]) {
      if (/^on/i.test(at.name) || /href$/i.test(at.name) || at.name === 'style') el.removeAttribute(at.name);
    }
  }
  if (nudge) svg.setAttribute('style', `vertical-align:${parseFloat(nudge[1])}ex`);
  for (const bad of [...svg.querySelectorAll('script, foreignObject, image, use')]) bad.remove();
  return svg;
}

export interface MathResult {
  /** The drawing, ready to place. */
  svg: string;
  /** Natural size at font size 1, in the same units as the font size. */
  width: number;
  height: number;
}

/** Throws with a readable message if the LaTeX is wrong. */
export async function texToSvg(tex: string, display = true): Promise<MathResult> {
  const mj = await loadEngine();
  const node: HTMLElement = await mj.tex2svgPromise(tex, { display });
  const found = node.querySelector('svg');
  if (!found) throw new Error('This could not be drawn.');
  const svg = cleanSvg(found);
  if (svg.querySelector('[data-mjx-error], merror')) {
    throw new Error(svg.querySelector('title')?.textContent ?? 'This could not be read as LaTeX.');
  }
  const box = (svg.getAttribute('viewBox') ?? '0 0 1000 1000').split(/\s+/).map(Number);
  svg.removeAttribute('style');
  svg.removeAttribute('role');
  svg.removeAttribute('focusable');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return { svg: svg.outerHTML, width: box[2] / 1000, height: box[3] / 1000 };
}

/** The same drawing, for inline use in a sentence, where it sizes itself to the surrounding text. */
export async function texToInline(tex: string, display: boolean): Promise<string> {
  const mj = await loadEngine();
  const node: HTMLElement = await mj.tex2svgPromise(tex, { display });
  const svg = node.querySelector('svg');
  if (!svg) throw new Error('This could not be drawn.');
  return cleanSvg(svg).outerHTML;
}

/** Size an equation box should have, in points. */
export function mathBoxSize(r: MathResult, fontSize: number): { w: number; h: number } {
  return { w: Math.max(6, r.width * fontSize), h: Math.max(6, r.height * fontSize) };
}

const GREEK: Record<string, number> = {
  alpha: 0x3b1, beta: 0x3b2, gamma: 0x3b3, delta: 0x3b4, epsilon: 0x3b5, theta: 0x3b8, lambda: 0x3bb, mu: 0x3bc, pi: 0x3c0,
  rho: 0x3c1, sigma: 0x3c3, tau: 0x3c4, phi: 0x3c6, chi: 0x3c7, psi: 0x3c8, omega: 0x3c9, Delta: 0x394, Sigma: 0x3a3, Omega: 0x3a9,
};

export interface MathSnippet { label: string; tex: string; title: string }

/** Common building blocks, for people who do not remember the LaTeX. */
export const MATH_GROUPS: { name: string; items: MathSnippet[] }[] = [
  {
    name: 'Structures',
    items: [
      { label: 'a/b', title: 'Fraction', tex: '\\frac{a}{b}' },
      { label: 'xⁿ', title: 'Power', tex: 'x^{n}' },
      { label: 'xₙ', title: 'Subscript', tex: 'x_{n}' },
      { label: '√x', title: 'Square root', tex: '\\sqrt{x}' },
      { label: 'ⁿ√x', title: 'Root', tex: '\\sqrt[n]{x}' },
      { label: '( )', title: 'Brackets that grow', tex: '\\left( x \\right)' },
      { label: 'x̄', title: 'Bar', tex: '\\bar{x}' },
      { label: 'x⃗', title: 'Vector', tex: '\\vec{x}' },
      { label: 'x̂', title: 'Hat', tex: '\\hat{x}' },
    ],
  },
  {
    name: 'Calculus',
    items: [
      { label: '∑', title: 'Sum', tex: '\\sum_{i=1}^{n} ' },
      { label: '∏', title: 'Product', tex: '\\prod_{i=1}^{n} ' },
      { label: '∫', title: 'Integral', tex: '\\int_{a}^{b} f(x)\\,dx' },
      { label: '∮', title: 'Contour integral', tex: '\\oint ' },
      { label: 'lim', title: 'Limit', tex: '\\lim_{x \\to \\infty} ' },
      { label: 'd/dx', title: 'Derivative', tex: '\\frac{d}{dx}' },
      { label: '∂/∂x', title: 'Partial derivative', tex: '\\frac{\\partial}{\\partial x}' },
      { label: '∇', title: 'Nabla', tex: '\\nabla ' },
      { label: '∞', title: 'Infinity', tex: '\\infty ' },
    ],
  },
  {
    name: 'Relations',
    items: [
      { label: '≤', title: 'Less or equal', tex: '\\leq ' },
      { label: '≥', title: 'Greater or equal', tex: '\\geq ' },
      { label: '≠', title: 'Not equal', tex: '\\neq ' },
      { label: '≈', title: 'Approximately', tex: '\\approx ' },
      { label: '≡', title: 'Identical', tex: '\\equiv ' },
      { label: '±', title: 'Plus or minus', tex: '\\pm ' },
      { label: '×', title: 'Times', tex: '\\times ' },
      { label: '÷', title: 'Divide', tex: '\\div ' },
      { label: '·', title: 'Dot', tex: '\\cdot ' },
      { label: '→', title: 'Arrow', tex: '\\rightarrow ' },
      { label: '⇒', title: 'Implies', tex: '\\Rightarrow ' },
      { label: '⇔', title: 'If and only if', tex: '\\Leftrightarrow ' },
    ],
  },
  {
    name: 'Sets and logic',
    items: [
      { label: '∈', title: 'In', tex: '\\in ' },
      { label: '∉', title: 'Not in', tex: '\\notin ' },
      { label: '⊂', title: 'Subset', tex: '\\subset ' },
      { label: '∪', title: 'Union', tex: '\\cup ' },
      { label: '∩', title: 'Intersection', tex: '\\cap ' },
      { label: '∅', title: 'Empty set', tex: '\\emptyset ' },
      { label: 'ℝ', title: 'Real numbers', tex: '\\mathbb{R}' },
      { label: 'ℕ', title: 'Natural numbers', tex: '\\mathbb{N}' },
      { label: '∀', title: 'For all', tex: '\\forall ' },
      { label: '∃', title: 'There exists', tex: '\\exists ' },
    ],
  },
  {
    name: 'Greek',
    items: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi', 'rho', 'sigma', 'tau', 'phi', 'chi', 'psi', 'omega', 'Delta', 'Sigma', 'Omega']
      .map(n => ({ label: String.fromCodePoint(GREEK[n]), title: n, tex: `\\${n} ` })),
  },
  {
    name: 'Layouts',
    items: [
      { label: '[ ]', title: 'Matrix', tex: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}' },
      { label: '{', title: 'Cases', tex: 'f(x) = \\begin{cases} a & x > 0 \\\\ b & x \\leq 0 \\end{cases}' },
      { label: '=', title: 'Lined-up equations', tex: '\\begin{aligned} a &= b + c \\\\ d &= e + f \\end{aligned}' },
      { label: 'C(n,k)', title: 'Choose', tex: '\\binom{n}{k}' },
    ],
  },
];
