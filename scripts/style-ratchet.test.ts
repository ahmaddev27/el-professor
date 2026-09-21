import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareToBaseline, countStyleDebt, isCounted, stripComments } from './style-ratchet-core.mjs';

describe('countStyleDebt: inline styles', () => {
  it('counts a JSX style attribute, literal or variable', () => {
    expect(countStyleDebt(`<div style={{ color: 'var(--text-primary)' }} /><input style={inputStyle} />`).style).toBe(2);
  });

  it('counts an imperative style write, which is how the legacy screens do hover', () => {
    const source = `onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
      el.style.setProperty('--x', '1');`;
    expect(countStyleDebt(source).style).toBe(2);
  });

  it('does not count a comparison or a read', () => {
    expect(countStyleDebt(`if (el.style.display === 'none') return el.style.color;`).style).toBe(0);
  });
});

describe('countStyleDebt: colours', () => {
  it('counts hex literals of every length', () => {
    expect(countStyleDebt(`const a = '#fff'; const b = "#0A7A45"; const c = '#0a7a4580'; const d = '#abcd';`).color).toBe(4);
  });

  it('counts rgb and hsl with numbers, including inside a Tailwind arbitrary value', () => {
    expect(countStyleDebt(`'rgba(220,38,38,0.06)' 'hsl(210 40% 50%)' className="bg-[rgb(5_8_16/0.55)]"`).color).toBe(3);
  });

  it('does not count a token read through rgb(var(--x))', () => {
    expect(countStyleDebt(`shadow-[inset_0_-1px_0_rgb(var(--line))] 'rgb(var(--brand) / 0.1)'`).color).toBe(0);
  });

  it('counts Tailwind palette classes, with or without a variant, and white/black', () => {
    const source = `className="bg-gradient-to-r from-green-600 to-green-800 text-white hover:bg-blue-700 dark:text-gray-300 border-black/10"`;
    expect(countStyleDebt(source).color).toBe(6);
  });

  it('does not count design-system classes that merely share a prefix', () => {
    expect(countStyleDebt(`className="bg-brand text-fg-muted border-line bg-critical-soft text-positive ring-focus"`).color).toBe(0);
  });

  it("counts 'white' and 'black' as quoted values, not as words in text", () => {
    expect(countStyleDebt(`style={{ color: 'white' }} <p>white and black</p>`)).toEqual({ style: 1, color: 1 });
  });

  it('ignores an HTML entity, an anchor and an issue number', () => {
    expect(countStyleDebt(`'&#8203;' href="#gehaltsquittungen" 'PR #72'`).color).toBe(0);
  });
});

describe('stripComments', () => {
  it('drops line and block comments and keeps strings, URLs included', () => {
    const source = `const url = 'https://example.com'; // style={{ color: '#fff' }}\n/* #000 style={x} */ const c = '#123456';`;
    const stripped = stripComments(source);
    expect(stripped).toContain(`'https://example.com'`);
    expect(stripped).toContain(`'#123456'`);
    expect(stripped).not.toContain('#fff');
    expect(stripped).not.toContain('#000');
    expect(countStyleDebt(source)).toEqual({ style: 0, color: 1 });
  });

  it('keeps line breaks, so a stray apostrophe in JSX text ends with its line', () => {
    const source = `<p>Don't</p>\n<div style={{}} />`;
    expect(stripComments(source).split('\n')).toHaveLength(2);
    expect(countStyleDebt(source).style).toBe(1);
  });
});

describe('isCounted', () => {
  it('counts application source and leaves tests and declarations out', () => {
    expect(isCounted('src/components/CarsManagement.tsx')).toBe(true);
    expect(isCounted('src/utils/money.ts')).toBe(true);
    expect(isCounted('src/components/ui/tokens.contrast.test.ts')).toBe(false);
    expect(isCounted('src/vite-env.d.ts')).toBe(false);
    expect(isCounted('src/index.css')).toBe(false);
  });
});

describe('compareToBaseline', () => {
  it('reports a rise and a fall separately, per file and per kind', () => {
    const baseline = { 'a.tsx': { style: 3, color: 1 }, 'b.tsx': { style: 1, color: 0 } };
    const current = { 'a.tsx': { style: 2, color: 1 }, 'c.tsx': { style: 0, color: 2 } };
    expect(compareToBaseline(current, baseline)).toEqual({
      worse: [{ path: 'c.tsx', kind: 'color', was: 0, now: 2 }],
      better: [
        { path: 'a.tsx', kind: 'style', was: 3, now: 2 },
        { path: 'b.tsx', kind: 'style', was: 1, now: 0 },
      ],
    });
  });

  it('does not let one file pay for another', () => {
    const { worse, better } = compareToBaseline({ 'a.tsx': { style: 2, color: 0 }, 'b.tsx': { style: 0, color: 0 } }, {
      'a.tsx': { style: 1, color: 0 },
      'b.tsx': { style: 1, color: 0 },
    });
    expect(worse).toHaveLength(1);
    expect(better).toHaveLength(1);
  });
});

describe('the committed baseline', () => {
  const baseline = JSON.parse(readFileSync(new URL('../style-baseline.json', import.meta.url), 'utf8')) as {
    files: Record<string, { style: number; color: number }>;
  };

  it('still sees debt in a screen phase 5 has not reached, so a broken counter cannot pass by finding nothing', () => {
    const source = readFileSync(new URL('../src/pages/WerkstattPage.tsx', import.meta.url), 'utf8');
    expect(countStyleDebt(source).style).toBeGreaterThan(0);
    expect(baseline.files['src/pages/WerkstattPage.tsx']?.style).toBeGreaterThan(0);
  });

  it('holds the phase 5 batch-1 screens at zero: they are on the design system', () => {
    for (const path of [
      'src/components/CarsManagement.tsx',
      'src/components/CarModal.tsx',
      'src/components/FixedCostsManagement.tsx',
      'src/pages/CarsPage.tsx',
      'src/pages/FixkostenPage.tsx',
    ]) {
      expect(baseline.files[path], path).toBeUndefined();
    }
  });
});
