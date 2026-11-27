/** @type {import('tailwindcss').Config} */

// Design-system colours resolve to the RGB-channel variables in src/index.css.
// The light and dark values swap under `.dark`, so the components need no
// `dark:` variants, and the opacity modifier (`bg-brand/10`) still works.
//
// A translucent token (the glass panes, the lines, the scrim) carries its own
// alpha in a sibling `--<name>-a`; the modifier multiplies it, so `bg-raised`
// paints the pane at its designed alpha and `bg-raised/50` at half of that. An
// opaque token has no sibling and the fallback 1 leaves it as it was.
// None of these names existed as classes before the design system, so no legacy
// screen changes through them (the legacy screens read the `--bg-*` / `--text-*`
// variables directly).
const token = name => `rgb(var(--${name}) / calc(var(--${name}-a, 1) * <alpha-value>))`;

const tone = name => ({
  DEFAULT: token(name),
  soft: token(`${name}-soft`),
  dot: token(`${name}-dot`),
});

// Geist for every word the product shows, Geist Mono for codes and figures that
// are read character by character. Self-hosted in src/assets/fonts.
// IBM Plex Sans Arabic follows Geist: Latin glyphs stay Geist, Arabic ones come from Plex
// (its @font-face rules carry the Arabic unicode-range only; see src/index.css).
const sans = ['Geist', 'IBM Plex Sans Arabic', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'];
const mono = ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'];

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        raised: token('raised'),
        overlay: token('overlay'),
        sunken: token('sunken'),
        wash: token('wash'),
        field: token('field'),
        solid: token('solid'),
        sheet: token('sheet'),
        edge: token('edge'),
        scrim: token('scrim'),
        toast: { DEFAULT: token('toast'), fg: token('toast-fg') },
        fg: {
          DEFAULT: token('fg'),
          muted: token('fg-muted'),
          subtle: token('fg-subtle'),
        },
        line: {
          DEFAULT: token('line'),
          strong: token('line-strong'),
        },
        brand: {
          DEFAULT: token('brand'),
          hover: token('brand-hover'),
          fg: token('brand-fg'),
          soft: token('brand-soft'),
          text: token('brand-text'),
        },
        signal: token('signal'),
        focus: token('focus'),
        positive: tone('positive'),
        caution: tone('caution'),
        critical: {
          ...tone('critical'),
          solid: token('critical-solid'),
          fg: token('critical-fg'),
        },
        info: tone('info'),
        violet: tone('violet'),
        teal: tone('teal'),
        neutral: tone('neutral'),
        chart: {
          1: token('chart-1'),
          2: token('chart-2'),
          3: token('chart-3'),
          4: token('chart-4'),
          5: token('chart-5'),
          '1-soft': token('chart-1-soft'),
        },
      },
      fontFamily: {
        sans,
        ui: sans,
        mono,
      },
      borderRadius: {
        chip: 'var(--radius-xs)',
        tight: 'var(--radius-sm)',
        control: 'var(--radius-control)',
        tile: 'var(--radius-lg)',
        surface: 'var(--radius-surface)',
        pane: 'var(--radius-pane)',
      },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
        hi: 'var(--glass-hi)',
        'elev-xs': 'var(--elev-xs)',
        'elev-md': 'var(--elev-md)',
        'elev-lg': 'var(--elev-lg)',
        brand: 'var(--brand-glow)',
        mark: 'var(--mark-glow)',
        segment: 'var(--glass-hi), 0 2px 8px -3px rgb(4 60 44 / 0.25)',
        field: 'inset 0 1px 2px rgb(4 60 44 / 0.05)',
      },
      backgroundImage: {
        'brand-gradient': 'var(--brand-gradient)',
        'brand-gradient-hover': 'var(--brand-gradient-hover)',
        mark: 'var(--mark-gradient)',
        shimmer: 'linear-gradient(90deg, rgb(var(--sunken) / var(--sunken-a)) 25%, rgb(var(--sunken) / calc(var(--sunken-a) * 0.55)) 37%, rgb(var(--sunken) / var(--sunken-a)) 63%)',
      },
      transitionTimingFunction: {
        glass: 'var(--ease)',
      },
      backdropBlur: {
        scrim: '6px',
        toast: '16px',
        topbar: '18px',
        sidebar: '22px',
        dialog: '26px',
        drawer: '28px',
      },
      keyframes: {
        'ui-fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'ui-pop-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'ui-slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'ui-slide-in-left': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
        'ui-slide-in-bottom': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'ui-shimmer': {
          from: { backgroundPosition: '100% 50%' },
          to: { backgroundPosition: '0 50%' },
        },
      },
      animation: {
        'ui-fade-in': 'ui-fade-in 200ms var(--ease)',
        'ui-pop-in': 'ui-pop-in 280ms var(--ease)',
        'ui-menu-in': 'ui-pop-in 200ms var(--ease)',
        'ui-slide-in-right': 'ui-slide-in-right 320ms var(--ease)',
        'ui-slide-in-left': 'ui-slide-in-left 320ms var(--ease)',
        'ui-slide-in-bottom': 'ui-slide-in-bottom 320ms var(--ease)',
        'ui-shimmer': 'ui-shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
