/**
 * Layout direction: a class that names a physical side (`ml-`, `pr-`, `left-`,
 * `text-right`, `rounded-l`, `border-r` …) means the wrong side as soon as the
 * page is right-to-left, so the code says `ms-`, `pe-`, `start-`, `text-end`,
 * `rounded-s`, `border-e` instead and the browser picks the side.
 *
 * This reads every source file under `src/` and fails on a physical class that
 * is not in ALLOWED below. An entry names the file, the exact class and why that
 * place stays physical. A new reason goes beside the entry, never into the regex.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.dirname(fileURLToPath(import.meta.url));

const BASES = [
  'ml', 'mr', 'pl', 'pr', 'scroll-ml', 'scroll-mr', 'scroll-pl', 'scroll-pr',
  'text-left', 'text-right', 'float-left', 'float-right', 'clear-left', 'clear-right',
  'origin-left', 'origin-right', 'origin-top-left', 'origin-top-right',
  'origin-bottom-left', 'origin-bottom-right',
  'rounded-l', 'rounded-r', 'rounded-tl', 'rounded-tr', 'rounded-bl', 'rounded-br',
  'border-l', 'border-r', 'left', 'right',
];
const NEEDS_VALUE = new Set(['left', 'right']);
const VALUE = String.raw`(?:\[[^\]\s]+\]|[\w./%]+)`;
// `left`/`right` also occur in prose ("right-aligned"), so only a spacing value counts there.
const POSITION_VALUE = /^(?:\d[\w./%]*|px|full|auto|\[.+\])$/;

/** The physical class tokens in `source`, with any variant prefix kept off. */
export function findPhysicalClasses(source: string): string[] {
  const re = new RegExp(
    String.raw`(?<![\w\-/.#$])-?(${BASES.join('|')})(?:-(${VALUE}))?(?=[\s"'\`]|$)`,
    'g',
  );
  const found: string[] = [];
  for (const m of source.matchAll(re)) {
    if (NEEDS_VALUE.has(m[1]) && !(m[2] && POSITION_VALUE.test(m[2]))) continue;
    found.push(m[0]);
  }
  return found;
}

interface Allowed { file: string; classes: string[]; reason: string }

const ALLOWED: Allowed[] = [
  {
    file: 'contexts/ToastContext.tsx',
    classes: ['left-1/2'],
    reason: 'centring: left-1/2 with -translate-x-1/2 centres in either direction; start-1/2 would be off-centre in RTL',
  },
  {
    file: 'contexts/ToastContext.render.test.ts',
    classes: ['left-1/2'],
    reason: 'the test of the toast container above',
  },
  {
    file: 'components/signup/PlanSelection.tsx',
    classes: ['left-1/2'],
    reason: 'centring of the "recommended" badge, same idiom as the toast',
  },
  {
    file: 'pages/StundennachweisPage.tsx',
    classes: ['ml-1'],
    reason: 'inside the Stundennachweis sheet (Timesheet), a generated document pinned dir="ltr" whose classes stay untouched',
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && entry.name !== 'rtlClasses.test.ts' ? [full] : [];
  });
}

describe('physical direction classes', () => {
  it('finds every physical form the codemod handled (mutation control)', () => {
    const sample = 'ml-2 -ml-2.5 sm:pr-[18px] hover:text-left left-3 -right-1 rounded-tl-lg border-r-2 [@media(pointer:coarse)]:pl-4';
    expect(findPhysicalClasses(sample)).toEqual([
      'ml-2', '-ml-2.5', 'pr-[18px]', 'text-left', 'left-3', '-right-1', 'rounded-tl-lg', 'border-r-2', 'pl-4',
    ]);
  });

  it('ignores the logical forms and prose', () => {
    expect(findPhysicalClasses('ms-2 pe-3 start-0 text-end rounded-s border-e left aligned right-hand')).toEqual([]);
  });

  it('has no physical class outside the allow-list', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const allowed = ALLOWED.find(a => a.file === rel)?.classes ?? [];
      const bad = findPhysicalClasses(readFileSync(file, 'utf8')).filter(c => !allowed.includes(c));
      if (bad.length > 0) offenders.push(`${rel}: ${[...new Set(bad)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every allow-list entry alive', () => {
    for (const entry of ALLOWED) {
      const found = findPhysicalClasses(readFileSync(path.join(SRC, entry.file), 'utf8'));
      for (const cls of entry.classes) expect(found, `${entry.file}: ${entry.reason}`).toContain(cls);
    }
  });
});

/**
 * Tailwind's `rtl:` variant is `:where([dir=rtl], [dir=rtl] *)`, so it matches
 * inside a `dir="ltr"` island too: one `rtl:` class inside a German document
 * would flip that part of the sheet for an Arabic user. Each region below is a
 * document root pinned `dir="ltr" lang="de"`, from its start marker to the end
 * of the component (`end`), or to the end of the file.
 */
const DOCUMENT_REGIONS: { file: string; start: string; end?: string }[] = [
  { file: 'components/GehaltsquittungDocument.tsx', start: 'export function GehaltsquittungSheet', end: '\n}\n' },
  { file: 'components/DriverSalarySummaryCard.tsx', start: '' },
  { file: 'components/TrinkgeldQuittungModal.tsx', start: 'const A4Document', end: '\n};' },
  { file: 'components/MietwagenauftragModal.tsx', start: 'const A4Document', end: '\n};' },
  { file: 'pages/StundennachweisPage.tsx', start: 'export const Timesheet', end: '\n};' },
  { file: 'pages/AbrechnungPage.tsx', start: 'Off-screen shareable card' },
];

function documentRegion({ file, start, end }: (typeof DOCUMENT_REGIONS)[number]): string {
  const source = readFileSync(path.join(SRC, file), 'utf8');
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`${file}: start marker ${JSON.stringify(start)} not found`);
  const to = end ? source.indexOf(end, from) : source.length;
  if (to < 0) throw new Error(`${file}: end marker not found after ${JSON.stringify(start)}`);
  return source.slice(from, to);
}

describe('German documents', () => {
  it('pins every document root left-to-right', () => {
    for (const region of DOCUMENT_REGIONS) {
      expect(documentRegion(region), region.file).toMatch(/dir="ltr" lang="de"/);
    }
  });

  it('carries no rtl: class inside a document', () => {
    const offenders = DOCUMENT_REGIONS.filter(region => /(?<![\w-])rtl:/.test(documentRegion(region)))
      .map(region => region.file);
    expect(offenders).toEqual([]);
  });
});
