#!/usr/bin/env node
/**
 * Phase 5 batch 2, proven as text: every converted file's logic is the base's
 * logic, byte for byte, except for lines this list names.
 *
 *   node design-harness/prove-batch2.mjs [base commit, default: where HEAD left origin/staging]
 *
 * For each file it takes one or more blocks — from a line that starts the
 * logic to a line that ends it, in the base and in the working tree — and
 * compares them after removing exactly the lines listed as `added` (each must
 * occur in the new block exactly as many times as listed) and `removed` (each
 * must occur in the old block). Presentation that had to reach into the logic
 * — an `onChange` handler, a sum the old markup computed inline — is listed as
 * `carried`: each snippet must appear verbatim in the base file and in the new
 * one, so a handler moved into new markup is still the old handler. Leading
 * indentation is ignored there and only there, because a carried block may
 * sit at another depth; every character after it must match. A `verbatim`
 * block — the Abrechnung share card html2canvas turns into an image — must
 * reappear exactly, indentation included.
 *
 * It prints the block sizes and exits non-zero on the first difference, with
 * the first differing line of each side.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The branch point by default: the commit the before shots were rendered from
// has the same four files, and so does every later staging commit this was
// rebased onto unless it touched them.
const base =
  process.argv[2] ?? execFileSync('git', ['merge-base', 'HEAD', 'origin/staging'], { cwd: root, encoding: 'utf8' }).trim();
const PRESENTATION = '  // ── Presentation (phase 5) ────────────────────────────────────────────────';

const FILES = [
  {
    path: 'src/pages/BargeldbestandPage.tsx',
    blocks: [
      // The module's doc comment and constants, then the component through handleExport.
      { from: '/**', oldTo: '  const inputStyle: React.CSSProperties = {', newTo: PRESENTATION },
    ],
    added: [
      '  const [loadFailed, setLoadFailed] = useState(false);',
      '      setLoadFailed(false);',
      '      setLoadFailed(true);',
    ],
    removed: [],
    carried: [
      'onChange={(e) => setSelectedMonth(e.target.value)}',
      'onChange={(e) => setStartDate(e.target.value)}',
      'onChange={(e) => setEndDate(e.target.value)}',
      "{ledgerInScope ? t('bargeld.balanceFormula') : t('bargeld.balanceFormulaNoLedger')}",
      '{ledgerInScope && (',
      '!ledgerInScope &&',
      "selectedDriver !== 'all' || selectedType !== 'all' || startDate || endDate",
      'onClick={handleExport}',
      'onClick={resetFilters}',
    ],
  },
  {
    path: 'src/pages/SalariesPage.tsx',
    blocks: [{ from: 'const SalariesPage: React.FC = () => {', oldTo: '  if (loading) {', newTo: PRESENTATION }],
    added: [],
    removed: [],
    carried: ['onClick={loadDrivers}', 'return <SalariesManagement drivers={drivers} />;'],
  },
  {
    path: 'src/components/SalariesManagement.tsx',
    blocks: [
      {
        from: 'const SalariesManagement: React.FC<SalariesManagementProps> = ({ drivers }) => {',
        oldTo: '  const inputStyle = {',
        newTo: PRESENTATION,
      },
    ],
    added: [
      '  const [loadFailed, setLoadFailed] = useState(false);',
      '      setLoadFailed(false);',
      '      setLoadFailed(true);',
    ],
    removed: [],
    carried: [
      // The overlap hint the old table built inside its row map.
      [
        'const overlaps = overlapsByDriver.get(calc.driver_id);',
        '// One line per overlapping row, so the owner can go straight to',
        '// the period he has to merge instead of hunting for it.',
        'const overlapHint = overlaps',
        '? [',
        "t('sal.overlap.tooltip'),",
        '...overlaps.map(other =>',
        "t('sal.overlap.entry', {",
        'period: `${formatStoredDate(other.period_start)} – ${formatStoredDate(other.period_end)}`,',
        'amount: formatSalaryDue(other),',
        '}),',
        '),',
        "].join('\\n')",
        ": '';",
      ].join('\n'),
      'onClick={() => setPeriodsDriverId(calc.driver_id)}',
      "title={`${overlapHint}\\n\\n${t('sal.periods.openHint')}`}",
      "aria-label={`${overlapHint}\\n\\n${t('sal.periods.openHint')}`}",
      "calc.payment_status === 'paid' ? (",
      "calc.payment_status === 'partially_paid' ? (",
      'calc.netto_salary || calc.amount_due',
      '{calc.netto_salary && calc.netto_salary !== calc.amount_due && (',
      'calc.total_paid ? (',
      'calc.remaining_balance > 0 ?',
      'onClick={() => showDriverDetails(calc.driver_name)}',
      'onClick={() => generateDriverSalaryPdf({ salary: calc, settings, showNote: false })}',
      'onClick={() => setSalaryDetailsModal({ isOpen: true, salary: calc })}',
      'disabled={!isAdmin}',
      "isAdmin ? t('sal.action.managePayments') : t('sal.adminOnlyShort')",
      'disabled={!rowsByDriver.get(calc.driver_id)?.length}',
      "? t('sal.periods.open')\n: t('sal.periods.noRows')",
      'onChange={e => handleMonthChange(e.target.value)}',
      'onChange={e => setPeriodStart(e.target.value)}',
      'onChange={e => setPeriodEnd(e.target.value)}',
      "drivers.filter(driver => driver.status !== 'inactive').map(driver => (",
      "as 'all' | 'paid' | 'unpaid'",
      'onClick={resetFilters}',
      'onClick={handleExport}',
      "calculations.length === 0 ? t('sal.export.noDataTooltip') : t('common.exportExcelShort')",
      "t('sal.paidUnpaidCount', { paid: paidCount, unpaid: unpaidCount })",
      // The unreachable status dialog, left as it was.
      [
        '<ConfirmationModal',
        'isOpen={statusModal.isOpen}',
        "onClose={() => setStatusModal({ isOpen: false, salary: null, newStatus: 'unpaid' })}",
        'onConfirm={handleStatusChange}',
        "title={statusModal.newStatus === 'paid' ? t('sal.confirm.markPaidTitle') : t('sal.confirm.markUnpaidTitle')}",
        'message={',
        'statusModal.salary',
        '? t(',
        "statusModal.newStatus === 'paid' ? 'sal.confirm.markPaidMessage' : 'sal.confirm.markUnpaidMessage',",
        '{ name: statusModal.salary.driver_name, amount: statusModal.salary.amount_due.toFixed(2) },',
        ')',
        ": ''",
        '}',
        "type={statusModal.newStatus === 'paid' ? 'success' : 'warning'}",
        '/>',
      ].join('\n'),
      // The transaction dialog's sums, computed where the old dialog computed them.
      [
        '{detailsModal.isOpen && (() => {',
        'const transactions = detailsModal.transactions;',
        "const umsatzTotal = transactions.filter(tx => tx.type === 'umsatz').reduce((sum, tx) => sum + Number(tx.amount), 0);",
        "const aktionenTotal = transactions.filter(tx => tx.type === 'aktionen').reduce((sum, tx) => sum + Number(tx.amount), 0);",
        "const trinkgeldTotal = transactions.filter(tx => tx.type === 'trinkgeld').reduce((sum, tx) => sum + Number(tx.amount), 0);",
        "const bargeldTotal = transactions.filter(tx => tx.type === 'bargeld').reduce((sum, tx) => sum + Number(tx.amount), 0);",
        'const totalIncome = umsatzTotal + aktionenTotal + trinkgeldTotal + bargeldTotal;',
      ].join('\n'),
      [
        '// `type` is the stored income type; only the returned label is translated.',
        'const getTypeLabel = (type: string) => {',
        'switch (type) {',
        "case 'umsatz': return t('sal.type.umsatz');",
        "case 'aktionen': return t('sal.type.aktionen');",
        "case 'trinkgeld': return t('sal.type.trinkgeld');",
        "case 'bargeld': return t('sal.type.bargeld');",
        'default: return type;',
        '}',
        '};',
      ].join('\n'),
      '{aktionenTotal > 0 && ',
      "setDetailsModal({ isOpen: false, driverName: '', transactions: [] })",
      "transaction.type === 'bargeld' ?",
      [
        '{salaryDetailsModal.isOpen && salaryDetailsModal.salary && (',
        '<SalaryDetailsModal',
        'isOpen={salaryDetailsModal.isOpen}',
        'onClose={() => setSalaryDetailsModal({ isOpen: false, salary: null })}',
        'salary={salaryDetailsModal.salary}',
        'onUpdate={loadData}',
        '/>',
        ')}',
      ].join('\n'),
      [
        '{periodsDriverId && (',
        '<SalaryPeriodsModal',
        'isOpen',
        'onClose={() => setPeriodsDriverId(null)}',
        "driverName={drivers.find(driver => driver.id === periodsDriverId)?.name ?? ''}",
        'rows={rowsByDriver.get(periodsDriverId) ?? []}',
        'companyId={companyId}',
        'writeRefusal={writeRefusal}',
        'onChanged={loadData}',
        '/>',
        ')}',
      ].join('\n'),
    ],
  },
  {
    path: 'src/pages/AbrechnungPage.tsx',
    blocks: [
      // The row types and MONTH_NAMES; the module-level inputStyle after them is presentation.
      { from: 'interface WeeklyAbrechnung {', oldTo: 'const inputStyle: React.CSSProperties = {', newTo: 'export function AbrechnungPage() {' },
      // The component through handleDownloadImage.
      { from: 'export function AbrechnungPage() {', oldTo: '  const renderWeeklyView = () => {', newTo: '  const getFilteredMonthlyData = () => {' },
      // The monthly filter and totals, which sat between the two render functions.
      { from: '  const getFilteredMonthlyData = () => {', oldTo: '  const renderMonthlyView = () => {', newTo: PRESENTATION },
    ],
    added: [
      '  const [loadFailed, setLoadFailed] = useState(false);',
      '      setLoadFailed(false);',
      '      setLoadFailed(true);',
      '      setLoadFailed(false);',
      '      setLoadFailed(true);',
    ],
    removed: [],
    // The off-screen card html2canvas renders into the shared image: exact, indentation included.
    verbatim: [
      {
        from: '      {/* ── Off-screen shareable card — mirrors the visible modal, fully theme-aware ── */}',
        to: '      )}',
      },
    ],
    carried: [
      'const groupedData = groupByWeek();',
      'const weekNumbers = Object.keys(groupedData).map(Number).sort((a, b) => b - a);',
      'const weekData = groupedData[weekNumber];',
      'const totals = calculateWeekTotals(weekData);',
      '{getWeekLabel(weekNumber)} - {MONTH_NAMES[selectedMonth - 1]} {selectedYear}',
      '() => handleRowClick(item)',
      'const filteredData = getFilteredMonthlyData();',
      'const totals = calculateMonthlyTotals(filteredData);',
      '() => handleMonthlyRowClick(item)',
      "({item.week_count} {item.week_count === 1 ? t('common.week') : t('common.weeks')})",
      'Number(item.ausgegebene_bargeld)',
      'Number(item.bargeld)',
      'Number(item.bar_zuruck)',
      'weeklyData.length === 0',
      'monthlyData.length === 0',
      "viewMode === 'weekly' ?",
      '{MONTH_NAMES[selectedMonth - 1]} {selectedYear}',
      "=== 'all' ? 'all' : Number(",
      'drivers.map(driver => (',
      'availableWeeks.map(week => (',
      'MONTH_NAMES.map((month, idx) => (',
      'idx + 1',
      '[2024, 2025, 2026, 2027].map(year => (',
      [
        '{detailModalData.driverName} · {detailModalData.weekNumber === 0',
        '? `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`',
        ': `Woche ${detailModalData.weekNumber}`}',
      ].join('\n'),
      "{detailModalData.weekNumber === 0 ? t('common.month') : t('common.week')}",
      "detailModalData.weekNumber === 0 ? t('common.month') : t('abr.thisWeek')",
      '{detailModalData.weekStartDate} – {detailModalData.weekEndDate}',
      'const pos = detailModalData.difference >= 0;',
      "quote !== null ? formatPercent(quote) : '—'",
      'onClick={handleShareToWhatsApp}',
      'onClick={handleCopyImage}',
      'onClick={handleDownloadImage}',
      'disabled={isSharing}',
      "{isSharing ? t('abr.creatingImage') : t('common.share')}",
      "{isSharing ? t('abr.creatingImage') : t('common.copy')}",
      "{isSharing ? t('abr.creatingImage') : t('common.download')}",
      'setDetailModalData(null)',
    ],
  },
];

