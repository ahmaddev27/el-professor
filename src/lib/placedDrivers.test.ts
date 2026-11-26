import { describe, expect, it } from 'vitest';
import { parsePlacedDrivers, placedNames } from './placedDrivers';

describe('parsePlacedDrivers', () => {
  it('keeps well-formed entries and drops everything else', () => {
    const parsed = parsePlacedDrivers([
      { name: 'Nora Vogt', action: 'created' },
      { name: 'Ali Test', action: 'linked' },
      { name: 3, action: 'created' },
      { name: '  ', action: 'created' },
      { name: 'Eva', action: 'deleted' },
      { name: 'Max' },
      null,
      'Nora',
    ]);
    expect(parsed).toEqual([
      { name: 'Nora Vogt', action: 'created' },
      { name: 'Ali Test', action: 'linked' },
    ]);
    expect(placedNames(parsed, 'created')).toEqual(['Nora Vogt']);
    expect(placedNames(parsed, 'linked')).toEqual(['Ali Test']);
  });

  it.each([null, undefined, {}, 'x', 5])('reads %j as no entries', raw => {
    expect(parsePlacedDrivers(raw)).toEqual([]);
  });
});
