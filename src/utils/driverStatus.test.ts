import { describe, expect, it } from 'vitest';
import {
  ACTIVE_DRIVER_STATUS,
  DEACTIVATED_DRIVER_STATUS,
  driverNameWithStatus,
  isDeactivatedDriver,
  selectableDrivers,
} from './driverStatus';

/**
 * The rule the call sites apply, pinned on its own.
 *
 * The case that matters most is the third one: a row read without the `status`
 * column is NOT reported deactivated, because the read never asked. Answering
 * true there would empty every chooser whose select omits the column; answering
 * "I know it is active" is the mistake that makes a query-level filter look
 * optional. False means "not known to be deactivated", and the registry test
 * beside this one is what then requires a chooser to filter in its query.
 */
describe('isDeactivatedDriver', () => {
  it('is true only for the stored deactivated value', () => {
    expect(isDeactivatedDriver({ status: DEACTIVATED_DRIVER_STATUS })).toBe(true);
    expect(isDeactivatedDriver({ status: ACTIVE_DRIVER_STATUS })).toBe(false);
  });

  it('is false for a row that does not carry the column', () => {
    expect(isDeactivatedDriver({})).toBe(false);
    expect(isDeactivatedDriver({ status: null })).toBe(false);
    expect(isDeactivatedDriver({ status: undefined })).toBe(false);
  });

  it('is false for a value outside the two the CHECK constraint admits', () => {
    // `drivers_status_check` admits 'active' and 'inactive' only, so this cannot
    // come out of the database. It can come out of a stale localStorage blob,
    // which `useDatabase` still falls back to.
    expect(isDeactivatedDriver({ status: 'archived' })).toBe(false);
    expect(isDeactivatedDriver({ status: 'INACTIVE' })).toBe(false);
  });
});

describe('selectableDrivers', () => {
  interface Row { id: string; name: string; status?: string | null }
  const anna: Row = { id: 'a', name: 'Anna', status: ACTIVE_DRIVER_STATUS };
  const bruno: Row = { id: 'b', name: 'Bruno', status: DEACTIVATED_DRIVER_STATUS };
  // No `status` at all: a row read by a select that did not ask for the column.
  const clara: Row = { id: 'c', name: 'Clara' };

  it('drops the deactivated and keeps the order of the rest', () => {
    expect(selectableDrivers([anna, bruno, clara]).map(d => d.id)).toEqual(['a', 'c']);
  });

  it('does not mutate its input', () => {
    const list = [anna, bruno];
    selectableDrivers(list);
    expect(list).toHaveLength(2);
  });

  it('answers an empty list for an empty list', () => {
    expect(selectableDrivers([])).toEqual([]);
  });
});

describe('driverNameWithStatus', () => {
  const t = (_key: 'gq.driver.inactive', vars: { name: string }) => `${vars.name} (inaktiv)`;

  it('marks a deactivated driver and leaves an active one alone', () => {
    expect(driverNameWithStatus({ name: 'Bruno', status: DEACTIVATED_DRIVER_STATUS }, t)).toBe('Bruno (inaktiv)');
    expect(driverNameWithStatus({ name: 'Anna', status: ACTIVE_DRIVER_STATUS }, t)).toBe('Anna');
  });

  it('leaves a name alone when the row does not carry the column', () => {
    expect(driverNameWithStatus({ name: 'Clara' }, t)).toBe('Clara');
  });
});
