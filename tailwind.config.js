/** @type {import('tailwindcss').Config} */

// Design-system colours resolve to the RGB-channel variables in src/index.css.
// The light and dark values swap under `.dark`, so the components need no
// `dark:` variants, and the opacity modifier (`bg-brand/10`) still works.
// None of these names existed as classes before, so no legacy screen changes.
const token = name => `rgb(var(--${name}) / <alpha-value>)`;

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
        field: token('field'),
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
        positive: {
          DEFAULT: token('positive'),
          soft: token('positive-soft'),
        },
        caution: {
          DEFAULT: token('caution'),
          soft: token('caution-soft'),
        },
        critical: {
          DEFAULT: token('critical'),
          soft: token('critical-soft'),
          solid: token('critical-solid'),
        },
      },
      fontFamily: {
        ui: ['Barlow', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        control: 'var(--radius-control)',
        surface: 'var(--radius-surface)',
      },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
      },
      keyframes: {
        'ui-fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'ui-pop-in': {
          from: { opacity: '0', transform: 'translateY(4px) scale(0.98)' },
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
      },
      animation: {
        'ui-fade-in': 'ui-fade-in 150ms ease-out',
        'ui-pop-in': 'ui-pop-in 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'ui-slide-in-right': 'ui-slide-in-right 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'ui-slide-in-left': 'ui-slide-in-left 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'ui-slide-in-bottom': 'ui-slide-in-bottom 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