const lines = text => text.replace(/\r\n/g, '\n').split('\n');
/** Leading indentation removed from every line: a carried block may sit deeper or shallower. */
const dedent = text => lines(text).map(line => line.trimStart()).join('\n');

function block(all, from, to, label) {
  const start = all.indexOf(from);
  if (start < 0) throw new Error(`${label}: start line not found: ${from}`);
  const end = all.indexOf(to, start + 1);
  if (end < 0) throw new Error(`${label}: end line not found: ${to}`);
  return all.slice(start, end);
}

function without(blockLines, remove, label) {
  const out = [...blockLines];
  for (const line of remove) {
    const index = out.indexOf(line);
    if (index < 0) throw new Error(`${label}: listed line not found: ${line}`);
    out.splice(index, 1);
  }
  return out;
}

let failed = false;
for (const file of FILES) {
  const oldText = execFileSync('git', ['show', `${base}:${file.path}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const newText = readFileSync(join(root, file.path), 'utf8');
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const oldNorm = dedent(oldText);
  const newNorm = dedent(newText);

  let verbatimLines = 0;
  try {
    let oldCount = 0;
    let newCount = 0;
    const oldBlocks = [];
    const newBlocks = [];
    for (const spec of file.blocks) {
      const oldBlock = block(oldLines, spec.from, spec.oldTo, `${file.path} (base)`);
      const newBlock = block(newLines, spec.from, spec.newTo, file.path);
      oldCount += oldBlock.length;
      newCount += newBlock.length;
      oldBlocks.push(...oldBlock);
      newBlocks.push(...newBlock);
    }
    const oldKept = without(oldBlocks, file.removed, `${file.path} (base)`);
    const newKept = without(newBlocks, file.added, file.path);
    const length = Math.max(oldKept.length, newKept.length);
    for (let i = 0; i < length; i += 1) {
      if (oldKept[i] !== newKept[i]) {
        throw new Error(`${file.path}: logic differs at kept line ${i + 1}\n  base: ${oldKept[i]}\n  new:  ${newKept[i]}`);
      }
    }
    for (const { from, to } of file.verbatim ?? []) {
      const start = oldLines.indexOf(from);
      if (start < 0) throw new Error(`${file.path} (base): verbatim block not found: ${from}`);
      const end = oldLines.indexOf(to, start + 1);
      const text = oldLines.slice(start, end + 1).join('\n');
      if (!lines(newText).join('\n').includes(text)) {
        throw new Error(`${file.path}: the ${end + 1 - start}-line block from "${from.trim()}" is not in the new file byte for byte`);
      }
      verbatimLines += end + 1 - start;
    }
    for (const carried of file.carried) {
      const snippet = dedent(carried);
      if (!oldNorm.includes(snippet)) throw new Error(`${file.path}: carried snippet not in the base file: ${snippet}`);
      if (!newNorm.includes(snippet)) throw new Error(`${file.path}: carried snippet not in the new file: ${snippet}`);
    }
    console.log(
      `ok   ${file.path}: logic ${oldCount} lines at ${base.slice(0, 7)}, ${newCount} now; identical after removing ` +
        `${file.added.length} added and ${file.removed.length} removed lines; ${file.carried.length} carried snippets verbatim` +
        (verbatimLines ? `; ${verbatimLines} lines kept byte for byte` : ""),
    );
  } catch (error) {
    failed = true;
    console.log(`FAIL ${error.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
