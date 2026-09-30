import { describe, expect, it } from 'vitest';
import {
  COVERAGE_SOURCES,
  coverageHistory,
  coverageState,
  parseCoverageRows,
  type CoverageRow,
} from './companyCoverageHistory';

/*
  What these assertions are for.

  `CompanyBillingPage` printed "Noch keine Aktivierungen vorhanden" to every
  company user, always, because it read `activation_codes` — a table whose SELECT
  policy carries no tenant term, so a company role is filtered to zero rows with
  no error to notice. Before this module existed there was nothing to assert
  against: the screen's history was a constant `[]` dressed as a fact. Every test
  below fails without the module, and the five state boundaries fail against any
  reimplementation that folds two states into one.
*/

const row = (over: Partial<CoverageRow> = {}): CoverageRow => ({
  id: 'r1',
  source: 'activation_code',
  sourceRaw: 'activation_code',
  period_start: '2026-09-01T00:00:00+02:00',
  period_end: '2026-10-01T00:00:00+02:00',
  grants_access: true,
  status: 'active',
  created_at: '2026-09-01T09:00:00+02:00',
  ...over,
});

const NOW = new Date('2026-09-15T12:00:00+02:00');

describe('COVERAGE_SOURCES', () => {
  it('is exactly the source CHECK of subscription_coverage', () => {
    // 20260919150000: CHECK (source IN ('invoice','activation_code','manual','trial','migration')).
    // A sixth source added to the column must be added here in the same change,
    // or its periods render with the stored word instead of a label.
    expect([...COVERAGE_SOURCES]).toEqual(['invoice', 'activation_code', 'manual', 'trial', 'migration']);
  });
});

describe('coverageState', () => {
  it('calls a period that contains now current', () => {
    expect(coverageState(row(), NOW)).toBe('current');
  });

  it('calls an open-ended granting period current', () => {
    // Rule 1 of recompute_company_subscription: an open-ended granting row wins,
    // and the expiry stays NULL. It is not "unknown" and not "past".
    expect(coverageState(row({ period_end: null }), NOW)).toBe('current');
  });

  it('calls a period that has already ended past', () => {
    expect(coverageState(row({
      period_start: '2026-07-01T00:00:00+02:00',
      period_end: '2026-08-01T00:00:00+02:00',
    }), NOW)).toBe('past');
  });

  it('treats period_end exactly at now as past, like the recompute does', () => {
    // The recompute grants while `period_end > now()`, so equality is over.
    expect(coverageState(row({ period_end: NOW.toISOString() }), NOW)).toBe('past');
  });

  it('calls a period that has not started yet future', () => {
    // An early renewal: recorded, granting, and starting after today. It must not
    // read as "Aktuell aktiv", and it must not read as expired either.
    expect(coverageState(row({
      period_start: '2026-11-01T00:00:00+01:00',
      period_end: '2026-12-01T00:00:00+01:00',
    }), NOW)).toBe('future');
  });

  it('calls a voided row withdrawn even when its dates are current', () => {
    // Voiding is a correction and does not rewrite the period it withdraws
    // (20260919150000), so a void row keeps dates that still contain now. The
    // dates must not win over the correction.
    expect(coverageState(row({ status: 'void' }), NOW)).toBe('withdrawn');
  });

  it('calls a live period that grants nothing blocked, not past', () => {
    // What update_company_subscription_manual('suspended') records: on the
    // books, granting nothing. Reporting it as "Abgelaufen" would say a company
    // once had access it never had.
    expect(coverageState(row({ grants_access: false }), NOW)).toBe('blocked');
  });

  it('prefers withdrawn over blocked when a row is both', () => {
    expect(coverageState(row({ status: 'void', grants_access: false }), NOW)).toBe('withdrawn');
  });

  it('calls a row with no dates at all current rather than throwing', () => {
    expect(coverageState(row({ period_start: null, period_end: null }), NOW)).toBe('current');
  });

  it('ignores a date the browser cannot read instead of failing', () => {
    expect(coverageState(row({ period_end: 'not-a-date' }), NOW)).toBe('current');
  });
});

describe('coverageHistory', () => {
  it('orders by period start, newest first', () => {
    const rows = [
      row({ id: 'old', period_start: '2026-01-01T00:00:00+01:00', period_end: '2026-02-01T00:00:00+01:00' }),
      row({ id: 'new', period_start: '2026-09-01T00:00:00+02:00' }),
      row({ id: 'mid', period_start: '2026-05-01T00:00:00+02:00', period_end: '2026-06-01T00:00:00+02:00' }),
    ];
    expect(coverageHistory(rows, NOW).map(e => e.row.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a tie on the same period by when the row was recorded', () => {
    const rows = [
      row({ id: 'first', created_at: '2026-09-01T08:00:00+02:00' }),
      row({ id: 'second', created_at: '2026-09-01T10:00:00+02:00' }),
    ];
    expect(coverageHistory(rows, NOW).map(e => e.row.id)).toEqual(['second', 'first']);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [
      row({ id: 'a', period_start: '2026-01-01T00:00:00+01:00', period_end: '2026-02-01T00:00:00+01:00' }),
      row({ id: 'b' }),
    ];
    coverageHistory(rows, NOW);
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('carries each row its own state', () => {
    const entries = coverageHistory([
      row({ id: 'live' }),
      row({ id: 'gone', status: 'void' }),
    ], NOW);
    expect(entries.find(e => e.row.id === 'live')?.state).toBe('current');
    expect(entries.find(e => e.row.id === 'gone')?.state).toBe('withdrawn');
  });
});

describe('parseCoverageRows', () => {
  it('reads the columns the screen draws', () => {
    const [parsed] = parseCoverageRows([{
      id: 'r1',
      source: 'invoice',
      period_start: '2026-09-01T00:00:00+02:00',
      period_end: null,
      grants_access: true,
      status: 'active',
      created_at: '2026-09-01T09:00:00+02:00',
    }]);
    expect(parsed).toEqual({
      id: 'r1',
      source: 'invoice',
      sourceRaw: 'invoice',
      period_start: '2026-09-01T00:00:00+02:00',
      period_end: null,
      grants_access: true,
      status: 'active',
      created_at: '2026-09-01T09:00:00+02:00',
    });
  });

  it('keeps the stored word for a source this build does not know', () => {
    const [parsed] = parseCoverageRows([{ id: 'r1', source: 'voucher', status: 'active' }]);
    expect(parsed.source).toBeNull();
    expect(parsed.sourceRaw).toBe('voucher');
  });

  it('reads an unknown status as void rather than as granted coverage', () => {
    // A state this build cannot judge must not be drawn as live access.
    expect(parseCoverageRows([{ id: 'r1', status: 'pending' }])[0].status).toBe('void');
  });

  it('drops a row with no id instead of rendering a blank line', () => {
    expect(parseCoverageRows([{ source: 'invoice' }, { id: 'r1' }]).map(r => r.id)).toEqual(['r1']);
  });

  it('survives anything that is not the shape PostgREST documents', () => {
    expect(parseCoverageRows(null)).toEqual([]);
    expect(parseCoverageRows({ id: 'r1' })).toEqual([]);
    expect(parseCoverageRows(['r1', 7, null])).toEqual([]);
  });

  it('defaults grants_access to true only for a value that is not false', () => {
    expect(parseCoverageRows([{ id: 'a', grants_access: false }])[0].grants_access).toBe(false);
    expect(parseCoverageRows([{ id: 'b' }])[0].grants_access).toBe(true);
  });
});
