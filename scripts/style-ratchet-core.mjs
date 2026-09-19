/**
 * What the style ratchet counts, as pure functions so the rules can be tested.
 *
 * Two kinds of styling debt, per source file:
 *
 *   style  An inline style: a JSX `style={…}` attribute, or a style written
 *          imperatively (`el.style.background = …`, `el.style.setProperty(…)`),
 *          which is how the legacy screens do hover. Layout that changes with
 *          screen size cannot be expressed in either — that is the lesson of the
 *          landing page — and neither can a focus ring or a coarse-pointer size.
 *
 *   color  A colour spelled out instead of taken from a token: a hex literal
 *          (#0a7a45), rgb()/rgba()/hsl()/hsla() with a number inside, a
 *          Tailwind palette class (text-green-100, bg-white, from-blue-600), or
 *          the bare words 'white' / 'black' as a quoted value. These are theme-
 *          blind: they read in one theme and fail in the other. `rgb(var(--x))`
 *          is a token and is not counted.
 *
 * Comments are removed before counting, so documenting a pattern ("never write
 * `style={{ color: '#fff' }}`") is not debt. Strings are kept, because that is
 * where colours live. The lexer is deliberately small: it knows line and block
 * comments, quotes and template literals, and resets an unterminated ' or "
 * string at the end of its line, so an apostrophe in JSX text costs at most
 * that one line.
 */

/** Replaces every comment with spaces, keeping line breaks and strings. */
export function stripComments(source) {
  let out = '';
  let state = 'code';
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    switch (state) {
      case 'code':
        if (char === '/' && next === '/') {
          state = 'line';
          out += '  ';
          i += 1;
        } else if (char === '/' && next === '*') {
          state = 'block';
          out += '  ';
          i += 1;
        } else {
          if (char === '"' || char === "'" || char === '`') {
            state = 'string';
            quote = char;
          }
          out += char;
        }
        break;
      case 'string':
        out += char;
        if (char === '\\') {
          out += next ?? '';
          i += 1;
        } else if (char === quote) {
          state = 'code';
        } else if (char === '\n' && quote !== '`') {
          state = 'code';
        }
        break;
      case 'line':
        if (char === '\n') {
          state = 'code';
          out += '\n';
        } else {
          out += ' ';
        }
        break;
      case 'block':
        if (char === '*' && next === '/') {
          state = 'code';
          out += '  ';
          i += 1;
        } else {
          out += char === '\n' ? '\n' : ' ';
        }
        break;
    }
  }
  return out;
}

const STYLE_PATTERNS = [
  /\bstyle=\{/g,
  /\.style\.[A-Za-z]+\s*=(?!=)/g,
  /\.style\.setProperty\(/g,
];

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const UTILITY = 'bg|text|border(?:-[trblxy])?|from|via|to|ring|ring-offset|outline|fill|stroke|divide|placeholder|decoration|accent|caret|shadow';

const COLOR_PATTERNS = [
  // Not after & (an HTML entity like &#8203;) and not inside a word.
  /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g,
  /\b(?:rgba?|hsla?)\(\s*[\d.]/g,
  new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|white|black)(?![\\w-])`, 'g'),
  /(['"`])(?:white|black)\1/g,
];

const countAll = (text, patterns) => patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);

/** The two counts for one file's source text. */
export function countStyleDebt(source) {
  const code = stripComments(source);
  return { style: countAll(code, STYLE_PATTERNS), color: countAll(code, COLOR_PATTERNS) };
}

/** Which files under src/ are counted: application source, not tests or declarations. */
export function isCounted(relativePath) {
  const path = relativePath.replace(/\\/g, '/');
  return /\.(?:tsx?|jsx?)$/.test(path) && !/\.test\.[jt]sx?$/.test(path) && !path.endsWith('.d.ts');
}

/**
 * Compares the current counts with the baseline, file by file.
 *
 * Both maps are `{ [path]: { style, color } }` holding only files with a
 * non-zero count. A file absent from a map counts as zero in it.
 */
export function compareToBaseline(current, baseline) {
  const worse = [];
  const better = [];
  const paths = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const path of [...paths].sort()) {
    const now = current[path] ?? { style: 0, color: 0 };
    const was = baseline[path] ?? { style: 0, color: 0 };
    for (const kind of ['style', 'color']) {
      if (now[kind] > was[kind]) worse.push({ path, kind, was: was[kind], now: now[kind] });
      if (now[kind] < was[kind]) better.push({ path, kind, was: was[kind], now: now[kind] });
    }
  }
  return { worse, better };
}

export function totals(counts) {
  return Object.values(counts).reduce(
    (sum, { style, color }) => ({ style: sum.style + style, color: sum.color + color, files: sum.files + 1 }),
    { style: 0, color: 0, files: 0 },
  );
}
