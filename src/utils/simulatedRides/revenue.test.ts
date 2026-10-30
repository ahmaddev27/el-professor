import { describe, expect, it } from 'vitest';
import { cancellationFeeOf, countRevenue, declineFeeOf, inExportScope, revenueBasis } from './revenue';
import { DEFAULT_SIMULATION_TENANT_SETTINGS, type SimulationTenantSettings } from './tenantSettings';
import type { SimRide, SimRideStatus } from './types';

const ADDR = { label: 'Teststraße 1, 42651 Solingen, Deutschland', lat: 51.17, lon: 7.07 };

let counter = 0;
function ride(status: SimRideStatus, over: Partial<SimRide> = {}): SimRide {
  counter += 1;
  return {
    shiftId: `S${counter}`,
    vehicle: { plate: 'XX-TEST1', type: 'Mietwagen' },
    driver: { name: 'Test Fahrer', id: '00000000-0000-4000-8000-000000000001' },
    status,
    orderReceivedMs: 1_000 * counter,
    orderTransmittedMs: 1_000 * counter,
    plannedPickupMs: null,
    startMs: status === 'completed' ? 1_000 * counter : null,
    endMs: status === 'completed' ? 1_000 * counter + 600_000 : null,
    vehiclePosition: ADDR,
    pickup: ADDR,
    dropoff: ADDR,
    fare: 0,
    tip: 0,
    km: 0,
    payment: 'App',
    prebooked: false,
    ...over,
  };
}

const completed = (fare: number, tip = 0, km = 0, payment: 'App' | 'Bar' = 'App') =>
  ride('completed', { fare, tip, km, payment });
const declined = (over: Partial<SimRide> = {}) => ride('declined', over);
const cancelled = (sheetFare = 0) => ride('cancelled', { fare: sheetFare });

const S = (over: Partial<SimulationTenantSettings> = {}): SimulationTenantSettings => ({
  ...DEFAULT_SIMULATION_TENANT_SETTINGS,
  ...over,
});

describe('status buckets are disjoint', () => {
  it('a completed ride earns fare and tip and never a fee', () => {
    const r = countRevenue([completed(12.5, 1.5, 4.2)], S());
    expect(r).toMatchObject({ fareCents: 1250, tipCents: 150, declinedFeeCents: 0, cancelledFeeCents: 0, km: 4.2 });
    expect(r.counts).toEqual({ completed: 1, cancelled: 0, declined: 0, total: 1 });
  });

  it('a declined ride earns a fee and no fare, tip or kilometre', () => {
    // A malformed declined ride that carries a fare must still not leak it into the fare bucket.
    const r = countRevenue([declined({ fare: 99, tip: 9, km: 9 })], S());
    expect(r).toMatchObject({ fareCents: 0, tipCents: 0, km: 0, declinedFeeCents: 600, cancelledFeeCents: 0 });
    expect(r.counts.declined).toBe(1);
  });

  it('a cancelled ride earns no fee by default', () => {
    const r = countRevenue([cancelled(6)], S());
    expect(r).toMatchObject({ fareCents: 0, tipCents: 0, declinedFeeCents: 0, cancelledFeeCents: 0 });
    expect(r.counts.cancelled).toBe(1);
  });

  it('a mixed month adds each bucket exactly once', () => {
    const r = countRevenue([completed(10), completed(20, 2, 3, 'Bar'), declined(), declined(), cancelled(6)], S());
    expect(r.fareCents).toBe(3000);
    expect(r.appFareCents).toBe(1000);
    expect(r.cashFareCents).toBe(2000);
    expect(r.tipCents).toBe(200);
    expect(r.declinedFeeCents).toBe(1200);
    expect(r.counts).toEqual({ completed: 2, cancelled: 1, declined: 2, total: 5 });
  });
});

describe('the per-tenant fee', () => {
  it('uses the tenant fee when the ride carries none, and the ride own fee when it does', () => {
    const s = S({ declinedFeeCents: 750 });
    expect(declineFeeOf(declined(), s)).toBe(750);
    expect(declineFeeOf(declined({ declinedFeeCents: 425 }), s)).toBe(425);
    expect(countRevenue([declined(), declined({ declinedFeeCents: 425 })], s).declinedFeeCents).toBe(1175);
  });

  it('a ride own fee of zero is a fee of zero, not a missing one', () => {
    expect(declineFeeOf(declined({ declinedFeeCents: 0 }), S())).toBe(0);
  });

  it('changing the tenant fee moves the total by exactly count times delta', () => {
    const rides = [declined(), declined(), declined(), completed(5)];
    const a = countRevenue(rides, S({ declinedFeeCents: 600 })).declinedFeeCents;
    const b = countRevenue(rides, S({ declinedFeeCents: 850 })).declinedFeeCents;
    expect(b - a).toBe(3 * 250);
  });
});

