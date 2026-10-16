import { describe, expect, it } from 'vitest';
import { addDaysIso, diffDaysIso, mondayOf, splitIntoDays } from '../../supabase/functions/_shared/uber-earnings-core';
import { runEarningsBackfill, type BackfillDeps, type PullResult } from './uberBackfill';
import { overallStatus, runFleetImport } from './partnerFleetImport';

// 15.10.2026 midday Berlin: the last completed operating day is 14.10.2026.
const NOW = new Date('2026-10-15T10:00:00Z');
const THROUGH = '2026-10-14';
const DATA_START = '2026-04-08'; // a Wednesday: its Monday is 2026-04-06

interface World {
  deps: BackfillDeps;
  income: Array<{ start: string; end: string }>;
  pulls: Array<{ from: string; to: string; gran: string }>;
  failWriteAt: { value: string | null };
  stop: { value: boolean };
  manual: { value: number };
  stateReadable: { value: boolean };
  unlinked: { value: boolean };
  /** Once the database has linked the earner, the next pull carries the link. */
  linkMade: { value: boolean };
  unmatched: { value: string[] };
  resolveCalls: Array<Array<{ externalDriverId: string; name: string }>>;
  resolveAnswer: { value: 'created' | 'skipped' | 'refused' };
}

function world(dataStart: string | null = DATA_START): World {
  const income: World['income'] = [];
  const pulls: World['pulls'] = [];
  const w = {
    failWriteAt: { value: null as string | null },
    stop: { value: false },
    manual: { value: 0 },
    stateReadable: { value: true },
    unlinked: { value: false },
    linkMade: { value: false },
    unmatched: { value: [] as string[] },
    resolveCalls: [] as World['resolveCalls'],
    resolveAnswer: { value: 'created' as World['resolveAnswer']['value'] },
  };
  const driver = (fare: number) => ({
    externalDriverId: '7', uberDriverUuid: null, name: 'Anna', fareCents: fare,
    promotionCents: 0, tipsCents: 0, cashCents: 0, netOutstandingCents: 0, trips: 1, differenceCents: 0,
  });
  const deps: BackfillDeps = {
    now: () => NOW,
    readState: async () => w.stateReadable.value
      ? { latestEnd: income.reduce<string | null>((m, r) => (m === null || r.end > m ? r.end : m), null), manualRows: w.manual.value }
      : null,
    pull: async (from, to, gran): Promise<PullResult> => {
      pulls.push({ from, to, gran });
      const segs = gran === 'day'
        ? (splitIntoDays(from, to) as { ok: true; value: Array<{ from: string; to: string; monday: string }> }).value
        : [{ from, to, monday: mondayOf(from) }];
      const weeks = segs.map(seg => {
        let fare = 0;
        for (let d = seg.from; diffDaysIso(d, seg.to) >= 0; d = addDaysIso(d, 1)) {
          if (dataStart !== null && d >= dataStart) fare += 1000;
        }
        return { segment: seg, drivers: fare > 0 ? [driver(fare)] : [] };
      });
      const noLink = w.unlinked.value && !w.linkMade.value;
      const links: Record<string, { driverId: string; driverName: string }> = noLink ? {} : { '7': { driverId: 'd1', driverName: 'Anna' } };
      const unmatched = w.unmatched.value.map(name => ({ name, uberDriverUuid: null, trips: null }));
      return { ok: true, weeks, links, unmatched };
    },
    resolve: async earners => {
      w.resolveCalls.push(earners);
      if (w.resolveAnswer.value === 'refused') return { ok: false, reason: 'inc.uber.err.notAuthorized' };
      if (w.resolveAnswer.value === 'skipped') return { ok: true, created: [], linked: [], skipped: earners.map(e => e.name) };
      w.linkMade.value = true;
      return { ok: true, created: earners.map(e => e.name), linked: [], skipped: [] };
    },
    write: async rows => {
      const start = rows.map(r => r.period_start).sort().reverse()[0] as string;
      if (w.failWriteAt.value !== null && start >= w.failWriteAt.value) {
        return { ok: false, reason: 'inc.uber.err.partnerUnavailable' };
      }
      for (const r of rows) income.push({ start: r.period_start, end: r.period_end });
      return { ok: true, inserted: rows.length };
    },
    sleep: async () => {},
    shouldStop: () => w.stop.value,
  };
  return { deps, income, pulls, ...w };
}

