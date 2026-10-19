import { describe, expect, it } from 'vitest';
import { INCIDENT_NOTE_TYPES, NOTE_TYPES, noteVehicleMissing, noteVehicleRequired } from './noteRules';

describe('note types', () => {
  it('are the driver apps ten, in any order', () => {
    expect([...NOTE_TYPES].sort()).toEqual(
      ['accident', 'blitzer', 'breakdown', 'general', 'kontrolle', 'off', 'other', 'sick', 'vacation', 'wait'],
    );
  });

  it('name exactly five incident types, all of them real types', () => {
    expect([...INCIDENT_NOTE_TYPES].sort()).toEqual(['accident', 'blitzer', 'breakdown', 'kontrolle', 'wait']);
    for (const type of INCIDENT_NOTE_TYPES) expect(NOTE_TYPES).toContain(type);
  });
});

describe('noteVehicleRequired', () => {
  it.each(['blitzer', 'accident', 'kontrolle', 'breakdown', 'wait'])('%s needs a vehicle', (type) => {
    expect(noteVehicleRequired(type)).toBe(true);
  });
  it.each(['general', 'sick', 'vacation', 'off', 'other'])('%s does not', (type) => {
    expect(noteVehicleRequired(type)).toBe(false);
  });
  it('does not wave an unknown type through as an incident', () => {
    expect(noteVehicleRequired('nonsense')).toBe(false);
  });
});

describe('noteVehicleMissing', () => {
  it('is true for an incident with no car, blank included', () => {
    expect(noteVehicleMissing('accident', '')).toBe(true);
    expect(noteVehicleMissing('accident', '  ')).toBe(true);
  });
  it('is false once a car is named, or for a type that needs none', () => {
    expect(noteVehicleMissing('accident', 'car-1')).toBe(false);
    expect(noteVehicleMissing('sick', '')).toBe(false);
  });
  it('lets an old note without a car be edited, but never a new one', () => {
    expect(noteVehicleMissing('wait', '', true)).toBe(false);
    expect(noteVehicleMissing('wait', '', false)).toBe(true);
  });
});

describe('the Notizen screen', () => {
  it('offers exactly these types', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/pages/NotesPage.tsx', 'utf8');
    const list = source.slice(source.indexOf('const NOTE_TYPES = ['), source.indexOf('const PLANNING_BEHAVIOR_LABELS'));
    const offered = [...list.matchAll(/value: '(\w+)'/g)].map((m) => m[1]);
    expect([...offered].sort()).toEqual([...NOTE_TYPES].sort());
  });
});