describe('the cancellation fee', () => {
  it('is off by default and is never the decline fee', () => {
    expect(DEFAULT_SIMULATION_TENANT_SETTINGS.cancellationFeeEnabled).toBe(false);
    expect(cancellationFeeOf(cancelled(), S())).toBeNull();
    expect(declineFeeOf(cancelled(), S({ cancellationFeeEnabled: true }))).toBeNull();
  });

  it('is the company setting, in cancelledFeeCents and never in declinedFeeCents', () => {
    const s = S({ cancellationFeeEnabled: true, cancellationFeeCents: 600, declinedFeeCents: 850 });
    const r = countRevenue([cancelled(), cancelled(), declined()], s);
    expect(r.cancelledFeeCents).toBe(1200);
    expect(r.declinedFeeCents).toBe(850);
  });

  it('with no declined ride at all, declinedFeeCents stays zero', () => {
    const r = countRevenue([cancelled()], S({ cancellationFeeEnabled: true }));
    expect(r.declinedFeeCents).toBe(0);
    expect(r.cancelledFeeCents).toBe(600);
  });
});

describe('the report scope', () => {
  it('holds completed and cancelled rides and never a declined order', () => {
    expect([completed(10), cancelled(6), declined()].map(inExportScope)).toEqual([true, true, false]);
  });
});

describe('cancelledSheetFareCents', () => {
  const rides = [completed(10), cancelled(6), cancelled(7.2), declined()];

  it('is reported but is not in the fare', () => {
    const r = countRevenue(rides, S());
    expect(r.cancelledSheetFareCents).toBe(1320);
    expect(r.fareCents).toBe(1000);
  });

  it('is in no basis, for any combination of the flags', () => {
    for (const tips of [false, true]) {
      for (const fees of [false, true]) {
        for (const charge of [false, true]) {
          const s = S({ basisIncludesTips: tips, basisIncludesCancellationFees: fees, cancellationFeeEnabled: charge });
          const r = countRevenue(rides, s);
          const b = revenueBasis(r, s);
          const expected = r.fareCents + (tips ? r.tipCents : 0) + (fees ? r.cancelledFeeCents : 0);
          expect(b.basisCents).toBe(expected);
          expect(Object.values(b.parts)).not.toContain(r.cancelledSheetFareCents);
        }
      }
    }
  });
});

describe('the basis flags', () => {
  const rides = [completed(100, 10), declined(), cancelled(6)];
  const cases: [boolean, boolean, number][] = [
    [false, false, 10000],
    [true, false, 11000],
    [false, true, 10600],
    [true, true, 11600],
  ];
  it.each(cases)('tips=%s cancellation fees=%s gives %i cents', (tips, fees, expected) => {
    const s = S({ basisIncludesTips: tips, basisIncludesCancellationFees: fees, cancellationFeeEnabled: true });
    const b = revenueBasis(countRevenue(rides, s), s);
    expect(b.basisCents).toBe(expected);
    expect(b.includesTips).toBe(tips);
    expect(b.includesCancellationFees).toBe(fees);
    expect(b.parts).toEqual({ fareCents: 10000, tipCents: 1000, cancelledFeeCents: 600 });
  });

  it('never takes a decline fee into the basis, even from a breakdown that counted one', () => {
    const s = S({ basisIncludesTips: true, basisIncludesCancellationFees: true, cancellationFeeEnabled: true });
    const all = countRevenue(rides, s);
    expect(all.declinedFeeCents).toBe(600);
    expect(revenueBasis(all, s).basisCents).toBe(11600);
  });
});

describe('unreadable figures', () => {
  it.each([
    ['NaN', NaN, 'unreadable_amount'],
    ['Infinity', Infinity, 'unreadable_amount'],
    ['-12.5', -12.5, 'negative_amount'],
    ['12.345', 12.345, 'unreadable_amount'],
  ])('a fare of %s is a finding and is left out, not counted as zero', (text, fare, code) => {
    const r = countRevenue([completed(fare), completed(10)], S());
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ field: 'fare', code, value: text, status: 'completed' });
    expect(r.fareCents).toBe(1000);
    expect(r.appFareCents).toBe(1000);
    // The ride is still an order received, so it stays in the count.
    expect(r.counts.completed).toBe(2);
  });

  it('a bad tip and a bad distance are reported on their own fields', () => {
    const r = countRevenue([completed(10, NaN, Infinity)], S());
    expect(r.findings.map(f => [f.field, f.code, f.value])).toEqual([
      ['tip', 'unreadable_amount', 'NaN'],
      ['km', 'unreadable_amount', 'Infinity'],
    ]);
    expect(r.fareCents).toBe(1000);
    expect(r.tipCents).toBe(0);
  });

  it('a decline fee that is not whole cents or is negative is a finding and is not counted', () => {
    const r = countRevenue([declined({ declinedFeeCents: 5.5 }), declined({ declinedFeeCents: -100 }), declined()], S());
    expect(r.findings.map(f => f.code)).toEqual(['fee_not_whole_cents', 'negative_amount']);
    expect(r.declinedFeeCents).toBe(600);
  });
});

describe('an empty month', () => {
  it('is all zeros with no findings', () => {
    const r = countRevenue([], S());
    expect(r.counts).toEqual({ completed: 0, cancelled: 0, declined: 0, total: 0 });
    expect(r).toMatchObject({
      fareCents: 0, tipCents: 0, declinedFeeCents: 0, cancelledFeeCents: 0,
      cancelledSheetFareCents: 0, appFareCents: 0, cashFareCents: 0, km: 0,
    });
    expect(r.findings).toEqual([]);
  });

  it('does not share state between calls', () => {
    countRevenue([completed(10), declined()], S());
    expect(countRevenue([], S()).counts.total).toBe(0);
  });
});