describe('runEarningsBackfill', () => {
  it('finds the start from the data and imports every day through the last completed one', async () => {
    const x = world();
    const out = await runEarningsBackfill(x.deps);
    const days = diffDaysIso(DATA_START, THROUGH) + 1;
    // Probing starts at the Monday of the oldest week holding earnings.
    expect(out).toMatchObject({ status: 'done', from: '2026-04-06', to: THROUGH, resumed: false });
    expect(x.income.length).toBe(days);
    expect(x.income.every(r => r.start === r.end)).toBe(true);
    expect(x.income.map(r => r.start).sort()[0]).toBe(DATA_START);
    // No request covers more than three days, and weekly probes only ask one week.
    expect(x.pulls.filter(p => p.gran === 'day').every(p => diffDaysIso(p.from, p.to) < 3)).toBe(true);
    expect(x.pulls.filter(p => p.gran === 'week').every(p => diffDaysIso(p.from, p.to) <= 6)).toBe(true);
  });

  it('resumes after a failure from the last day that is in the table, not from the start', async () => {
    const x = world();
    x.failWriteAt.value = '2026-07-01';
    const first = await runEarningsBackfill(x.deps);
    expect(first.status).toBe('failed');
    const written = x.income.length;
    expect(written).toBeGreaterThan(0);
    const lastDone = x.income.map(r => r.end).sort().reverse()[0] as string;
    expect(first).toMatchObject({ status: 'failed', reason: 'inc.uber.err.partnerUnavailable' });
    expect(lastDone < '2026-07-01').toBe(true);

    x.failWriteAt.value = null;
    x.pulls.length = 0;
    const second = await runEarningsBackfill(x.deps);
    expect(second).toMatchObject({ status: 'done', resumed: true });
    expect(x.pulls.every(p => p.gran === 'day')).toBe(true); // no new search for the start
    expect(x.pulls[0].from).toBe(addDaysIso(lastDone, 1)); // and nothing already imported is asked again
    const keys = x.income.map(r => r.start);
    expect(new Set(keys).size).toBe(keys.length); // no day twice
    expect(keys.length).toBe(diffDaysIso(DATA_START, THROUGH) + 1);
  });

  it('says it is up to date when a second click finds nothing new', async () => {
    const x = world();
    await runEarningsBackfill(x.deps);
    x.pulls.length = 0;
    const again = await runEarningsBackfill(x.deps);
    expect(again).toMatchObject({ status: 'done', days: 0, resumed: true });
    expect(x.pulls).toHaveLength(0);
  });

  it('does not start on a company that already has hand-typed income', async () => {
    const x = world();
    x.manual.value = 3;
    const out = await runEarningsBackfill(x.deps);
    expect(out).toEqual({ status: 'unavailable', reason: 'import.earnings.manualExists' });
    expect(x.pulls).toHaveLength(0);
  });

  it('treats an unreadable income table as a failure, never as an empty one', async () => {
    const x = world();
    x.stateReadable.value = false;
    const out = await runEarningsBackfill(x.deps);
    expect(out).toMatchObject({ status: 'failed', reason: 'import.earnings.stateUnreadable' });
    expect(x.pulls).toHaveLength(0);
  });

  it('reports nothing when Uber holds no earnings at all', async () => {
    const x = world(null);
    expect(await runEarningsBackfill(x.deps)).toEqual({ status: 'nothing' });
    expect(x.income).toHaveLength(0);
  });

  it('gives an unlinked earner a named home and carries on, reporting the driver it made', async () => {
    const x = world();
    x.unlinked.value = true;
    const out = await runEarningsBackfill(x.deps);
    expect(out).toMatchObject({ status: 'done', created: ['Anna'], linked: [] });
    // One call: the link it made is in every later pull, so Anna is created once.
    expect(x.resolveCalls).toEqual([[{ externalDriverId: '7', name: 'Anna' }]]);
    expect(x.income).toHaveLength(diffDaysIso(DATA_START, THROUGH) + 1);
  });

  it('stops, names the earner and writes nothing when no driver can be made for them', async () => {
    const x = world();
    x.unlinked.value = true;
    x.resolveAnswer.value = 'skipped';
    const out = await runEarningsBackfill(x.deps);
    expect(out).toMatchObject({ status: 'failed', reason: 'import.earnings.unresolved', detail: 'Anna', through: null });
    expect(x.income).toHaveLength(0);
  });

  it('stops on a refused resolve with that reason, writing nothing', async () => {
    const x = world();
    x.unlinked.value = true;
    x.resolveAnswer.value = 'refused';
    const out = await runEarningsBackfill(x.deps);
    expect(out).toMatchObject({ status: 'failed', reason: 'inc.uber.err.notAuthorized', through: null });
    expect(x.income).toHaveLength(0);
  });

  it('still stops on an earner Reidey cannot place, and creates no driver on the way', async () => {
    const x = world();
    x.unlinked.value = true; // an unlinked earner in the same piece must not be created either
    x.unmatched.value = ['Nobody Known'];
    const out = await runEarningsBackfill(x.deps);
    expect(out).toMatchObject({ status: 'failed', reason: 'import.earnings.unmatched', detail: 'Nobody Known', created: [] });
    expect(x.resolveCalls).toHaveLength(0);
    expect(x.income).toHaveLength(0);
  });

  it('keeps the drivers it created in the report when a later piece fails', async () => {
    const x = world();
    x.unlinked.value = true;
    x.failWriteAt.value = '2026-07-01';
    const out = await runEarningsBackfill(x.deps);
    expect(out).toMatchObject({ status: 'failed', created: ['Anna'] });
  });

  it('can be stopped between pieces and then resumed', async () => {
    const x = world();
    let pieces = 0;
    const inner = x.deps.write;
    x.deps.write = async rows => { pieces++; if (pieces === 3) x.stop.value = true; return inner(rows); };
    const out = await runEarningsBackfill(x.deps);
    expect(out).toMatchObject({ status: 'stopped' });
    x.stop.value = false;
    expect(await runEarningsBackfill(x.deps)).toMatchObject({ status: 'done', resumed: true });
  });
});

