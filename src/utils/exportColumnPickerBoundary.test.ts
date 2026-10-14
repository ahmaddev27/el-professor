import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The column picker belongs to the generic list dump, and to nothing else.
 *
 * Statutory documents have their content fixed by German law, and the
 * Fahrtenbuch `'original'` mode must reproduce an imported sheet byte for byte;
 * a picker in front of one produces an invalid record. This file reads the source
 * so that a later change cannot quietly wire one in:
 *
 *   1. no document builder mentions the picker;
 *   2. the picker's own modules import no document builder;
 *   3. the set of tables that open the picker is a written list, so a new
 *      `exportPicker.table(...)` / `.sheets(...)` call fails here until a person
 *      has decided that the thing it exports is a list and not a document.
 */
const SRC = path.resolve(import.meta.dirname, '..');

const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** The closed list of documents (CLAUDE.md, "Language"), plus their builders. */
const DOCUMENT_MODULES = [
  'utils/stundennachweisPdfExport.ts',
  'utils/fahrtenbuchExport.ts',
  'utils/historicalWorkingHoursFahrtenbuchExport.ts',
  'utils/monatsplanungXlsxExport.ts',
  'utils/monthlyPlanFahrtenbuchExport.ts',
  'utils/monthlyPlanDocumentBuilders.ts',
  'utils/fahreruebersichtExport.ts',
  'utils/driverSalaryPdf.ts',
  'utils/salaryCashReceiptDocument.ts',
  'components/TrinkgeldQuittungModal.tsx',
  'components/GehaltsquittungModal.tsx',
  'components/GehaltsquittungDocument.tsx',
  'components/MietwagenauftragModal.tsx',
  'lib/legalPages.ts',
  'pages/LegalPage.tsx',
];

const PICKER_MODULES = [
  'utils/exportColumnSelection.ts',
  'components/export/ExportColumnsDialog.tsx',
  'contexts/ExportPickerContext.tsx',
];

const PICKER_MARKERS = /exportColumnSelection|ExportColumnsDialog|ExportPickerContext|useColumnPickerExport|exportPicker\./;

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('column picker boundary', () => {
  it('the document list names files that exist', () => {
    for (const rel of DOCUMENT_MODULES) expect(() => read(rel), rel).not.toThrow();
  });

  it.each(DOCUMENT_MODULES)('%s never mentions the picker', rel => {
    expect(read(rel)).not.toMatch(PICKER_MARKERS);
  });

  it.each(PICKER_MODULES)('%s imports no document builder', rel => {
    const documents = new Set(DOCUMENT_MODULES.map(m => path.basename(m).replace(/\.tsx?$/, '')));
    const hits = importsOf(read(rel)).filter(spec => documents.has(path.basename(spec)));
    expect(hits).toEqual([]);
  });

  it('only a written list of tables opens the picker', () => {
    const ids: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      if (file.endsWith('ExportPickerContext.tsx')) continue;
      const calls = source.matchAll(/exportPicker\.(?:table|sheets)\(\s*(`[^`]*`|'[^']*')/g);
      for (const call of calls) ids.push(call[1].slice(1, -1));
    }
    expect(ids.sort()).toEqual([
      'abrechnung',
      'belege',
      'cars',
      'cashBalance',
      'companies',
      'drivers',
      'fahrtenliste',
      'fixedCosts',
      'gehaltsquittungen',
      'income',
      'notes',
      'platformAudit',
      'platformDirectory:${tab}',
      'platformInvoices',
      'platformSubscriptions',
      'platformTeam',
      'returnCheckReview',
      'roles',
      'salaries',
      'shiftRecommendation',
      'stundennachweisArchive',
      'users',
      'werkstatt',
    ]);
  });
});
