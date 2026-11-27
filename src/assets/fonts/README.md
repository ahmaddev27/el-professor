# Fonts

`geist-latin-var.woff2` and `geist-mono-latin-var.woff2` are the Latin subsets of **Geist** and
**Geist Mono** (variable weight), © Vercel, licensed under the SIL Open Font License 1.1
(<https://openfontlicense.org>). They are self-hosted: `src/index.css` declares them with `@font-face`,
Vite fingerprints them into the bundle, and no page loads a font from a CDN.

The Latin subset covers U+0000–00FF (umlauts and ß included), the € sign and the typographic quotes
and dashes German text uses.