describe('the fleet import with the earnings leg', () => {
  const ok = { data: { ok: true, seen: 1 }, error: null };
  const rpc = { data: { ok: true, created: 1, linked: 0, skipped: [] }, error: null };

  it('is not a success when earnings stopped halfway, and keeps the other legs', async () => {
    const x = world();
    x.failWriteAt.value = '2026-07-01';
    const out = await runFleetImport(
      { pull: async () => ok, importRpc: async () => rpc },
      report => runEarningsBackfill(x.deps, report),
    );
    expect(out.map(o => o.scope)).toEqual(['drivers', 'vehicles', 'earnings']);
    expect(overallStatus(out)).toBe('partial');
  });

  it('is a success when all three legs finish', async () => {
    const x = world();
    const out = await runFleetImport(
      { pull: async () => ok, importRpc: async () => rpc },
      report => runEarningsBackfill(x.deps, report),
    );
    expect(overallStatus(out)).toBe('success');
  });
});

describe('splitIntoDays', () => {
  it('cuts into single days and refuses more than three', () => {
    expect(splitIntoDays('2026-10-11', '2026-10-13')).toEqual({
      ok: true,
      value: [
        { from: '2026-10-11', to: '2026-10-11', monday: '2026-10-05' },
        { from: '2026-10-12', to: '2026-10-12', monday: '2026-10-12' },
        { from: '2026-10-13', to: '2026-10-13', monday: '2026-10-12' },
      ],
    });
    expect(splitIntoDays('2026-10-01', '2026-10-04')).toEqual({ ok: false, problem: 'range_too_long' });
    expect(splitIntoDays('2026-10-04', '2026-10-01')).toEqual({ ok: false, problem: 'invalid_range' });
  });
});
