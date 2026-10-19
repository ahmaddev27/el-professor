/**
 * The hand-over is a record and moves no cash. This reads the source, because
 * the property is about what is NOT connected: a hand-over that reached the
 * ledger would count a driver's cash twice (`cashLedger.ts` already counts it as
 * in the till from the day its `income.type = 'bargeld'` row is dated).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const read = (file: string) => readFileSync(file, 'utf8');

describe('the hand-over record stays out of the till', () => {
  const files = sourceFiles(SRC);

  it('no file reads or writes both the hand-over table and a ledger table', () => {
    const offenders = files.filter(f => {
      const text = read(f);
      return /abrechnung_handovers/.test(text) && /cash_movements|salary_payments|salary_cash_receipts|cash_transactions/.test(text);
    });
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([]);
  });

  it('the cash ledger and the Bargeldbestand do not know the hand-over', () => {
    for (const rel of ['utils/cashLedger.ts', 'pages/BargeldbestandPage.tsx', 'utils/salaryCashReceipt.ts']) {
      expect(read(path.join(SRC, rel)), rel).not.toMatch(/abrechnungHandover|abrechnung_handovers/);
    }
  });

  it('the hand-over module imports nothing but the money helpers', () => {
    const imports = [...read(path.join(SRC, 'utils/abrechnungHandover.ts')).matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]);
    expect(imports).toEqual(['./money']);
  });

  it('the Abrechnung screen writes the hand-over table and no other table', () => {
    const text = read(path.join(SRC, 'pages/AbrechnungPage.tsx'));
    const written = [...text.matchAll(/\.from\('([a-z_]+)'\)\s*\.(?:insert|upsert|update|delete)\(/g)].map(m => m[1]);
    expect(new Set(written)).toEqual(new Set(['abrechnung_handovers']));
  });
});
