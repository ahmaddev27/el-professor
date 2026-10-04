#!/usr/bin/env node
/**
 * Reports what is actually inside a downloaded .xlsx.
 *
 * The owner reported on 01.10.2026 that the Excel files were ugly and signed, and
 * the cause was a writer that discarded every style it was handed — so a file can
 * be described correctly in code and still arrive as a plain grid. The unit test
 * `src/utils/exportDrawing.test.ts` closes that for workbooks built from a fixture
 * in Node. This closes the rest of the path: it opens the file a BROWSER produced
 * and downloaded from staging, and says, per sheet, how many cells carry a fill, a
 * border and a number format, how many hold a real number rather than text, and
 * whether any cell or document property names the product.
 *
 *   node scripts/inspect-exports.mjs e2e/test-results/exports/*.xlsx
 *
 * It asserts nothing and exits 0 unless a file cannot be read: it is an
 * instrument, and the judgement is in the report it prints.
 */
import ExcelJS from 'exceljs';
import { argv, exit } from 'node:process';

const files = argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/inspect-exports.mjs <file.xlsx> [...]');
  exit(2);
}

const SIGNATURE = /professor/i;

for (const file of files) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(file);
  } catch (error) {
    console.error(`\n✗ ${file}: could not be read — ${(error && error.message) || error}`);
    exit(1);
  }

  console.log(`\n═══ ${file} ═══`);

  const props = [
    ['creator', workbook.creator],
    ['lastModifiedBy', workbook.lastModifiedBy],
    ['company', workbook.company],
    ['title', workbook.title],
    ['subject', workbook.subject],
  ].filter(([, v]) => typeof v === 'string' && v.length > 0);
  console.log('  properties: ' + (props.length
    ? props.map(([k, v]) => `${k}="${v}"`).join('  ')
    : '(none)'));
  const signedProps = props.filter(([, v]) => SIGNATURE.test(v));

  const signatures = signedProps.map(([k, v]) => `[property ${k}] ${v}`);

  for (const sheet of workbook.worksheets) {
    let fills = 0, borders = 0, formats = 0, numbers = 0, cells = 0;
    let widths = 0;
    sheet.eachRow({ includeEmpty: false }, row => {
      row.eachCell({ includeEmpty: false }, cell => {
        cells++;
        if (cell.fill && cell.fill.type) fills++;
        if (cell.border && Object.keys(cell.border).length > 0) borders++;
        if (cell.numFmt) formats++;
        if (typeof cell.value === 'number') numbers++;
        if (typeof cell.value === 'string' && SIGNATURE.test(cell.value)) {
          signatures.push(`[${sheet.name} ${cell.address}] ${cell.value}`);
        }
      });
    });
    sheet.columns?.forEach(column => { if (column.width) widths++; });

    const frozen = sheet.views?.some(view => view.state === 'frozen') ? 'freeze' : '—';
    const filter = sheet.autoFilter ? 'filter' : '—';
    console.log(
      `  ${sheet.name.padEnd(22)} rows=${String(sheet.rowCount).padStart(4)}` +
      ` cells=${String(cells).padStart(4)}` +
      ` fills=${String(fills).padStart(4)}` +
      ` borders=${String(borders).padStart(4)}` +
      ` numFmt=${String(formats).padStart(4)}` +
      ` numeric=${String(numbers).padStart(4)}` +
      ` widths=${String(widths).padStart(3)}  ${frozen} ${filter}`,
    );
  }

  if (signatures.length > 0) {
    console.log('  SIGNED:');
    for (const line of signatures) console.log('    ' + line);
  } else {
    console.log('  signature: none');
  }

  // A money column written as text is the defect that made these files unusable,
  // so the figures are shown rather than only counted.
  const first = workbook.worksheets[0];
  const sample = [];
  first?.eachRow({ includeEmpty: false }, row => {
    row.eachCell({ includeEmpty: false }, cell => {
      if (sample.length < 6 && typeof cell.value === 'number') {
        sample.push(`${cell.address}=${cell.value} [${cell.numFmt ?? 'no format'}]`);
      }
    });
  });
  console.log('  first numbers: ' + (sample.length ? sample.join('  ') : '(none — every figure is text)'));
}

console.log('');
